import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	TextComponent,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";

export const VIEW_TYPE = "mobile-explorer";

export class MobileExplorerView extends ItemView {
	private currentFolder: TFolder;
	private folderHistory = new Map<string, string>();
	private headerEl!: HTMLElement;
	private wrapperEl!: HTMLElement;
	private listEl!: HTMLElement;
	private isAnimating = false;
	private longPressTriggered = false;
	private refreshTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.currentFolder = this.app.vault.getRoot();
	}

	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "Explorer";
	}
	getIcon() {
		return "folder";
	}

	async onOpen() {
		const el = this.contentEl;
		el.empty();
		el.addClass("mobile-explorer-container");

		this.headerEl = el.createDiv("mobile-explorer-header");
		this.wrapperEl = el.createDiv("mobile-explorer-wrapper");
		this.listEl = this.wrapperEl.createDiv("mobile-explorer-list");

		this.registerVaultEvents();
		this.setupSwipeBack();

		const active = this.app.workspace.getActiveFile();
		if (active?.parent) {
			this.setFolder(active.parent, active.path);
		} else {
			this.setFolder(this.app.vault.getRoot());
		}
	}

	async onClose() {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
	}

	revealFile(file: TFile) {
		if (file.parent) {
			this.setFolder(file.parent, file.path);
		}
	}

	// --- Vault events ---

	private registerVaultEvents() {
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (this.isInCurrentFolder(file)) this.debouncedRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file.path === this.currentFolder.path) {
					this.setFolder(this.app.vault.getRoot());
					return;
				}
				if (this.isInCurrentFolder(file)) this.debouncedRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (
					oldPath === this.currentFolder.path &&
					file instanceof TFolder
				) {
					this.currentFolder = file;
					this.renderHeader();
					return;
				}
				if (
					this.isInCurrentFolder(file) ||
					this.wasInCurrentFolder(oldPath)
				) {
					this.debouncedRefresh();
				}
			})
		);
	}

	private isInCurrentFolder(file: TAbstractFile): boolean {
		return file.parent?.path === this.currentFolder.path;
	}

	private wasInCurrentFolder(oldPath: string): boolean {
		const lastSlash = oldPath.lastIndexOf("/");
		const parentPath = lastSlash === -1 ? "" : oldPath.substring(0, lastSlash);
		return parentPath === this.currentFolder.path;
	}

	private debouncedRefresh() {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.renderList();
		}, 100);
	}

	// --- Navigation ---

	private setFolder(folder: TFolder, restorePath?: string) {
		this.currentFolder = folder;
		this.renderHeader();
		this.renderList(restorePath);
	}

	private navigateToParent() {
		if (!this.currentFolder.parent || this.isAnimating) return;
		const returnTo = this.currentFolder.path;
		this.animateTransition("back", () => {
			this.setFolder(this.currentFolder.parent!, returnTo);
		});
	}

	private enterFolder(folder: TFolder) {
		if (this.isAnimating) return;
		this.animateTransition("forward", () => {
			this.setFolder(folder);
		});
	}

	private openFile(file: TFile) {
		this.app.workspace.getLeaf(false).openFile(file);
	}

	// --- Animation ---

	private animateTransition(
		direction: "forward" | "back",
		update: () => void
	) {
		this.isAnimating = true;
		const oldList = this.listEl;
		const newList = this.wrapperEl.createDiv("mobile-explorer-list");

		if (direction === "forward") {
			newList.style.transform = "translateX(100%)";
			newList.style.opacity = "1";
		} else {
			newList.style.transform = "translateX(-30%)";
			newList.style.opacity = "0.3";
		}

		this.listEl = newList;
		update();

		void newList.offsetHeight;

		if (direction === "forward") {
			oldList.style.transform = "translateX(-30%)";
			oldList.style.opacity = "0";
		} else {
			oldList.style.transform = "translateX(100%)";
			oldList.style.opacity = "0";
		}

		newList.style.transform = "translateX(0)";
		newList.style.opacity = "1";

		const cleanup = () => {
			oldList.remove();
			this.isAnimating = false;
		};

		let cleaned = false;
		const safeCleanup = () => {
			if (cleaned) return;
			cleaned = true;
			cleanup();
		};

		newList.addEventListener("transitionend", safeCleanup, { once: true });
		setTimeout(safeCleanup, 350);
	}

	// --- Swipe back gesture ---

	private setupSwipeBack() {
		let startX = 0;
		let startY = 0;
		let tracking = false;

		this.wrapperEl.addEventListener("touchstart", (e) => {
			const touch = e.touches[0];
			if (touch && touch.clientX < 30 && this.currentFolder.parent) {
				startX = touch.clientX;
				startY = touch.clientY;
				tracking = true;
			}
		});

		this.wrapperEl.addEventListener("touchmove", (e) => {
			if (!tracking) return;
			const touch = e.touches[0];
			if (!touch) return;
			const dy = Math.abs(touch.clientY - startY);
			const dx = touch.clientX - startX;
			if (dy > 30 && dy > dx) {
				tracking = false;
			}
		});

		this.wrapperEl.addEventListener("touchend", (e) => {
			if (!tracking) return;
			tracking = false;
			const touch = e.changedTouches[0];
			if (!touch) return;
			const dx = touch.clientX - startX;
			const dy = Math.abs(touch.clientY - startY);
			if (dx > 80 && dx > dy * 2) {
				this.navigateToParent();
			}
		});
	}

	// --- Rendering ---

	private renderHeader() {
		this.headerEl.empty();
		const isRoot = !this.currentFolder.parent;

		if (!isRoot) {
			const nav = this.headerEl.createDiv("mobile-explorer-nav");
			const backIcon = nav.createDiv("mobile-explorer-back-icon");
			setIcon(backIcon, "chevron-left");
			const backLabel = nav.createSpan("mobile-explorer-back-label");
			backLabel.textContent = this.currentFolder.parent?.parent
				? this.currentFolder.parent.name
				: this.app.vault.getName();
			nav.addEventListener("click", () => this.navigateToParent());
		}

		const titleRow = this.headerEl.createDiv("mobile-explorer-title-row");
		const title = titleRow.createDiv("mobile-explorer-title");
		title.textContent = isRoot
			? this.app.vault.getName()
			: this.currentFolder.name;

		const actions = titleRow.createDiv("mobile-explorer-actions");

		const newFolderBtn = actions.createDiv("mobile-explorer-action-btn");
		setIcon(newFolderBtn, "folder-plus");
		newFolderBtn.addEventListener("click", () => this.createNewFolder());

		const newNoteBtn = actions.createDiv("mobile-explorer-action-btn");
		setIcon(newNoteBtn, "square-pen");
		newNoteBtn.addEventListener("click", () => this.createNewNote());

		const children = this.currentFolder.children;
		const folders = children.filter((c) => c instanceof TFolder);
		const files = children.filter((c) => c instanceof TFile);
		const parts: string[] = [];
		if (folders.length > 0)
			parts.push(`${folders.length} folder${folders.length !== 1 ? "s" : ""}`);
		if (files.length > 0)
			parts.push(`${files.length} note${files.length !== 1 ? "s" : ""}`);
		if (parts.length > 0) {
			const subtitle = this.headerEl.createDiv("mobile-explorer-subtitle");
			subtitle.textContent = parts.join(", ");
		}
	}

	private formatDate(ts: number): string {
		const d = new Date(ts);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffDays === 0) {
			return d.toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
			});
		}
		if (diffDays === 1) return "Yesterday";
		if (diffDays < 7) {
			return d.toLocaleDateString(undefined, { weekday: "long" });
		}
		return d.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
		});
	}

	private renderList(restorePath?: string) {
		this.listEl.empty();
		const children = this.getSortedChildren(this.currentFolder);

		if (children.length === 0) {
			const empty = this.listEl.createDiv("mobile-explorer-empty");
			empty.textContent = "No items";
			return;
		}

		const folders = children.filter((c) => c instanceof TFolder) as TFolder[];
		const files = children.filter((c) => c instanceof TFile) as TFile[];

		let restoreEl: HTMLElement | null = null;

		if (folders.length > 0) {
			const section = this.listEl.createDiv("mobile-explorer-section");
			if (files.length > 0) {
				section.createDiv({
					cls: "mobile-explorer-section-label",
					text: "Folders",
				});
			}
			const card = section.createDiv("mobile-explorer-section-card");
			for (const folder of folders) {
				const el = this.renderFolderItem(card, folder);
				if (restorePath && folder.path === restorePath) restoreEl = el;
			}
		}

		if (files.length > 0) {
			const section = this.listEl.createDiv("mobile-explorer-section");
			if (folders.length > 0) {
				section.createDiv({
					cls: "mobile-explorer-section-label",
					text: "Notes",
				});
			}
			const card = section.createDiv("mobile-explorer-section-card");
			for (const file of files) {
				const el = this.renderFileItem(card, file);
				if (restorePath && file.path === restorePath) restoreEl = el;
			}
		}

		if (restoreEl) {
			restoreEl.addClass("is-highlighted");
			restoreEl.scrollIntoView({ block: "center" });
			setTimeout(() => restoreEl?.removeClass("is-highlighted"), 1000);
		}
	}

	private renderFolderItem(container: HTMLElement, folder: TFolder): HTMLElement {
		const item = container.createDiv({
			cls: "mobile-explorer-item is-folder",
		});

		const icon = item.createDiv("mobile-explorer-item-icon");
		setIcon(icon, "folder");

		const content = item.createDiv("mobile-explorer-item-content");
		content.createDiv({ cls: "mobile-explorer-item-name", text: folder.name });

		const count = item.createDiv("mobile-explorer-item-count");
		count.textContent = String(folder.children.length);

		const chevron = item.createDiv("mobile-explorer-item-chevron");
		setIcon(chevron, "chevron-right");

		item.addEventListener("click", () => {
			if (this.longPressTriggered) {
				this.longPressTriggered = false;
				return;
			}
			this.enterFolder(folder);
		});

		this.addLongPress(item, folder);
		return item;
	}

	private renderFileItem(container: HTMLElement, file: TFile): HTMLElement {
		const item = container.createDiv({
			cls: "mobile-explorer-item is-file",
		});

		const icon = item.createDiv("mobile-explorer-item-icon");
		setIcon(icon, "file-text");

		const content = item.createDiv("mobile-explorer-item-content");
		content.createDiv({ cls: "mobile-explorer-item-name", text: file.basename });

		const metaParts: string[] = [];
		metaParts.push(this.formatDate(file.stat.mtime));
		const ext = file.extension;
		if (ext && ext !== "md") metaParts.push(ext.toUpperCase());
		content.createDiv({
			cls: "mobile-explorer-item-meta",
			text: metaParts.join("  ·  "),
		});

		item.addEventListener("click", () => {
			if (this.longPressTriggered) {
				this.longPressTriggered = false;
				return;
			}
			this.openFile(file);
		});

		this.addLongPress(item, file);
		return item;
	}

	// --- Long press / context menu ---

	private addLongPress(el: HTMLElement, file: TAbstractFile) {
		let timer: number | null = null;
		let pressX = 0;
		let pressY = 0;

		el.addEventListener(
			"touchstart",
			(e) => {
				const touch = e.touches[0];
				if (!touch) return;
				pressX = touch.clientX;
				pressY = touch.clientY;
				timer = window.setTimeout(() => {
					timer = null;
					this.longPressTriggered = true;
					this.showContextMenu(pressX, pressY, file);
				}, 500);
			},
			{ passive: true }
		);

		el.addEventListener("touchmove", (e) => {
			if (timer === null) return;
			const touch = e.touches[0];
			if (!touch) return;
			const dx = touch.clientX - pressX;
			const dy = touch.clientY - pressY;
			if (dx * dx + dy * dy > 100) {
				window.clearTimeout(timer);
				timer = null;
			}
		});

		el.addEventListener("touchend", () => {
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
		});
	}

	private showContextMenu(x: number, y: number, file: TAbstractFile) {
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Rename")
				.setIcon("pencil")
				.onClick(() => this.renameItem(file))
		);

		menu.addItem((item) =>
			item
				.setTitle("Delete")
				.setIcon("trash")
				.onClick(async () => {
					await this.app.fileManager.trashFile(file);
					new Notice(`Moved to trash: ${file.name}`);
				})
		);

		if (file instanceof TFile) {
			menu.addItem((item) =>
				item
					.setTitle("Open in new tab")
					.setIcon("file-plus")
					.onClick(() =>
						this.app.workspace.getLeaf("tab").openFile(file)
					)
			);
		}

		menu.showAtPosition({ x, y });
	}

	// --- File operations ---

	private async createNewNote() {
		const path = this.getUniquePath(
			this.currentFolder.path,
			"Untitled",
			false
		);
		const file = await this.app.vault.create(path, "");
		this.openFile(file);
	}

	private async createNewFolder() {
		const path = this.getUniquePath(
			this.currentFolder.path,
			"New folder",
			true
		);
		await this.app.vault.createFolder(path);
	}

	private renameItem(file: TAbstractFile) {
		new RenameModal(this.app, file, async (newName) => {
			const isFolder = file instanceof TFolder;
			const ext = isFolder ? "" : "." + (file as TFile).extension;
			const parentPath = file.parent?.path ?? "";
			const newPath = parentPath
				? `${parentPath}/${newName}${ext}`
				: `${newName}${ext}`;
			try {
				await this.app.fileManager.renameFile(file, newPath);
			} catch (e) {
				new Notice(`Rename failed: ${e}`);
			}
		}).open();
	}

	private getUniquePath(
		parentPath: string,
		baseName: string,
		isFolder: boolean
	): string {
		const ext = isFolder ? "" : ".md";
		let name = `${baseName}${ext}`;
		let fullPath = parentPath ? `${parentPath}/${name}` : name;
		let counter = 0;

		while (this.app.vault.getAbstractFileByPath(fullPath)) {
			counter++;
			name = `${baseName} ${counter}${ext}`;
			fullPath = parentPath ? `${parentPath}/${name}` : name;
		}

		return fullPath;
	}

	private getSortedChildren(folder: TFolder): TAbstractFile[] {
		return [...folder.children].sort((a, b) => {
			const aIsFolder = a instanceof TFolder;
			const bIsFolder = b instanceof TFolder;
			if (aIsFolder && !bIsFolder) return -1;
			if (!aIsFolder && bIsFolder) return 1;
			return a.name.localeCompare(b.name);
		});
	}
}

