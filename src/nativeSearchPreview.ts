import { debounce, SearchView } from "obsidian";
import { around } from "monkey-around";
import type FloatSearchPlugin from "./floatSearchIndex";
import { isEmebeddedLeaf } from "./leafView";
import { PreviewPane } from "./previewPane";
import {
	isComposingEvent,
	resolveResultItem,
	SearchResultDom,
	SearchResultItem,
} from "./searchResults";

/**
 * Tab preview for search views that live in the workspace (sidebar, tab,
 * split, window). The float search modal has its own implementation (#80).
 *
 * - Tab: preview the focused result below the results; Tab again focuses it.
 * - Shift+Tab: close the preview.
 * - Ctrl+G / Ctrl+Tab / Esc inside the preview: back to the search input.
 *
 * Keys are registered on the view's scope: Obsidian blurs the search input
 * as soon as the arrow keys move through the results.
 */
export function attachNativeSearchPreview(
	plugin: FloatSearchPlugin,
	view: SearchView
) {
	const inputEl = view.searchComponent?.inputEl;
	const dom = view.dom as SearchResultDom | undefined;
	if (!inputEl || !dom || !view.scope) return;

	let pane: PreviewPane | null = null;
	const isNative = () => !isEmebeddedLeaf(view.leaf);

	const close = () => {
		follow.cancel();
		pane?.destroy();
		pane = null;
		view.containerEl.removeClass("float-search-has-preview");
	};

	const show = async (focus: boolean) => {
		const resolved = resolveResultItem(dom.focusedItem);
		if (!resolved) return;
		if (pane && pane.key === resolved.key) {
			if (focus) pane.focus();
			return;
		}
		if (!pane) {
			pane = new PreviewPane(plugin, view.containerEl, "float-search-native-preview");
			view.containerEl.addClass("float-search-has-preview");
			pane.el.addEventListener("keydown", onPreviewKeyDown, true);
		}
		await pane.open(resolved.file, resolved.eState, resolved.key);
	};

	// Keep the preview in sync with the focused result (keyboard or mouse).
	const follow = debounce(() => {
		if (pane) void show(false);
	}, 150, true);
	view.register(
		around(dom as unknown as Record<string, (item: SearchResultItem | null) => void>, {
			setFocusedItem(old) {
				return function (this: SearchResultDom, item: SearchResultItem | null) {
					old.call(this, item);
					if (pane) follow();
				};
			},
		})
	);

	const onPreviewKeyDown = (e: KeyboardEvent) => {
		const back =
			(e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "g" || e.key === "Tab")) ||
			(e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey);
		if (!back) return;
		e.preventDefault();
		e.stopPropagation();
		inputEl.focus();
	};

	const onTab = (e: KeyboardEvent, shift: boolean): false | void => {
		if (!isNative() || isComposingEvent(e)) return;
		if (pane?.contains(activeDocument.activeElement)) return;
		if (shift) {
			if (!pane) return;
			close();
			return false;
		}
		if (!dom.focusedItem) return; // Nothing to preview: keep the default Tab behaviour.
		void show(true);
		return false;
	};
	view.scope.register([], "Tab", (e) => onTab(e, false));
	view.scope.register(["Shift"], "Tab", (e) => onTab(e, true));

	view.register(close);
}
