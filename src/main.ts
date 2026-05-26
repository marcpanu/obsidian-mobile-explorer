import { Plugin } from "obsidian";
import { MobileExplorerView, VIEW_TYPE } from "./view";

export default class MobileExplorerPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf) => new MobileExplorerView(leaf));

		this.addCommand({
			id: "open-mobile-explorer",
			name: "Open mobile explorer",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "reveal-active-file",
			name: "Reveal active file in mobile explorer",
			callback: () => this.revealActiveFile(),
		});

		this.app.workspace.onLayoutReady(() => this.activateView());
	}

	private async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	private revealActiveFile() {
		const file = this.app.workspace.getActiveFile();
		if (!file?.parent) return;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length > 0) {
			const view = leaves[0].view as MobileExplorerView;
			view.revealFile(file);
			this.app.workspace.revealLeaf(leaves[0]);
		}
	}
}
