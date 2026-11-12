import {
    App,
    Modal,
    Plugin,
    PluginSettingTab,
    Setting,
    WorkspaceLeaf,
    setIcon,
    normalizePath,
    TAbstractFile,
    TFolder
} from 'obsidian';

interface TabConfig {
    id: string;
    name: string;
    icon: string;
    paths: string[];
    filesOnly?: boolean;
}

interface ExplorerTabsSettings {
    tabs: TabConfig[];
    activeTabId: string | null;
    hideRootFolders: boolean;
    hideWithAutoHide: boolean;
}

const ROOT_PATH_TOKEN = '<root>';

function isRootPathToken(path: string): boolean {
    return path.trim().toLowerCase() === ROOT_PATH_TOKEN;
}

function normalizeVaultPath(path: string): string {
    return normalizePath(path.trim()).replace(/^\/+|\/+$/g, '');
}

const DEFAULT_SETTINGS: ExplorerTabsSettings = {
    activeTabId: 'inbox',
    hideRootFolders: false,
    hideWithAutoHide: false,
    tabs: [
        { id: 'inbox', name: 'Inbox', icon: 'inbox', paths: ['Inbox'], filesOnly: false },
        { id: 'periodic', name: 'Periodic', icon: 'calendar', paths: ['Periodic', 'Daily Notes'], filesOnly: false },
        { id: 'assets', name: 'Assets', icon: 'image', paths: ['Assets', 'Images'], filesOnly: false },
        { id: 'templates', name: 'Templates', icon: 'file-code', paths: ['Templates'], filesOnly: false },
        { id: 'misc', name: 'Misc', icon: 'folder', paths: ['Misc'], filesOnly: false }
    ]
};

