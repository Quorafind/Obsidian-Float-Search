import {
	addIcon,
	App,
	Editor,
	ExtraButtonComponent,
	Keymap,
	Menu,
	MenuItem,
	Modal,
	ObsidianProtocolData,
	OpenViewState,
	PaneType,
	Plugin,
	prepareFuzzySearch,
	prepareSimpleSearch,
	renderResults,
	SearchResult,
	requireApiVersion,
	Scope,
	SearchView,
	setIcon,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TAbstractFile,
	TFile,
	ViewStateResult,
	Workspace,
	WorkspaceContainer,
	WorkspaceItem,
	WorkspaceLeaf,
} from "obsidian";
import { EmbeddedView, isEmebeddedLeaf, spawnLeafView } from "./leafView";
import { around } from "monkey-around";
import { debounce } from "obsidian";

type sortOrder =
	| "alphabetical"
	| "alphabeticalReverse"
	| "byModifiedTime"
	| "byModifiedTimeReverse"
	| "byCreatedTime"
	| "byCreatedTimeReverse";

type searchType = "modal" | "sidebar" | PaneType;

interface viewType {
	type: searchType;
	icon: string;
}

interface searchState extends Record<string, unknown> {
	collapseAll?: boolean;
	explainSearch?: boolean;
	extraContext?: boolean;
	matchingCase?: boolean;
	query: string;
	sortOrder?: sortOrder;
	current?: boolean;
}

type CmdkTriggerKey = "Shift" | "Control" | "Alt" | "Meta" | "none";

interface FloatSearchSettings {
	searchViewState: searchState;
	showFilePath: boolean;
	showInstructions: boolean;
	defaultViewType: searchType;
	cmdkTriggerKey: CmdkTriggerKey;
	cmdkDoubleTapInterval: number;
}

const DEFAULT_SETTINGS: FloatSearchSettings = {
	searchViewState: {
		collapseAll: false,
		explainSearch: false,
		extraContext: false,
		matchingCase: false,
		query: "",
		sortOrder: "alphabetical",
	},
	showFilePath: false,
	showInstructions: true,
	defaultViewType: "modal",
	cmdkTriggerKey: "Shift",
	cmdkDoubleTapInterval: 300,
};

const allViews: viewType[] = [
	{
		type: "modal",
		icon: "square-equal",
	},
	{
		type: "sidebar",
		icon: "panel-left-inactive",
	},
	{
		type: "split",
		icon: "split-square-horizontal",
	},
	{
		type: "tab",
		icon: "panel-top",
	},
	{
		type: "window",
		icon: "app-window",
	},
];

const initSearchViewWithLeaf = async (
	app: App,
	type: PaneType | "sidebar",
	state?: searchState
) => {
	const leaf =
		type === "sidebar"
			? app.workspace.getLeftLeaf(false)
			: app.workspace.getLeaf(type);
	leaf?.setPinned(type !== "sidebar");
	await leaf?.setViewState({
		type: "search",
		active: true,
		state: {
			...DEFAULT_SETTINGS.searchViewState,
			...state,
			triggerBySelf: true,
		},
	});

	setTimeout(() => {
		const inputEl = leaf?.containerEl.getElementsByTagName("input")?.[0];
		inputEl?.focus();
	}, 0);
};

export default class FloatSearchPlugin extends Plugin {
	settings: FloatSearchSettings;
	private state: searchState;
	private modal: FloatSearchModal;
	private cmdkModal: FloatSearchCmdkModal;

	allLoaded: boolean = false;
	queryLoaded: boolean = false;

	patchedDomChildren = false;

	public applySettingsUpdate = debounce(async () => {
		if (!this.allLoaded) {
			this.allLoaded = true;
			return;
		}
		// Ensure all searchState properties are preserved
		this.settings.searchViewState = {
			...DEFAULT_SETTINGS.searchViewState,
			...this.settings.searchViewState,
			query: this.state?.query || "",
		};
		await this.saveSettings();
	}, 1000);

	private applyStateUpdate = debounce(() => {
		// Preserve all state properties when updating
		this.state = {
			...DEFAULT_SETTINGS.searchViewState,
			...this.state,
			query: "",
		};
	}, 30000);

	async onload() {
		await this.loadSettings();

		this.app.workspace.onLayoutReady(() => {
			this.initState();
			this.registerIcons();

			this.patchWorkspace();
			this.patchWorkspaceLeaf();
			this.patchSearchView();
			this.patchVchildren();
			this.patchDragManager();
			this.registerDoubleKeyHandler();
		});

		this.registerObsidianURIHandler();
		this.registerObsidianCommands();
		this.registerEditorMenuHandler();
		this.registerContextMenuHandler();

		this.addRibbonIcon(
			"search",
			`Search obsidian in ${this.settings.defaultViewType} view`,
			() => {
				if (this.settings.defaultViewType === "modal") {
					this.initModal(this.state, true, true);
				} else {
					initSearchViewWithLeaf(
						this.app,
						this.settings.defaultViewType,
						{
							...this.state,
							query: "",
						}
					);
				}
			}
		);
		this.updateFilePathVisibility();
		this.addSettingTab(new FloatSearchSettingTab(this.app, this));
	}

	onunload() {
		// this.state = DEFAULT_SETTINGS.searchViewState;
		this.modal?.close();
	}

