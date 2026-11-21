// Original code from https://github.com/nothingislost/obsidian-hover-editor/blob/9ec3449be9ab3433dc46c4c3acfde1da72ff0261/src/popover.ts
// You can use this file as a basic leaf view create method in anywhere
// Please rememeber if you want to use this file, you should patch the types-obsidian.d.ts file
// And also monkey around the Obsidian original method.
import {
	Component,
	HoverPopover,
	PopoverState,
	View,
	Workspace,
	WorkspaceContainer,
	WorkspaceLeaf,
	WorkspaceSplit,
	WorkspaceTabs,
} from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import { getActiveLeaf } from "./activeLeaf";


export interface EmbeddedViewParent {
	hoverPopover: EmbeddedView | null;
	containerEl?: HTMLElement;
	view?: View;
	dom?: HTMLElement;
}

const popovers = new WeakMap<Element, EmbeddedView>();
type ConstructableWorkspaceSplit = new (ws: Workspace, dir: "horizontal" | "vertical") => WorkspaceSplit;
type Constructor<T> = (new (...args: unknown[]) => T) & { prototype: T };

export function isEmebeddedLeaf(leaf: WorkspaceLeaf) {
	// Work around missing enhance.js API by checking match condition instead of looking up parent
	return leaf.containerEl.matches(".fs-block.fs-leaf-view .workspace-leaf");
}

function genId(size: number): string {
	const chars = [];
	for (let n = 0; n < size; n++) chars.push(((16 * Math.random()) | 0).toString(16));
	return chars.join("");
}

function nosuper<T extends object>(base: Constructor<T>): new () => T {
	const derived = function () {
		return Object.setPrototypeOf(new Component(), (new.target as { prototype: object }).prototype) as T;
	};
	derived.prototype = base.prototype;
	return Object.setPrototypeOf(derived, base) as new () => T;
}

export const spawnLeafView = (plugin: FloatSearchPlugin, initiatingEl?: HTMLElement, leaf?: WorkspaceLeaf, onShowCallback?: () => unknown): [WorkspaceLeaf, EmbeddedView] => {
	// When Obsidian doesn't set any leaf active, use leaf instead.
	let parent = getActiveLeaf(plugin.app.workspace) as unknown as EmbeddedViewParent;
	if (!parent) parent = leaf as unknown as EmbeddedViewParent;

	if (!initiatingEl) initiatingEl = parent?.containerEl;

	const hoverPopover = new EmbeddedView(parent, initiatingEl!, plugin, undefined, onShowCallback);
	return [hoverPopover.attachLeaf(), hoverPopover];

};

export class EmbeddedView extends nosuper(HoverPopover) {
	onTarget: boolean;
	setActive: (event: MouseEvent) => void;

	lockedOut: boolean;
	abortController? = this.addChild(new Component());
	detaching = false;
	opening = false;

	rootSplit: WorkspaceSplit = new (WorkspaceSplit as ConstructableWorkspaceSplit)(this.plugin.app.workspace, "vertical");

	isPinned = true;

	titleEl: HTMLElement;
	containerEl: HTMLElement;

	// It is currently not useful.
	// leafInHoverEl: WorkspaceLeaf;

	oldPopover = this.parent?.hoverPopover;
	document: Document = this.targetEl?.ownerDocument ?? window.activeDocument ?? window.document;

	id = genId(8);
	bounce?: number;
	boundOnZoomOut: () => void;

	originalPath: string; // these are kept to avoid adopting targets w/a different link
	originalLinkText: string;
	static activePopover?: EmbeddedView;

	/** The main window and the popout windows. */
	static activeWindows(plugin: FloatSearchPlugin) {
		const windows: Window[] = [window];
		const {floatingSplit} = plugin.app.workspace;
		if (floatingSplit) {
			for (const split of floatingSplit.children) {
				if (split.win) windows.push(split.win);
			}
		}
		return windows;
	}

	static containerForDocument(doc: Document, plugin: FloatSearchPlugin): WorkspaceContainer {
		const {workspace} = plugin.app;
		if (doc !== workspace.rootSplit.doc && workspace.floatingSplit) {
			for (const container of workspace.floatingSplit.children) {
				if (container.doc === doc) return container;
			}
		}
		return workspace.rootSplit;
	}

	static activePopovers(plugin: FloatSearchPlugin) {
		return this.activeWindows(plugin).flatMap((win) => EmbeddedView.popoversForWindow(win));
	}