export default class ExplorerTabsPlugin extends Plugin {
    settings: ExplorerTabsSettings;
    private observers: MutationObserver[] = [];
    private filterRefreshTimer: number | null = null;
    /** Open/collapsed state of settings sections, kept across display() re-renders. */
    sectionCollapsed: Record<string, boolean> = {};

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new ExplorerTabsSettingTab(this.app, this));

        // Wait for layout to be ready before querying file-explorer leaves
        this.app.workspace.onLayoutReady(() => {
            this.initExplorerTabs();
        });

        // Re-inject if workspace layout changes (e.g., file explorer closed and reopened)
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.initExplorerTabs();
            })
        );

        // Re-apply filters when files/folders are created, deleted, or renamed
        this.registerEvent(this.app.vault.on('create', () => this.applyFilter()));
        this.registerEvent(this.app.vault.on('delete', () => this.applyFilter()));
        this.registerEvent(this.app.vault.on('rename', () => this.applyFilter()));
    }

    onunload() {
        this.disconnectObservers();
        if (this.filterRefreshTimer !== null) {
            window.clearTimeout(this.filterRefreshTimer);
            this.filterRefreshTimer = null;
        }
        // Remove injected UI bars and restore hidden items
        document.querySelectorAll('.octarine-tabs-container').forEach(el => el.remove());
        document.querySelectorAll('.octarine-filtered-out').forEach(el => {
            el.classList.remove('octarine-filtered-out');
        });
        document.querySelectorAll('.octarine-hidden-root').forEach(el => {
            el.classList.remove('octarine-hidden-root');
        });
        document.querySelectorAll('.octarine-files-only-folder').forEach(el => {
            el.classList.remove('octarine-files-only-folder');
        });
    }

    private disconnectObservers() {
        this.observers.forEach(obs => obs.disconnect());
        this.observers = [];
    }

    private scheduleFilterRefresh() {
        if (this.filterRefreshTimer !== null) return;

        this.filterRefreshTimer = window.setTimeout(() => {
            this.filterRefreshTimer = null;
            this.applyFilter();
        }, 50);
    }

    public initExplorerTabs() {
        this.disconnectObservers();
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');

        for (const leaf of leaves) {
            this.injectTabBar(leaf);
            this.setupMutationObserver(leaf);
        }

        this.applyFilter();
    }

    private injectTabBar(leaf: WorkspaceLeaf) {
        const container = leaf.view.containerEl;
        if (!container) return;

        // Clean up existing bar in this leaf if refreshing
        const existingBar = container.querySelector('.octarine-tabs-container');
        if (existingBar) existingBar.remove();

        const navHeader = container.querySelector('.nav-header');
        const filesContainer = container.querySelector('.nav-files-container');

        const tabBar = document.createElement('div');
        tabBar.className = 'octarine-tabs-container';
        tabBar.classList.toggle('octarine-auto-hide', this.settings.hideWithAutoHide);

        const tabButtons = document.createElement('div');
        tabButtons.className = 'octarine-tab-buttons';

        for (const tab of this.settings.tabs) {
            const btn = document.createElement('button');
            btn.className = 'octarine-tab-btn clickable-icon';
            if (this.settings.activeTabId === tab.id) {
                btn.classList.add('is-active');
            }
            btn.setAttribute('aria-label', tab.name);
            btn.setAttribute('data-tooltip-position', 'bottom');
            setIcon(btn, tab.icon || 'folder');

            btn.addEventListener('click', async () => {
                // Clicking active tab toggles filter off (shows all files)
                if (this.settings.activeTabId === tab.id) {
                    this.settings.activeTabId = null;
                } else {
                    this.settings.activeTabId = tab.id;
                }
                await this.saveSettings();
                this.updateTabButtonsState();
                this.applyFilter();
            });

            tabButtons.appendChild(btn);
        }

        tabBar.appendChild(tabButtons);

        const actions = document.createElement('div');
        actions.className = 'octarine-tab-actions';

        const resetButton = document.createElement('button');
        resetButton.className = 'octarine-reset-expansion-btn clickable-icon';
        resetButton.setAttribute('aria-label', 'Reset folder expansion to settings');
        resetButton.setAttribute('data-tooltip-position', 'bottom');
        resetButton.title = 'Reset folder expansion to settings';
        setIcon(resetButton, 'rotate-ccw');
        resetButton.addEventListener('click', () => this.resetFolderExpansion());
        actions.appendChild(resetButton);
        tabBar.appendChild(actions);

        // Insert right below the standard explorer action buttons (New Note, New Folder, etc.)
        if (navHeader && navHeader.nextSibling) {
            container.insertBefore(tabBar, navHeader.nextSibling);
        } else if (filesContainer) {
            container.insertBefore(tabBar, filesContainer);
        } else {
            container.prepend(tabBar);
        }
    }

    public resetFolderExpansion() {
        const activeTab = this.settings.tabs.find(t => t.id === this.settings.activeTabId);
        const targetPaths = activeTab
            ? activeTab.paths
                .filter(p => !isRootPathToken(p))
                .map(normalizeVaultPath)
                .filter(p => p.length > 0)
            : [];
        const hiddenRootPaths = new Set<string>();

        if (activeTab && this.settings.hideRootFolders) {
            for (const path of targetPaths) {
                const root = path.split('/')[0];
                if (path.includes('/')) {
                    hiddenRootPaths.add(root);
                }
            }
            for (const path of targetPaths) {
                if (!path.includes('/')) {
                    hiddenRootPaths.delete(path);
                }
            }
        }

        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        for (const leaf of leaves) {
            const filesContainer = leaf.view.containerEl.querySelector<HTMLElement>('.nav-files-container');
            if (!filesContainer) continue;

            const expandedFolders = Array.from(
                filesContainer.querySelectorAll<HTMLElement>('.nav-folder-title')
            ).flatMap(titleEl => {
                const wrapperEl = titleEl.parentElement;
                const dataPath = titleEl.getAttribute('data-path');
                if (!wrapperEl || !dataPath || wrapperEl.classList.contains('mod-root')) return [];

                const normalizedPath = normalizeVaultPath(dataPath);
                return [{
                    titleEl,
                    wrapperEl,
                    normalizedPath,
                    shouldExpand: this.shouldExpandFolder(
                        normalizedPath,
                        true,
                        activeTab,
                        targetPaths,
                        hiddenRootPaths
                    )
                }];
            }).filter(folder =>
                !folder.shouldExpand &&
                !this.isFolderCollapsed(folder.titleEl, folder.wrapperEl)
            ).sort((a, b) =>
                b.normalizedPath.split('/').length - a.normalizedPath.split('/').length
            );

            for (const folder of expandedFolders) {
                const collapseIndicator =
                    folder.titleEl.querySelector<HTMLElement>('.nav-folder-collapse-indicator');
                (collapseIndicator ?? folder.titleEl).click();
            }
        }

        this.applyFilter();
    }

    private setupMutationObserver(leaf: WorkspaceLeaf) {
        const filesContainer = leaf.view.containerEl.querySelector('.nav-files-container');
        if (!filesContainer) return;

        const observer = new MutationObserver((mutations) => {
            const needsRefresh = mutations.some(mutation => {
                if (mutation.type === 'childList') return true;
                if (mutation.attributeName !== 'class' || !(mutation.target instanceof HTMLElement)) {
                    return false;
                }

                const target = mutation.target;
                if (!target.closest('.nav-folder')) return false;

                const wasCollapsed = mutation.oldValue?.split(/\s+/).includes('is-collapsed') ?? false;
                return wasCollapsed !== target.classList.contains('is-collapsed');
            });

            if (needsRefresh) this.scheduleFilterRefresh();
        });

        observer.observe(filesContainer, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
            attributeOldValue: true
        });

        this.observers.push(observer);
    }

    private updateTabButtonsState() {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        for (const leaf of leaves) {
            const buttons = leaf.view.containerEl.querySelectorAll('.octarine-tab-btn');
            buttons.forEach((btn, index) => {
                const tab = this.settings.tabs[index];
                if (tab && this.settings.activeTabId === tab.id) {
                    btn.classList.add('is-active');
                } else {
                    btn.classList.remove('is-active');
                }
            });
        }
    }

    public applyFilter() {
        const leaves = this.app.workspace.getLeavesOfType('file-explorer');
        for (const leaf of leaves) {
            const filesContainer = leaf.view.containerEl.querySelector('.nav-files-container');
            if (filesContainer) {
                this.applyFilterToContainer(filesContainer as HTMLElement);
            }
        }
    }

    private applyFilterToContainer(filesContainer: HTMLElement) {
        const activeTab = this.settings.tabs.find(t => t.id === this.settings.activeTabId);
        const includesVaultRoot = activeTab?.paths.some(isRootPathToken) ?? false;

        // Normalize configured paths
        const targetPaths = activeTab
            ? activeTab.paths
                .filter(p => !isRootPathToken(p))
                .map(normalizeVaultPath)
                .filter(p => p.length > 0)
            : [];
        const hiddenRootPaths = new Set<string>();
        if (activeTab && this.settings.hideRootFolders) {
            for (const path of targetPaths) {
                const root = path.split('/')[0];
                if (path.includes('/')) {
                    hiddenRootPaths.add(root);
                }
            }
            for (const path of targetPaths) {
                if (!path.includes('/')) {
                    hiddenRootPaths.delete(path);
                }
            }
        }

        if (includesVaultRoot && activeTab?.filesOnly) {
            const rootFolder = filesContainer.querySelector<HTMLElement>('.nav-folder.mod-root');
            const rootTitle = rootFolder?.querySelector<HTMLElement>('.nav-folder-title');
            if (rootFolder && rootTitle && this.isFolderCollapsed(rootTitle, rootFolder)) {
                this.clearFilterClasses(filesContainer);
                const collapseIndicator =
                    rootTitle.querySelector<HTMLElement>('.nav-folder-collapse-indicator');
                (collapseIndicator ?? rootTitle).click();
                this.scheduleFilterRefresh();
                return;
            }
        }

        // Query all file and folder items in the explorer
        const items = filesContainer.querySelectorAll<HTMLElement>('.nav-folder-title, .nav-file-title');

        const itemStates = Array.from(items).flatMap((titleEl) => {
            const dataPath = titleEl.getAttribute('data-path');
            const wrapperEl = titleEl.parentElement; // .nav-folder or .nav-file

            if (!wrapperEl || !dataPath) return [];

            // Never hide the vault root element itself
            if (dataPath === '/' || wrapperEl.classList.contains('mod-root')) {
                return [];
            }

            const normalizedPath = normalizeVaultPath(dataPath);
            const hideRoot = hiddenRootPaths.has(normalizedPath);
            const isFolder = titleEl.classList.contains('nav-folder-title');
            const folder = activeTab?.filesOnly && isFolder
                ? this.app.vault.getAbstractFileByPath(normalizedPath)
                : null;
            const isLeafFolder =
                folder instanceof TFolder &&
                !folder.children.some(child => child instanceof TFolder);
            const targetPathVisible = activeTab
                ? this.shouldDisplayPath(normalizedPath, targetPaths)
                : true;
            const isRootLevelFile =
                includesVaultRoot &&
                Boolean(activeTab?.filesOnly) &&
                !normalizedPath.includes('/') &&
                titleEl.classList.contains('nav-file-title');
            const rootTargetVisible = includesVaultRoot &&
                (!activeTab?.filesOnly || isRootLevelFile);
            const isVisible = !activeTab || hideRoot || targetPathVisible || rootTargetVisible;
            const hideFolderTitle =
                Boolean(activeTab?.filesOnly) &&
                isFolder &&
                isLeafFolder &&
                targetPathVisible;
            const shouldExpand = this.shouldExpandFolder(
                normalizedPath,
                isFolder,
                activeTab,
                targetPaths,
                hiddenRootPaths
            );

            return [{
                titleEl,
                wrapperEl,
                normalizedPath,
                hideRoot,
                hideFolderTitle,
                isVisible,
                shouldExpand,
                isFolder
            }];
        });

        const collapsedTargetFolder = itemStates
            .filter(item =>
                item.isFolder &&
                item.shouldExpand &&
                this.isFolderCollapsed(item.titleEl, item.wrapperEl)
            )
            .sort((a, b) => a.normalizedPath.split('/').length - b.normalizedPath.split('/').length)[0];

        if (collapsedTargetFolder) {
            this.clearFilterClasses(filesContainer);

            const collapseIndicator =
                collapsedTargetFolder.titleEl.querySelector<HTMLElement>('.nav-folder-collapse-indicator');
            (collapseIndicator ?? collapsedTargetFolder.titleEl as HTMLElement).click();
            this.scheduleFilterRefresh();
            return;
        }

        itemStates.forEach(({ wrapperEl, hideRoot, hideFolderTitle, isVisible }) => {
            wrapperEl.classList.toggle('octarine-hidden-root', hideRoot);
            wrapperEl.classList.toggle('octarine-files-only-folder', hideFolderTitle);
            wrapperEl.classList.toggle('octarine-filtered-out', !isVisible);
        });
    }

    private shouldExpandFolder(
        normalizedPath: string,
        isFolder: boolean,
        activeTab: TabConfig | undefined,
        targetPaths: string[],
        hiddenRootPaths: Set<string>
    ): boolean {
        const targetPathVisible = activeTab
            ? this.shouldDisplayPath(normalizedPath, targetPaths)
            : true;
        const isAncestorOfTarget =
            isFolder &&
            targetPaths.some(target => target.startsWith(normalizedPath + '/'));

        return hiddenRootPaths.has(normalizedPath) ||
            isAncestorOfTarget ||
            (Boolean(activeTab?.filesOnly) && isFolder && targetPathVisible);
    }

    private clearFilterClasses(filesContainer: HTMLElement) {
        filesContainer.querySelectorAll<HTMLElement>('.nav-folder, .nav-file').forEach(wrapperEl => {
            wrapperEl.classList.remove(
                'octarine-filtered-out',
                'octarine-hidden-root',
                'octarine-files-only-folder'
            );
        });
    }

    private isFolderCollapsed(titleEl: HTMLElement, wrapperEl: HTMLElement): boolean {
        const collapseIndicator = titleEl.querySelector<HTMLElement>('.nav-folder-collapse-indicator');
        return (
            wrapperEl.classList.contains('is-collapsed') ||
            titleEl.classList.contains('is-collapsed') ||
            Boolean(collapseIndicator?.classList.contains('is-collapsed'))
        );
    }

    /**
     * Determines if a given DOM node path should be visible for the active tab's configured paths.
     * Shows:
     * 1. Exact matches
     * 2. Descendants of a configured folder (so expanding a configured folder shows its contents)
     * 3. Ancestor folders of a deeply nested configured path (so the nested item's parent tree remains visible)
     */
    private shouldDisplayPath(itemPath: string, configuredPaths: string[]): boolean {
        const normItem = normalizeVaultPath(itemPath);

        for (const target of configuredPaths) {
            const normalizedTarget = normalizeVaultPath(target);
            if (normItem === normalizedTarget) return true;
            if (normItem.startsWith(normalizedTarget + '/')) return true;
            if (normalizedTarget.startsWith(normItem + '/')) return true;
        }
        return false;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

const POPULAR_LUCIDE_ICONS: string[] = [
    "calendar", "calendar-clock", "calendar-check", "clock", "hourglass", "timer",
    "alarm-clock", "plane-takeoff", "rocket", "plus-circle", "check-circle-2",
    "check", "check-square", "pencil", "x-circle", "x", "repeat", "refresh-cw", "chevrons-up",
    "chevron-up", "minus", "chevron-down", "chevrons-down", "arrow-up", "arrow-down",
    "flame", "zap", "alert-triangle", "alert-circle", "bell", "bookmark", "flag",
    "star", "heart", "tag", "tags", "hash", "at-sign", "user", "users", "phone",
    "mail", "message-square", "home", "briefcase", "folder", "file-text", "link",
    "lock", "unlock", "key", "ban", "shield", "eye", "search", "settings", "wrench",
    "sparkles", "lightbulb", "target", "trophy", "compass", "map-pin", "globe",
    "coffee", "shopping-cart", "credit-card", "dollar-sign", "laptop", "terminal",
    "code", "bug", "git-branch", "git-pull-request", "database", "cloud", "inbox",
    "send", "archive", "trash-2", "clipboard-list", "layers", "activity"
].map((s) => s.toLowerCase());

/** Icon search + pick modal, same UX as the Tasks Lucide Icons plugin. */
class OctarineIconPickerModal extends Modal {
    private searchQuery = "";
    private gridEl!: HTMLElement;

    constructor(
        app: App,
        private readonly currentIcon: string,
        private readonly onSelect: (iconName: string) => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Choose a Lucide Icon" });

        const searchInput = contentEl.createEl("input", {
            type: "text",
            placeholder: "Type any Lucide icon ID (e.g. calendar, flame, tag, rocket)..."
        });
        searchInput.style.width = "100%";
        searchInput.value = this.currentIcon;

        this.gridEl = contentEl.createDiv({ cls: "octarine-icon-modal-grid" });

        searchInput.addEventListener("input", () => {
            this.searchQuery = searchInput.value.trim().toLowerCase();
            this.renderGrid();
        });

        this.renderGrid();
        setTimeout(() => searchInput.focus(), 50);
    }

    private renderGrid() {
        this.gridEl.empty();
        const candidates = new Set<string>();
        if (this.searchQuery.length > 0) {
            candidates.add(this.searchQuery);
        }
        for (const icon of POPULAR_LUCIDE_ICONS) {
            if (!this.searchQuery || icon.includes(this.searchQuery)) {
                candidates.add(icon);
            }
        }

        candidates.forEach((iconName) => {
            const item = this.gridEl.createDiv({ cls: "octarine-icon-modal-item" });
            const iconBox = item.createDiv();
            setIcon(iconBox, iconName);

            // Only show if Obsidian actually rendered a valid SVG for this ID
            if (!iconBox.querySelector("svg")) {
                item.remove();
                return;
            }

            item.createDiv({ cls: "octarine-icon-modal-name", text: iconName });
            item.addEventListener("click", () => {
                this.onSelect(iconName);
                this.close();
            });
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ExplorerTabsSettingTab extends PluginSettingTab {
    plugin: ExplorerTabsPlugin;
    /** Audit container, refreshed live when a tab's paths change. */
    private unassignedContainer: HTMLElement | null = null;

    constructor(app: App, plugin: ExplorerTabsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'File Explorer Category Tabs' });
        containerEl.createEl('p', {
            text: 'Category buttons filter the File Explorer to the folders you assign. Folders you open stay open; use the reset icon in the explorer to return to the tab\u2019s minimum view.',
            cls: 'setting-item-description'
        });

        // --- Global toggles (always visible, above the foldable groups) ---
        new Setting(containerEl)
            .setName('Hide configured root folders')
            .setDesc('Hide the root folder label for nested targets like Assets/Images.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.hideRootFolders)
                .onChange(async (value) => {
                    this.plugin.settings.hideRootFolders = value;
                    await this.plugin.saveSettings();
                    this.plugin.applyFilter();
                }));

        const autoHideSnippetEnabled =
            getComputedStyle(document.body).getPropertyValue('--octarine-auto-hide-snippet-active').trim() === '1';
        if (autoHideSnippetEnabled) {
            new Setting(containerEl)
                .setName('Hide category tabs with Auto Hide')
                .setDesc('Collapse the category bar to a pill that expands on hover.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.hideWithAutoHide)
                    .onChange(async (value) => {
                        this.plugin.settings.hideWithAutoHide = value;
                        await this.plugin.saveSettings();
                        this.plugin.initExplorerTabs();
                    }));
        }

        // --- Category Tabs: collapsible section with one card per tab ---
        const tabsBody = this.makeSection('tabs', 'Category Tabs', containerEl);

        const tabsListEl = tabsBody.createDiv({ cls: 'octarine-tab-list' });

        this.plugin.settings.tabs.forEach((tab, index) => {
            this.renderTabCard(tabsListEl, tab, index);
        });

        // Add button at the bottom of the fold, after the tab cards.
        const tabsFooter = tabsBody.createDiv({ cls: 'octarine-section-footer' });
        tabsFooter.createEl('button', {
            cls: 'mod-cta',
            text: '+ Add New Category Tab'
        }).addEventListener('click', async () => {
            const newId = 'tab-' + Date.now();
            this.plugin.settings.tabs.push({
                id: newId,
                name: 'New Category',
                icon: 'folder',
                paths: [],
                filesOnly: false
            });
            await this.plugin.saveSettings();
            this.plugin.initExplorerTabs();
            this.display();
        });

        // --- Vault Root Coverage: collapsible audit section ---
        const auditBody = this.makeSection('audit', 'Vault Root Coverage', containerEl);
        auditBody.createDiv({
            cls: 'octarine-section-desc',
            text: 'Root-level folders with no dedicated category tab. <root> views don\u2019t count \u2014 a folder should be owned by a tab that shows it.'
        });
        const unassignedContainer = auditBody.createDiv();
        this.unassignedContainer = unassignedContainer;
        this.renderUnassignedRootItems(unassignedContainer);
    }

    /** Collapsible <details> section; state lives in plugin.sectionCollapsed. */
    private makeSection(
        key: string,
        title: string,
        parentEl: HTMLElement
    ): HTMLElement {
        const details = parentEl.createEl('details', { cls: 'octarine-collapse' });
        details.open = !this.plugin.sectionCollapsed[key];

        const summary = details.createEl('summary', { cls: 'octarine-collapse-summary' });
        const chevron = summary.createSpan({ cls: 'octarine-collapse-chevron' });
        setIcon(chevron, 'chevron-right');
        chevron.setAttr('aria-hidden', 'true');
        summary.createSpan({ cls: 'octarine-collapse-title', text: title });

        const body = details.createDiv({ cls: 'octarine-collapse-body' });

        details.addEventListener('toggle', () => {
            this.plugin.sectionCollapsed[key] = !details.open;
        });

        return body;
    }

    private renderTabCard(parentEl: HTMLElement, tab: TabConfig, index: number) {
        const card = parentEl.createDiv({ cls: 'octarine-tab-setting-card' });

        const header = card.createDiv({ cls: 'octarine-tab-setting-header' });
        const titleSpan = header.createSpan({ text: `${index + 1}. ${tab.name}` });

        const removeBtn = header.createEl('button', {
            cls: 'clickable-icon',
            attr: {
                'aria-label': 'Remove tab',
                title: 'Remove tab'
            }
        });
        setIcon(removeBtn, 'trash-2');
        removeBtn.style.color = 'var(--text-error)';
        removeBtn.addEventListener('click', async () => {
            this.plugin.settings.tabs.splice(index, 1);
            if (this.plugin.settings.activeTabId === tab.id) {
                this.plugin.settings.activeTabId = null;
            }
            await this.plugin.saveSettings();
            this.plugin.initExplorerTabs();
            this.display();
        });

        // Compact 2-column card: left = name/icon/files-only, right = paths.
        const grid = card.createDiv({ cls: 'octarine-tab-grid' });

        // --- Left column ---
        const leftCol = grid.createDiv({ cls: 'octarine-tab-left' });

        leftCol.createDiv({ cls: 'octarine-field-label', text: 'Name' });
        const nameInput = leftCol.createEl('input', {
            type: 'text',
            cls: 'octarine-text-input',
            placeholder: 'Category Name'
        });
        nameInput.value = tab.name;
        nameInput.addEventListener('input', async () => {
            tab.name = nameInput.value;
            titleSpan.setText(`${index + 1}. ${tab.name || 'Unnamed'}`);
            await this.plugin.saveSettings();
            this.plugin.initExplorerTabs();
        });

        leftCol.createDiv({ cls: 'octarine-field-label', text: 'Icon' });
        const iconRow = leftCol.createDiv({ cls: 'octarine-icon-row' });
        const iconInput = iconRow.createEl('input', {
            type: 'text',
            cls: 'octarine-text-input',
            placeholder: 'icon-id'
        });
        iconInput.value = tab.icon;
        iconInput.addEventListener('change', async () => {
            tab.icon = iconInput.value.trim();
            await this.plugin.saveSettings();
            this.plugin.initExplorerTabs();
        });

        // Magnifying-glass button opens the searchable icon modal.
        const pickBtn = iconRow.createEl('button', {
            cls: 'clickable-icon',
            attr: {
                'aria-label': 'Browse Lucide icons',
                title: 'Browse Lucide icons'
            }
        });
        setIcon(pickBtn, 'search');
        pickBtn.addEventListener('click', () => {
            new OctarineIconPickerModal(this.app, tab.icon, async (chosen) => {
                tab.icon = chosen;
                iconInput.value = chosen;
                await this.plugin.saveSettings();
                this.plugin.initExplorerTabs();
            }).open();
        });

        // Name label styled like the other field labels, native toggle kept.
        const filesOnlyName = document.createDocumentFragment();
        filesOnlyName.createSpan({ cls: 'octarine-field-label', text: 'Files-only view' });
        new Setting(leftCol)
            .setName(filesOnlyName)
            .setDesc('Show files, hide folder labels.')
            .addToggle(toggle => toggle
                .setValue(tab.filesOnly ?? false)
                .onChange(async (value) => {
                    tab.filesOnly = value;
                    await this.plugin.saveSettings();
                    this.plugin.applyFilter();
                }));

        // --- Right column: paths textarea (compact) + validation ---
        const rightCol = grid.createDiv({ cls: 'octarine-tab-right' });
        rightCol.createDiv({ cls: 'octarine-field-label', text: 'Folders & Files' });
        rightCol.createDiv({
            cls: 'octarine-field-desc',
            text: 'Vault-relative paths, one per line. <root> includes the vault root.'
        });

        const validationContainer = rightCol.createDiv();

        const textArea = rightCol.createEl('textarea', {
            cls: 'octarine-paths-textarea',
            placeholder: 'Inbox\n<root>\nProjects/Active\nREADME.md'
        });
        textArea.rows = 4;
        textArea.value = tab.paths.join('\n');
        textArea.addEventListener('input', async () => {
            tab.paths = textArea.value
                .split('\n')
                .map(p => p.trim())
                .filter(p => p.length > 0);
            await this.plugin.saveSettings();
            this.plugin.applyFilter();
            this.renderPathValidation(validationContainer, tab.paths);
            if (this.unassignedContainer) {
                this.renderUnassignedRootItems(this.unassignedContainer);
            }
        });

        this.renderPathValidation(validationContainer, tab.paths);
    }

    private renderPathValidation(container: HTMLElement, paths: string[]) {
        container.empty();

        if (paths.length === 0) {
            container.createDiv({
                cls: 'octarine-validation-box octarine-validation-warning',
                text: '⚠️ No paths configured for this tab. Clicking it will hide all files.'
            });
            return;
        }

        const missingPaths: string[] = [];
        for (const rawPath of paths) {
            if (isRootPathToken(rawPath)) continue;
            const norm = normalizePath(rawPath);
            const exists: TAbstractFile | null = this.app.vault.getAbstractFileByPath(norm);
            if (!exists) {
                missingPaths.push(rawPath);
            }
        }

        if (missingPaths.length > 0) {
            const warnBox = container.createDiv({
                cls: 'octarine-validation-box octarine-validation-warning'
            });
            warnBox.createEl('strong', { text: '⚠️ Missing folders/files in vault: ' });
            warnBox.createSpan({ text: missingPaths.join(', ') });
        } else {
            container.createDiv({
                cls: 'octarine-validation-ok',
                text: `✓ All ${paths.length} configured path(s) verified in vault.`
            });
        }
    }

    /** Root-level folder names not claimed by any tab's explicit paths.
        <root> is deliberately NOT treated as coverage here: a tab that
        includes it is a "show-everything" view, and the point of this
        audit is catching folders with no dedicated tab. Dot-folders
        (.obsidian, .git, ...) are internal and skipped. */
    private getUnassignedRootNames(): string[] {
        const rootChildren = this.app.vault.getRoot().children || [];
        const rootCovered = new Set<string>();

        this.plugin.settings.tabs.forEach(tab => {
            tab.paths.forEach(p => {
                if (isRootPathToken(p)) return;
                const norm = normalizePath(p.trim());
                if (norm) {
                    const rootSegment = norm.split('/')[0];
                    rootCovered.add(rootSegment);
                }
            });
        });

        return rootChildren
            .filter((child): child is TFolder => child instanceof TFolder)
            .filter(folder => !folder.name.startsWith('.'))
            .filter(folder => !rootCovered.has(folder.name))
            .map(folder => folder.name);
    }

    /** When the audit has findings, make the collapse summary red and add
        a warning icon so the folded section still signals "check me". */
    private refreshAuditSummary(container: HTMLElement) {
        const summary = container.closest('.octarine-collapse')
            ?.querySelector<HTMLElement>('.octarine-collapse-summary');
        if (!summary) return;

        const hasIssues = this.getUnassignedRootNames().length > 0;
        summary.toggleClass('octarine-audit-warning', hasIssues);

        summary.querySelector('.octarine-audit-warning-icon')?.remove();
        if (hasIssues) {
            const icon = summary.createSpan({ cls: 'octarine-audit-warning-icon' });
            setIcon(icon, 'triangle-alert');
            if (!icon.querySelector('svg')) {
                icon.empty();
                setIcon(icon, 'alert-triangle');
            }
        }
    }

    private renderUnassignedRootItems(container: HTMLElement) {
        container.empty();

        const unassigned = this.getUnassignedRootNames();

        if (unassigned.length === 0) {
            container.createDiv({
                cls: 'octarine-validation-ok',
                text: '✓ Every root-level folder has a dedicated tab.'
            });
        } else {
            const box = container.createDiv({ cls: 'octarine-unassigned-list' });
            box.setText(`Unassigned root folders (${unassigned.length}): ${unassigned.join(', ')}`);
        }

        this.refreshAuditSummary(container);
    }
}
