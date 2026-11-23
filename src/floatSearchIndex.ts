import {
	debounce,
	Editor,
	ExtraButtonComponent,
	Menu,
	MenuItem,
	ObsidianProtocolData,
	OpenViewState,
	PaneType,
	Plugin,
	requireApiVersion,
	SearchView,
	setIcon,
	Setting,
	TAbstractFile,
	TFile,
	View,
	ViewStateResult,
	Workspace,
	WorkspaceContainer,
	WorkspaceItem,
	WorkspaceLeaf,
} from "obsidian";
import { around } from "monkey-around";
import { getActiveLeaf } from "./activeLeaf";
import { EmbeddedView, isEmebeddedLeaf } from "./leafView";
import { FloatSearchModal } from "./floatSearchModal";
import { FloatSearchCmdkModal } from "./floatSearchCmdk";
import { FloatSearchSettingTab } from "./settingTab";
import { registerIcons } from "./icons";
import { DoubleTapDetector } from "./doubleTap";
import { buildBacklinkQuery } from "./backlinkQuery";
import { attachNativeSearchPreview } from "./nativeSearchPreview";
import {
	getWorkspaceSearchLeaves,
	isPopoutLeaf,
	isSidebarLeaf,
	openSearchInLeaf,
} from "./searchLeaf";
import {
	allViews,
	DEFAULT_SEARCH_STATE,
	DEFAULT_SETTINGS,
	FloatSearchSettings,
	LeafSearchType,
	searchState,
	searchType,
	sortOrder,
	VIEW_TYPE_LABELS,
} from "./floatSearchTypes";

/** Elements and fields of Obsidian's (internal) search view used to decorate it. */
interface SearchViewInternals {
	filterSectionToggleEl?: HTMLElement;
	searchParamsContainerEl?: HTMLElement;
}

type LeafIterator = (leaf: WorkspaceLeaf) => boolean | void;

/**
 * The Workspace methods patched below, as the patches call them: they pass
 * their arguments through whichever overload (or internal signature) they are for.
 */
interface WorkspacePatchTarget {
	getLeaf(...args: Parameters<Workspace["getLeaf"]>): WorkspaceLeaf;
	changeLayout(layout: unknown): Promise<void>;
	iterateLeaves(arg1: unknown, arg2: unknown): boolean;
	setActiveLeaf(leaf: WorkspaceLeaf, params?: unknown): void;
	pushUndoHistory(leaf: WorkspaceLeaf, id: string, ...args: unknown[]): void;
}

/** The (internal) SearchView methods patched to remember the search options. */
interface SearchViewPatchTarget {
	onOpen(): Promise<void>;
	setExplainSearch(value: boolean): void;
	setCollapseAll(value: boolean): void;
	setExtraContext(value: boolean): void;
	setMatchingCase(value: boolean): void;
	setSortOrder(value: string): void;
	setQuery(value: string): void;
	setState(state: unknown, result: ViewStateResult): Promise<void>;
}

const LEAF_SEARCH_TYPES: LeafSearchType[] = ["sidebar", "split", "tab", "window"];

export default class FloatSearchPlugin extends Plugin {
	settings: FloatSearchSettings;
	modal: FloatSearchModal | null = null;

	/** Last used search state; the query is forgotten after 30s. */
	private state: searchState = { ...DEFAULT_SEARCH_STATE };
	private cmdkModal: FloatSearchCmdkModal | null = null;

	/** The first query a workspace search view receives (layout restore) is let through. */
	private queryLoaded = false;
	private allLoaded = false;

	applySettingsUpdate = debounce(async () => {
		// The first call happens while search views restore their state at startup.
		if (!this.allLoaded) {
			this.allLoaded = true;
			return;
		}
		this.settings.searchViewState = {
			...DEFAULT_SEARCH_STATE,
			...this.settings.searchViewState,
			query: this.state.query || "",
		};
		await this.saveSettings();
	}, 1000);

	private applyStateUpdate = debounce(() => {
		this.state = { ...DEFAULT_SEARCH_STATE, ...this.state, query: "" };
	}, 30000);