	static popoversForWindow(win?: Window) {
		return (Array.prototype.slice.call(win?.document?.body.querySelectorAll(".fs-leaf-view") ?? []) as HTMLElement[])
			.map(el => popovers.get(el)!)
			.filter(he => he);
	}

	static forLeaf(leaf: WorkspaceLeaf | undefined) {
		// leaf can be null such as when right clicking on an internal link
		const el = leaf?.containerEl.closest(".fs-leaf-view");
		return el ? popovers.get(el) : undefined;
	}

	static iteratePopoverLeaves(ws: Workspace, cb: (leaf: WorkspaceLeaf) => boolean | void, plugin: FloatSearchPlugin) {
		for (const popover of this.activePopovers(plugin)) {
			if (popover.rootSplit && ws.iterateLeaves(cb, popover.rootSplit)) return true;
		}
		return false;
	}

	hoverEl: HTMLElement = this.document.defaultView!.createDiv({
		cls: "fs-block fs-leaf-view",
		attr: {id: "fs-" + this.id},
	});

	constructor(
		parent: EmbeddedViewParent,
		public targetEl: HTMLElement,
		public plugin: FloatSearchPlugin,
		waitTime?: number,
		public onShowCallback?: () => unknown,
	) {
		//
		super();

		if (waitTime === undefined) {
			waitTime = 300;
		}
		this.onTarget = true;

		this.parent = parent;
		this.waitTime = waitTime;
		this.state = PopoverState.Showing;

		this.abortController!.load();
		this.show();
		this.onShow();

		this.setActive = this._setActive.bind(this);
		// if (hoverEl) {
		//     hoverEl.addEventListener("mousedown", this.setActive);
		// }
		// custom logic begin
		popovers.set(this.hoverEl, this);
		this.hoverEl.addClass("fs-block");
		this.containerEl = this.hoverEl.createDiv("fs-content");
		this.buildWindowControls();
	}

	_setActive(evt: MouseEvent) {
		evt.preventDefault();
		evt.stopPropagation();
		this.plugin.app.workspace.setActiveLeaf(this.leaves()[0], {focus: true});
	}

	updateLeaves() {
		if (this.onTarget && this.targetEl && !this.document.contains(this.targetEl)) {
			this.onTarget = false;
			this.transition();
		}
		let leafCount = 0;
		this.plugin.app.workspace.iterateLeaves(() => {
			leafCount++;
		}, this.rootSplit);

		if (leafCount === 0) {
			this.hide(); // close if we have no leaves
		}
		this.hoverEl.setAttribute("data-leaf-count", leafCount.toString());
	}

	leaves() {
		const leaves: WorkspaceLeaf[] = [];
		this.plugin.app.workspace.iterateLeaves(leaf => {
			leaves.push(leaf);
		}, this.rootSplit);
		return leaves;
	}

	transition() {
		if (this.shouldShow()) {
			if (this.state === PopoverState.Hiding) {
				this.state = PopoverState.Shown;
				window.clearTimeout(this.timer);
			}
		} else {
			if (this.state === PopoverState.Showing) {
				this.hide();
			} else {
				if (this.state === PopoverState.Shown) {
					this.state = PopoverState.Hiding;
					this.timer = window.setTimeout(() => {
						if (this.shouldShow()) {
							this.transition();
						} else {
							this.hide();
						}
					}, this.waitTime);
				}
			}
		}
	}


	buildWindowControls() {
		this.titleEl = this.document.defaultView!.createDiv("popover-titlebar");
		this.titleEl.createDiv("popover-title");

		this.containerEl.prepend(this.titleEl);

	}

	attachLeaf(): WorkspaceLeaf {
		const {workspace} = this.plugin.app;
		this.rootSplit.getRoot = () =>
			this.document === workspace.rootSplit.doc || !workspace.floatingSplit
				? workspace.rootSplit
				: workspace.floatingSplit;
		this.rootSplit.getContainer = () => EmbeddedView.containerForDocument(this.document, this.plugin);

		this.titleEl.insertAdjacentElement("afterend", this.rootSplit.containerEl);
		const leaf = workspace.createLeafInParent(this.rootSplit, 0);

		this.updateLeaves();
		return leaf;
	}

