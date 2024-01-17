import {
	addIcon,
	App,
	Editor, ExtraButtonComponent,
	Menu, MenuItem,
	Modal, OpenViewState, PaneType,
	Plugin, Scope, SearchView, setIcon,
	TAbstractFile,
	TFile, ViewStateResult,
	Workspace,
	WorkspaceContainer, WorkspaceItem,
	WorkspaceLeaf
} from 'obsidian';
import { EmbeddedView, isEmebeddedLeaf, spawnLeafView } from "./leafView";
import { around } from "monkey-around";

type sortOrder =
	"alphabetical"
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

interface searchState {
	collapseAll?: boolean;
	explainSearch?: boolean;
	extraContext?: boolean;
	matchingCase?: boolean;
	query: string;
	sortOrder?: sortOrder;
	current?: boolean;
}

interface FloatSearchSettings {
	searchViewState: searchState;
}


const DEFAULT_SETTINGS: FloatSearchSettings = {
	searchViewState: {
		collapseAll: false,
		explainSearch: false,
		extraContext: false,
		matchingCase: false,
		query: "",
		sortOrder: "alphabetical",
	}
};

const allViews: viewType[] = [{
	type: "modal",
	icon: "square-equal"
}, {
	type: "sidebar",
	icon: "panel-left-inactive"
}, {
	type: "split",
	icon: "split-square-horizontal"
}, {
	type: "tab",
	icon: "panel-top"
}, {
	type: "window",
	icon: "app-window"
}];

const initSearchViewWithLeaf = async (app: App, type: PaneType | 'sidebar', state?: searchState) => {
	const leaf = type === 'sidebar' ? app.workspace.getLeftLeaf(false) : app.workspace.getLeaf(type);
	leaf.setPinned(type !== 'sidebar');
	await leaf.setViewState({
		type: "search",
		active: true,
		state: state
	});

	setTimeout(() => {
		const inputEl = leaf.containerEl.getElementsByTagName("input")[0];
		inputEl.focus();
	}, 0);
};

export default class FloatSearchPlugin extends Plugin {
	settings: FloatSearchSettings;
	private state: any;
	private modal: FloatSearchModal;

	private applyStateDebounceTimer = 0;
	private applySettingsDebounceTimer = 0;


	public applySettingsUpdate() {
		clearTimeout(this.applySettingsDebounceTimer);
		this.applySettingsDebounceTimer = window.setTimeout(async () => {
			await this.saveSettings();
		}, 1000);
	}

	private applyStateUpdate() {
		this.applyStateDebounceTimer = window.setTimeout(() => {
			clearTimeout(this.applyStateDebounceTimer);
			this.state = {
				...this.state,
				query: "",
			};
		}, 30000);
	}

	async onload() {
		await this.loadSettings();
		this.initState();
		this.registerIcons();

		this.patchWorkspace();
		this.patchWorkspaceLeaf();
		this.patchSearchView();

		this.registerObsidianURIHandler();
		this.registerObsidianCommands();
		this.registerEditorMenuHandler();
		this.registerContextMenuHandler();

		this.addRibbonIcon('search', 'Search Obsidian In Modal', () => this.initModal(this.state, true, true));
	}

	onunload() {
		this.state = undefined;
		this.modal?.close();
	}

	registerIcons() {
		addIcon('panel-left-inactive', `<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 13.999688 L 9 15 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 19.000312 L 9 21 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 3 L 9 4.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 9 L 9 10.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`);
		addIcon('app-window', `<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.000312 4.000312 L 19.999688 4.000312 C 21.105 4.000312 22.000312 4.895625 22.000312 6 L 22.000312 18 C 22.000312 19.104375 21.105 19.999688 19.999688 19.999688 L 4.000312 19.999688 C 2.895 19.999688 1.999687 19.104375 1.999687 18 L 1.999687 6 C 1.999687 4.895625 2.895 4.000312 4.000312 4.000312 Z M 4.000312 4.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 10.000312 4.000312 L 10.000312 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 1.999687 7.999687 L 22.000312 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 6 4.000312 L 6 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`);
		addIcon('panel-top', `<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 3 9 L 21 9 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`);
		addIcon('square-equal', `<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 7.000312 10.000312 L 16.999688 10.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 7.000312 13.999688 L 16.999688 13.999688 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`);
	}

	initState() {
		this.state = this.settings.searchViewState as searchState;
	}

	initModal(state: searchState, stateSave: boolean = false, clearQuery: boolean = false) {
		this.modal = new FloatSearchModal((state) => {
			this.state = state;
			if (stateSave) this.applyStateUpdate();
			this.settings.searchViewState = state as searchState;
			this.applySettingsUpdate();
		}, this, {...state, query: clearQuery ? "" : state.query});
		this.modal.open();
	}