	async onload() {
		await this.loadSettings();
		this.initState();

		this.registerObsidianURIHandler();
		this.registerObsidianCommands();
		this.registerEditorMenuHandler();
		this.registerContextMenuHandler();
		this.addSettingTab(new FloatSearchSettingTab(this.app, this));

		this.addRibbonIcon(
			"search",
			`Search obsidian in ${this.settings.defaultViewType} view`,
			() => this.openSearch(this.state, { clearQuery: true })
		);
		this.updateFilePathVisibility();
		this.registerEvent(
			this.app.workspace.on("window-open", (_workspaceWindow, win) =>
				this.applyFilePathVisibility(win.document)
			)
		);

		this.app.workspace.onLayoutReady(() => {
			this.updateFilePathVisibility();
			registerIcons();
			this.patchWorkspace();
			this.patchWorkspaceLeaf();
			this.patchSearchView();
			this.patchDragManager();
			this.registerDoubleTap();
		});
	}

	onunload() {
		this.modal?.close();
		this.cmdkModal?.close();
		this.forEachWindowDocument((doc) => doc.body.removeClass("show-file-path"));
	}

	initState() {
		this.state = {
			...DEFAULT_SEARCH_STATE,
			...this.settings.searchViewState,
		};
	}

	/** Open a search in the default view type. */
	openSearch(
		state: searchState,
		options: { stateSave?: boolean; clearQuery?: boolean } = {}
	) {
		const { stateSave = true, clearQuery = false } = options;
		const type = this.settings.defaultViewType;
		if (type === "modal") {
			this.initModal(state, stateSave, clearQuery);
			return;
		}
		this.openSearchInLeaf(type, clearQuery ? { ...state, query: "" } : state);
	}

	openSearchInLeaf(type: LeafSearchType, state: searchState) {
		void openSearchInLeaf(this.app, type, state).catch((error) => {
			console.error("Float Search: failed to open search view", error);
		});
	}

	initModal(state: searchState, stateSave = false, clearQuery = false) {
		this.modal?.close();

		const modal = new FloatSearchModal(
			this,
			{ ...state, query: clearQuery ? "" : state.query },
			(newState) => {
				this.state = { ...DEFAULT_SEARCH_STATE, ...newState };
				if (stateSave) this.applyStateUpdate();
				this.settings.searchViewState = { ...this.state };
				this.applySettingsUpdate();
				if (this.modal === modal) this.modal = null;
			}
		);
		this.modal = modal;
		modal.open();
	}

	openCmdkModal() {
		this.cmdkModal?.close();
		this.cmdkModal = new FloatSearchCmdkModal(this);
		this.cmdkModal.open();
	}

	/** Show or hide the file path of results in every window, popouts included. */
	updateFilePathVisibility() {
		this.forEachWindowDocument((doc) => this.applyFilePathVisibility(doc));
	}

	private applyFilePathVisibility(doc: Document) {
		doc.body.toggleClass("show-file-path", this.settings.showFilePath);
	}

	/** Run `cb` for the document of the main window and of each popout window. */
	private forEachWindowDocument(cb: (doc: Document) => void) {
		for (const win of EmbeddedView.activeWindows(this)) cb(win.document);
	}

	setFilePathVisibility(show: boolean) {
		this.settings.showFilePath = show;
		this.updateFilePathVisibility();
		void this.saveSettings();
	}

	/** Change the default search options (sort order, collapse...) used everywhere (#77). */
	async updateSearchDefaults(update: Partial<searchState>) {
		this.settings.searchViewState = {
			...DEFAULT_SEARCH_STATE,
			...this.settings.searchViewState,
			...update,
		};
		this.state = { ...this.state, ...update };
		await this.saveSettings();
	}

	/**
	 * Whether a query set on this search view from outside the plugin (core
	 * search, bookmarks, tags, obsidian://search ...) should be shown in the
	 * default view type instead.
	 */
	private shouldRedirectSearch(leaf: WorkspaceLeaf | undefined): boolean {
		if (!leaf || isEmebeddedLeaf(leaf)) return false;
		if (this.settings.defaultViewType === "sidebar") {
			// Already where it should be: reuse it instead of opening another tab (#86).
			return !isSidebarLeaf(leaf);
		}
		return true;
	}

