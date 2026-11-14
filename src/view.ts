import {
	ItemView,
	Menu,
	Notice,
	Platform,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from "obsidian";
import type MobileExplorerPlugin from "./main";

export const VIEW_TYPE = "mobile-explorer";

/** Whether `path` is `ancestor` itself or lies somewhere beneath it. */
export function isPathAtOrUnder(path: string, ancestor: string): boolean {
	return path === ancestor || path.startsWith(ancestor + "/");
}

// History entry marking the Recents view. NUL can never appear in a vault
// path, so it can't collide with a real folder.
const RECENTS_LOCATION = "\u0000recents";

interface DropZoneOptions {
	canDrop?: () => boolean;
	onDrop?: () => void;
	springNavigate?: () => void;
}

export class MobileExplorerView extends ItemView {
	private plugin: MobileExplorerPlugin;
	private currentFolder: TFolder;
	private folderHistory = new Map<string, string>();
	private headerEl!: HTMLElement;
	private wrapperEl!: HTMLElement;
	private listEl!: HTMLElement;
	private isAnimating = false;
	private longPressTriggered = false;
	private lastMenuOpenedAt = 0;
	private refreshTimer: number | null = null;
	// While an inline rename input is on screen, list re-renders are held
	// back so they don't replace the input mid-edit; the refresh runs once
	// the rename finishes. The input element is the source of truth: if a
	// swipe or navigation rebuilt the list underneath it, it is no longer
	// connected and the guard lifts on its own.
	private renameInput: HTMLInputElement | null = null;
	private refreshDeferred = false;

	private readonly isDesktop = Platform.isDesktop;
	private selectedPaths = new Set<string>();
	private itemEls = new Map<string, HTMLElement>();
	private draggedPaths: string[] = [];
	private springTimer: number | null = null;
	private activeDropEl: HTMLElement | null = null;
	private dropZones = new WeakMap<HTMLElement, DropZoneOptions>();
	private touchGhostEl: HTMLElement | null = null;
	private touchScrollTimer: number | null = null;
	private touchScrollSpeed = 0;
	private showingRecents = false;
	private navBackStack: string[] = [];
	private navForwardStack: string[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: MobileExplorerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.currentFolder = this.home;
	}

	/** The folder this device treats as the top of the explorer. */
	private get home(): TFolder {
		return this.plugin.getHomeFolder();
	}

	private isHome(folder: TFolder): boolean {
		return folder.path === this.home.path;
	}

	/**
	 * The folder the back button / swipe-back leads to, or null when there
	 * is nowhere to go up to. Navigation stops at the home folder (and at
	 * the vault root for folders outside the home subtree).
	 */
	private parentForNav(): TFolder | null {
		if (this.isHome(this.currentFolder)) return null;
		return this.currentFolder.parent;
	}

	/** Display name for a folder: the vault name for the root. */
	private locationName(folder: TFolder): string {
		return folder.isRoot() ? this.app.vault.getName() : folder.name;
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

		// Dropping on the list background (not on a folder row) moves the
		// dragged items into the folder currently being viewed.
		this.setupDropZone(this.wrapperEl, {
			canDrop: () =>
				!this.showingRecents &&
				this.canDropInto(this.currentFolder) &&
				this.draggedPaths.some(
					(p) =>
						this.app.vault.getAbstractFileByPath(p)?.parent?.path !==
						this.currentFolder.path
				),
			onDrop: () =>
				void this.moveItemsToFolder(this.draggedPaths, this.currentFolder),
		});

		this.registerVaultEvents();
		this.setupSwipeBack();
		this.setupMouseNav();

		// The vault index may still be loading when a restored leaf opens
		// (notably on mobile); resolving home before then falls back to the
		// vault root. Wait for the index so the configured home is honoured.
		this.app.workspace.onLayoutReady(() => {
			const active = this.app.workspace.getActiveFile();
			if (active?.parent) {
				this.setFolder(active.parent, active.path);
			} else {
				this.setFolder(this.home);
			}
		});
	}

	async onClose() {
		this.cancelPendingRefresh();
		if (this.touchGhostEl) this.endTouchDrag(false);
	}

	revealFile(file: TFile) {
		if (file.parent) {
			this.setFolder(file.parent, file.path);
		}
	}

	onSettingsChanged() {
		this.renderHeader();
	}

	/**
	 * The device's home folder changed. Jump to the new home, or, when home
	 * merely moved or appeared/disappeared, redraw in place. The list only
	 * depends on home for its Recents entry, so that redraw goes through the
	 * debounce and coalesces with the refresh the vault event itself causes.
	 */
	onHomeChanged(navigate: boolean) {
		if (navigate) {
			this.setFolder(this.home);
		} else {
			this.renderHeader();
			this.debouncedRefresh();
		}
	}

	// --- Vault events ---

	private registerVaultEvents() {
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (this.isPathInCurrentFolder(file.path)) this.debouncedRefresh();
				else this.updateSubfolderCount(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				// If the current folder (or one of its ancestors) was deleted,
				// fall back to home so we're not showing a defunct folder.
				if (this.isCurrentFolderAtOrUnder(file.path)) {
					this.setFolder(this.home);
					return;
				}
				// Note: Obsidian nulls file.parent before firing "delete", so the
				// parent must be derived from the path rather than file.parent.
				if (this.isPathInCurrentFolder(file.path)) this.debouncedRefresh();
				else this.updateSubfolderCount(file.path);
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
					this.isPathInCurrentFolder(file.path) ||
					this.isPathInCurrentFolder(oldPath)
				) {
					this.debouncedRefresh();
				} else {
					this.updateSubfolderCount(oldPath);
					this.updateSubfolderCount(file.path);
				}
			})
		);
	}

	private parentPathOf(path: string): string {
		const lastSlash = path.lastIndexOf("/");
		return lastSlash === -1 ? "/" : path.substring(0, lastSlash);
	}

	private isPathInCurrentFolder(path: string): boolean {
		return this.parentPathOf(path) === this.currentFolder.path;
	}

	/**
	 * Keep a subfolder row's item count current when something is added to
	 * or removed from that subfolder (e.g. by sync). Changes directly in the
	 * current folder are covered by the full refresh instead.
	 */
	private updateSubfolderCount(path: string) {
		const folderPath = this.parentPathOf(path);
		if (!this.isPathInCurrentFolder(folderPath)) return;
		const el = this.itemEls.get(folderPath);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!el || !(folder instanceof TFolder)) return;
		const countEl = el.querySelector(".mobile-explorer-item-count");
		if (countEl) countEl.textContent = String(folder.children.length);
	}

	private isCurrentFolderAtOrUnder(path: string): boolean {
		return isPathAtOrUnder(this.currentFolder.path, path);
	}

	private cancelPendingRefresh() {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	/** True while an inline rename input is live in the list. */
	private isRenaming(): boolean {
		if (this.renameInput === null) return false;
		if (this.renameInput.isConnected) return true;
		// The input was torn down by a re-render that bypassed the rename's
		// own finish (swipe-back, delete handler, history navigation). The
		// list was rebuilt anyway, so no refresh is owed.
		this.renameInput = null;
		this.refreshDeferred = false;
		return false;
	}

	private debouncedRefresh() {
		if (this.isRenaming()) {
			this.refreshDeferred = true;
			return;
		}
		this.cancelPendingRefresh();
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.renderList();
		}, 100);
	}

	// --- Navigation ---

	private setFolder(folder: TFolder, restorePath?: string) {
		if (this.showingRecents || folder.path !== this.currentFolder.path) {
			this.recordHistory();
		}
		this.showingRecents = false;
		this.selectedPaths.clear();
		this.currentFolder = folder;
		this.renderHeader();
		this.renderList(restorePath);
	}

	/** The current location as a history entry. */
	private currentLocation(): string {
		return this.showingRecents ? RECENTS_LOCATION : this.currentFolder.path;
	}

	private recordHistory() {
		this.navBackStack.push(this.currentLocation());
		if (this.navBackStack.length > 100) this.navBackStack.shift();
		this.navForwardStack.length = 0;
	}

	private navigateToParent() {
		if (this.isAnimating) return;
		if (this.showingRecents) {
			this.animateTransition("back", () => {
				this.recordHistory();
				this.showingRecents = false;
				this.renderHeader();
				this.renderList();
			});
			return;
		}
		const parent = this.parentForNav();
		if (!parent) return;
		const returnTo = this.currentFolder.path;
		this.animateTransition("back", () => {
			this.setFolder(parent, returnTo);
		});
	}

	private enterFolder(folder: TFolder) {
		if (this.isAnimating) return;
		this.animateTransition("forward", () => {
			this.setFolder(folder);
		});
	}

	private openFile(file: TFile) {
		void this.app.workspace.getLeaf(false).openFile(file);
	}

	// --- Mouse back/forward buttons ---

	private setupMouseNav() {
		const isNavButton = (e: MouseEvent) => e.button === 3 || e.button === 4;
		// Capture phase + stopPropagation so Obsidian's own note-history
		// handling of these buttons doesn't also fire while the pointer is
		// over the explorer.
		this.registerDomEvent(
			this.containerEl,
			"mousedown",
			(e) => {
				if (!isNavButton(e)) return;
				e.preventDefault();
				e.stopPropagation();
			},
			{ capture: true }
		);
		this.registerDomEvent(
			this.containerEl,
			"mouseup",
			(e) => {
				if (!isNavButton(e)) return;
				e.preventDefault();
				e.stopPropagation();
				if (e.button === 3) this.goBack();
				else this.goForward();
			},
			{ capture: true }
		);
	}

	private goBack() {
		if (this.isAnimating) return;
		while (this.navBackStack.length > 0) {
			const target = this.resolveLocation(this.navBackStack.pop()!);
			if (!target) continue; // deleted or renamed since it was visited
			this.navForwardStack.push(this.currentLocation());
			this.applyLocation(target, "back");
			return;
		}
		// No history to return to — fall back to going up a level.
		this.navigateToParent();
	}

	private goForward() {
		if (this.isAnimating) return;
		while (this.navForwardStack.length > 0) {
			const target = this.resolveLocation(this.navForwardStack.pop()!);
			if (!target) continue;
			this.navBackStack.push(this.currentLocation());
			this.applyLocation(target, "forward");
			return;
		}
	}

	private resolveLocation(entry: string): TFolder | "recents" | null {
		if (entry === RECENTS_LOCATION) return "recents";
		const f = this.app.vault.getAbstractFileByPath(entry);
		return f instanceof TFolder ? f : null;
	}

	/** Navigate to a history entry without recording it as a new step. */
	private applyLocation(target: TFolder | "recents", direction: "forward" | "back") {
		const cameFrom = this.showingRecents ? undefined : this.currentFolder.path;
		this.animateTransition(direction, () => {
			this.selectedPaths.clear();
			if (target === "recents") {
				this.showingRecents = true;
			} else {
				this.showingRecents = false;
				this.currentFolder = target;
			}
			this.renderHeader();
			this.renderList(direction === "back" ? cameFrom : undefined);
		});
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
			newList.setCssStyles({ transform: "translateX(100%)", opacity: "1" });
		} else {
			newList.setCssStyles({ transform: "translateX(-30%)", opacity: "0.3" });
		}

		this.listEl = newList;
		update();

		void newList.offsetHeight;

		if (direction === "forward") {
			oldList.setCssStyles({ transform: "translateX(-30%)", opacity: "0" });
		} else {
			oldList.setCssStyles({ transform: "translateX(100%)", opacity: "0" });
		}

		newList.setCssStyles({ transform: "translateX(0)", opacity: "1" });

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
		window.setTimeout(safeCleanup, 350);
	}

	// --- Swipe back gesture ---

	private setupSwipeBack() {
		let startX = 0;
		let startY = 0;
		let tracking = false;
		let axis: "none" | "horizontal" | "vertical" = "none";
		let prevList: HTMLElement | null = null;
		let width = 1;

		this.wrapperEl.addEventListener("touchstart", (e) => {
			if (!this.parentForNav() || this.isAnimating) {
				tracking = false;
				return;
			}
			const touch = e.touches[0];
			if (!touch) return;
			startX = touch.clientX;
			startY = touch.clientY;
			axis = "none";
			tracking = true;
		});

		this.wrapperEl.addEventListener(
			"touchmove",
			(e) => {
				if (!tracking) return;
				const touch = e.touches[0];
				if (!touch) return;
				const dx = touch.clientX - startX;
				const dy = touch.clientY - startY;

				if (axis === "none" && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
					axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
				}
				if (axis !== "horizontal") return;

				const parent = this.parentForNav();
				if (!parent) return;

				// Engage only on a rightward drag; a leftward horizontal swipe is
				// left to Obsidian (e.g. closing the sidebar).
				if (!prevList) {
					if (dx <= 0) return;
					width = this.wrapperEl.clientWidth || 1;
					prevList = this.wrapperEl.createDiv("mobile-explorer-list");
					this.wrapperEl.insertBefore(prevList, this.listEl);
					this.renderFolderInto(prevList, parent, this.currentFolder.path);
					prevList.setCssStyles({ transition: "none" });
					this.listEl.setCssStyles({ transition: "none" });
				}

				// Claim the gesture so it drags the view instead of scrolling
				// the list or triggering Obsidian's panel gestures.
				e.preventDefault();
				e.stopPropagation();

				const offset = Math.max(0, Math.min(dx, width));
				const progress = offset / width;
				this.listEl.setCssStyles({ transform: `translateX(${offset}px)` });
				prevList.setCssStyles({
					transform: `translateX(${-30 * (1 - progress)}%)`,
					opacity: String(0.3 + 0.7 * progress),
				});
			},
			{ passive: false }
		);

		this.wrapperEl.addEventListener("touchend", (e) => {
			tracking = false;
			if (!prevList) return;

			const incoming = prevList;
			prevList = null;
			const outgoing = this.listEl;
			const parent = this.parentForNav();

			const touch = e.changedTouches[0];
			const dx = touch ? touch.clientX - startX : 0;
			const complete = !!parent && dx > width * 0.4;

			this.isAnimating = true;
			const settle =
				"transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.3s ease";
			outgoing.setCssStyles({ transition: settle });
			incoming.setCssStyles({ transition: settle });

			if (complete && parent) {
				outgoing.setCssStyles({ transform: "translateX(100%)", opacity: "0" });
				incoming.setCssStyles({ transform: "translateX(0)", opacity: "1" });
				this.onSettle(incoming, () => {
					outgoing.remove();
					incoming.setCssStyles({ transition: "" });
					this.listEl = incoming;
					this.recordHistory();
					this.currentFolder = parent;
					this.renderHeader();
					this.isAnimating = false;
				});
			} else {
				outgoing.setCssStyles({ transform: "translateX(0)", opacity: "1" });
				incoming.setCssStyles({ transform: "translateX(-30%)", opacity: "0" });
				this.onSettle(outgoing, () => {
					incoming.remove();
					outgoing.setCssStyles({ transition: "" });
					this.isAnimating = false;
				});
			}
		});
	}

	private onSettle(el: HTMLElement, cb: () => void) {
		let done = false;
		const fire = () => {
			if (done) return;
			done = true;
			cb();
		};
		el.addEventListener("transitionend", fire, { once: true });
		window.setTimeout(fire, 350);
	}

	// --- Rendering ---

	private renderHeader() {
		this.headerEl.empty();
		// Leaving Recents returns to the folder it was opened from.
		const backTarget = this.showingRecents
			? this.currentFolder
			: this.parentForNav();

		if (backTarget) {
			const nav = this.headerEl.createDiv("mobile-explorer-nav");
			const backIcon = nav.createDiv("mobile-explorer-back-icon");
			setIcon(backIcon, "chevron-left");
			const backLabel = nav.createSpan("mobile-explorer-back-label");
			backLabel.textContent = this.locationName(backTarget);
			nav.addEventListener("click", () => this.navigateToParent());
			this.setupDropZone(nav, {
				springNavigate: () => this.navigateToParent(),
			});
		}

		const titleRow = this.headerEl.createDiv("mobile-explorer-title-row");
		const title = titleRow.createDiv("mobile-explorer-title");
		if (this.showingRecents) {
			title.textContent = "Recents";
		} else {
			title.textContent = this.locationName(this.currentFolder);
		}

		const shortcuts = titleRow.createDiv("mobile-explorer-shortcuts");
		this.renderShortcutButtons(shortcuts);

		const actions = titleRow.createDiv("mobile-explorer-actions");

		const newFolderBtn = actions.createDiv("mobile-explorer-action-btn");
		setIcon(newFolderBtn, "folder-plus");
		newFolderBtn.addEventListener("click", () =>
			void this.createNewFolder(this.currentFolder)
		);

		const newNoteBtn = actions.createDiv("mobile-explorer-action-btn");
		setIcon(newNoteBtn, "square-pen");
		newNoteBtn.addEventListener("click", () => void this.createNewNote());

		if (this.showingRecents) {
			const allFiles = this.getAllVaultFiles();
			const subtitle = this.headerEl.createDiv("mobile-explorer-subtitle");
			subtitle.textContent = `${allFiles.length} note${allFiles.length !== 1 ? "s" : ""}`;
		} else {
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
	}

	private renderShortcutButtons(container: HTMLElement) {
		if (!this.isHome(this.currentFolder)) {
			const homeBtn = container.createDiv("mobile-explorer-action-btn");
			setIcon(homeBtn, "house");
			if (this.isDesktop) {
				setTooltip(homeBtn, this.locationName(this.home), {
					placement: "bottom",
				});
			}
			homeBtn.addEventListener("click", () => this.setFolder(this.home));
		}

		for (const shortcut of this.plugin.settings.shortcuts) {
			if (!shortcut.folder) continue;
			const folder = this.app.vault.getAbstractFileByPath(shortcut.folder);
			if (!(folder instanceof TFolder) || folder === this.currentFolder)
				continue;
			const btn = container.createDiv("mobile-explorer-action-btn");
			setIcon(btn, shortcut.icon || "folder-open");
			if (this.isDesktop) {
				setTooltip(btn, folder.name, { placement: "bottom" });
			}
			btn.addEventListener("click", () => this.setFolder(folder));
		}
	}

	// --- Recents ---

	private renderRecentsEntry(target: HTMLElement) {
		const allFiles = this.getAllVaultFiles();
		if (allFiles.length === 0) return;

		const section = target.createDiv("mobile-explorer-section");
		const card = section.createDiv("mobile-explorer-section-card");
		const item = card.createDiv({
			cls: "mobile-explorer-item is-folder",
		});
		const icon = item.createDiv("mobile-explorer-item-icon");
		setIcon(icon, "clock");
		item.createDiv("mobile-explorer-item-content").createDiv({
			cls: "mobile-explorer-item-name",
			text: "Recents",
		});
		const count = item.createDiv("mobile-explorer-item-count");
		count.textContent = String(allFiles.length);
		const chevron = item.createDiv("mobile-explorer-item-chevron");
		setIcon(chevron, "chevron-right");
		item.addEventListener("click", () => {
			if (this.isAnimating) return;
			this.animateTransition("forward", () => {
				this.recordHistory();
				this.showingRecents = true;
				this.renderHeader();
				this.renderList();
			});
		});
	}

	/** Every file under the home folder, most recently modified first. */
	private getAllVaultFiles(): TFile[] {
		const files: TFile[] = [];
		const collect = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFile) files.push(child);
				else if (child instanceof TFolder) collect(child);
			}
		};
		collect(this.home);
		return files.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	private renderRecentsInto(target: HTMLElement) {
		target.empty();
		const files = this.getAllVaultFiles();

		if (files.length === 0) {
			target.createDiv({
				cls: "mobile-explorer-empty",
				text: "No notes",
			});
			return;
		}

		const groups = this.groupByTimePeriod(files);
		for (const group of groups) {
			const section = target.createDiv("mobile-explorer-section");
			section.createDiv({
				cls: "mobile-explorer-section-label mobile-explorer-time-group",
				text: group.label,
			});
			const card = section.createDiv("mobile-explorer-section-card");
			for (const file of group.files) {
				this.renderRecentFileItem(card, file);
			}
		}
	}

	private renderRecentFileItem(container: HTMLElement, file: TFile) {
		const item = container.createDiv({
			cls: "mobile-explorer-item is-file",
		});
		const content = item.createDiv("mobile-explorer-item-content");
		content.createDiv({
			cls: "mobile-explorer-item-name",
			text: file.basename,
		});

		const metaParts: string[] = [];
		metaParts.push(this.formatDate(file.stat.mtime));
		if (file.parent) metaParts.push(this.locationName(file.parent));
		content.createDiv({
			cls: "mobile-explorer-item-meta",
			text: metaParts.join("  ·  "),
		});

		item.addEventListener("click", () => this.openFile(file));
		this.addContextMenu(item, file);
	}

	private groupByTimePeriod(
		files: TFile[]
	): { label: string; files: TFile[] }[] {
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const yesterday = new Date(today.getTime() - 86400000);
		const weekAgo = new Date(today.getTime() - 7 * 86400000);
		const monthAgo = new Date(today.getTime() - 30 * 86400000);

		const groups: Map<string, { label: string; files: TFile[] }> = new Map();

		const addToGroup = (key: string, label: string, file: TFile) => {
			let group = groups.get(key);
			if (!group) {
				group = { label, files: [] };
				groups.set(key, group);
			}
			group.files.push(file);
		};

		for (const file of files) {
			const d = new Date(file.stat.mtime);
			if (d >= today) {
				addToGroup("today", "Today", file);
			} else if (d >= yesterday) {
				addToGroup("yesterday", "Yesterday", file);
			} else if (d >= weekAgo) {
				addToGroup("week", "Previous 7 Days", file);
			} else if (d >= monthAgo) {
				addToGroup("month", "Previous 30 Days", file);
			} else if (d.getFullYear() === now.getFullYear()) {
				const monthName = d.toLocaleDateString(undefined, {
					month: "long",
				});
				addToGroup(`month-${d.getMonth()}`, monthName, file);
			} else {
				addToGroup(`year-${d.getFullYear()}`, String(d.getFullYear()), file);
			}
		}

		return [...groups.values()];
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

	private formatFullDateTime(ts: number): string {
		const d = new Date(ts);
		const pad = (n: number) => String(n).padStart(2, "0");
		return (
			`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
			`${pad(d.getHours())}:${pad(d.getMinutes())}`
		);
	}

	private renderList(restorePath?: string) {
		if (this.showingRecents) {
			this.renderRecentsInto(this.listEl);
		} else {
			this.renderFolderInto(this.listEl, this.currentFolder, restorePath);
		}
	}

	private renderFolderInto(
		target: HTMLElement,
		folder: TFolder,
		restorePath?: string
	) {
		target.empty();
		// Track item elements only for the live list so selection/drag classes
		// can be updated without a full re-render. Transient lists (swipe,
		// animation) are excluded.
		const track = target === this.listEl;
		if (track) this.itemEls.clear();
		const children = this.getSortedChildren(folder);

		if (children.length === 0) {
			const empty = target.createDiv("mobile-explorer-empty");
			empty.textContent = "No items";
			return;
		}

		const folders = children.filter((c) => c instanceof TFolder);
		const files = children.filter((c) => c instanceof TFile);

		let restoreEl: HTMLElement | null = null;

		if (this.isHome(folder)) {
			this.renderRecentsEntry(target);
		}

		if (folders.length > 0) {
			const section = target.createDiv("mobile-explorer-section");
			if (files.length > 0) {
				section.createDiv({
					cls: "mobile-explorer-section-label",
					text: "Folders",
				});
			}
			const card = section.createDiv("mobile-explorer-section-card");
			for (const folder of folders) {
				const el = this.renderFolderItem(card, folder);
				if (track) this.itemEls.set(folder.path, el);
				if (restorePath && folder.path === restorePath) restoreEl = el;
			}
		}

		if (files.length > 0) {
			const section = target.createDiv("mobile-explorer-section");
			if (folders.length > 0) {
				section.createDiv({
					cls: "mobile-explorer-section-label",
					text: "Notes",
				});
			}
			const card = section.createDiv("mobile-explorer-section-card");
			for (const file of files) {
				const el = this.renderFileItem(card, file);
				if (track) this.itemEls.set(file.path, el);
				if (restorePath && file.path === restorePath) restoreEl = el;
			}
		}

		if (restoreEl) {
			restoreEl.addClass("is-highlighted");
			restoreEl.scrollIntoView({ block: "center" });
			window.setTimeout(() => restoreEl?.removeClass("is-highlighted"), 1000);
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

		item.addEventListener("click", (e) => {
			if (this.longPressTriggered) {
				this.longPressTriggered = false;
				return;
			}
			if (this.isDesktop && (e.metaKey || e.ctrlKey)) {
				this.toggleSelection(folder);
				return;
			}
			if (this.selectedPaths.size > 0) this.clearSelection();
			this.enterFolder(folder);
		});

		if (this.selectedPaths.has(folder.path)) item.addClass("is-selected");
		this.setupDragSource(item, folder);
		this.setupDropZone(item, {
			canDrop: () => this.canDropInto(folder),
			onDrop: () => void this.moveItemsToFolder(this.draggedPaths, folder),
			springNavigate: () => this.enterFolder(folder),
		});

		this.addContextMenu(item, folder, true);
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

		if (this.isDesktop) {
			setTooltip(
				item,
				`Last modified at ${this.formatFullDateTime(file.stat.mtime)}\n` +
					`Created at ${this.formatFullDateTime(file.stat.ctime)}`,
				{ placement: "right" }
			);
		}
		if (this.selectedPaths.has(file.path)) item.addClass("is-selected");
		this.setupDragSource(item, file);

		item.addEventListener("click", (e) => {
			if (this.longPressTriggered) {
				this.longPressTriggered = false;
				return;
			}
			if (this.isDesktop && (e.metaKey || e.ctrlKey)) {
				this.toggleSelection(file);
				return;
			}
			if (this.selectedPaths.size > 0) this.clearSelection();
			this.openFile(file);
		});

		this.addContextMenu(item, file, true);
		return item;
	}

	// --- Context menu: right-click (desktop) and long-press (touch) ---

	// On touch devices a long-press opens the menu; if the finger then moves
	// without lifting, the menu is dismissed and the row is dragged instead
	// (when `canDrag` is set).
	private addContextMenu(el: HTMLElement, file: TAbstractFile, canDrag = false) {
		const open = (x: number, y: number): Menu | null => {
			// A long-press can also raise a native "contextmenu" event (Android);
			// make sure only one menu opens per gesture.
			const now = Date.now();
			if (now - this.lastMenuOpenedAt < 800) return null;
			this.lastMenuOpenedAt = now;

			// If the item is part of an active multi-selection, act on the whole
			// group. Opening the menu on anything else clears the selection.
			if (
				this.selectedPaths.size > 1 &&
				this.selectedPaths.has(file.path)
			) {
				return this.showSelectionMenu(x, y);
			}
			if (this.selectedPaths.size > 0) this.clearSelection();
			return this.showContextMenu(x, y, file);
		};

		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			open(e.clientX, e.clientY);
		});

		// iOS never fires "contextmenu" for a long-press, so detect it from
		// touch events.
		let state: "idle" | "pending" | "pressed" | "dragging" = "idle";
		let timer: number | null = null;
		let menu: Menu | null = null;
		let startX = 0;
		let startY = 0;
		const clearTimer = () => {
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
		};
		const movedFar = (touch: Touch) =>
			Math.abs(touch.clientX - startX) > 10 ||
			Math.abs(touch.clientY - startY) > 10;

		el.addEventListener(
			"touchstart",
			(e) => {
				clearTimer();
				if (state === "dragging") this.endTouchDrag(false);
				state = "idle";
				menu = null;
				this.longPressTriggered = false;
				if (e.touches.length !== 1) return;
				const touch = e.touches[0];
				if (!touch) return;
				startX = touch.clientX;
				startY = touch.clientY;
				state = "pending";
				timer = window.setTimeout(() => {
					timer = null;
					if (this.isAnimating || !el.isConnected) {
						state = "idle";
						return;
					}
					state = "pressed";
					// Swallow the click that follows when the finger lifts.
					this.longPressTriggered = true;
					menu = open(startX, startY);
				}, 500);
			},
			{ passive: true }
		);
		el.addEventListener(
			"touchmove",
			(e) => {
				const touch = e.touches[0];
				if (!touch) return;
				if (state === "pending") {
					// Moved before the hold completed: it's a scroll or swipe.
					if (movedFar(touch)) {
						clearTimer();
						state = "idle";
					}
					return;
				}
				if (state === "idle") return;

				// The hold completed: this gesture is ours, not a scroll or the
				// swipe-back gesture.
				if (e.cancelable) e.preventDefault();
				e.stopPropagation();
				if (state === "pressed") {
					if (!canDrag || !movedFar(touch)) return;
					menu?.hide();
					menu = null;
					state = "dragging";
					this.beginTouchDrag(file);
				}
				this.updateTouchDrag(touch.clientX, touch.clientY);
			},
			{ passive: false }
		);
		const finish = (drop: boolean) => (e: TouchEvent) => {
			clearTimer();
			if (state === "dragging") {
				e.stopPropagation();
				this.endTouchDrag(drop);
			}
			state = "idle";
		};
		el.addEventListener("touchend", finish(true));
		el.addEventListener("touchcancel", finish(false));
	}

	private showSelectionMenu(x: number, y: number): Menu {
		const items = this.getSelectedItems();
		const files = items.filter((f) => f instanceof TFile);
		const menu = new Menu();
		if (files.length > 0) {
			menu.addItem((item) =>
				item
					.setTitle(`Copy ${files.length} file${files.length !== 1 ? "s" : ""}`)
					.setIcon("lucide-files")
					.onClick(async () => {
						for (const f of files) await this.duplicateFile(f);
					})
			);
		}
		menu.addItem((item) =>
			item
				.setTitle(`Delete ${items.length} item${items.length !== 1 ? "s" : ""}`)
				.setIcon("lucide-trash-2")
				.setWarning(true)
				.onClick(async () => {
					for (const f of items) await this.app.fileManager.trashFile(f);
					this.clearSelection();
				})
		);
		menu.showAtPosition({ x, y });
		return menu;
	}

	private showContextMenu(x: number, y: number, file: TAbstractFile): Menu {
		const menu = new Menu();

		// The native file explorer adds core items (Open in new tab, Rename,
		// Delete, etc.) directly to the Menu *before* firing the "file-menu"
		// event.  The event only lets other plugins append their own items.
		// We must therefore add the core items ourselves.

		if (file instanceof TFile) {
			menu.addItem((item) =>
				item
					.setTitle("Open in new tab")
					.setIcon("lucide-file-plus")
					.setSection("open")
					.onClick(() => {
						void this.app.workspace.getLeaf("tab").openFile(file);
					})
			);
			if (this.isDesktop) {
				menu.addItem((item) =>
					item
						.setTitle("Open to the right")
						.setIcon("lucide-separator-vertical")
						.setSection("open")
						.onClick(() => {
							void this.app.workspace.getLeaf("split").openFile(file);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Open in new window")
						.setIcon("lucide-picture-in-picture-2")
						.setSection("open")
						.onClick(() => {
							void this.app.workspace.getLeaf("window").openFile(file);
						})
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Duplicate")
					.setIcon("lucide-files")
					.setSection("action")
					.onClick(() => void this.duplicateFile(file))
			);
		}

		if (file instanceof TFolder) {
			menu.addItem((item) =>
				item
					.setTitle("New note")
					.setIcon("lucide-edit")
					.setSection("action")
					.onClick(async () => {
						const path = this.getUniquePath(file.path, "Untitled", false);
						const newFile = await this.app.vault.create(path, "");
						void this.app.workspace.getLeaf(false).openFile(newFile);
					})
			);
			menu.addItem((item) =>
				item
					.setTitle("New folder")
					.setIcon("lucide-folder-plus")
					.setSection("action")
					.onClick(() => void this.createNewFolder(file))
			);
			menu.addSeparator();
		}

		menu.addItem((item) =>
			item
				.setTitle("Rename...")
				.setIcon("lucide-pencil")
				.setSection("danger")
				.onClick(() => {
					this.startInlineRename(file);
				})
		);
		menu.addItem((item) => {
			item
				.setTitle("Delete")
				.setIcon("lucide-trash-2")
				.setSection("danger")
				.setWarning(true)
				.onClick(() => {
					void this.app.fileManager.promptForDeletion(file);
				});
		});

		// Now let other plugins contribute their items (Copy path,
		// Open in default app, Reveal in Finder, Move file to...,
		// Bookmark, etc.)
		this.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu");

		menu.showAtPosition({ x, y });
		return menu;
	}

	private startInlineRename(file: TAbstractFile) {
		// One rename at a time: a second input would be destroyed when the
		// first one finishes and flushes its deferred refresh.
		if (this.isRenaming()) return;
		const el = this.itemEls.get(file.path);
		if (!el) return;
		const nameEl = el.querySelector<HTMLElement>(".mobile-explorer-item-name");
		if (!nameEl) return;

		const isFile = file instanceof TFile;
		const originalName = isFile ? file.basename : file.name;

		const input = activeDocument.createElement("input");
		input.type = "text";
		input.value = originalName;
		input.addClass("mobile-explorer-inline-rename");
		// Clicks inside the input must not activate the row (which would
		// navigate into a folder or open a note), text selection by mouse
		// must not start a row drag, and a long-press or right-click in the
		// input is for text editing, not the row's context menu.
		input.addEventListener("click", (e) => e.stopPropagation());
		input.addEventListener("dblclick", (e) => e.stopPropagation());
		input.addEventListener("contextmenu", (e) => e.stopPropagation());
		input.addEventListener("touchstart", (e) => e.stopPropagation(), {
			passive: true,
		});
		const wasDraggable = el.draggable;
		el.draggable = false;
		nameEl.replaceWith(input);
		input.focus();
		input.select();

		// A refresh that is already scheduled would rebuild the list and
		// destroy the input; hold it until the rename finishes instead.
		if (this.refreshTimer !== null) {
			this.cancelPendingRefresh();
			this.refreshDeferred = true;
		}
		this.renameInput = input;
		const finish = () => {
			el.draggable = wasDraggable;
			if (this.renameInput === input) this.renameInput = null;
			if (this.refreshDeferred) {
				this.refreshDeferred = false;
				this.debouncedRefresh();
			}
		};
		const revert = () => {
			input.replaceWith(nameEl);
			nameEl.textContent = originalName;
			finish();
		};

		let committed = false;
		const commit = async () => {
			if (committed) return;
			committed = true;

			const newName = input.value.trim();

			if (!newName || newName === originalName) {
				revert();
				return;
			}

			const parentPath = file.parent?.path ?? "/";
			const prefix =
				parentPath && parentPath !== "/" ? parentPath + "/" : "";
			const ext = isFile ? "." + file.extension : "";
			const newPath = `${prefix}${newName}${ext}`;

			try {
				await this.app.fileManager.renameFile(file, newPath);
				// Show the new name right away rather than waiting on the
				// rename event's refresh: in Recents the renamed file may not
				// be under the current folder, so that refresh never comes.
				input.replaceWith(nameEl);
				nameEl.textContent = newName;
				finish();
			} catch {
				new Notice(`Could not rename "${originalName}"`);
				revert();
			}
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void commit();
			} else if (e.key === "Escape") {
				committed = true;
				revert();
			}
		});
		input.addEventListener("blur", () => void commit());
	}

	private async duplicateFile(file: TFile) {
		const parent = file.parent ?? this.app.vault.getRoot();
		const basePath = parent.path
			? `${parent.path}/${file.basename}`
			: file.basename;
		// Find a unique name for the copy.
		let newPath = `${basePath} copy.${file.extension}`;
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(newPath)) {
			counter++;
			newPath = `${basePath} copy ${counter}.${file.extension}`;
		}
		await this.app.vault.copy(file, newPath);
	}

	// --- Multi-selection (desktop) ---

	private toggleSelection(file: TAbstractFile) {
		if (this.selectedPaths.has(file.path)) {
			this.selectedPaths.delete(file.path);
			this.itemEls.get(file.path)?.removeClass("is-selected");
		} else {
			this.selectedPaths.add(file.path);
			this.itemEls.get(file.path)?.addClass("is-selected");
		}
	}

	private clearSelection() {
		for (const path of this.selectedPaths) {
			this.itemEls.get(path)?.removeClass("is-selected");
		}
		this.selectedPaths.clear();
	}

	private getSelectedItems(): TAbstractFile[] {
		const items: TAbstractFile[] = [];
		for (const path of this.selectedPaths) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f) items.push(f);
		}
		return items;
	}

	// --- Drag & drop (native on desktop, touch-driven on mobile) ---

	private setupDragSource(item: HTMLElement, file: TAbstractFile) {
		// Touch platforms drag via the long-press gesture in addContextMenu; a
		// natively draggable row would hijack the long-press there.
		if (!this.isDesktop) return;
		item.draggable = true;
		item.addEventListener("dragstart", (e) => {
			const paths = this.beginDrag(file);
			e.dataTransfer?.setData("text/plain", paths.join("\n"));
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		});
		item.addEventListener("dragend", () => this.endDrag());
	}

	private beginDrag(file: TAbstractFile): string[] {
		let paths: string[];
		if (this.selectedPaths.has(file.path)) {
			paths = [...this.selectedPaths];
		} else {
			if (this.selectedPaths.size > 0) this.clearSelection();
			paths = [file.path];
		}
		this.draggedPaths = paths;
		for (const p of paths) this.itemEls.get(p)?.addClass("is-dragging");
		return paths;
	}

	private endDrag() {
		for (const p of this.draggedPaths) {
			this.itemEls.get(p)?.removeClass("is-dragging");
		}
		this.draggedPaths = [];
		this.clearSpringTimer();
		this.activeDropEl?.removeClass("is-drop-target");
		this.activeDropEl = null;
	}

	private beginTouchDrag(file: TAbstractFile) {
		const paths = this.beginDrag(file);
		const name = file instanceof TFile ? file.basename : file.name;
		this.touchGhostEl = activeDocument.body.createDiv({
			cls: "mobile-explorer-drag-ghost",
			text: paths.length > 1 ? `${paths.length} items` : name,
		});
	}

	private updateTouchDrag(x: number, y: number) {
		this.touchGhostEl?.setCssStyles({
			transform: `translate(${x}px, ${y}px) translate(-50%, -150%)`,
		});

		// Find the innermost drop zone under the finger that accepts the drag.
		let zone: HTMLElement | null = null;
		let node = activeDocument.elementFromPoint(x, y);
		while (node) {
			if (node.instanceOf(HTMLElement)) {
				const opts = this.dropZones.get(node);
				if (opts && (!opts.canDrop || opts.canDrop())) {
					zone = node;
					break;
				}
			}
			node = node.parentElement;
		}
		if (zone !== this.activeDropEl) {
			if (this.activeDropEl) this.leaveDropZone(this.activeDropEl);
			if (zone) this.enterDropZone(zone);
		}

		// Auto-scroll the list while the finger is near its top/bottom edge.
		const rect = this.listEl.getBoundingClientRect();
		const edge = 56;
		const speed =
			y < rect.top + edge ? -10 : y > rect.bottom - edge ? 10 : 0;
		if (speed === 0) {
			this.clearTouchScroll();
		} else if (this.touchScrollSpeed !== speed) {
			this.clearTouchScroll();
			this.touchScrollSpeed = speed;
			this.touchScrollTimer = window.setInterval(() => {
				this.listEl.scrollTop += speed;
			}, 16);
		}
	}

	private endTouchDrag(drop: boolean) {
		const zone = this.activeDropEl;
		if (drop && zone?.isConnected) this.dropZones.get(zone)?.onDrop?.();
		this.clearTouchScroll();
		this.touchGhostEl?.remove();
		this.touchGhostEl = null;
		this.endDrag();
	}

	private clearTouchScroll() {
		if (this.touchScrollTimer !== null) {
			window.clearInterval(this.touchScrollTimer);
			this.touchScrollTimer = null;
		}
		this.touchScrollSpeed = 0;
	}

	private enterDropZone(el: HTMLElement) {
		if (this.activeDropEl && this.activeDropEl !== el) {
			this.activeDropEl.removeClass("is-drop-target");
		}
		this.activeDropEl = el;
		el.addClass("is-drop-target");
		const opts = this.dropZones.get(el);
		if (opts?.springNavigate && this.springTimer === null) {
			this.springTimer = window.setTimeout(() => {
				this.springTimer = null;
				opts.springNavigate!();
			}, 700);
		}
	}

	private leaveDropZone(el: HTMLElement) {
		el.removeClass("is-drop-target");
		if (this.activeDropEl === el) this.activeDropEl = null;
		this.clearSpringTimer();
	}

	private setupDropZone(el: HTMLElement, opts: DropZoneOptions) {
		this.dropZones.set(el, opts);
		el.addEventListener("dragover", (e) => {
			if (this.draggedPaths.length === 0) return;
			if (opts.canDrop && !opts.canDrop()) return;
			e.preventDefault();
			// Innermost drop zone wins (folder rows over the list background).
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			this.enterDropZone(el);
		});
		el.addEventListener("dragleave", (e) => {
			if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))
				return;
			this.leaveDropZone(el);
		});
		if (opts.onDrop) {
			el.addEventListener("drop", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.leaveDropZone(el);
				opts.onDrop!();
			});
		}
	}

	private clearSpringTimer() {
		if (this.springTimer !== null) {
			window.clearTimeout(this.springTimer);
			this.springTimer = null;
		}
	}

	private canDropInto(target: TFolder): boolean {
		for (const path of this.draggedPaths) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFolder)) continue;
			if (target.path === f.path || target.path.startsWith(f.path + "/"))
				return false;
		}
		return true;
	}

	private async moveItemsToFolder(paths: string[], target: TFolder) {
		let moved = 0;
		for (const path of paths) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!f) continue;
			if (f.parent?.path === target.path) continue;
			if (
				f instanceof TFolder &&
				(target.path === f.path || target.path.startsWith(f.path + "/"))
			) {
				continue;
			}
			const newPath = target.path ? `${target.path}/${f.name}` : f.name;
			if (this.app.vault.getAbstractFileByPath(newPath)) {
				new Notice(
					`"${f.name}" already exists in ${target.name || "the vault root"}`
				);
				continue;
			}
			try {
				await this.app.fileManager.renameFile(f, newPath);
				moved++;
			} catch {
				new Notice(`Could not move "${f.name}"`);
			}
		}
		if (moved > 0) this.clearSelection();
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

	/**
	 * Create a folder inside `parent` and immediately put its row into inline
	 * rename mode, so the user can type the name without a second step.
	 */
	private async createNewFolder(parent: TFolder) {
		if (this.isAnimating || this.isRenaming()) return;
		const path = this.getUniquePath(parent.path, "New folder", true);
		const folder = await this.app.vault.createFolder(path);
		// A swipe may have started during the await; rendering into a list
		// that is mid-transition would corrupt navigation state.
		if (this.isAnimating) return;

		// Make sure the new row is on screen now rather than after the
		// debounced vault-event refresh. setFolder only records history when
		// the location actually changes, so when the parent is already the
		// folder being shown this is just a re-render.
		this.setFolder(parent, folder.path);
		this.startInlineRename(folder);
	}

	private getUniquePath(
		parentPath: string,
		baseName: string,
		isFolder: boolean
	): string {
		const prefix = parentPath && parentPath !== "/" ? parentPath + "/" : "";
		const ext = isFolder ? "" : ".md";
		let name = `${baseName}${ext}`;
		let fullPath = `${prefix}${name}`;
		let counter = 0;

		while (this.app.vault.getAbstractFileByPath(fullPath)) {
			counter++;
			name = `${baseName} ${counter}${ext}`;
			fullPath = `${prefix}${name}`;
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
