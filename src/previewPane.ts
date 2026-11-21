import { EventRef, TFile, WorkspaceLeaf } from "obsidian";
import { getActiveLeaf } from "./activeLeaf";
import { EmbeddedView, spawnLeafView } from "./leafView";
import type FloatSearchPlugin from "./floatSearchIndex";

/**
 * An embedded, pinned leaf used to preview search results inside the
 * float search modal, the quick search (CMDK) modal and native search views.
 */
export class PreviewPane {
	readonly el: HTMLElement;
	/** Identifies the result currently shown (see ResolvedResult.key). */
	key: string | null = null;

	private leaf: WorkspaceLeaf | null = null;
	private embeddedView: EmbeddedView | null = null;
	private destroyed = false;
	private readonly activeLeafRef: EventRef;

	constructor(
		private readonly plugin: FloatSearchPlugin,
		parentEl: HTMLElement,
		cls: string
	) {
		this.el = parentEl.createDiv({ cls });
		// Mark the pane while its leaf has focus (see .is-active in styles.css).
		this.activeLeafRef = plugin.app.workspace.on("active-leaf-change", (leaf) => {
			if (!this.destroyed) this.el.toggleClass("is-active", !!leaf && leaf === this.leaf);
		});
	}

	get isDestroyed() {
		return this.destroyed;
	}

	get fileLeaf() {
		return this.leaf;
	}

	contains(node: Node | null | undefined): boolean {
		return !!node && this.el.contains(node);
	}

	/** Returns false when the pane was destroyed while the file was loading. */
	async open(
		file: TFile,
		eState?: Record<string, unknown>,
		key?: string
	): Promise<boolean> {
		if (this.destroyed) return false;
		if (!this.leaf) {
			const { workspace } = this.plugin.app;
			const previouslyActive = getActiveLeaf(workspace);
			const [leaf, view] = spawnLeafView(this.plugin, this.el);
			leaf.setPinned(true);
			this.leaf = leaf;
			this.embeddedView = view;
			// Creating the leaf made it active, which takes keyboard handling
			// away from the search view that owns this preview.
			if (previouslyActive && getActiveLeaf(workspace) !== previouslyActive) {
				workspace.setActiveLeaf(previouslyActive, { focus: false });
			}
		}
		this.key = key ?? file.path;
		try {
			await this.leaf.openFile(file, { active: false, eState });
		} catch (error) {
			if (!this.destroyed) console.error("Float Search: failed to preview file", error);
			return false;
		}
		return !this.destroyed;
	}

	focus() {
		if (!this.leaf || this.destroyed) return;
		this.plugin.app.workspace.setActiveLeaf(this.leaf, { focus: true });
	}

	/** Toggle between reading and editing mode. */
	async toggleMode() {
		if (!this.leaf || this.destroyed) return;
		const viewState = this.leaf.getViewState();
		viewState.state = {
			...viewState.state,
			mode: viewState.state?.mode === "preview" ? "source" : "preview",
		};
		await this.leaf.setViewState(viewState);
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.plugin.app.workspace.offref(this.activeLeafRef);
		this.key = null;
		this.leaf?.detach();
		this.embeddedView?.unload();
		this.leaf = null;
		this.embeddedView = null;
		this.el.remove();
	}
}
