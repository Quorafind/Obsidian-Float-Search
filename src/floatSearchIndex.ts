import {
	App,
	Editor,
	MarkdownView,
	Menu,
	Modal, Notice, OpenViewState,
	Plugin, SearchView,
	TAbstractFile,
	TFile,
	Workspace,
	WorkspaceContainer, WorkspaceItem,
	WorkspaceLeaf
} from 'obsidian';
import { EmbeddedView, isEmebeddedLeaf, spawnLeafView } from "./leafView";
import { around } from "monkey-around";

export default class FloatSearchPlugin extends Plugin {
	private state: any;
	private applyDebounceTimer = 0;
	private modal: FloatSearchModal;

	public applySettingsUpdate() {
		clearTimeout(this.applyDebounceTimer);
		this.applyDebounceTimer = window.setTimeout(() => {
			this.state = {
				...this.state,
				query: "",
			};
		}, 30000);
	}

	async onload() {
		this.patchWorkspace();
		this.patchWorkspaceLeaf();

		this.registerObsidianURIHandler();
		this.registerObsidianCommands();
		this.registerEditorMenuHandler();
		this.registerContextMenuHandler();

		this.addRibbonIcon('search', 'Search Obsidian In Modal', () => {
			this.modal = new FloatSearchModal((state)=>{
				this.state = state;
				this.applySettingsUpdate();
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
						const fsCtnEl = (activeLeaf.parent.containerEl as HTMLElement).parentElement;
						if(fsCtnEl?.classList.contains("fs-content")) {
							if(activeLeaf.view.getViewType() === "markdown") {
								return activeLeaf;
							}
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
						setTimeout(()=>{
							const fsCtnEl = (this.parent.containerEl as HTMLElement).parentElement;
							if(!(fsCtnEl?.classList.contains("fs-content"))) return;
							if(file.extension != "canvas" ) return;

							const canvas = this.view.canvas;
							setTimeout(()=>{
								if(canvas && openState?.eState?.match) {
									let node = canvas.data.nodes?.find((e: any)=> e.text === openState.eState.match.content);
									node = canvas.nodes.get(node.id);

									canvas.selectOnly(node);
									canvas.zoomToSelection();
							}
							},20);
						}, 1);

						return view;
					}
				}
			}),
		);
	}

	registerObsidianURIHandler() {
		this.registerObsidianProtocolHandler("fs", (path)=>{
			this.modal = new FloatSearchModal((state)=>{
				this.state = state;
				this.applySettingsUpdate();
			},this.app, this, { query: path.query, current: false });
			this.modal.open();
		});
	}

	registerObsidianCommands() {
		this.addCommand({
			id: 'search-obsidian-globally',
			name: 'Search Obsidian Globally',
			callback: () => {
				this.modal = new FloatSearchModal((state)=>{
					this.state = state;
				},this.app, this, {...this.state, query: "", current: false});
				this.modal.open();
			}
		});


		this.addCommand({
			id: 'search-obsidian-globally-state',
			name: 'Search Obsidian Globally (With Last State)',
			callback: () => {
				this.modal = new FloatSearchModal((state)=>{
					this.state = state;
				},this.app, this, {...this.state, current: false});
				this.modal.open();
			}
		});


		this.addCommand({
		    id: 'search-in-backlink',
		    name: 'Search In Backlink Of Current File',
		    checkCallback: (checking: boolean) => {
		        // Conditions to check
				const activeLeaf = this.app.workspace.activeLeaf;
				if(!activeLeaf) return;

				const viewType = activeLeaf.view.getViewType();
				if (viewType === "markdown" || viewType === "canvas") {
					if (!checking) {
						const currentFile = activeLeaf.view.file;

						this.modal = new FloatSearchModal((state)=>{
							this.state = state;
							this.applySettingsUpdate();
						},this.app, this, {...this.state, query: " /\\[\\[" + (currentFile.extension === "canvas" ? currentFile.name : currentFile.basename) + "(\\|[^\\]]*)?\\]\\]/", current: true });
						this.modal.open();
					}

					return true;
				}
		    }
		});

		this.addCommand({
		    id: 'search-in-current-file',
		    name: 'Search In Current File',
		    checkCallback: (checking: boolean) => {
		        // Conditions to check
				const activeLeaf = this.app.workspace.activeLeaf;
				if(!activeLeaf) return;

				const viewType = activeLeaf.view.getViewType();
		        if (viewType === "markdown" || viewType === "canvas") {
		            if (!checking) {
						const currentFile = activeLeaf.view.file;

						this.modal = new FloatSearchModal((state)=>{
							this.state = state;
							this.applySettingsUpdate();
						},this.app, this, {...this.state, query: " path:" + currentFile.path, current: true });
						this.modal.open();
		            }

		            return true;
		        }
		    }
		});
	}

