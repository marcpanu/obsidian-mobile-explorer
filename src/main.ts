import {
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	Vault,
	setIcon,
} from "obsidian";
import { MobileExplorerView, VIEW_TYPE, isPathAtOrUnder } from "./view";
import { printNote } from "./print";

interface Shortcut {
	folder: string;
	icon: string;
}

interface MobileExplorerSettings {
	shortcuts: Shortcut[];
}

const DEFAULT_SETTINGS: MobileExplorerSettings = {
	shortcuts: [],
};

// The home folder is stored per device (in localStorage, not data.json) so
// each device can treat a different folder as the top of the explorer.
// localStorage keys are only scoped per vault, not per plugin, so the key
// carries the plugin id to stay clear of other plugins.
const HOME_FOLDER_KEY = "mobile-explorer-home-folder";

const SHORTCUT_ICONS = [
	"folder-open",
	"inbox",
	"star",
	"bookmark",
	"heart",
	"home",
	"archive",
	"book",
	"briefcase",
	"calendar",
	"camera",
	"clock",
	"code",
	"coffee",
	"edit",
	"file-text",
	"flag",
	"globe",
	"hash",
	"lightbulb",
	"list",
	"map-pin",
	"music",
	"paperclip",
	"tag",
];

export default class MobileExplorerPlugin extends Plugin {
	settings!: MobileExplorerSettings;
	// Cached home folder path; null until first read. Views ask for home on
	// every render and touch event, so this avoids a localStorage round trip
	// each time.
	private homePath: string | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new MobileExplorerSettingTab(this));

		this.registerView(VIEW_TYPE, (leaf) => new MobileExplorerView(leaf, this));

		this.addCommand({
			id: "open",
			name: "Open",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "reveal-active-file",
			name: "Reveal active file",
			callback: () => this.revealActiveFile(),
		});

		this.addCommand({
			id: "print-note",
			name: "Print current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.printNoteSafely(file);
				return true;
			},
		});

		// Adds "Print note" to every file menu: this plugin's long-press /
		// right-click menu (which triggers "file-menu") as well as Obsidian's
		// own file menus.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) =>
					item
						.setTitle("Print note")
						.setIcon("lucide-printer")
						.setSection("action")
						.onClick(() => this.printNoteSafely(file))
				);
			})
		);

		// Keep the device-local home folder pointing at the right place when
		// it (or one of its ancestors) is renamed or moved.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFolder)) return;
				const home = this.getHomeFolderPath();
				if (!isPathAtOrUnder(home, oldPath)) return;
				this.setHomeFolderPath(
					file.path + home.slice(oldPath.length),
					false
				);
			})
		);

		// Creating or deleting the home folder (or an ancestor) switches the
		// explorer between that folder and the vault root, so views need to
		// redraw even though the stored path is unchanged.
		const onHomeExistenceChanged = (file: TAbstractFile) => {
			if (!(file instanceof TFolder)) return;
			if (!isPathAtOrUnder(this.getHomeFolderPath(), file.path)) return;
			for (const view of this.getViews()) view.onHomeChanged(false);
		};
		this.registerEvent(this.app.vault.on("create", onHomeExistenceChanged));
		this.registerEvent(this.app.vault.on("delete", onHomeExistenceChanged));

		this.app.workspace.onLayoutReady(() => this.activateView());
	}

	/**
	 * The configured home folder path for this device, or "" when unset
	 * (meaning the vault root).
	 */
	getHomeFolderPath(): string {
		if (this.homePath === null) {
			const value: unknown = this.app.loadLocalStorage(HOME_FOLDER_KEY);
			this.homePath = typeof value === "string" ? value : "";
		}
		return this.homePath;
	}

	/**
	 * Set the home folder for this device. Pass "" to use the vault root.
	 */
	setHomeFolderPath(path: string, navigate = true) {
		this.homePath = path;
		this.app.saveLocalStorage(HOME_FOLDER_KEY, path || null);
		for (const view of this.getViews()) view.onHomeChanged(navigate);
	}

	/**
	 * The folder the explorer treats as its top level. Falls back to the
	 * vault root when nothing is configured or the configured folder no
	 * longer exists.
	 */
	getHomeFolder(): TFolder {
		const path = this.getHomeFolderPath();
		if (path) {
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (folder instanceof TFolder) return folder;
		}
		return this.app.vault.getRoot();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MobileExplorerSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshViews();
	}

	private printNoteSafely(file: TFile) {
		printNote(this.app, file).catch((error: unknown) => {
			console.error("Mobile Explorer: printing failed", error);
			new Notice(`Could not print "${file.basename}"`);
		});
	}

	private refreshViews() {
		for (const view of this.getViews()) view.onSettingsChanged();
	}

	/** Open explorer views, skipping leaves that are still deferred. */
	private getViews(): MobileExplorerView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((v): v is MobileExplorerView => v instanceof MobileExplorerView);
	}

	private async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	private revealActiveFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file?.parent) return;
		const view = this.getViews()[0];
		if (view) {
			view.revealFile(file);
			void this.app.workspace.revealLeaf(view.leaf);
		}
	}
}