	onload(): void {
		super.onload();
		this.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.updateLeaves()));
		this.registerEvent(this.plugin.app.workspace.on("layout-change", () => {
			// Ensure that top-level items in a popover are not tabbed
			this.rootSplit.children.forEach((item, index) => {
				if (item instanceof WorkspaceTabs) {
					this.rootSplit.replaceChild(index, item.children[0]);
				}
			});
		}));
	}

	onShow() {
		// Once we've been open for closeDelay, use the closeDelay as a hiding timeout
		const closeDelay = 600;
		window.setTimeout(() => {
			this.waitTime = closeDelay;
		}, closeDelay);

		this.oldPopover?.hide();
		this.oldPopover = null;

		this.hoverEl.toggleClass("is-new", true);

		this.document.body.addEventListener(
			"click",
			() => {
				this.hoverEl.toggleClass("is-new", false);
			},
			{once: true, capture: true},
		);

		if (this.parent) {
			this.parent.hoverPopover = this;
		}

		// Remove original view header;
		const viewHeaderEl = this.hoverEl.querySelector(".view-header");
		viewHeaderEl?.remove();

		const sizer = this.hoverEl.querySelector(".workspace-leaf");
		if (sizer) this.hoverEl.appendChild(sizer);

		// Remove original inline tilte;
		const inlineTitle = this.hoverEl.querySelector(".inline-title");
		if (inlineTitle) inlineTitle.remove();

		this.onShowCallback?.();
		this.onShowCallback = undefined; // only call it once
	}

	detect(el: HTMLElement) {
		// TODO: may not be needed? the mouseover/out handers handle most detection use cases
		const {targetEl} = this;

		if (targetEl) {
			this.onTarget = el === targetEl || targetEl.contains(el);
		}
	}

	shouldShow() {
		return this.shouldShowSelf() || this.shouldShowChild();
	}

	shouldShowChild(): boolean {
		return EmbeddedView.activePopovers(this.plugin).some(popover => {
			if (popover !== this && popover.targetEl && this.hoverEl.contains(popover.targetEl)) {
				return popover.shouldShow();
			}
			return false;
		});
	}

	shouldShowSelf() {
		// Don't let obsidian show() us if we've already started closing
		// return !this.detaching && (this.onTarget || this.onHover);
		return (
			!this.detaching &&
			!!(
				this.onTarget ||
				(this.state == PopoverState.Shown) ||
				this.document.querySelector(`body>.modal-container, body > #he${this.id} ~ .menu, body > #he${this.id} ~ .suggestion-container`)
			)
		);
	}

	show() {
		// native obsidian logic start
		// if (!this.targetEl || this.document.body.contains(this.targetEl)) {
		this.state = PopoverState.Shown;
		this.timer = 0;

		this.targetEl.appendChild(this.hoverEl);
		this.onShow();
		this.plugin.app.workspace.onLayoutChange();

		// initializingHoverPopovers.remove(this);
		// activeHoverPopovers.push(this);
		// initializePopoverChecker();
		this.load();
		// }
		// native obsidian logic end
	}

	onHide() {
		this.oldPopover = null;
		if (this.parent?.hoverPopover === this) {
			this.parent.hoverPopover = null;
		}
	}

	hide() {
		this.onTarget = false;
		this.detaching = true;
		// Once we reach this point, we're committed to closing

		// in case we didn't ever call show()


		// A timer might be pending to call show() for the first time, make sure
		// it doesn't bring us back up after we close
		if (this.timer) {
			window.clearTimeout(this.timer);
			this.timer = 0;
		}

		// Hide our HTML element immediately, even if our leaves might not be
		// detachable yet.  This makes things more responsive and improves the
		// odds of not showing an empty popup that's just going to disappear
		// momentarily.
		this.hoverEl.hide();

		// If a file load is in progress, we need to wait until it's finished before
		// detaching leaves.  Because we set .detaching, The in-progress openFile()
		// will call us again when it finishes.
		if (this.opening) return;

		// Leave this code here to observe the state of the leaves
		const leaves = this.leaves();
		if (leaves.length) {
			// Detach all leaves before we unload the popover and remove it from the DOM.
			// Each leaf.detach() will trigger layout-changed and the updateLeaves()
			// method will then call hide() again when the last one is gone.
			// leaves[0].detach();
			// leaves[0].detach();
			this.targetEl.empty();
		} else {
			this.parent = null;
			this.abortController?.unload();
			this.abortController = undefined;
			return this.nativeHide();
		}
	}

	nativeHide() {
		const {hoverEl, targetEl} = this;
		this.state = PopoverState.Hidden;
		hoverEl.detach();

		if (targetEl) {
			const parent = targetEl.matchParent(".fs-leaf-view");
			if (parent) popovers.get(parent)?.transition();
		}

		this.onHide();
		this.unload();
	}
}