	/** Double-tap a modifier to open quick search (#82). */
	private registerDoubleTap() {
		const detector = new DoubleTapDetector(
			() => this.settings.cmdkTriggerKey,
			() => this.settings.cmdkDoubleTapInterval,
			() => {
				if (!activeDocument.querySelector(".float-search-cmdk-container")) {
					this.openCmdkModal();
				}
			}
		);
		const attach = (win: Window) => {
			this.registerDomEvent(win, "keydown", detector.onKeyDown, { capture: true });
			this.registerDomEvent(win, "keyup", detector.onKeyUp, { capture: true });
			this.registerDomEvent(win, "mousedown", detector.reset, { capture: true });
			this.registerDomEvent(win, "blur", detector.reset);
		};
		attach(window);
		this.registerEvent(
			this.app.workspace.on("window-open", (_workspaceWindow, win) => attach(win))
		);
	}

	patchWorkspace() {
		let layoutChanging = false;
		const workspace = this.app.workspace;
		const uninstaller = around(Workspace.prototype as unknown as WorkspacePatchTarget, {
			getLeaf: (next) =>
				function (this: Workspace, ...args: Parameters<Workspace["getLeaf"]>) {
					const activeLeaf = getActiveLeaf(this);
					if (activeLeaf) {
						const fsCtnEl = (
							activeLeaf.parent as unknown as { containerEl: HTMLElement }
						).containerEl?.parentElement;
						if (fsCtnEl?.hasClass("fs-content")) {
							if (activeLeaf.view.getViewType() === "markdown") {
								return activeLeaf;
							}
							const newLeaf = workspace.getMostRecentLeaf();
							if (newLeaf) this.setActiveLeaf(newLeaf);
						}
					}
					return next.call(this, ...args);
				},
			changeLayout(old) {
				return async function (this: Workspace, layout: unknown) {
					layoutChanging = true;
					try {
						// Don't consider embedded views part of the workspace while it's changing
						await old.call(this, layout);
					} finally {
						layoutChanging = false;
					}
				};
			},
			// Make leaves inside the modal and previews visible to getLeavesOfType()
			// & co, so other plugins (e.g. Supercharged Links) can decorate them (#74).
			iterateLeaves(old) {
				return function (this: Workspace, arg1: unknown, arg2: unknown) {
					if (old.call(this, arg1, arg2)) return true;

					// Handle old/new API parameter order
					const cb = (typeof arg1 === "function" ? arg1 : arg2) as LeafIterator;
					const parent = (typeof arg1 === "function" ? arg2 : arg1) as WorkspaceItem;

					if (!parent) return false; // During app startup, rootSplit can be null
					if (layoutChanging) return false;

					if (
						parent === workspace.rootSplit ||
						(WorkspaceContainer && parent instanceof WorkspaceContainer)
					) {
						for (const popover of EmbeddedView.popoversForWindow(
							(parent as WorkspaceContainer).win
						)) {
							if (old.call(this, cb, popover.rootSplit)) return true;
						}
					}
					return false;
				};
			},
			setActiveLeaf(old) {
				return function (this: Workspace, leaf: WorkspaceLeaf, params?: unknown) {
					if (isEmebeddedLeaf(leaf)) {
						old.call(this, leaf, params);
						leaf.activeTime = 1700000000000;
					}
					return old.call(this, leaf, params);
				};
			},
			pushUndoHistory(old) {
				return function (
					this: Workspace,
					leaf: WorkspaceLeaf,
					id: string,
					...args: unknown[]
				) {
					if (leaf.getViewState().type === "search") return;
					return old.call(this, leaf, id, ...args);
				};
			},
		});
		this.register(uninstaller);
	}

