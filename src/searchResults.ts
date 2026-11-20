import { App, TFile, WorkspaceLeaf, WorkspaceParent, WorkspaceSplit } from "obsidian";
import { isEmebeddedLeaf } from "./leafView";

type MatchRange = [number, number];

/** The parts of Obsidian's (internal) search result tree items that this plugin relies on. */
export interface SearchResultItem {
	el: HTMLElement;
	/** Set on file items. */
	file?: TFile;
	/** For match items this is the owning file item. */
	parent?: SearchResultItem;
	content?: string;
	matches?: MatchRange[];
	result?: { content?: MatchRange[]; properties?: unknown };
	vChildren?: { children: SearchResultItem[] };
	collapsible?: boolean;
	collapseEl?: HTMLElement;
	setCollapse?(collapsed: boolean, animate?: boolean): void;
	mutateEState?(eState: Record<string, unknown>): void;
}

export interface SearchResultDom {
	el: HTMLElement;
	focusedItem: SearchResultItem | null;
	vChildren: { children: SearchResultItem[] };
	setFocusedItem(item: SearchResultItem | null): void;
	changeFocusedItem(direction: "forwards" | "backwards"): void;
}

export interface ResolvedResult {
	file: TFile;
	/** Ephemeral state that scrolls to / highlights the match, when the item is a match. */
	eState?: Record<string, unknown>;
	/** Identifies the exact result, so a repeated preview of the same result can be detected. */
	key: string;
}

export function isComposingEvent(e: KeyboardEvent): boolean {
	// keyCode 229 is what IMEs report while a composition is in progress.
	return e.isComposing || e.key === "Process" || e.keyCode === 229;
}

export function resolveResultItem(
	item: SearchResultItem | null | undefined
): ResolvedResult | null {
	if (!item) return null;
	if (item.file instanceof TFile) {
		return { file: item.file, key: item.file.path };
	}
	const file = item.parent?.file;
	if (!(file instanceof TFile)) return null;
	const eState: Record<string, unknown> = {
		match: { content: item.content, matches: item.matches ?? [] },
	};
	item.mutateEState?.(eState);
	return {
		file,
		eState,
		key: `${file.path}#${item.matches?.[0]?.[0] ?? ""}`,
	};
}

/** Same ephemeral state Obsidian uses when a file result itself is opened. */
export function openStateForItem(
	item: SearchResultItem
): Record<string, unknown> | undefined {
	const resolved = resolveResultItem(item);
	if (!resolved) return undefined;
	if (resolved.eState) return resolved.eState;
	return {
		match: { content: item.content, matches: item.result?.content ?? [] },
		propertyMatches: item.result?.properties,
	};
}

/** Find the result item (file or match) that contains `target`. */
export function findResultItem(
	dom: SearchResultDom | undefined,
	target: EventTarget | null
): SearchResultItem | null {
	if (!dom || !(target instanceof Node)) return null;
	for (const fileItem of dom.vChildren?.children ?? []) {
		if (!fileItem.el?.contains(target)) continue;
		for (const match of fileItem.vChildren?.children ?? []) {
			if (match.el?.contains(target)) return match;
		}
		return fileItem;
	}
	return null;
}

/**
 * Like Workspace.createLeafInParent(), minus making the new leaf active (which
 * would switch the active file while the user keeps searching).
 */
function createInactiveLeaf(app: App, parent: WorkspaceParent, index: number): WorkspaceLeaf {
	try {
		const LeafCtor = WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf & {
			setDimension?(size: number): void;
		};
		const leaf = new LeafCtor(app);
		const count = (parent as unknown as { children: unknown[] }).children.length;
		if (count > 0) leaf.setDimension?.(100 / count);
		parent.insertChild(index, leaf);
		return leaf;
	} catch {
		return app.workspace.createLeafInParent(parent as unknown as WorkspaceSplit, index);
	}
}

/** A tab of the main window's root split, i.e. a sensible place to open files next to. */
export function isMainAreaLeaf(app: App, leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf {
	return !!leaf && !isEmebeddedLeaf(leaf) && leaf.getRoot() === app.workspace.rootSplit;
}

/**
 * Open a file in a new tab next to `anchor` (or the most recent tab of the
 * main window) without switching to it, and keep the current leaf active.
 */
export async function openInBackgroundTab(
	app: App,
	file: TFile,
	eState?: Record<string, unknown>,
	anchorLeaf?: WorkspaceLeaf | null
): Promise<WorkspaceLeaf> {
	const { workspace } = app;
	const previouslyActive = workspace.activeLeaf;
	const anchor = isMainAreaLeaf(app, anchorLeaf)
		? anchorLeaf
		: workspace.getMostRecentLeaf(workspace.rootSplit);
	let leaf: WorkspaceLeaf;
	if (anchor && !isEmebeddedLeaf(anchor) && anchor.parent) {
		const parent = anchor.parent as unknown as WorkspaceParent & {
			children: unknown[];
			selectTab?(leaf: WorkspaceLeaf): void;
		};
		const index = parent.children.indexOf(anchor);
		leaf = createInactiveLeaf(app, parent, index + 1);
		await leaf.openFile(file, { active: false, eState });
		// Keep the tab the user was looking at in front.
		parent.selectTab?.(anchor);
	} else {
		leaf = workspace.getLeaf("tab");
		await leaf.openFile(file, { active: false, eState });
	}
	// Creating the leaf made it active; give the focus back.
	if (previouslyActive && previouslyActive !== leaf && workspace.activeLeaf !== previouslyActive) {
		workspace.setActiveLeaf(previouslyActive, { focus: false });
	}
	return leaf;
}
