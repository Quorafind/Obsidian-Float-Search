import { App, SearchView, WorkspaceLeaf } from "obsidian";
import { DEFAULT_SEARCH_STATE, LeafSearchType, searchState } from "./floatSearchTypes";
import { isEmebeddedLeaf } from "./leafView";

export function isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
	const side = leaf.getRoot()?.side;
	return side === "left" || side === "right";
}

export function isPopoutLeaf(leaf: WorkspaceLeaf): boolean {
	return leaf.getContainer?.()?.type === "window";
}

/** Search leaves that live in the workspace (not inside a float search modal or preview). */
export function getWorkspaceSearchLeaves(app: App): WorkspaceLeaf[] {
	return app.workspace
		.getLeavesOfType("search")
		.filter((leaf) => !isEmebeddedLeaf(leaf));
}

export function findSidebarSearchLeaf(app: App): WorkspaceLeaf | null {
	const leaves = getWorkspaceSearchLeaves(app).filter(isSidebarLeaf);
	// Prefer the left sidebar (where the core search lives by default).
	return (
		leaves.find((leaf) => leaf.getRoot()?.side === "left") ??
		leaves[0] ??
		null
	);
}

export function focusSearchInput(leaf: WorkspaceLeaf | null | undefined) {
	const view = leaf?.view as SearchView | undefined;
	const inputEl =
		view?.searchComponent?.inputEl ??
		leaf?.containerEl.querySelector<HTMLInputElement>("input");
	inputEl?.focus();
}

/**
 * Open the search in a leaf. For the sidebar an existing search tab (left or
 * right) is reused and its sidebar is expanded, like Ctrl+Shift+F does.
 */
export async function openSearchInLeaf(
	app: App,
	type: LeafSearchType,
	state?: Partial<searchState>
): Promise<WorkspaceLeaf | null> {
	let leaf: WorkspaceLeaf | null;
	if (type === "sidebar") {
		leaf = findSidebarSearchLeaf(app) ?? app.workspace.getLeftLeaf(false);
	} else {
		leaf = app.workspace.getLeaf(type);
		leaf?.setPinned(true);
	}
	if (!leaf) return null;

	await leaf.setViewState({
		type: "search",
		active: true,
		state: {
			...DEFAULT_SEARCH_STATE,
			...state,
			triggerBySelf: true,
		},
	});
	await app.workspace.revealLeaf(leaf);

	window.setTimeout(() => {
		focusSearchInput(leaf);
		const inputEl = (leaf?.view as SearchView | undefined)?.searchComponent?.inputEl;
		if (!inputEl || !state) return;
		if (typeof state.cursor === "number") inputEl.setSelectionRange(state.cursor, state.cursor);
		else if (state.current) inputEl.setSelectionRange(0, 0);
	}, 0);
	return leaf;
}