	// Used for patch workspaceleaf pinned behaviors
	patchWorkspaceLeaf() {
		const app = this.app;
		this.register(
			around(WorkspaceLeaf.prototype, {
				getRoot(old) {
					return function (this: WorkspaceLeaf) {
						const top = old.call(this);
						return top?.getRoot === this.getRoot ? top : top?.getRoot();
					};
				},
				setPinned(old) {
					return function (this: WorkspaceLeaf, pinned: boolean) {
						old.call(this, pinned);
						if (isEmebeddedLeaf(this) && !pinned) this.setPinned(true);
					};
				},
				openFile(old) {
					return function (
						this: WorkspaceLeaf,
						file: TFile,
						openState?: OpenViewState
					) {
						if (isEmebeddedLeaf(this)) {
							window.setTimeout(
								around(Workspace.prototype, {
									recordMostRecentOpenedFile(old) {
										return function (this: Workspace, _file: TFile) {
											// Don't update the quick switcher's recent list
											if (_file !== file) return old.call(this, _file);
										};
									},
								}),
								1
							);
							const recentFiles = app.plugins.plugins["recent-files-obsidian"];
							if (recentFiles) {
								window.setTimeout(
									around(recentFiles, {
										shouldAddFile(old) {
											return function (this: unknown, _file: TFile) {
												// Don't update the Recent Files plugin
												return _file !== file && old.call(this, _file);
											};
										},
									}),
									1
								);
							}
						}

						const view = old.call(this, file, openState);
						window.setTimeout(() => {
							const fsCtnEl = (
								this.parent as unknown as { containerEl: HTMLElement }
							).containerEl?.parentElement;
							if (!fsCtnEl?.classList.contains("fs-content")) return;
							if (file.extension !== "canvas") return;

							const canvas = (this.view as unknown as { canvas?: CanvasLike }).canvas;
							const match = (openState?.eState as { match?: { content?: string } } | undefined)?.match;
							window.setTimeout(() => {
								if (!canvas || !match) return;
								const data = canvas.data.nodes?.find((n) => n.text === match.content);
								const node = data && canvas.nodes.get(data.id);
								if (node) {
									canvas.selectOnly(node);
									canvas.zoomToSelection();
								}
							}, 20);
						}, 1);

						return view;
					};
				},
			})
		);
	}

	private currentViewType(leaf: WorkspaceLeaf): searchType {
		if (isEmebeddedLeaf(leaf)) return "modal";
		if (isSidebarLeaf(leaf)) return "sidebar";
		if (isPopoutLeaf(leaf)) return "window";
		return "split";
	}

	private buildViewMenu(menu: Menu, current: searchType, originLeaf: WorkspaceLeaf) {
		menu.dom.addClass("float-search-view-menu");
		const availableViews = allViews.filter((view) =>
			current === "split" ? view.type !== "tab" : view.type !== current
		);
		const stateOf = (): searchState => ({
			...this.state,
			...(originLeaf.view.getState() as Partial<searchState>),
		});

		for (const view of availableViews) {
			menu.addItem((item: MenuItem) => {
				item.setTitle(`${VIEW_TYPE_LABELS[view.type]} view`)
					.setIcon(view.icon)
					.onClick(() => {
						const state = stateOf();
						if (current === "modal") this.modal?.close();
						else originLeaf.detach();

						window.setTimeout(() => {
							if (view.type === "modal") this.initModal(state, true, false);
							else this.openSearchInLeaf(view.type, state);
						}, 10);
					});
			});
		}
		return menu;
	}

	/** Add the view switcher, extra options and the Tab preview to a search view. */
	private decorateSearchView(view: SearchView & SearchViewInternals) {
		// Every step is optional: the search view looks different across
		// platforms (mobile, #68) and Obsidian versions.
		const steps: [string, () => void][] = [
			["view switcher", () => this.addViewSwitchButton(view)],
			["search options", () => this.addSearchParamSettings(view)],
			["preview", () => attachNativeSearchPreview(this, view)],
		];
		for (const [name, step] of steps) {
			try {
				step();
			} catch (error) {
				console.error(`Float Search: failed to add ${name} to the search view`, error);
			}
		}
	}

	private addViewSwitchButton(view: SearchView & SearchViewInternals) {
		const anchorEl = view.filterSectionToggleEl;
		const rowEl =
			anchorEl?.parentElement ??
			view.containerEl.querySelector<HTMLElement>(".search-row");
		if (!rowEl || rowEl.querySelector(".float-search-view-switch")) return;

		const viewSwitchEl = createDiv({ cls: "float-search-view-switch" });
		new ExtraButtonComponent(viewSwitchEl)
			.setIcon("layout-template")
			.setTooltip("Switch view")
			.onClick(() => {
				const menu = this.buildViewMenu(
					new Menu(),
					this.currentViewType(view.leaf),
					view.leaf
				);
				const rect = viewSwitchEl.getBoundingClientRect();
				menu.showAtPosition({ x: rect.x, y: rect.y + 30 });
			});
		if (anchorEl && anchorEl.parentElement === rowEl) {
			rowEl.insertBefore(viewSwitchEl, anchorEl);
		} else {
			rowEl.appendChild(viewSwitchEl);
		}
	}