	registerDoubleKeyHandler() {
		let lastKeyUp = 0;
		let keyOnly = true;

		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			const triggerKey = this.settings.cmdkTriggerKey;
			if (triggerKey === "none" || e.key !== triggerKey) {
				keyOnly = false;
			}
		});

		this.registerDomEvent(document, "keyup", (e: KeyboardEvent) => {
			const triggerKey = this.settings.cmdkTriggerKey;
			if (triggerKey === "none") return;
			if (e.key === triggerKey) {
				const now = Date.now();
				if (
					keyOnly &&
					now - lastKeyUp < this.settings.cmdkDoubleTapInterval &&
					!document.querySelector(
						".float-search-cmdk-container"
					)
				) {
					lastKeyUp = 0;
					this.openCmdkModal();
				} else {
					lastKeyUp = now;
					keyOnly = true;
				}
			}
		});
	}

	openCmdkModal() {
		if (this.cmdkModal) {
			this.cmdkModal.close();
		}
		this.cmdkModal = new FloatSearchCmdkModal(this);
		this.cmdkModal.open();
	}

	updateFilePathVisibility() {
		const { showFilePath } = this.settings;
		document.body.toggleClass("show-file-path", showFilePath);
	}

	changeFilePathVisibility() {
		this.settings.showFilePath = !this.settings.showFilePath;
		this.updateFilePathVisibility();
		this.applySettingsUpdate();
	}

	initState() {
		// Initialize state with all default properties
		this.state = {
			...DEFAULT_SETTINGS.searchViewState,
			...this.settings.searchViewState,
		};
	}

	initModal(
		state: searchState,
		stateSave: boolean = false,
		clearQuery: boolean = false
	) {
		if (this.modal) {
			this.modal.close();
		}

		this.modal = new FloatSearchModal(
			(state) => {
				// Preserve all state properties when updating from modal
				this.state = {
					...DEFAULT_SETTINGS.searchViewState,
					...state,
				};
				if (stateSave) this.applyStateUpdate();
				this.settings.searchViewState = this.state;
				this.applySettingsUpdate();
			},
			this,
			{ ...state, query: clearQuery ? "" : state.query }
		);
		this.modal.open();
	}

	patchWorkspace() {
		let layoutChanging = false;
		const self = this;
		const uninstaller = around(Workspace.prototype, {
			getLeaf: (next) =>
				function (...args) {
					const activeLeaf = (this as Workspace).activeLeaf;
					if (activeLeaf) {
						// @ts-ignore
						const fsCtnEl = (
							activeLeaf.parent.containerEl as HTMLElement
						).parentElement;
						if (fsCtnEl?.hasClass("fs-content")) {
							if (activeLeaf.view.getViewType() === "markdown") {
								return activeLeaf;
							}

							const newLeaf =
								self.app.workspace.getMostRecentLeaf();

							if (newLeaf) {
								this.setActiveLeaf(newLeaf);
							}
						}
						return next.call(this, ...args);
					}
					return next.call(this, ...args);
				},
			changeLayout(old) {
				return async function (workspace: unknown) {
					layoutChanging = true;
					try {
						// Don't consider hover popovers part of the workspace while it's changing
						await old.call(this, workspace);
					} finally {
						layoutChanging = false;
					}
				};
			},
			iterateLeaves(old) {
				type leafIterator = (item: WorkspaceLeaf) => boolean | void;
				return function (arg1, arg2) {
					// Fast exit if desired leaf found
					if (old.call(this, arg1, arg2)) return true;

					// Handle old/new API parameter swap
					const cb: leafIterator = (
						typeof arg1 === "function" ? arg1 : arg2
					) as leafIterator;
					const parent: WorkspaceItem = (
						typeof arg1 === "function" ? arg2 : arg1
					) as WorkspaceItem;

					if (!parent) return false; // <- during app startup, rootSplit can be null
					if (layoutChanging) return false; // Don't let HEs close during workspace change

					// 0.14.x doesn't have WorkspaceContainer; this can just be an instanceof check once 15.x is mandatory:

					if (!requireApiVersion("0.15.0")) {
						if (
							parent === self.app.workspace.rootSplit ||
							(WorkspaceContainer &&
								parent instanceof WorkspaceContainer)
						) {
							for (const popover of EmbeddedView.popoversForWindow(
								(parent as WorkspaceContainer).win
							)) {
								// Use old API here for compat w/0.14.x
								if (old.call(this, cb, popover.rootSplit))
									return false;
							}
						}
					}
					return false;
				};
			},
			setActiveLeaf(old) {
				return function (leaf: any, params?: any) {
					if (isEmebeddedLeaf(leaf)) {
						old.call(this, leaf, params);
						leaf.activeTime = 1700000000000;
					}
					return old.call(this, leaf, params);
				};
			},
			pushUndoHistory(old: any) {
				return function (
					leaf: WorkspaceLeaf,
					id: string,
					...args: any[]
				) {
					const viewState = leaf.getViewState();
					if (viewState.type === "search") {
						return;
					}
					return old.call(this, leaf, id, ...args);
				};
			},
		});
		this.register(uninstaller);
	}

	// Used for patch workspaceleaf pinned behaviors
	patchWorkspaceLeaf() {
		this.register(
			around(WorkspaceLeaf.prototype, {
				getRoot(old) {
					return function () {
						const top = old.call(this);
						return top?.getRoot === this.getRoot
							? top
							: top?.getRoot();
					};
				},
				setPinned(old) {
					return function (pinned: boolean) {
						old.call(this, pinned);
						if (isEmebeddedLeaf(this) && !pinned)
							this.setPinned(true);
					};
				},
				openFile(old) {
					return function (file: TFile, openState?: OpenViewState) {
						if (isEmebeddedLeaf(this)) {
							setTimeout(
								around(Workspace.prototype, {
									recordMostRecentOpenedFile(old) {
										return function (_file: TFile) {
											// Don't update the quick switcher's recent list
											if (_file !== file) {
												return old.call(this, _file);
											}
										};
									},
								}),
								1
							);
							const recentFiles =
								this.app.plugins.plugins[
									"recent-files-obsidian"
								];
							if (recentFiles) {
								setTimeout(
									around(recentFiles, {
										shouldAddFile(old) {
											return function (_file: TFile) {
												// Don't update the Recent Files plugin
												return (
													_file !== file &&
													old.call(this, _file)
												);
											};
										},
									}),
									1
								);
							}
						}

						const view = old.call(this, file, openState);
						setTimeout(() => {
							const fsCtnEl = (
								this.parent.containerEl as HTMLElement
							).parentElement;
							if (!fsCtnEl?.classList.contains("fs-content"))
								return;
							if (file.extension != "canvas") return;

							const canvas = this.view.canvas;
							setTimeout(() => {
								if (canvas && openState?.eState?.match) {
									let node = canvas.data.nodes?.find(
										(e: any) =>
											e.text ===
											(openState?.eState as any)?.match
												?.content
									);
									if (node) {
										node = canvas.nodes.get(node.id);
										canvas.selectOnly(node);
										canvas.zoomToSelection();
									}
								}
							}, 20);
						}, 1);

						return view;
					};
				},
			})
		);
	}

	patchSearchView() {
		const checkCurrentViewType = (leaf: WorkspaceLeaf) => {
			const isModal =
				document.querySelector(".float-search-modal") !== null;
			const currentLeafRoot = leaf.getRoot();
			if (
				currentLeafRoot?.side &&
				(currentLeafRoot?.side === "left" ||
					currentLeafRoot?.side === "right")
			)
				return "sidebar";
			if (leaf.getContainer()?.type === "window") return "window";
			return isModal ? "modal" : "split";
		};

		const initViewMenu = (
			menu: Menu,
			current: searchType,
			originLeaf?: WorkspaceLeaf
		) => {
			menu.dom.toggleClass("float-search-view-menu", true);
			let availableViews = allViews.filter((view) => {
				if (current === "split") {
					return view.type !== "tab";
				} else {
					return view.type !== current;
				}
			});
			for (const view of availableViews) {
				menu.addItem((item: MenuItem) => {
					item.setTitle(`${view.type} view`)
						.setIcon(`${view.icon}`)
						.onClick(async () => {
							if (view.type === "modal") {
								originLeaf?.detach();
								setTimeout(() => {
									this.initModal(this.state, true, false);
								}, 10);
							} else if (view.type === "sidebar") {
								await initSearchViewWithLeaf(
									this.app,
									view.type,
									this.state
								);
							} else {
								if (current === "window") {
									originLeaf?.detach();
									setTimeout(async () => {
										await initSearchViewWithLeaf(
											this.app,
											<"tab" | "split">view.type,
											this.state
										);
									}, 10);
								} else {
									await initSearchViewWithLeaf(
										this.app,
										view.type,
										this.state
									);
								}
							}
							if (current === "modal") {
								this.modal.close();
							} else {
								originLeaf?.detach();
							}
						});
				});
			}
			return menu;
		};

		const patchSearch = async () => {
			const searchLeaf = this.app.workspace.getLeavesOfType("search")[0];
			if (!searchLeaf) return false;
			if (requireApiVersion("1.7.3") && searchLeaf.isDeferred) {
				await searchLeaf.loadIfDeferred();
			}

			const searchView = searchLeaf?.view as any;
			const self = this;

			if (!searchView) return false;

			const searchViewConstructor = searchView.constructor;

			this.register(
				around(searchViewConstructor.prototype, {
					onOpen(old) {
						return function () {
							old.call(this);

							const viewSwitchEl = createDiv({
								cls: "float-search-view-switch",
							});
							const targetEl = this.filterSectionToggleEl;
							const viewSwitchButton = new ExtraButtonComponent(
								viewSwitchEl
							);
							viewSwitchButton
								.setIcon("layout-template")
								.setTooltip("Switch to File View");
							viewSwitchButton.onClick(() => {
								const currentType = checkCurrentViewType(
									this.leaf
								);
								const layoutMenu = initViewMenu(
									new Menu(),
									currentType,
									this.leaf
								);
								const viewSwitchButtonPos =
									viewSwitchEl.getBoundingClientRect();
								layoutMenu.showAtPosition({
									x: viewSwitchButtonPos.x,
									y: viewSwitchButtonPos.y + 30,
								});
							});
							targetEl.parentElement.insertBefore(
								viewSwitchEl,
								targetEl
							);
							if (!this.hidePathToggle) {
								this.hidePathToggle = new Setting(
									this.searchParamsContainerEl
								)
									.setName("Show file path")
									.addToggle((toggle) => {
										toggle.toggleEl.toggleClass(
											"mod-small",
											true
										);
										toggle
											.setValue(
												self.settings.showFilePath
											)
											.onChange(async (value) => {
												self.settings.showFilePath =
													!value;
												self.changeFilePathVisibility();
												self.applySettingsUpdate();
											});
									});
							}
							if (!this.showInstructionsToggle) {
								this.showInstructionsToggle = new Setting(
									this.searchParamsContainerEl
								)
									.setName("Show instructions")
									.addToggle((toggle) => {
										toggle.toggleEl.toggleClass(
											"mod-small",
											true
										);
										toggle
											.setValue(
												self.settings.showInstructions
											)
											.onChange(async (value) => {
												self.settings.showInstructions =
													value;
												self.applySettingsUpdate();
											});
									});
							}
							if (!this.defaultViewTypeDropdown) {
								this.defaultViewTypeDropdown = new Setting(
									this.searchParamsContainerEl
								)
									.setName("Default view type")
									.addDropdown((dropdown) => {
										dropdown.addOptions({
											modal: "Modal",
											split: "Split",
											tab: "Tab",
											window: "Window",
											sidebar: "Sidebar",
										});
										dropdown.setValue(
											self.settings.defaultViewType
										);
										dropdown.onChange((value) => {
											self.settings.defaultViewType =
												value as searchType;
											self.applySettingsUpdate();
										});
									});
							}
						};
					},
					setExplainSearch(old) {
						return function (value: boolean) {
							old.call(this, value);
							if (self.app.workspace.layoutReady) {
								self.settings.searchViewState.explainSearch =
									value;
								self.applySettingsUpdate();
							}
						};
					},
					setCollapseAll(old) {
						return function (value: boolean) {
							old.call(this, value);
							if (self.app.workspace.layoutReady) {
								self.settings.searchViewState.collapseAll =
									value;
								self.applySettingsUpdate();
							}
						};
					},
					setExtraContext(old) {
						return function (value: boolean) {
							old.call(this, value);
							if (self.app.workspace.layoutReady) {
								self.settings.searchViewState.extraContext =
									value;
								self.applySettingsUpdate();
							}
						};
					},
					setMatchingCase(old) {
						return function (value: boolean) {
							old.call(this, value);
							if (self.app.workspace.layoutReady) {
								self.settings.searchViewState.matchingCase =
									value;
								self.applySettingsUpdate();
							}
						};
					},
					setSortOrder(old) {
						return function (value: string) {
							old.call(this, value);
							if (self.app.workspace.layoutReady) {
								self.settings.searchViewState.sortOrder =
									value as sortOrder;
								self.applySettingsUpdate();
							}
						};
					},
					setQuery(old) {
						return function (value: string) {
							old.call(this, value);
							if (self.app.workspace.layoutReady) {
								self.settings.searchViewState.query = value;
								self.applySettingsUpdate();
							}
						};
					},
					setState(old) {
						return function (
							state: any,
							eState: Record<string, unknown>
						) {
							if (
								typeof state.query === "string" &&
								!state?.triggerBySelf
							) {
								if (self.queryLoaded) {
									if (
										self.settings.defaultViewType ===
										"modal"
									) {
										self.initModal(
											{
												...state,
												query: state.query,
												current: false,
												triggerBySelf: true,
											},
											true,
											false
										);
									} else {
										initSearchViewWithLeaf(
											self.app,
											self.settings.defaultViewType,
											{
												...state,
												query: state.query,
												current: false,
												triggerBySelf: true,
											}
										);
									}

									return;
								}

								self.queryLoaded = true;
							}

							old.call(this, state, eState);
						};
					},
				})
			);
			searchView.leaf?.rebuildView();
			return true;
		};
		this.app.workspace.onLayoutReady(async () => {
			if (!(await patchSearch())) {
				const evt = this.app.workspace.on("layout-change", async () => {
					(await patchSearch()) && this.app.workspace.offref(evt);
				});
				this.registerEvent(evt);
			}
		});
	}

	patchVchildren() {
		const patchSearchDom = () => {
			const searchView = this.app.workspace.getLeavesOfType("search")[0]
				?.view as any;
			if (!searchView) return false;

			const dom = searchView.dom.constructor;
			const self = this;

			this.register(
				around(dom.prototype, {
					stopLoader(old) {
						return function () {
							old.call(this);
							// console.log(this?.vChildren?.children);
							this?.vChildren?.children?.forEach((child: any) => {
								if (child?.file && !child?.pathEl) {
									const path =
										child?.file.parent?.path || "/";
									const pathEl = createDiv({
										cls: "search-result-file-path",
									});
									const pathIconEl = pathEl.createDiv({
										cls: "search-result-file-path-icon",
									});
									setIcon(pathIconEl, "folder");
									const pathTextEl = pathEl.createDiv({
										cls: "search-result-file-path-text",
										text: path,
									});
									child.pathEl = pathEl;
									const titleEl = child.containerEl.find(
										".search-result-file-title"
									);
									titleEl.prepend(pathEl);
								}
							});
						};
					},
				})
			);
			return true;
		};
		this.app.workspace.onLayoutReady(() => {
			if (!patchSearchDom()) {
				const evt = this.app.workspace.on("layout-change", () => {
					patchSearchDom() && this.app.workspace.offref(evt);
				});
				this.registerEvent(evt);
			}
		});
	}

	patchDragManager() {
		const manager = this.app.dragManager;
		if (!manager) return;
		const self = this;

		this.register(
			around(manager.constructor.prototype, {
				dragFile(old: any) {
					return function (e: any, a: TFile) {
						const result = old.call(this, e, a);

						setTimeout(() => {
							self?.modal?.close();
						}, 10);
						return result;
					};
				},
			})
		);
	}

	registerObsidianURIHandler() {
		/**
		 * Handles obsidian://fs protocol for search functionality
		 *
		 * @param viewType - Where to open search:
		 *   - "modal" (default) - Opens in modal popup
		 *   - "tab" - Opens in new tab
		 *   - "split" - Opens in split pane
		 *   - "window" - Opens in new window
		 *   - "sidebar" - Opens in sidebar
		 * @param query - Search query string
		 *
		 * Examples:
		 * obsidian://fs?query=hello&viewType=modal
		 * obsidian://fs?query=world&viewType=tab
		 * obsidian://fs?query=test (defaults to modal)
		 */
		this.registerObsidianProtocolHandler(
			"fs",
			async (path: ObsidianProtocolData) => {
				const viewType = path.viewType || "modal";
				const query = path.query || "";

				if (viewType === "modal") {
					this.initModal(
						{
							...this.state,
							query,
							current: false,
						},
						true,
						false
					);
				} else {
					await initSearchViewWithLeaf(
						this.app,
						viewType as PaneType | "sidebar",
						{
							...this.state,
							query,
							current: false,
						}
					);
				}
			}
		);
	}

	private createCommand(options: {
		id: string;
		name: string;
		queryBuilder: (file?: TFile) => string;
		global: boolean;
	}): void {
		if (options.global) {
			this.addCommand({
				id: options.id,
				name: options.name,
				callback: () => {
					const query = options.queryBuilder();
					const viewType = this.settings.defaultViewType;

					if (viewType === "modal") {
						this.initModal(
							{ ...this.state, query, current: true },
							true,
							false
						);
					} else {
						initSearchViewWithLeaf(
							this.app,
							viewType as PaneType | "sidebar",
							{
								...this.state,
								query,
								current: true,
							}
						);
					}
				},
			});
		} else {
			this.addCommand({
				id: options.id,
				name: options.name,
				checkCallback: (checking: boolean) => {
					const activeLeaf = this.app.workspace.activeLeaf;
					if (!activeLeaf) return;

					const viewType = activeLeaf.view.getViewType();
					if (viewType === "markdown" || viewType === "canvas") {
						if (!checking) {
							const currentFile = activeLeaf.view.file;
							const query = options.queryBuilder(currentFile);
							const viewType = this.settings.defaultViewType;

							if (viewType === "modal") {
								this.initModal(
									{ ...this.state, query, current: true },
									true,
									false
								);
							} else {
								initSearchViewWithLeaf(
									this.app,
									viewType as PaneType | "sidebar",
									{
										...this.state,
										query,
										current: true,
									}
								);
							}
						}
						return true;
					}
				},
			});
		}
	}

	registerObsidianCommands() {
		this.addCommand({
			id: "show-or-hide-file-path",
			name: "Show/hide file path",
			callback: () => {
				this.changeFilePathVisibility();
			},
		});

		this.addCommand({
			id: "search-obsidian-globally",
			name: "Search obsidian globally",
			callback: () =>
				this.initModal(
					{ ...this.state, query: "", current: false },
					false,
					true
				),
		});

		this.addCommand({
			id: "search-obsidian-globally-state",
			name: "Search Obsidian Globally (With Last State)",
			callback: () =>
				this.initModal(
					{ ...this.state, query: this.state.query, current: false },
					true,
					false
				),
		});

		this.createCommand({
			id: "search-in-backlink",
			name: "Search in backlink Of current file",
			queryBuilder: (file?: TFile) => {
				if (!file) return "";
				return (
					" /\\[\\[" +
					(file.extension === "canvas" ? file.name : file.basename) +
					"(\\|[^\\]]*)?\\]\\]/"
				);
			},
			global: false,
		});

		this.createCommand({
			id: "search-in-current-file",
			name: "Search in current file",
			queryBuilder: (file?: TFile) => {
				if (!file) return "";
				return " path:" + `"${file.path}"`;
			},
			global: false,
		});

		// Register search operator commands
		this.registerSearchOperatorCommands();

		for (const type of ["split", "tab", "window"] as PaneType[]) {
			this.addCommand({
				id: `open-search-view-${type}`,
				name: `Open search view (${type})`,
				callback: async () => {
					const existingLeaf =
						this.app.workspace.getLeavesOfType("search");
					switch (type) {
						case "window":
							// @ts-ignore
							const isExistingWindowLeaf = existingLeaf.find(
								(leaf) =>
									leaf.parentSplit.parent.type === "window"
							);
							if (isExistingWindowLeaf) {
								this.app.workspace.revealLeaf(
									isExistingWindowLeaf
								);
								return;
							}
							await initSearchViewWithLeaf(this.app, type, {
								...this.state,
								triggerBySelf: true,
							});
							break;
						case "tab":
						case "split":
							// @ts-ignore
							const isExistingLeaf = existingLeaf.find(
								(leaf) => !leaf.parentSplit.parent.side
							);
							if (isExistingLeaf) {
								this.app.workspace.revealLeaf(isExistingLeaf);
								isExistingLeaf.setViewState({
									type: "search",
									active: true,
									state: {
										...this.state,
										triggerBySelf: true,
									} as Record<string, unknown>,
								});
								return;
							}
							await initSearchViewWithLeaf(this.app, type, {
								...this.state,
								triggerBySelf: true,
							});
							break;
					}
				},
			});
		}
	}

	registerSearchOperatorCommands() {
		const searchOperators = [
			{
				id: "search-file-operator",
				name: "Search: file: (Find text in filename)",
				query: "file:",
			},
			{
				id: "search-path-operator",
				name: "Search: path: (Find text in file path)",
				query: "path:",
			},
			{
				id: "search-content-operator",
				name: "Search: content: (Find text in file content)",
				query: "content:",
			},
			{
				id: "search-match-case-operator",
				name: "Search: match-case: (Case-sensitive match)",
				query: "match-case:",
			},
			{
				id: "search-ignore-case-operator",
				name: "Search: ignore-case: (Case-insensitive match)",
				query: "ignore-case:",
			},
			{
				id: "search-tag-operator",
				name: "Search: tag: (Find tag)",
				query: "tag:",
			},
			{
				id: "search-line-operator",
				name: "Search: line: (Find files with matching line)",
				query: "line:",
			},
			{
				id: "search-block-operator",
				name: "Search: block: (Find matches in the same block)",
				query: "block:",
			},
			{
				id: "search-section-operator",
				name: "Search: section: (Find matches in the same section)",
				query: "section:",
			},
			{
				id: "search-task-operator",
				name: "Search: task: (Find matches in a task)",
				query: "task:",
			},
			{
				id: "search-task-todo-operator",
				name: "Search: task-todo: (Find matches in uncompleted tasks)",
				query: "task-todo:",
			},
			{
				id: "search-task-done-operator",
				name: "Search: task-done: (Find matches in completed tasks)",
				query: "task-done:",
			},
			{
				id: "search-property",
				name: "Search: [property] or [property:value]",
				query: "[]",
			},
		];

		// Register all search operator commands
		searchOperators.forEach((operator) => {
			this.createCommand({
				id: operator.id,
				name: operator.name,
				queryBuilder: () => operator.query || "",
				global: true,
			});
		});
	}

	registerEditorMenuHandler() {
		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				(menu: Menu, editor: Editor) => {
					if (!editor) {
						return;
					}
					if (editor.getSelection().length === 0) {
						return;
					}
					const selection = editor.getSelection().trim();
					let searchWord = selection;

					if (selection.length > 8) {
						searchWord =
							selection.substring(0, 3) +
							"..." +
							selection.substring(
								selection.length - 3,
								selection.length
							);
					} else {
						searchWord = selection;
					}

					menu.addItem((item) => {
						// Add sub menu
						item.setTitle(
							'Search "' + searchWord + '"' + " in Float Search"
						)
							.setIcon("search")
							.onClick(() =>
								this.initModal(
									{
										...this.state,
										query: selection,
										current: false,
									},
									true,
									false
								)
							);
					});
				}
			)
		);
	}

	registerContextMenuHandler() {
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(
					menu: Menu,
					file: TAbstractFile,
					source: string,
					leaf?: WorkspaceLeaf
				) => {
					const popover = leaf
						? EmbeddedView.forLeaf(leaf)
						: undefined;
					if (file instanceof TFile && !popover && !leaf) {
						menu.addItem((item) => {
							item.setIcon("popup-open")
								.setTitle("Open in Float Preview")
								.onClick(async () => {
									if (this.modal) {
										await this.modal.initFileView(
											file,
											undefined
										);

										return;
									}

									this.initModal(
										{ ...this.state, current: false },
										true,
										true
									);
									setTimeout(async () => {
										await this.modal.initFileView(
											file,
											undefined
										);
									}, 20);
								})
								.setSection?.("open");
						});
					}
				}
			)
		);
	}

	registerIcons() {
		addIcon(
			"panel-left-inactive",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 13.999688 L 9 15 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 19.000312 L 9 21 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 3 L 9 4.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 9 L 9 10.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
		addIcon(
			"app-window",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.000312 4.000312 L 19.999688 4.000312 C 21.105 4.000312 22.000312 4.895625 22.000312 6 L 22.000312 18 C 22.000312 19.104375 21.105 19.999688 19.999688 19.999688 L 4.000312 19.999688 C 2.895 19.999688 1.999687 19.104375 1.999687 18 L 1.999687 6 C 1.999687 4.895625 2.895 4.000312 4.000312 4.000312 Z M 4.000312 4.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 10.000312 4.000312 L 10.000312 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 1.999687 7.999687 L 22.000312 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 6 4.000312 L 6 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
		addIcon(
			"panel-top",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 3 9 L 21 9 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
		addIcon(
			"square-equal",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 7.000312 10.000312 L 16.999688 10.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 7.000312 13.999688 L 16.999688 13.999688 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

const TRIGGER_KEY_OPTIONS: Record<CmdkTriggerKey, string> = {
	Shift: "Double Shift",
	Control: "Double Ctrl",
	Alt: "Double Alt",
	Meta: "Double Meta (Cmd/Win)",
	none: "Disabled",
};

class FloatSearchSettingTab extends PluginSettingTab {
	plugin: FloatSearchPlugin;

	constructor(app: App, plugin: FloatSearchPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Float Search Settings" });

		new Setting(containerEl)
			.setName("Quick search trigger")
			.setDesc(
				"Double-tap this key to open the quick search modal (CMDK)."
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(
					TRIGGER_KEY_OPTIONS
				)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.cmdkTriggerKey);
				dropdown.onChange(async (value) => {
					this.plugin.settings.cmdkTriggerKey =
						value as CmdkTriggerKey;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Double-tap interval (ms)")
			.setDesc(
				"Maximum time between two key presses to trigger quick search. Default: 300ms."
			)
			.addSlider((slider) => {
				slider
					.setLimits(150, 600, 50)
					.setValue(this.plugin.settings.cmdkDoubleTapInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.cmdkDoubleTapInterval =
							value;
						await this.plugin.saveSettings();
					});
			});
	}
}

function createInstructionElement(
	parentEl: HTMLElement,
	divCls: string,
	keyText: string,
	text: string
) {
	const divEl = parentEl.createDiv({ cls: divCls });
	const iconEl = divEl.createSpan({
		cls: "float-search-modal-instructions-key",
	});
	const textEl = divEl.createSpan({
		cls: "float-search-modal-instructions-text",
	});

	iconEl.setText(keyText);
	textEl.setText(text);

	return { divEl, iconEl, textEl };
}

class FloatSearchModal extends Modal {
	private readonly plugin: FloatSearchPlugin;
	private searchEmbeddedView: EmbeddedView;
	private fileEmbeddedView: EmbeddedView;

	searchLeaf: WorkspaceLeaf;
	fileLeaf: WorkspaceLeaf | undefined;

	private cb: (state: any) => void;
	private state: any;

	private fileState: any;

	private searchCtnEl: HTMLElement;
	private instructionsEl: HTMLElement;
	private fileEl: HTMLElement;
	private viewType: string;

	private focusdItem: any;

	private debouncedAutoPreview = debounce(() => {
		this.autoPreviewFocusedItem();
	}, 150);

	constructor(
		cb: (state: any) => void,
		plugin: FloatSearchPlugin,
		state: any,
		viewType: string = "search"
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.cb = cb;
		this.state = state;
		this.viewType = viewType;
	}

	async onOpen() {
		const { contentEl, containerEl, modalEl } = this;

		this.searchCtnEl = contentEl.createDiv({
			cls: "float-search-modal-search-ctn",
		});
		this.instructionsEl = modalEl.createDiv({
			cls: "float-search-modal-instructions",
		});

		this.initInstructions(this.instructionsEl);
		this.initCss(contentEl, modalEl, containerEl);
		await this.initSearchView(this.searchCtnEl);
		this.initInput();
		this.initContent();
	}

	onClose() {
		const { contentEl } = this;

		this.cb(this.searchLeaf.view.getState());

		this.searchLeaf.detach();
		this.fileLeaf?.detach();
		this.searchEmbeddedView.unload();
		this.fileEmbeddedView?.unload();
		contentEl.empty();
	}

	initInstructions(instructionsEl: HTMLElement) {
		if (!this.plugin.settings.showInstructions) {
			return;
		}
		const navigate = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-navigate",
			"↑↓",
			"Navigate"
		);
		const collapse = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-collapse",
			"Shift+↑↓",
			"Collapse/Expand"
		);
		const enter = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-enter",
			"↵",
			"Open in background"
		);
		const altEnter = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-alt-enter",
			"Alt+↵",
			"Open File and Close"
		);
		const ctrlEnter = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-ctrl-enter",
			"Ctrl+↵",
			"Create File When Not Exist"
		);
		const tab = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-tab",
			"Tab/Shift+Tab",
			"Preview/Close Preview"
		);
		const switchView = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-switch",
			"Ctrl+G",
			"Switch Between Search and File View"
		);
		const click = createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-click",
			"Alt+Click",
			"Close Modal While In File View"
		);
	}

	initCss(
		contentEl: HTMLElement,
		modalEl: HTMLElement,
		containerEl: HTMLElement
	) {
		contentEl.classList.add("float-search-modal-content");
		modalEl.classList.add("float-search-modal");
		containerEl.classList.add("float-search-modal-container");
	}

	async initSearchView(contentEl: HTMLElement) {
		const [createdLeaf, embeddedView] = spawnLeafView(
			this.plugin,
			contentEl
		);
		this.searchLeaf = createdLeaf;
		this.searchEmbeddedView = embeddedView;

		this.searchLeaf.setPinned(true);
		await this.searchLeaf.setViewState({
			type: "search",
			state: { ...this.state, triggerBySelf: true },
		});

		setTimeout(async () => {
			await this.searchLeaf.view.setState(
				{ ...this.state, triggerBySelf: true },
				{ history: false }
			);
			const searchComponent = (this.searchLeaf.view as SearchView)
				.searchComponent;
			if (searchComponent?.inputEl) {
				this.state?.current
					? searchComponent.inputEl.setSelectionRange(0, 0)
					: searchComponent.inputEl.setSelectionRange(
							0,
							this.state?.query?.length
					  );
			}
		}, 0);

		return;
	}

	initInput(retries = 10) {
		const inputEl = this.contentEl.getElementsByTagName("input")[0];
		if (!inputEl) {
			if (retries > 0) {
				setTimeout(() => this.initInput(retries - 1), 50);
			}
			return;
		}
		inputEl.focus();
		inputEl.onkeydown = (e) => {
			const currentView = this.searchLeaf.view as SearchView;
			switch (e.key) {
				case "ArrowDown":
				case "n":
					if (e.key === "n" && !e.ctrlKey) break;
					if (e.key === "n") e.preventDefault();

					if (e.shiftKey) {
						currentView.onKeyShowMoreAfter(e);
						if (currentView.dom.focusedItem) {
							if (currentView.dom.focusedItem.collapsible) {
								currentView.dom.focusedItem.setCollapse(false);
							}
							this.focusdItem = currentView.dom.focusedItem;
						}
					} else {
						currentView.onKeyArrowDownInFocus(e);
						this.focusdItem = currentView.dom.focusedItem;
						this.debouncedAutoPreview();
					}
					break;
				case "ArrowUp":
				case "p":
					if (e.key === "p" && !e.ctrlKey) break;
					if (e.key === "p") e.preventDefault();

					if (e.shiftKey) {
						currentView.onKeyShowMoreBefore(e);
						if (currentView.dom.focusedItem) {
							if (currentView.dom.focusedItem.collapseEl) {
								currentView.dom.focusedItem.setCollapse(true);
							}
							this.focusdItem = currentView.dom.focusedItem;
						}
					} else {
						currentView.onKeyArrowUpInFocus(e);
						this.focusdItem = currentView.dom.focusedItem;
						if (!currentView.dom.focusedItem.content) {
							this.focusdItem = undefined;
						}
						this.debouncedAutoPreview();
					}
					break;
				case "ArrowLeft":
					currentView.onKeyArrowLeftInFocus(e);
					break;
				case "ArrowRight":
					currentView.onKeyArrowRightInFocus(e);
					break;
				case "Enter":
					if (
						Keymap.isModifier(e, "Mod") &&
						Keymap.isModifier(e, "Shift") &&
						!this.focusdItem
					) {
						e.preventDefault();
						const fileName = inputEl.value.trim();
						const real = fileName.replace(/[/\\?%*:|"<>]/g, "-");
						this.plugin.app.workspace.openLinkText(real, "", true);
						this.close();
						break;
					}
					currentView.onKeyEnterInFocus(e);
					if (e.altKey && currentView.dom.focusedItem) {
						this.close();
					}
					break;
				case "Tab":
					e.preventDefault();
					if (e.shiftKey) {
						if (this.fileLeaf) {
							this.fileLeaf?.detach();
							this.fileLeaf = undefined;
							this.fileEmbeddedView?.unload();
							this.modalEl.toggleClass(
								"float-search-width",
								false
							);
							this.fileEl.detach();

							break;
						}
					}

					if (currentView.dom.focusedItem) {
						const item = currentView.dom.focusedItem;
						const file =
							item.parent.file instanceof TFile
								? item.parent.file
								: item.file;

						item.parent.file instanceof TFile
							? this.initFileView(file, {
									match: {
										content: item.content,
										matches: item.matches,
									},
							  })
							: this.initFileView(file, undefined);
					}
					break;
				case "e":
					if (e.ctrlKey) {
						e.preventDefault();
						if (this.fileLeaf) {
							const estate = this.fileLeaf.getViewState();
							estate.state = {
								...estate.state,
								mode:
									"preview" === estate.state?.mode
										? "source"
										: "preview",
							};
							this.fileLeaf.setViewState(estate, {
								focus: true,
							});
							setTimeout(() => {
								(
									this.searchLeaf.view as SearchView
								).searchComponent?.inputEl?.focus();
							}, 0);
						}
					}
					break;
				case "g":
					if (this.fileLeaf && e.ctrlKey) {
						e.preventDefault();
						this.plugin.app.workspace.setActiveLeaf(this.fileLeaf, {
							focus: true,
						});
					}
					break;
				case "C":
					if (e.ctrlKey && e.shiftKey) {
						e.preventDefault();
						const text = currentView.dom.focusedItem.el.innerText;
						navigator.clipboard.writeText(text);
					}
					break;
			}
		};
	}

	private autoPreviewFocusedItem() {
		const currentView = this.searchLeaf.view as SearchView;
		const item = currentView.dom?.focusedItem;
		if (!item) return;

		const file =
			item.parent?.file instanceof TFile
				? item.parent.file
				: item.file;
		if (!(file instanceof TFile)) return;

		const state =
			item.parent?.file instanceof TFile
				? {
						match: {
							content: item.content,
							matches: item.matches,
						},
				  }
				: undefined;

		this.initFileView(file, state);
	}

	initContent() {
		const { contentEl } = this;
		contentEl.onclick = (e) => {
			const resultElement = contentEl.getElementsByClassName(
				"search-results-children"
			)[0];
			if (resultElement.children.length < 2) {
				return;
			}

			let targetElement = e.target as HTMLElement | null;

			if (e.altKey || !this.fileLeaf) {
				while (targetElement) {
					if (targetElement.classList.contains("tree-item-icon")) {
						break;
					}
					if (
						targetElement.classList.contains(
							"search-result-hover-button"
						)
					) {
						break;
					}
					if (targetElement.classList.contains("tree-item")) {
						this.close();
						break;
					}
					targetElement = targetElement.parentElement;
				}
				return;
			}

			if (this.fileLeaf) {
				const currentView = this.searchLeaf.view as SearchView;

				if (
					(this.searchCtnEl as Node).contains(targetElement as Node)
				) {
					while (targetElement) {
						if (targetElement.classList.contains("tree-item")) {
							break;
						}
						targetElement = targetElement.parentElement;
					}
					if (!targetElement) return;

					const fileInnerEl = targetElement?.getElementsByClassName(
						"tree-item-inner"
					)[0] as HTMLElement;
					const innerText = fileInnerEl.innerText;
					const file =
						this.plugin.app.metadataCache.getFirstLinkpathDest(
							innerText,
							""
						);

					if (file) {
						const item = currentView.dom.resultDomLookup.get(file);
						currentView.dom.setFocusedItem(item);
						this.initFileView(file, undefined);
						(
							this.searchLeaf.view as SearchView
						).searchComponent?.inputEl?.focus();
					}
				}

				return;
			}
		};
	}

	async initFileView(file: TFile, state: any) {
		if (this.fileLeaf) {
			await this.fileLeaf.openFile(file, {
				active: false,
				eState: state,
			});

			if (
				this.fileState?.match?.matches[0] ===
					state?.match?.matches[0] &&
				state &&
				this.fileState
			) {
				setTimeout(() => {
					if (this.fileLeaf) {
						this.plugin.app.workspace.setActiveLeaf(this.fileLeaf, {
							focus: true,
						});
					}
				}, 0);
			} else {
				this.fileState = state;
				setTimeout(() => {
					(
						this.searchLeaf.view as SearchView
					).searchComponent?.inputEl?.focus();
				}, 0);
			}

			return;
		}

		const { contentEl } = this;
		this.fileEl = contentEl.createDiv({
			cls: "float-search-modal-file-ctn",
		});
		this.modalEl.toggleClass("float-search-width", true);
		this.fileEl.onkeydown = (e) => {
			if (e.ctrlKey && e.key === "g") {
				e.preventDefault();
				e.stopPropagation();

				(
					this.searchLeaf.view as SearchView
				).searchComponent?.inputEl?.focus();
			}

			if (e.key === "Tab" && e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();

				(
					this.searchLeaf.view as SearchView
				).searchComponent?.inputEl?.focus();
			}
		};

		if (!this.fileEl) return;

		const [createdLeaf, embeddedView] = spawnLeafView(
			this.plugin,
			this.fileEl
		);
		this.fileLeaf = createdLeaf;
		this.fileEmbeddedView = embeddedView;

		this.fileLeaf.setPinned(true);
		await this.fileLeaf.openFile(file, {
			active: false,
			eState: state,
		});
		this.fileState = state;

		(this.searchLeaf.view as SearchView).searchComponent?.inputEl?.focus();
	}
}

interface CmdkResult {
	file: TFile;
	nameMatch: SearchResult | null;
	pathMatch: SearchResult | null;
	heading?: string;
	headingMatch?: SearchResult | null;
	content?: string;
	contentMatch?: SearchResult | null;
	line?: number;
	type: "file" | "heading" | "content";
}

class FloatSearchCmdkModal extends SuggestModal<CmdkResult> {
	plugin: FloatSearchPlugin;
	private bodyEl: HTMLElement;
	private previewEl: HTMLElement | undefined;
	private fileLeaf: WorkspaceLeaf | undefined;
	private fileEmbeddedView: EmbeddedView | undefined;
	private searchAbort: AbortController | null = null;

	constructor(plugin: FloatSearchPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.limit = 50;
		this.setPlaceholder("Search files and content...");
		this.setInstructions([
			{ command: "↑↓", purpose: "Navigate" },
			{ command: "↵", purpose: "Open" },
			{ command: "Shift ↵", purpose: "New tab" },
			{ command: "esc", purpose: "Close" },
		]);
		this.modalEl.addClass("float-search-cmdk");
		this.containerEl.addClass("float-search-cmdk-container");
	}

	onOpen() {
		super.onOpen();
		this.bodyEl = createDiv("float-search-cmdk-body");
		this.modalEl.insertBefore(
			this.bodyEl,
			(this as any).resultContainerEl
		);
		this.bodyEl.appendChild((this as any).resultContainerEl);
	}

	// Required by SuggestModal but unused — we drive the chooser directly
	getSuggestions(_query: string): CmdkResult[] {
		return [];
	}

	// Override to use progressive rendering via chooser.addSuggestion
	updateSuggestions() {
		// Cancel previous in-flight search
		this.searchAbort?.abort();
		const abort = (this.searchAbort = new AbortController());
		const { signal } = abort;

		const chooser = (this as any).chooser;
		const query = this.inputEl.value;

		const files = this.app.vault.getFiles().filter(
			(f: TFile) =>
				f.extension === "md" ||
				f.extension === "canvas" ||
				f.extension === "pdf"
		);

		// Empty query — show recent files
		if (!query.trim()) {
			const recent = files
				.sort((a: TFile, b: TFile) => b.stat.mtime - a.stat.mtime)
				.slice(0, this.limit)
				.map((file: TFile) => ({
					file,
					nameMatch: null,
					pathMatch: null,
					type: "file" as const,
				}));
			chooser.setSuggestions(recent);
			return;
		}

		// Phase 1: file name/path fuzzy (sync, instant)
		const fuzzy = prepareFuzzySearch(query);
		const fileResults: CmdkResult[] = [];

		for (const file of files) {
			const nameMatch = fuzzy(file.basename);
			const pathMatch = fuzzy(file.path);
			if (nameMatch || pathMatch) {
				fileResults.push({
					file,
					nameMatch,
					pathMatch,
					type: "file",
				});
			}
		}

		fileResults.sort((a, b) => {
			const sa = Math.max(
				a.nameMatch?.score ?? -Infinity,
				(a.pathMatch?.score ?? -Infinity) * 0.5
			);
			const sb = Math.max(
				b.nameMatch?.score ?? -Infinity,
				(b.pathMatch?.score ?? -Infinity) * 0.5
			);
			return sb - sa;
		});

		// Render file results immediately
		chooser.setSuggestions(fileResults.slice(0, this.limit));

		// Phase 2: heading search — progressive, batched via setTimeout
		if (query.trim().length >= 2) {
			this.progressiveHeadingSearch(
				files,
				fuzzy,
				chooser,
				signal
			);

			// Phase 3: content search — progressive, async (reads file content)
			this.progressiveContentSearch(
				files,
				query,
				chooser,
				signal
			);
		}
	}

	private progressiveHeadingSearch(
		files: TFile[],
		fuzzy: (text: string) => SearchResult | null,
		chooser: any,
		signal: AbortSignal
	) {
		const BATCH_SIZE = 50; // files per tick
		let idx = 0;
		let added = 0;
		const MAX_HEADING_RESULTS = 20;

		const processBatch = () => {
			if (signal.aborted) return;

			const end = Math.min(idx + BATCH_SIZE, files.length);
			for (; idx < end; idx++) {
				if (added >= MAX_HEADING_RESULTS) return;
				const file = files[idx];
				const cache =
					this.app.metadataCache.getFileCache(file);
				if (!cache?.headings) continue;

				for (const h of cache.headings) {
					const headingMatch = fuzzy(h.heading);
					if (headingMatch) {
						chooser.addSuggestion({
							file,
							nameMatch: null,
							pathMatch: null,
							heading: h.heading,
							headingMatch,
							type: "heading",
						});
						added++;
						if (added >= MAX_HEADING_RESULTS) return;
					}
				}
			}

			// More files to process — yield to event loop
			if (idx < files.length && added < MAX_HEADING_RESULTS) {
				setTimeout(processBatch, 0);
			}
		};

		// Start first batch on next microtask so file results render first
		setTimeout(processBatch, 0);
	}

	private progressiveContentSearch(
		files: TFile[],
		query: string,
		chooser: any,
		signal: AbortSignal
	) {
		const BATCH_SIZE = 50;
		const MAX_CONTENT_RESULTS = 20;
		const DURATION_LIMIT = 5; // ms before yielding
		const simpleSearch = prepareSimpleSearch(query);
		let idx = 0;
		let added = 0;

		const processBatch = async () => {
			if (signal.aborted) return;
			const start = performance.now();

			for (; idx < files.length; idx++) {
				if (signal.aborted || added >= MAX_CONTENT_RESULTS) return;

				// Adaptive yielding: check time every BATCH_SIZE items
				if (idx % BATCH_SIZE === 0 && idx > 0) {
					if (performance.now() - start > DURATION_LIMIT) {
						setTimeout(processBatch, 0);
						return;
					}
				}

				const file = files[idx];
				if (file.extension !== "md") continue;

				let text: string;
				try {
					text = await this.app.vault.cachedRead(file);
				} catch {
					continue;
				}

				const result = simpleSearch(text);
				if (!result) continue;

				// Compute line number and context from first match offset
				const matchStart = result.matches[0][0];
				let line = 0;
				let lineStart = 0;
				for (let i = 0; i < matchStart; i++) {
					if (text.charCodeAt(i) === 10) {
						line++;
						lineStart = i + 1;
					}
				}
				let lineEnd = text.indexOf("\n", lineStart);
				if (lineEnd === -1) lineEnd = text.length;
				const lineText = text.substring(lineStart, lineEnd).trim();

				// Recompute match on the line for highlight offsets
				const lineMatch = simpleSearch(lineText);

				chooser.addSuggestion({
					file,
					nameMatch: null,
					pathMatch: null,
					content: lineText,
					contentMatch: lineMatch,
					line,
					type: "content",
				} as CmdkResult);
				added++;
				if (added >= MAX_CONTENT_RESULTS) return;
			}
		};

		// Start after heading search has a chance to render
		setTimeout(processBatch, 50);
	}

	renderSuggestion(result: CmdkResult, el: HTMLElement) {
		el.addClass("mod-complex");
		const contentEl = el.createDiv("suggestion-content");

		if (result.type === "content" && result.content) {
			const titleEl = contentEl.createDiv("suggestion-title");
			if (result.contentMatch) {
				renderResults(titleEl, result.content, result.contentMatch);
			} else {
				titleEl.setText(result.content);
			}
			const noteEl = contentEl.createDiv("suggestion-note");
			noteEl.setText(result.file.path);
		} else if (result.type === "heading" && result.heading) {
			const titleEl = contentEl.createDiv("suggestion-title");
			if (result.headingMatch) {
				renderResults(titleEl, result.heading, result.headingMatch);
			} else {
				titleEl.setText(result.heading);
			}
			const noteEl = contentEl.createDiv("suggestion-note");
			noteEl.setText(result.file.path);
		} else {
			const titleEl = contentEl.createDiv("suggestion-title");
			if (result.nameMatch) {
				renderResults(
					titleEl,
					result.file.basename,
					result.nameMatch
				);
			} else {
				titleEl.setText(result.file.basename);
			}

			const noteEl = contentEl.createDiv("suggestion-note");
			const parentPath = result.file.parent?.path || "/";
			if (result.pathMatch) {
				renderResults(noteEl, parentPath, result.pathMatch);
			} else {
				noteEl.setText(parentPath);
			}
		}

		if (result.file.extension !== "md") {
			el.createDiv("suggestion-aux")
				.createSpan("suggestion-flair")
				.setText(result.file.extension);
		}
	}

	onChooseSuggestion(
		result: CmdkResult,
		evt: MouseEvent | KeyboardEvent
	) {
		const leaf = Keymap.isModEvent(evt)
			? this.app.workspace.getLeaf("tab")
			: this.app.workspace.getMostRecentLeaf() ??
				this.app.workspace.getLeaf();

		const eState: Record<string, any> = {};
		if (result.type === "heading" && result.heading) {
			eState.subpath = "#" + result.heading;
		} else if (result.type === "content" && result.line != null) {
			eState.line = result.line;
		}

		leaf.setViewState({
			type: result.file.extension === "pdf" ? "pdf" : "markdown",
			state: { file: result.file.path },
			active: true,
		}).then(() => {
			if (eState.subpath || eState.line != null) {
				leaf.setEphemeralState(eState);
			}
		});
	}

	// Called by internal Chooser on selection change
	// @ts-ignore
	onSelectedChange = debounce(
		(result: CmdkResult, _evt: Event | null) => {
			if (result?.file) this.showPreview(result);
		},
		100
	);

	async showPreview(result: CmdkResult) {
		if (!this.previewEl) {
			this.previewEl = this.bodyEl.createDiv(
				"float-search-cmdk-preview"
			);
			this.modalEl.addClass("float-search-cmdk-expanded");
			const [leaf, view] = spawnLeafView(
				this.plugin,
				this.previewEl
			);
			this.fileLeaf = leaf;
			this.fileEmbeddedView = view;
			this.fileLeaf.setPinned(true);
		}

		const file = result.file;
		await this.fileLeaf!.openFile(file, { active: false });

		const eState: Record<string, any> = {};
		if (result.type === "heading" && result.heading) {
			eState.subpath = "#" + result.heading;
		} else if (result.type === "content" && result.line != null) {
			eState.line = result.line;
		}

		if (eState.subpath || eState.line != null) {
			this.fileLeaf!.setViewState({
				type: file.extension === "pdf" ? "pdf" : "markdown",
				state: { file: file.path },
			}).then(() => {
				this.fileLeaf?.setEphemeralState(eState);
			});
		}

		this.inputEl.focus();
	}

	onClose() {
		this.fileLeaf?.detach();
		this.fileEmbeddedView?.unload();
	}
}
