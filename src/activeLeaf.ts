import { View, Workspace, WorkspaceLeaf } from "obsidian";

/**
 * The leaf that has focus, like the deprecated `workspace.activeLeaf`: every
 * leaf holds a view, so the active view's leaf is the active leaf.
 */
export function getActiveLeaf(workspace: Workspace): WorkspaceLeaf | null {
	return workspace.getActiveViewOfType(View)?.leaf ?? null;
}
