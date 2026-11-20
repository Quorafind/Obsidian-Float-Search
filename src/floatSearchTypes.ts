import { PaneType, SearchResult, TFile } from "obsidian";

export type sortOrder =
	| "alphabetical"
	| "alphabeticalReverse"
	| "byModifiedTime"
	| "byModifiedTimeReverse"
	| "byCreatedTime"
	| "byCreatedTimeReverse";

export type searchType = "modal" | "sidebar" | PaneType;
export type LeafSearchType = Exclude<searchType, "modal">;

export interface viewType {
	type: searchType;
	icon: string;
}

export interface searchState extends Record<string, unknown> {
	collapseAll?: boolean;
	explainSearch?: boolean;
	extraContext?: boolean;
	matchingCase?: boolean;
	query: string;
	sortOrder?: sortOrder;
	/** Put the caret at the start instead of selecting the query (e.g. "search in current file"). */
	current?: boolean;
	/** Explicit caret position in the query, e.g. after "tag:" or inside "[]". */
	cursor?: number;
	/** Set when the plugin itself drives the search view, so the setState patch lets it through. */
	triggerBySelf?: boolean;
}

export type CmdkTriggerKey = "Shift" | "Control" | "Alt" | "Meta" | "none";

export interface FloatSearchSettings {
	searchViewState: searchState;
	showFilePath: boolean;
	showInstructions: boolean;
	defaultViewType: searchType;
	/** Preview the focused result automatically while navigating with the arrow keys. */
	autoPreview: boolean;
	/** Moving the mouse over a result makes it the keyboard-focused result. */
	hoverToFocus: boolean;
	cmdkTriggerKey: CmdkTriggerKey;
	cmdkDoubleTapInterval: number;
	cmdkQuickCreate: boolean;
	cmdkQuickCreateFolder: string;
	cmdkQuickCreateTitleFormat: string;
}

export const DEFAULT_SEARCH_STATE: searchState = {
	collapseAll: false,
	explainSearch: false,
	extraContext: false,
	matchingCase: false,
	query: "",
	sortOrder: "alphabetical",
};

export const DEFAULT_SETTINGS: FloatSearchSettings = {
	searchViewState: { ...DEFAULT_SEARCH_STATE },
	showFilePath: false,
	showInstructions: true,
	defaultViewType: "modal",
	autoPreview: true,
	hoverToFocus: true,
	cmdkTriggerKey: "Shift",
	cmdkDoubleTapInterval: 300,
	cmdkQuickCreate: false,
	cmdkQuickCreateFolder: "",
	cmdkQuickCreateTitleFormat: "YYYYMMDDHHmmss",
};

export const allViews: viewType[] = [
	{ type: "modal", icon: "square-equal" },
	{ type: "sidebar", icon: "panel-left-inactive" },
	{ type: "split", icon: "split-square-horizontal" },
	{ type: "tab", icon: "panel-top" },
	{ type: "window", icon: "app-window" },
];

export const VIEW_TYPE_LABELS: Record<searchType, string> = {
	modal: "Modal",
	split: "Split",
	tab: "Tab",
	window: "Window",
	sidebar: "Sidebar",
};

export const SORT_ORDER_LABELS: Record<sortOrder, string> = {
	alphabetical: "File name (A to Z)",
	alphabeticalReverse: "File name (Z to A)",
	byModifiedTime: "Modified time (new to old)",
	byModifiedTimeReverse: "Modified time (old to new)",
	byCreatedTime: "Created time (new to old)",
	byCreatedTimeReverse: "Created time (old to new)",
};

export const TRIGGER_KEY_OPTIONS: Record<CmdkTriggerKey, string> = {
	Shift: "Double Shift",
	Control: "Double Ctrl",
	Alt: "Double Alt",
	Meta: "Double Meta (Cmd/Win)",
	none: "Disabled",
};

export interface CmdkResult {
	file: TFile;
	nameMatch: SearchResult | null;
	pathMatch: SearchResult | null;
	heading?: string;
	headingMatch?: SearchResult | null;
	content?: string;
	contentMatch?: SearchResult | null;
	line?: number;
	type: "file" | "heading" | "content" | "create";
	createQuery?: string;
}