	private addSearchParamSettings(view: SearchView & SearchViewInternals) {
		const paramsEl = view.searchParamsContainerEl;
		if (!paramsEl || paramsEl.querySelector(".float-search-param")) return;
		const { settings } = this;

		new Setting(paramsEl)
			.setName("Show file path")
			.setClass("float-search-param")
			.addToggle((toggle) => {
				toggle.toggleEl.addClass("mod-small");
				toggle
					.setValue(settings.showFilePath)
					.onChange((value) => this.setFilePathVisibility(value));
			});
		new Setting(paramsEl)
			.setName("Show instructions")
			.setClass("float-search-param")
			.addToggle((toggle) => {
				toggle.toggleEl.addClass("mod-small");
				toggle.setValue(settings.showInstructions).onChange(async (value) => {
					settings.showInstructions = value;
					await this.saveSettings();
				});
			});
		new Setting(paramsEl)
			.setName("Default view type")
			.setClass("float-search-param")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(VIEW_TYPE_LABELS)
					.setValue(settings.defaultViewType)
					.onChange(async (value) => {
						settings.defaultViewType = value as searchType;
						await this.saveSettings();
					});
			});
	}

	patchSearchView() {
		const settings = this.settings;
		const workspace = this.app.workspace;
		const decorate = (view: SearchView) => this.decorateSearchView(view);
		const saveOption = <K extends keyof searchState>(key: K, value: searchState[K]) => {
			if (!workspace.layoutReady) return;
			settings.searchViewState[key] = value;
			this.applySettingsUpdate();
		};
		const interceptQuery = (leaf: WorkspaceLeaf | undefined, state: searchState): boolean => {
			if (typeof state?.query !== "string" || state.triggerBySelf) return false;
			if (!this.shouldRedirectSearch(leaf)) return false;
			if (!this.queryLoaded) {
				this.queryLoaded = true;
				return false;
			}
			this.openSearch({ ...state, current: false }, { stateSave: true });
			return true;
		};

		const patchSearch = async () => {
			const leaves = workspace.getLeavesOfType("search");
			const leaf = leaves.find((l) => !isEmebeddedLeaf(l)) ?? leaves[0];
			if (!leaf) return false;
			if (requireApiVersion("1.7.3") && leaf.isDeferred) {
				await leaf.loadIfDeferred();
			}
			const searchView = leaf.view as SearchView;
			if (searchView?.getViewType() !== "search" || !searchView.dom) return false;

			this.register(
				around(searchView.constructor.prototype as SearchViewPatchTarget, {
					onOpen(old) {
						return function (this: SearchView) {
							const result = old.call(this);
							decorate(this);
							return result;
						};
					},
					setExplainSearch(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("explainSearch", value);
						};
					},
					setCollapseAll(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("collapseAll", value);
						};
					},
					setExtraContext(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("extraContext", value);
						};
					},
					setMatchingCase(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("matchingCase", value);
						};
					},
					setSortOrder(old) {
						return function (this: SearchView, value: string) {
							old.call(this, value);
							saveOption("sortOrder", value as sortOrder);
						};
					},
					setQuery(old) {
						return function (this: SearchView, value: string) {
							old.call(this, value);
							saveOption("query", value);
						};
					},
					setState(old) {
						return function (this: SearchView, state: searchState, result: ViewStateResult) {
							if (interceptQuery(this.leaf, state)) return Promise.resolve();
							return old.call(this, state, result);
						};
					},
				})
			);
			this.patchSearchResultDom(searchView);

			// Re-open existing workspace search views so they get the patched onOpen.
			for (const l of getWorkspaceSearchLeaves(this.app)) {
				if (!l.isDeferred) l.rebuildView();
			}
			return true;
		};

		const tryPatch = async () => {
			if (await patchSearch()) return;
			const ref = workspace.on("layout-change", () => {
				void patchSearch().then((patched) => {
					if (patched) workspace.offref(ref);
				});
			});
			this.registerEvent(ref);
		};
		void tryPatch().catch((error) => {
			console.error("Float Search: failed to patch the search view", error);
		});
	}

	/** Show the folder of each file result (the "Show file path" option). */
	private patchSearchResultDom(searchView: SearchView) {
		this.register(
			around(searchView.dom.constructor.prototype as { stopLoader(): void }, {
				stopLoader(old) {
					return function (this: { vChildren?: { children?: ResultFileItem[] } }) {
						old.call(this);
						this.vChildren?.children?.forEach((child) => {
							if (!child?.file || child.pathEl) return;
							const pathEl = createDiv({ cls: "search-result-file-path" });
							setIcon(pathEl.createDiv({ cls: "search-result-file-path-icon" }), "folder");
							pathEl.createDiv({
								cls: "search-result-file-path-text",
								text: child.file.parent?.path || "/",
							});
							child.pathEl = pathEl;
							child.containerEl
								.querySelector(".search-result-file-title")
								?.prepend(pathEl);
						});
					};
				},
			})
		);
	}

	patchDragManager() {
		const manager = this.app.dragManager as { constructor: { prototype: object } } | undefined;
		if (!manager) return;
		const closeModal = () => this.modal?.close();

		this.register(
			around(manager.constructor.prototype as { dragFile(...args: unknown[]): unknown }, {
				dragFile(old) {
					return function (this: unknown, ...args: unknown[]) {
						const result = old.call(this, ...args);
						window.setTimeout(closeModal, 10);
						return result;
					};
				},
			})
		);
	}

	registerObsidianURIHandler() {
		/**
		 * obsidian://fs?query=hello&viewType=modal
		 *
		 * viewType: "modal" (default), "tab", "split", "window" or "sidebar".
		 */
		this.registerObsidianProtocolHandler("fs", (params: ObsidianProtocolData) => {
			const viewType = params.viewType || "modal";
			const state: searchState = {
				...this.state,
				query: params.query || "",
				current: false,
			};
			if (LEAF_SEARCH_TYPES.includes(viewType as LeafSearchType)) {
				this.openSearchInLeaf(viewType as LeafSearchType, state);
			} else {
				this.initModal(state, true, false);
			}
		});
	}

	private createCommand(options: {
		id: string;
		name: string;
		queryBuilder: (file?: TFile) => string;
		isGlobal: boolean;
	}): void {
		if (options.isGlobal) {
			this.addCommand({
				id: options.id,
				name: options.name,
				callback: () => {
					const query = options.queryBuilder();
					// Type right after the operator ("tag:|") or inside the brackets ("[|]").
					const cursor = query.endsWith("]") ? query.length - 1 : query.length;
					this.openSearch({ ...this.state, query, cursor, current: false });
				},
			});
			return;
		}

		this.addCommand({
			id: options.id,
			name: options.name,
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(View);
				const viewType = view?.getViewType();
				if (!view?.file || (viewType !== "markdown" && viewType !== "canvas")) {
					return false;
				}
				if (!checking) {
					this.openSearch({
						...this.state,
						query: options.queryBuilder(view.file),
						current: true,
					});
				}
				return true;
			},
		});
	}

	registerObsidianCommands() {
		this.addCommand({
			id: "show-or-hide-file-path",
			name: "Show/hide file path",
			callback: () => this.setFilePathVisibility(!this.settings.showFilePath),
		});

		this.addCommand({
			id: "search-obsidian-globally",
			name: "Search obsidian globally",
			callback: () =>
				this.initModal({ ...this.state, query: "", current: false }, false, true),
		});

		this.addCommand({
			id: "search-obsidian-globally-state",
			name: "Search Obsidian Globally (With Last State)",
			callback: () =>
				this.initModal({ ...this.state, current: false }, true, false),
		});

		this.createCommand({
			id: "search-in-backlink",
			name: "Search in backlink Of current file",
			queryBuilder: (file?: TFile) => {
				if (!file) return "";
				const name = file.extension === "canvas" ? file.name : file.basename;
				return buildBacklinkQuery(name);
			},
			isGlobal: false,
		});

		this.createCommand({
			id: "search-in-current-file",
			name: "Search in current file",
			queryBuilder: (file?: TFile) => (file ? ` path:"${file.path}"` : ""),
			isGlobal: false,
		});

		this.registerSearchOperatorCommands();

		for (const type of ["split", "tab", "window"] as PaneType[]) {
			this.addCommand({
				id: `open-search-view-${type}`,
				name: `Open search view (${type})`,
				callback: () => void this.openOrRevealSearchView(type),
			});
		}
	}

	private async openOrRevealSearchView(type: PaneType) {
		const leaves = getWorkspaceSearchLeaves(this.app);
		const state = { ...this.state, triggerBySelf: true };
		const existing =
			type === "window"
				? leaves.find(isPopoutLeaf)
				: leaves.find((leaf) => !isSidebarLeaf(leaf) && !isPopoutLeaf(leaf));

		if (!existing) {
			this.openSearchInLeaf(type, state);
			return;
		}
		await this.app.workspace.revealLeaf(existing);
		if (type !== "window") {
			await existing.setViewState({ type: "search", active: true, state });
		}
	}

	registerSearchOperatorCommands() {
		const searchOperators = [
			["search-file-operator", "Search: file: (Find text in filename)", "file:"],
			["search-path-operator", "Search: path: (Find text in file path)", "path:"],
			["search-content-operator", "Search: content: (Find text in file content)", "content:"],
			["search-match-case-operator", "Search: match-case: (Case-sensitive match)", "match-case:"],
			["search-ignore-case-operator", "Search: ignore-case: (Case-insensitive match)", "ignore-case:"],
			["search-tag-operator", "Search: tag: (Find tag)", "tag:"],
			["search-line-operator", "Search: line: (Find files with matching line)", "line:"],
			["search-block-operator", "Search: block: (Find matches in the same block)", "block:"],
			["search-section-operator", "Search: section: (Find matches in the same section)", "section:"],
			["search-task-operator", "Search: task: (Find matches in a task)", "task:"],
			["search-task-todo-operator", "Search: task-todo: (Find matches in uncompleted tasks)", "task-todo:"],
			["search-task-done-operator", "Search: task-done: (Find matches in completed tasks)", "task-done:"],
			["search-property", "Search: [property] or [property:value]", "[]"],
		];
		for (const [id, name, query] of searchOperators) {
			this.createCommand({ id, name, queryBuilder: () => query, isGlobal: true });
		}
	}

	registerEditorMenuHandler() {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
				const selection = editor?.getSelection().trim();
				if (!selection) return;
				const label =
					selection.length > 8
						? `${selection.substring(0, 3)}...${selection.substring(selection.length - 3)}`
						: selection;

				menu.addItem((item) => {
					item.setTitle(`Search "${label}" in Float Search`)
						.setIcon("search")
						.onClick(() =>
							this.initModal(
								{ ...this.state, query: selection, current: false },
								true,
								false
							)
						);
				});
			})
		);
	}

	registerContextMenuHandler() {
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile, _source: string, leaf?: WorkspaceLeaf) => {
					if (!(file instanceof TFile) || leaf || EmbeddedView.forLeaf(leaf)) return;
					menu.addItem((item) => {
						item.setIcon("popup-open")
							.setTitle("Open in Float Preview")
							.onClick(() => {
								if (!this.modal) {
									this.initModal({ ...this.state, current: false }, true, true);
								}
								const modal = this.modal;
								window.setTimeout(() => {
									void modal?.previewFile(file).catch((error) => {
										console.error("Float Search: failed to preview file", error);
									});
								}, 20);
							})
							.setSection?.("open");
					});
				}
			)
		);
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<FloatSearchSettings>;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			searchViewState: {
				...DEFAULT_SEARCH_STATE,
				...data.searchViewState,
			},
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

interface CanvasLike {
	data: { nodes?: { id: string; text?: string }[] };
	nodes: Map<string, unknown>;
	selectOnly(node: unknown): void;
	zoomToSelection(): void;
}

interface ResultFileItem {
	file?: TFile;
	pathEl?: HTMLElement;
	containerEl: HTMLElement;
}
