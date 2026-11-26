# Explorer Category Tabs

Adds category filter tabs above Obsidian's native File Explorer so you can switch between named groups of folders with one click.

## Features

- Create unlimited category tabs, each with its own name, Lucide icon, and list of folder paths.
- Optionally treat folders as files-only, hiding their folder title while keeping their contents visible.
- Hide configured root folder labels for nested paths such as `Assets/Images`.
- Optional auto-hide mode via the `--ect-auto-hide-snippet-active` CSS variable.
- **Vault Root Coverage** audit lists root folders that no category tab owns.
- Icon picker with built-in Lucide icons and live filter refresh.

## Usage / Requirements

Enable Obsidian's core **File Explorer**, then open **Settings → Explorer Category Tabs**. Add a tab, assign folder paths, and click the tab in the File Explorer to filter. Use the reset button in the explorer to return to the tab's minimum view. No desktop-only requirement.

## Installation

### Install with BRAT (recommended)

1. Install and enable **BRAT** (`Obsidian42 - BRAT`) from **Settings → Community plugins → Browse**.
2. Open the Command Palette (`Cmd/Ctrl + P`) and run **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/ms3056/obsidian-explorer-tabs`.
4. Leave the version on **Latest version** and click **Add Plugin**.
5. Go to **Settings → Community plugins**, refresh if needed, and enable **Explorer Category Tabs**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` (if present) from the [latest GitHub release](https://github.com/ms3056/obsidian-explorer-tabs/releases), copy them into `<Vault>/.obsidian/plugins/obsidian-explorer-tabs/`, then enable **Explorer Category Tabs** in **Settings → Community plugins**.

## License

This plugin is licensed under the [MIT License](./LICENSE).