class MobileExplorerSettingTab extends PluginSettingTab {
	constructor(private plugin: MobileExplorerPlugin) {
		super(plugin.app, plugin);
	}

	private getAllFolders(vault: Vault): string[] {
		const paths: string[] = [];
		const collect = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					paths.push(child.path);
					collect(child);
				}
			}
		};
		collect(vault.getRoot());
		return paths.sort((a, b) => a.localeCompare(b));
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		const folders = this.getAllFolders(this.plugin.app.vault);
		const shortcuts = this.plugin.settings.shortcuts;

		new Setting(containerEl)
			.setName("Home folder")
			.setDesc(
				"The folder the explorer treats as its top level: where it " +
					"opens, where the Home button goes, and where Recents " +
					"appears. Recents and the back button are limited to this " +
					"folder. Saved on this device only, so each device can " +
					"have its own home folder."
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Vault root");
				const current = this.plugin.getHomeFolderPath();
				if (current && !folders.includes(current)) {
					dropdown.addOption(current, `${current} (missing)`);
				}
				for (const path of folders) {
					dropdown.addOption(path, path);
				}
				dropdown.setValue(current).onChange((value) => {
					this.plugin.setHomeFolderPath(value);
				});
			});

		new Setting(containerEl)
			.setName("Shortcut buttons")
			.setDesc("Up to 3 folder shortcuts displayed in the header bar.")
			.setHeading();

		for (let i = 0; i < 3; i++) {
			const shortcut = shortcuts[i] ?? { folder: "", icon: "folder-open" };
			this.addShortcutSetting(containerEl, i, shortcut, folders);
		}
	}

	private addShortcutSetting(
		containerEl: HTMLElement,
		index: number,
		shortcut: Shortcut,
		folders: string[]
	) {
		const setting = new Setting(containerEl)
			.setName(`Shortcut ${index + 1}`)
			.addDropdown((dropdown) => {
				dropdown.addOption("", "None");
				for (const path of folders) {
					dropdown.addOption(path, path);
				}
				dropdown
					.setValue(shortcut.folder)
					.onChange(async (value) => {
						this.updateShortcut(index, value, shortcut.icon);
						await this.plugin.saveSettings();
					});
			});

		if (shortcut.folder) {
			const preview = setting.controlEl.createSpan(
				"mobile-explorer-icon-preview"
			);
			setIcon(preview, shortcut.icon || "folder-open");

			setting.addDropdown((dropdown) => {
				dropdown.selectEl.addClass("mobile-explorer-icon-dropdown");
				for (const id of SHORTCUT_ICONS) {
					dropdown.addOption(id, id);
				}
				dropdown
					.setValue(shortcut.icon || "folder-open")
					.onChange(async (value) => {
						this.updateShortcut(index, shortcut.folder, value);
						setIcon(preview, value);
						await this.plugin.saveSettings();
					});
			});

			setting.addExtraButton((btn) => {
				btn.setIcon("chevron-up").setTooltip("Move up").onClick(async () => {
					this.swapShortcuts(index, index - 1);
					await this.plugin.saveSettings();
					this.display();
				});
				if (index === 0) btn.extraSettingsEl.setCssStyles({ visibility: "hidden" });
			});
			setting.addExtraButton((btn) => {
				btn.setIcon("chevron-down").setTooltip("Move down").onClick(async () => {
					this.swapShortcuts(index, index + 1);
					await this.plugin.saveSettings();
					this.display();
				});
				if (index === 2) btn.extraSettingsEl.setCssStyles({ visibility: "hidden" });
			});
		}
	}

	private swapShortcuts(a: number, b: number) {
		const shortcuts = this.plugin.settings.shortcuts;
		const empty: Shortcut = { folder: "", icon: "folder-open" };
		const itemA = shortcuts[a] ?? empty;
		const itemB = shortcuts[b] ?? empty;
		while (shortcuts.length <= Math.max(a, b)) {
			shortcuts.push({ folder: "", icon: "folder-open" });
		}
		shortcuts[a] = itemB;
		shortcuts[b] = itemA;
		while (
			shortcuts.length > 0 &&
			shortcuts[shortcuts.length - 1].folder === ""
		) {
			shortcuts.pop();
		}
	}

	private updateShortcut(index: number, folder: string, icon: string) {
		const shortcuts = this.plugin.settings.shortcuts;
		while (shortcuts.length <= index) {
			shortcuts.push({ folder: "", icon: "folder-open" });
		}
		shortcuts[index] = { folder, icon };
		while (
			shortcuts.length > 0 &&
			shortcuts[shortcuts.length - 1].folder === ""
		) {
			shortcuts.pop();
		}
	}
}
