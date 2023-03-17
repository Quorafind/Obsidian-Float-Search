import {
	App,
	Editor,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal, OpenViewState,
	Plugin, SearchView,
	setIcon,
	TFile,
	Workspace,
	WorkspaceContainer, WorkspaceItem,
	WorkspaceLeaf
} from 'obsidian';
import { EmbeddedView, isEmebeddedLeaf, spawnLeafView } from "./leafView";
import { around } from "monkey-around";

export default class FloatSearchPlugin extends Plugin {
	private state: any;
	private modal: FloatSearchModal;

	async onload() {
		this.patchWorkspace();
		this.patchWorkspaceLeaf();
		this.registerObsidianCommands();

		this.addRibbonIcon('search', 'Search Obsidian In Modal', () => {
			this.modal = new FloatSearchModal((state)=>{
				this.state = state;
			},this.app, this, this.state);
			this.modal.open();
		});
	}

	onunload() {
		this.state = undefined;
	}

	patchWorkspace() {
		let layoutChanging = false;
		const uninstaller = around(Workspace.prototype, {
			getLeaf: (next) =>
				function (...args) {
					const activeLeaf = this.activeLeaf;
					if(activeLeaf) {
						if(activeLeaf.pinned === true && activeLeaf.view.getViewType() === "search") {
							const newLeaf = app.workspace.getUnpinnedLeaf();
							if(newLeaf) {
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
					const cb:     leafIterator  = (typeof arg1 === "function" ? arg1 : arg2) as leafIterator;
					const parent: WorkspaceItem = (typeof arg1 === "function" ? arg2 : arg1) as WorkspaceItem;

					if (!parent) return false;  // <- during app startup, rootSplit can be null
					if (layoutChanging) return false;  // Don't let HEs close during workspace change

					// 0.14.x doesn't have WorkspaceContainer; this can just be an instanceof check once 15.x is mandatory:
					if (parent === app.workspace.rootSplit || (WorkspaceContainer && parent instanceof WorkspaceContainer)) {
						for(const popover of EmbeddedView.popoversForWindow((parent as WorkspaceContainer).win)) {
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
						if(isEmebeddedLeaf(this) && !pinned) this.setPinned(true);
					}
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
							if (recentFiles)
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
						return old.call(this, file, openState);
					}
				}
			}),
		);
	}

	registerObsidianCommands() {
		this.registerObsidianProtocolHandler("fs", (path)=>{
			this.modal = new FloatSearchModal((state)=>{
				this.state = state;
			},this.app, this, { query: path.query, uri: true });
			this.modal.open();
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				if (!editor) {
					return;
				}
				if (editor.getSelection().length === 0) {
					return;
				}
				const selection = editor.getSelection();

				menu.addItem((item) => {
					// Add sub menu
					item.setTitle('Search "' + selection + '"').setIcon("search")
						.onClick(()=>{
							this.modal = new FloatSearchModal((state)=>{
								this.state = state;
							},this.app, this, { query: selection, uri: true });
							this.modal.open();
						})
				})
			}))

		this.addCommand({
			id: 'float-search',
			name: 'Search Obsidian In Modal',
			callback: () => {
				this.modal = new FloatSearchModal((state)=>{
					this.state = state;
				},this.app, this, this.state);
				this.modal.open();
			}
		});
	}
}


class FloatSearchModal extends Modal {
	private readonly plugin: FloatSearchPlugin;
	private searchEmbeddedView: EmbeddedView;
	private fileEmbeddedView: EmbeddedView;

	searchLeaf: WorkspaceLeaf;
	fileLeaf: WorkspaceLeaf | undefined;

	private cb: (state: any)=> void;
	private state: any;

	private searchCtnEl: HTMLElement;
	private instructionsEl: HTMLElement;
	private fileEl: HTMLElement;

	constructor(cb: (state: any)=> void, app: App, plugin: FloatSearchPlugin, state: any) {
		super(app);
		this.plugin = plugin;
		this.cb = cb;
		this.state = state;
	}