	registerEditorMenuHandler() {
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
				if (!editor) {
					return;
				}
				if (editor.getSelection().length === 0) {
					return;
				}
				const selection = editor.getSelection().trim();
				let searchWord = selection;

				if(selection.length > 8) {
					searchWord = selection.substring(0, 3) + "..." + selection.substring(selection.length - 3, selection.length);
				} else {
					searchWord = selection;
				}

				menu.addItem((item) => {
					// Add sub menu
					item.setTitle('Search "' + searchWord + '"' + " in Float Search").setIcon("search")
						.onClick(()=>{
							this.modal = new FloatSearchModal((state)=>{
								this.state = state;
								this.applySettingsUpdate();
							},this.app, this, { query: selection, current: false });
							this.modal.open();
						})
				})
			}))
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
					if(this.modal) {
						await this.modal.initFileView(file, undefined);

						return;
					}

					this.modal = new FloatSearchModal((state)=>{
						this.state = state;
						this.applySettingsUpdate();
					},this.app, this, { query: "", current: false });
					this.modal.open();
					setTimeout(async ()=>{
						await this.modal.initFileView(file, undefined);
					}, 20);
				  })
				  .setSection?.("open");
			  });
			}
		  }),
		);
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

	private fileState: any;

	private searchCtnEl: HTMLElement;
	private instructionsEl: HTMLElement;
	private fileEl: HTMLElement;
	private viewType: string;

	constructor(cb: (state: any)=> void, app: App, plugin: FloatSearchPlugin, state: any, viewType: string = "search") {
		super(app);
		this.plugin = plugin;
		this.cb = cb;
		this.state = state;
		this.viewType = viewType;
	}

	async onOpen() {
		const { contentEl, containerEl, modalEl } = this;

		this.searchCtnEl = contentEl.createDiv({ cls: "float-search-modal-search-ctn" });
		this.instructionsEl = modalEl.createDiv({ cls: "float-search-modal-instructions" });

		this.initInstructions(this.instructionsEl);
		this.initCss(contentEl, modalEl, containerEl);
		await this.initSearchView(this.searchCtnEl, this.viewType);
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
		const collapseInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-collapse" });
		const enterInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-enter" });
		const altEnterInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-alt-enter" });

		const tabInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-tab" });
		const switchInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-switch" });

		const navigateIconEl = navigateInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const navigateTextEl = navigateInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		navigateIconEl.setText("↑↓");
		navigateTextEl.setText("Navigate");

		const collapseIconEl = collapseInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const collapseTextEl = collapseInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		collapseIconEl.setText("Shift+↑↓");
		collapseTextEl.setText("Collapse/Expand");

		const enterIconEl = enterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const enterTextEl = enterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		enterIconEl.setText("↵");
		enterTextEl.setText("Open in background");

		const altEnterIconEl = altEnterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const altEnterTextEl = altEnterInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		altEnterIconEl.setText("Alt+↵");
		altEnterTextEl.setText("Open File and Close");

		const tabIconEl = tabInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const tabTextEl = tabInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		tabIconEl.setText("Tab/Shift+Tab");
		tabTextEl.setText("Preview/Close Preview");

		const switchIconEl = switchInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const switchTextEl = switchInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		switchIconEl.setText("Ctrl+G");
		switchTextEl.setText("Switch Between Search and File View");

		const clickInstructionsEl = instructionsEl.createDiv({ cls: "float-search-modal-instructions-click" });
		const clickIconEl = clickInstructionsEl.createSpan({ cls: "float-search-modal-instructions-key" });
		const clickTextEl = clickInstructionsEl.createSpan({ cls: "float-search-modal-instructions-text" });
		clickIconEl.setText("Alt+Click");
		clickTextEl.setText("Close Modal While In File View");
	}

	initCss(contentEl: HTMLElement, modalEl: HTMLElement, containerEl: HTMLElement) {
		contentEl.classList.add("float-search-modal-content");
		modalEl.classList.add("float-search-modal");
		containerEl.classList.add("float-search-modal-container");
	}

	async initSearchView(contentEl: HTMLElement, viewType: string) {
		const [createdLeaf, embeddedView] = spawnLeafView(this.plugin, contentEl);
		this.searchLeaf = createdLeaf;
		this.searchEmbeddedView = embeddedView;

		this.searchLeaf.setPinned(true);
		await this.searchLeaf.setViewState({
			type: "search",
		});

		setTimeout(async ()=>{
			await this.searchLeaf.view.setState(this.state, true);
			this.state?.current ? (this.searchLeaf.view as SearchView).searchComponent.inputEl.setSelectionRange(0, 0) : (this.searchLeaf.view as SearchView).searchComponent.inputEl.setSelectionRange(this.state?.query?.length, this.state?.query?.length);
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
						if(currentView.dom.focusedItem) {
							if(currentView.dom.focusedItem.collapsible) {
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
						if(currentView.dom.focusedItem) {
							if(currentView.dom.focusedItem.collapseEl) {
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
					if(e.altKey && currentView.dom.focusedItem) {
						this.close();
					}
					break;
				case "Tab":
					e.preventDefault();
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
						e.preventDefault();
						app.workspace.setActiveLeaf(this.fileLeaf, {
							focus: true,
						});
					}
					break;
				case "C":
					if(e.ctrlKey && e.shiftKey) {
						e.preventDefault();
						const text = currentView.dom.focusedItem.el.innerText;
						navigator.clipboard.writeText(text);
					}

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

			let targetElement = e.target as HTMLElement | null;

			if(e.altKey || !this.fileLeaf) {
				while (targetElement) {
					if (targetElement.classList.contains('tree-item')) {
						this.close();
						break;
					}
					targetElement = targetElement.parentElement;
				}
				return;
			}

			if(this.fileLeaf) {
				const currentView = this.searchLeaf.view as SearchView;

				if((this.searchCtnEl as Node).contains(targetElement as Node)) {
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
		}
	}

	async initFileView(file: TFile, state: any) {
		if(this.fileLeaf) {
			await this.fileLeaf.openFile(file, {
				active: false,
				eState: state
			});

			if(this.fileState?.match?.matches[0] === state?.match?.matches[0] && state && this.fileState) {
				setTimeout(()=>{
					if(this.fileLeaf) {
						app.workspace.setActiveLeaf(this.fileLeaf, {
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

		const { contentEl } = this;
		this.fileEl = contentEl.createDiv({ cls: "float-search-modal-file-ctn" });
		this.modalEl.toggleClass("float-search-width", true);
		this.fileEl.onkeydown = (e) => {
			if(e.ctrlKey && e.key === "g") {
				e.preventDefault();
				e.stopPropagation();

				(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
			}

			if(e.key === "Tab" && e.ctrlKey) {
				e.preventDefault();
				e.stopPropagation();

				(this.searchLeaf.view as SearchView).searchComponent.inputEl.focus();
			}
		}

		if(!this.fileEl) return;

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