	patchWorkspace() {
		let layoutChanging = false;
		const uninstaller = around(Workspace.prototype, {
			getLeaf: (next) =>
				function (...args) {
					const activeLeaf = this.activeLeaf;
					if (activeLeaf) {
						const fsCtnEl = (activeLeaf.parent.containerEl as HTMLElement).parentElement;
						if (fsCtnEl?.hasClass("fs-content")) {
							if (activeLeaf.view.getViewType() === "markdown") {
								return activeLeaf;
							}
							const newLeaf = app.workspace.getUnpinnedLeaf();
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
					const cb: leafIterator = (typeof arg1 === "function" ? arg1 : arg2) as leafIterator;
					const parent: WorkspaceItem = (typeof arg1 === "function" ? arg2 : arg1) as WorkspaceItem;

					if (!parent) return false;  // <- during app startup, rootSplit can be null
					if (layoutChanging) return false;  // Don't let HEs close during workspace change

					// 0.14.x doesn't have WorkspaceContainer; this can just be an instanceof check once 15.x is mandatory:
					if (parent === app.workspace.rootSplit || (WorkspaceContainer && parent instanceof WorkspaceContainer)) {
						for (const popover of EmbeddedView.popoversForWindow((parent as WorkspaceContainer).win)) {
							// Use old API here for compat w/0.14.x
							if (old.call(this, cb, popover.rootSplit)) return true;
						}
					}
					return false;
				};
			},
			onDragLeaf(old) {
				return function (event: MouseEvent, leaf: WorkspaceLeaf) {
					return old.call(this, event, leaf);
				};
			},
			pushUndoHistory(old: any) {
				return function (leaf: WorkspaceLeaf, id: string, ...args: any[]) {
					const viewState = leaf.getViewState();
					if (viewState.type === "search") {
						return;
					}
					return old.call(this, leaf, id, ...args);
				};
			}
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
						return top?.getRoot === this.getRoot ? top : top?.getRoot();
					};
				},
				setPinned(old) {
					return function (pinned: boolean) {
						old.call(this, pinned);
						if (isEmebeddedLeaf(this) && !pinned) this.setPinned(true);
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
								1,
							);
							const recentFiles = this.app.plugins.plugins["recent-files-obsidian"];
							if (recentFiles) {
								setTimeout(
									around(recentFiles, {
										shouldAddFile(old) {
											return function (_file: TFile) {
												// Don't update the Recent Files plugin
												return _file !== file && old.call(this, _file);
											};
										},
									}),
									1,
								);
							}

						}

						const view = old.call(this, file, openState);
						setTimeout(() => {
							const fsCtnEl = (this.parent.containerEl as HTMLElement).parentElement;
							if (!(fsCtnEl?.classList.contains("fs-content"))) return;
							if (file.extension != "canvas") return;

							const canvas = this.view.canvas;
							setTimeout(() => {
								if (canvas && openState?.eState?.match) {
									let node = canvas.data.nodes?.find((e: any) => e.text === openState.eState.match.content);
									node = canvas.nodes.get(node.id);

									canvas.selectOnly(node);
									canvas.zoomToSelection();
								}
							}, 20);
						}, 1);

						return view;
					};
				},
			}),
		);
	}

	patchSearchView() {
		const updateCurrentState = (state: searchState) => {
			this.state = state;
			this.settings.searchViewState = state as searchState;
			this.applySettingsUpdate();
		};

		const checkCurrentViewType = (leaf: WorkspaceLeaf) => {
			const isModal = document.querySelector('.float-search-modal') !== null;
			const currentLeafRoot = leaf.getRoot();
			if (currentLeafRoot?.side && (currentLeafRoot?.side === "left" || currentLeafRoot?.side === 'right')) return "sidebar";
			if (leaf.getContainer()?.type === "window") return "window";
			return isModal ? "modal" : "split";
		};

		const initViewMenu = (menu: Menu, current: searchType, originLeaf?: WorkspaceLeaf) => {
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
					item.setTitle(`${view.type} view`).setIcon(`${view.icon}`).onClick(async () => {
						if (view.type === "modal") {
							originLeaf?.detach();
							setTimeout(() => {
								this.initModal(this.state, true, false);
							}, 10);
						} else if (view.type === "sidebar") {
							await initSearchViewWithLeaf(this.app, view.type, this.state);
						} else {
							if (current === "window") {
								originLeaf?.detach();
								setTimeout(async () => {
									await initSearchViewWithLeaf(this.app, <"tab" | "split">view.type, this.state);
								}, 10);
							} else {
								await initSearchViewWithLeaf(this.app, view.type, this.state);
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

		const patchSearch = () => {
			const searchView = this.app.workspace.getLeavesOfType("search")[0]?.view as any;

			if (!searchView) return false;

			const searchViewConstructor = searchView.constructor;

			this.register(
				around(searchViewConstructor.prototype, {
					onOpen(old) {
						return function () {
							old.call(this);
							const viewSwitchEl = createDiv({cls: "float-search-view-switch"});
							const targetEl = this.filterSectionToggleEl;
							const viewSwitchButton = new ExtraButtonComponent(viewSwitchEl);
							viewSwitchButton.setIcon('layout-template').setTooltip("Switch to File View");
							viewSwitchButton.onClick(() => {
								const currentType = checkCurrentViewType(this.leaf);
								const layoutMenu = initViewMenu(new Menu(), currentType, this.leaf);
								const viewSwitchButtonPos = viewSwitchEl.getBoundingClientRect();
								layoutMenu.showAtPosition({x: viewSwitchButtonPos.x, y: viewSwitchButtonPos.y + 30});
							});
							targetEl.parentElement.insertBefore(viewSwitchEl, targetEl);
						};
					},
					startSearch(old) {
						return function () {
							old.call(this);
							const viewState = this.getState();
							updateCurrentState({
								...viewState,
								query: this.searchComponent.getValue(),
							});
						};
					}
				})
			);
			searchView.leaf?.rebuildView();
			console.log("Metadata-Style: all property view get patched");
			return true;
		};
		this.app.workspace.onLayoutReady(() => {
			if (!patchSearch()) {
				const evt = this.app.workspace.on("layout-change", () => {
					patchSearch() && this.app.workspace.offref(evt);
				});
				this.registerEvent(evt);
			}
		});
	}

	registerObsidianURIHandler() {
		this.registerObsidianProtocolHandler("fs", (path) => this.initModal({
			...this.state,
			query: path.query,
			current: false
		}, true, true));
	}

	private createCommand(options: {
		id: string;
		name: string;
		queryBuilder: (file: any) => string;
	}): void {
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
						this.initModal({...this.state, query, current: true}, true, false);
					}
					return true;
				}
			}
		});
	}

	registerObsidianCommands() {
		this.addCommand({
			id: 'search-obsidian-globally',
			name: 'Search Obsidian Globally',
			callback: () => this.initModal({...this.state, query: "", current: false}, false, true)
		});


		this.addCommand({
			id: 'search-obsidian-globally-state',
			name: 'Search Obsidian Globally (With Last State)',
			callback: () => this.initModal({...this.state, query: this.state.query, current: false}, true, false)
		});


		this.createCommand({
			id: 'search-in-backlink',
			name: 'Search In Backlink Of Current File',
			queryBuilder: (file) => {
				return " /\\[\\[" + (file.extension === "canvas" ? file.name : file.basename) + "(\\|[^\\]]*)?\\]\\]/";
			}
		});

		this.createCommand({
			id: 'search-in-current-file',
			name: 'Search In Current File',
			queryBuilder: (file) => {
				return " path:" + `"${file.path}"`;
			}
		});

		for (const type of ['split', 'tab', 'window'] as PaneType[]) {
			this.addCommand({
				id: `open-search-view-${type}`,
				name: `Open Search View (${type})`,
				callback: async () => {
					const existingLeaf = this.app.workspace.getLeavesOfType("search");
					switch (type) {
						case "window":
							const isExistingWindowLeaf = existingLeaf.find((leaf) => leaf.parentSplit.parent.type === "window");
							if (isExistingWindowLeaf) {
								this.app.workspace.revealLeaf(isExistingWindowLeaf);
								return;
							}
							await initSearchViewWithLeaf(this.app, type);
							break;
						case "tab":
						case "split":
							const isExistingLeaf = existingLeaf.find((leaf) => !leaf.parentSplit.parent.side);
							if (isExistingLeaf) {
								this.app.workspace.revealLeaf(isExistingLeaf);
								return;
							}
							await initSearchViewWithLeaf(this.app, type);
							break;
					}
				}
			});
		}
	}

	registerEditorMenuHandler() {
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				if (!editor) {
					return;
				}
				if (editor.getSelection().length === 0) {
					return;
				}
				const selection = editor.getSelection().trim();
				let searchWord = selection;

				if (selection.length > 8) {
					searchWord = selection.substring(0, 3) + "..." + selection.substring(selection.length - 3, selection.length);
				} else {
					searchWord = selection;
				}

				menu.addItem((item) => {
					// Add sub menu
					item.setTitle('Search "' + searchWord + '"' + " in Float Search").setIcon("search")
						.onClick(() => this.initModal({...this.state, query: selection, current: false}, true, false));
				});
			}));
	}

	registerContextMenuHandler() {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => {
				const popover = leaf ? EmbeddedView.forLeaf(leaf) : undefined;
				if (file instanceof TFile && !popover && !leaf) {
					menu.addItem(item => {
						item
							.setIcon("popup-open")
							.setTitle("Open in Float Preview")
							.onClick(async () => {
								if (this.modal) {
									await this.modal.initFileView(file, undefined);

									return;
								}

								this.initModal({...this.state, current: false}, true, true);
								setTimeout(async () => {
									await this.modal.initFileView(file, undefined);
								}, 20);
							})
							.setSection?.("open");
					});
				}
			}),
		);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
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

	constructor(cb: (state: any) => void, plugin: FloatSearchPlugin, state: any, viewType: string = "search") {
		super(plugin.app);
		this.plugin = plugin;
		this.cb = cb;
		this.state = state;
		this.viewType = viewType;
	}

	async onOpen() {
		const {contentEl, containerEl, modalEl} = this;

		this.searchCtnEl = contentEl.createDiv({cls: "float-search-modal-search-ctn"});
		this.instructionsEl = modalEl.createDiv({cls: "float-search-modal-instructions"});

		this.initInstructions(this.instructionsEl);
		this.initCss(contentEl, modalEl, containerEl);
		await this.initSearchView(this.searchCtnEl);
		this.initInput();
		this.initContent();
	}

	onClose() {
		const {contentEl} = this;

		this.cb(this.searchLeaf.view.getState());

		this.searchLeaf.detach();
		this.fileLeaf?.detach();
		this.searchEmbeddedView.unload();
		this.fileEmbeddedView?.unload();
		contentEl.empty();
	}

	initInstructions(instructionsEl: HTMLElement) {
		const navigateInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-navigate"});
		const collapseInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-collapse"});
		const enterInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-enter"});
		const altEnterInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-alt-enter"});

		const tabInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-tab"});
		const switchInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-switch"});

		const navigateIconEl = navigateInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const navigateTextEl = navigateInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		navigateIconEl.setText("↑↓");
		navigateTextEl.setText("Navigate");

		const collapseIconEl = collapseInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const collapseTextEl = collapseInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		collapseIconEl.setText("Shift+↑↓");
		collapseTextEl.setText("Collapse/Expand");

		const enterIconEl = enterInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const enterTextEl = enterInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		enterIconEl.setText("↵");
		enterTextEl.setText("Open in background");

		const altEnterIconEl = altEnterInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const altEnterTextEl = altEnterInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		altEnterIconEl.setText("Alt+↵");
		altEnterTextEl.setText("Open File and Close");

		const tabIconEl = tabInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const tabTextEl = tabInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		tabIconEl.setText("Tab/Shift+Tab");
		tabTextEl.setText("Preview/Close Preview");

		const switchIconEl = switchInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const switchTextEl = switchInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		switchIconEl.setText("Ctrl+G");
		switchTextEl.setText("Switch Between Search and File View");

		const clickInstructionsEl = instructionsEl.createDiv({cls: "float-search-modal-instructions-click"});
		const clickIconEl = clickInstructionsEl.createSpan({cls: "float-search-modal-instructions-key"});
		const clickTextEl = clickInstructionsEl.createSpan({cls: "float-search-modal-instructions-text"});
		clickIconEl.setText("Alt+Click");
		clickTextEl.setText("Close Modal While In File View");
	}

	initCss(contentEl: HTMLElement, modalEl: HTMLElement, containerEl: HTMLElement) {
		contentEl.classList.add("float-search-modal-content");
		modalEl.classList.add("float-search-modal");
		containerEl.classList.add("float-search-modal-container");
	}

	async initSearchView(contentEl: HTMLElement) {
		const [createdLeaf, embeddedView] = spawnLeafView(this.plugin, contentEl);
		this.searchLeaf = createdLeaf;
		this.searchEmbeddedView = embeddedView;

		this.searchLeaf.setPinned(true);
		await this.searchLeaf.setViewState({
			type: "search",
		});

		setTimeout(async () => {
			await this.searchLeaf.view.setState(this.state, {
				history: false,
			});
			this.state?.current ? (this.searchLeaf.view as SearchView).searchComponent.inputEl.setSelectionRange(0, 0) : (this.searchLeaf.view as SearchView).searchComponent.inputEl.setSelectionRange(0, this.state?.query?.length);
		}, 0);

		return;
	}

	initInput() {
		const inputEl = this.contentEl.getElementsByTagName("input")[0];
		inputEl.focus();
		inputEl.onkeydown = (e) => {
			const currentView = this.searchLeaf.view as SearchView;
			switch (e.key) {
				case "ArrowDown":
					if (e.shiftKey) {
						currentView.onKeyShowMoreAfter(e);
						if (currentView.dom.focusedItem) {
							if (currentView.dom.focusedItem.collapsible) {
								currentView.dom.focusedItem.setCollapse(false);
							}
						}
						break;
					} else {
						currentView.onKeyArrowDownInFocus(e);
						break;
					}
				case "ArrowUp":
					if (e.shiftKey) {
						currentView.onKeyShowMoreBefore(e);
						if (currentView.dom.focusedItem) {
							if (currentView.dom.focusedItem.collapseEl) {
								currentView.dom.focusedItem.setCollapse(true);
							}
						}
						break;
					} else {
						currentView.onKeyArrowUpInFocus(e);
						break;
					}
				case "ArrowLeft":
					currentView.onKeyArrowLeftInFocus(e);
					break;
				case "ArrowRight":
					currentView.onKeyArrowRightInFocus(e);
					break;
				case "Enter":
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
							this.modalEl.toggleClass("float-search-width", false);
							this.fileEl.detach();

							break;
						}
					}

					if (currentView.dom.focusedItem) {
						const item = currentView.dom.focusedItem;
						const file = item.parent.file instanceof TFile ? item.parent.file : item.file;

						item.parent.file instanceof TFile ? this.initFileView(file, {
							match: {
								content: item.content,
								matches: item.matches
							}
						}) : this.initFileView(file, undefined);
					}
					break;
				case "e":
					if (e.ctrlKey) {
						e.preventDefault();
						if (this.fileLeaf) {
							const estate = this.fileLeaf.getViewState();
							estate.state.mode = "preview" === estate.state.mode ? "source" : "preview";
							this.fileLeaf.setViewState(estate, {
								focus: !0
							});
							setTimeout(() => {
								(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
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

	initContent() {
		const {contentEl} = this;
		contentEl.onclick = (e) => {
			const resultElement = contentEl.getElementsByClassName('search-results-children')[0];
			if (resultElement.children.length < 2) {
				return;
			}

			let targetElement = e.target as HTMLElement | null;

			if (e.altKey || !this.fileLeaf) {
				while (targetElement) {
					if (targetElement.classList.contains('tree-item-icon')) {
						break;
					}
					if (targetElement.classList.contains('search-result-hover-button')) {
						break;
					}
					if (targetElement.classList.contains('tree-item')) {
						this.close();
						break;
					}

					targetElement = targetElement.parentElement;
				}
				return;
			}

			if (this.fileLeaf) {
				const currentView = this.searchLeaf.view as SearchView;

				if ((this.searchCtnEl as Node).contains(targetElement as Node)) {
					while (targetElement) {
						if (targetElement.classList.contains('tree-item')) {
							break;
						}
						targetElement = targetElement.parentElement;
					}
					if (!targetElement) return;

					const fileInnerEl = targetElement?.getElementsByClassName("tree-item-inner")[0] as HTMLElement;
					const innerText = fileInnerEl.innerText;
					const file = this.plugin.app.metadataCache.getFirstLinkpathDest(innerText, "");

					if (file) {
						const item = currentView.dom.resultDomLookup.get(file);
						currentView.dom.setFocusedItem(item);
						this.initFileView(file, undefined);
						(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
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
				eState: state
			});

			if (this.fileState?.match?.matches[0] === state?.match?.matches[0] && state && this.fileState) {
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
					(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
				}, 0);
			}

			return;
		}

		const {contentEl} = this;
		this.fileEl = contentEl.createDiv({cls: "float-search-modal-file-ctn"});
		this.modalEl.toggleClass("float-search-width", true);
		this.fileEl.onkeydown = (e) => {
			if (e.ctrlKey && e.key === "g") {
				e.preventDefault();
				e.stopPropagation();

				(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
			}

			if (e.key === "Tab" && e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();

				(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
			}
		};

		if (!this.fileEl) return;

		const [createdLeaf, embeddedView] = spawnLeafView(this.plugin, this.fileEl);
		this.fileLeaf = createdLeaf;
		this.fileEmbeddedView = embeddedView;

		this.fileLeaf.setPinned(true);
		await this.fileLeaf.openFile(file, {
			active: false,
			eState: state
		});
		this.fileState = state;

		(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();

	}
}