	async onOpen() {
		const { contentEl, containerEl, modalEl } = this;

		this.searchCtnEl = contentEl.createDiv({ cls: "float-search-modal-search-ctn" });
		this.instructionsEl = modalEl.createDiv({ cls: "float-search-modal-instructions" });

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
		const navigateInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-navigate" });
		const enterInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-enter" });
		// const closeInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-close" });
		// const ctrlEnterInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-ctrl-enter" });
		const altEnterInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-alt-enter" });
		
		const tabInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-tab" });
		// const shiftTabInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-shift-tab" });
		const switchInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-switch" });

		const navigateIconEl = navigateInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const navigateTextEl = navigateInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		navigateIconEl.setText("↑↓");
		navigateTextEl.setText("Navigate");

		const enterIconEl = enterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const enterTextEl = enterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		enterIconEl.setText("↵");
		enterTextEl.setText("Open in background");

		// const ctrlEnterIconEl = ctrlEnterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		// const ctrlEnterTextEl = ctrlEnterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		// ctrlEnterIconEl.setText("Ctrl+↵");
		// ctrlEnterTextEl.setText("New pane in background");

		const altEnterIconEl = altEnterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const altEnterTextEl = altEnterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		altEnterIconEl.setText("Alt+↵");
		altEnterTextEl.setText("Open File and Close");

		// const closeIconEl = closeInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		// const closeTextEl = closeInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		// closeIconEl.setText("Esc");
		// closeTextEl.setText("Close");

		const tabIconEl = tabInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const tabTextEl = tabInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		tabIconEl.setText("Tab/Shift+Tab");
		tabTextEl.setText("Preview/Close Preview");

		// const shiftTabIconEl = shiftTabInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		// const shiftTabTextEl = shiftTabInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		// shiftTabIconEl.setText("Shift+Tab");
		// shiftTabTextEl.setText("Close Preview");

		const switchIconEl = switchInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const switchTextEl = switchInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		switchIconEl.setText("Ctrl+G");
		switchTextEl.setText("Switch Between Search and File View");
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


		if(this.state?.uri) {
			const tempState = this.searchLeaf.view.getState();
			tempState.query = this.state.query;
			this.searchLeaf.view.setState(tempState, true);

			return;
		}
		if(this.state) {
			this.state.query = "";
			this.searchLeaf.view.setState(this.state, true);
		}
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
						break;
					} else {
						currentView.onKeyArrowDownInFocus(e);
						break;
					}
				case "ArrowUp":
					if (e.shiftKey) {
						currentView.onKeyShowMoreBefore(e);
						break;
					} else {
						currentView.onKeyArrowUpInFocus(e);
						break;
					}
				case "ArrowLeft":
					currentView.onKeyArrowLeftInFocus(e);
					break;
				case "ArrowRight":
					if(e.ctrlKey) {
						if(this.fileLeaf) {
							app.workspace.setActiveLeaf(this.fileLeaf, {
								focus: true,
							});
						}
					}
					currentView.onKeyArrowRightInFocus(e);
					break;
				case "Enter":
					currentView.onKeyEnterInFocus(e);
					if(e.altKey && currentView.dom.focusedItem) {
						this.close();
					}
					break;
				case "Tab":
					if(e.shiftKey) {
						if(this.fileLeaf) {
							this.fileLeaf?.detach();
							this.fileLeaf = undefined;
							this.fileEmbeddedView?.unload();
							this.modalEl.toggleClass("float-search-width", false);
							this.fileEl.detach();

							break;
						}
					}

					if(currentView.dom.focusedItem) {
						const item = currentView.dom.focusedItem;
						const file = item.parent.file instanceof TFile ? item.parent.file : item.file;

						item.parent.file instanceof TFile ? this.initFileView(file, {match: {
                            content: item.content,
                            matches: item.matches
                        }}) : this.initFileView(file, undefined);
					}
					break;
				case "e":
					if(e.ctrlKey) {
						e.preventDefault();
						if(this.fileLeaf) {
							const estate = this.fileLeaf.getViewState();
                			estate.state.mode = "preview" === estate.state.mode ? "source" : "preview";
							this.fileLeaf.setViewState(estate, {
								focus: !0
							});
							setTimeout(()=>{
								(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
							}, 0);
						}
						break;
					}
				case "g":
					if(this.fileLeaf && e.ctrlKey) {
						app.workspace.setActiveLeaf(this.fileLeaf, {
							focus: true,
						});
					}
					break;
			}
		}
	}

	initContent() {
		const { contentEl } = this;
		contentEl.onclick = (e) => {
			const resultElement = contentEl.getElementsByClassName('search-results-children')[0];
			if(resultElement.children.length < 2)  {
				return;
			}

			if(this.fileLeaf) {
				let targetElement = e.target as HTMLElement | null;
				const currentView = this.searchLeaf.view as SearchView;

				if((this.searchCtnEl as Node).contains(targetElement as Node)) {
					if((currentView.searchComponent.inputEl as Node).contains(targetElement as Node) || (currentView.headerDom.navHeaderEl as Node).contains(targetElement as Node)) {
						return;
					}

					while (targetElement) {
						if (targetElement.classList.contains('tree-item')) {
							break;
						}
						targetElement = targetElement.parentElement;
					}
					if(!targetElement) return;

					const fileInnerEl = targetElement?.getElementsByClassName("tree-item-inner")[0] as HTMLElement;
					const innerText = fileInnerEl.innerText;
					const file = app.metadataCache.getFirstLinkpathDest(innerText, "");
					
					if(file) {
						const item = currentView.dom.resultDomLookup.get(file);
						currentView.dom.setFocusedItem(item);
						this.initFileView(file, undefined);
						(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
					}
				}

				
				return;
			}

			const target = e.target as HTMLElement;
			const classList = target.classList;

			const navElement = contentEl.getElementsByClassName('nav-header')[0];
			if (e.target !== navElement && (navElement as Node).contains(e.target as Node)) {
				return;
			}

			const fileElement = contentEl.getElementsByClassName('float-search-modal-file-ctn')[0];
			if ((fileElement as Node)?.contains(e.target as Node)) {
				return;
			}

			if(!(classList.contains("tree-item-icon") || classList.contains("float-search-modal-content") || classList.contains("right-triangle") || target.parentElement?.classList.contains("right-triangle") || classList.contains("search-input-container") || target?.parentElement?.classList.contains("search-input-container") || classList.contains("search-result-hover-button"))) {
				this.close();
			}
		}
	}

	async initFileView(file: TFile, state: any) {
		if(this.fileLeaf) {
			await this.fileLeaf.openFile(file, {
				active: false,
				eState: state
			});
			setTimeout(() => {
				(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
			}, 0);
			
			return;
		}

		const { contentEl } = this;
		this.fileEl = contentEl.createDiv({ cls: "float-search-modal-file-ctn" });
		this.modalEl.toggleClass("float-search-width", true);
		this.fileEl.onkeydown = (e) => {
			if(e.ctrlKey && e.key === "g") {
				e.preventDefault();
				e.stopPropagation();
				
				(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
			}
		}

		const [createdLeaf, embeddedView] = spawnLeafView(this.plugin, this.fileEl);
		this.fileLeaf = createdLeaf;
		this.fileEmbeddedView = embeddedView;

		this.fileLeaf.setPinned(true);
		await this.fileLeaf.openFile(file, {
			active: false,
			eState: state
		});

		(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
		
	}
}