class RenameModal extends Modal {
	private file: TAbstractFile;
	private onSubmit: (newName: string) => void;

	constructor(
		app: App,
		file: TAbstractFile,
		onSubmit: (newName: string) => void
	) {
		super(app);
		this.file = file;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		const isFolder = this.file instanceof TFolder;
		const currentName = isFolder
			? this.file.name
			: (this.file as TFile).basename;

		contentEl.createEl("h3", {
			text: `Rename ${isFolder ? "folder" : "file"}`,
		});

		const input = new TextComponent(contentEl);
		input.setValue(currentName);
		input.inputEl.addClass("mobile-explorer-rename-input");
		input.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				const val = input.getValue().trim();
				if (val && val !== currentName) this.onSubmit(val);
				this.close();
			}
		});

		const btnRow = contentEl.createDiv("modal-button-container");
		const submitBtn = btnRow.createEl("button", {
			text: "Rename",
			cls: "mod-cta",
		});
		submitBtn.addEventListener("click", () => {
			const val = input.getValue().trim();
			if (val && val !== currentName) this.onSubmit(val);
			this.close();
		});

		setTimeout(() => {
			input.inputEl.focus();
			input.inputEl.select();
		}, 50);
	}

	onClose() {
		this.contentEl.empty();
	}
}
