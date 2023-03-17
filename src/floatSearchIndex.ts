import {
	App,
	Modal, OpenViewState,
	Plugin, SearchView,
	TFile,
	Workspace,
	WorkspaceContainer, WorkspaceItem,
	WorkspaceLeaf
} from 'obsidian';
import { EmbeddedView, isEmebeddedLeaf, spawnLeafView } from "./leafView";
import { around } from "monkey-around";

export default class FloatSearchPlugin extends Plugin {

	async onload() {
		this.patchWorkspace();
		this.patchWorkspaceLeaf();

		this.addCommand({
		    id: 'float-search',
		    name: 'Search Obsidian In Modal',
		    callback: () => {
				new FloatSearchModal(this.app, this).open();
			}
		});

		this.addRibbonIcon('search', 'Search Obsidian In Modal', () => {
			new FloatSearchModal(this.app, this).open();
		});
	}

	onunload() {

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
}


class FloatSearchModal extends Modal {
	private readonly plugin: FloatSearchPlugin;
	private searchEmbeddedView: EmbeddedView;
	private fileEmbeddedView: EmbeddedView;
	private searchLeaf: WorkspaceLeaf;
	private fileLeaf: WorkspaceLeaf | undefined;

	private searchCtnEl: HTMLElement;
	private fileEl: HTMLElement;

	constructor(app: App, plugin: FloatSearchPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl, containerEl, modalEl } = this;

		this.searchCtnEl = contentEl.createDiv({ cls: "float-search-modal-search-ctn" });

		this.initCss(contentEl, modalEl, containerEl);
		await this.initSearchView(this.searchCtnEl);
		this.initInput();
		this.initContent();
	}

	onClose() {
		const { contentEl } = this;
		this.searchLeaf.detach();
		this.fileLeaf?.detach();
		this.searchEmbeddedView.unload();
		this.fileEmbeddedView?.unload();
		contentEl.empty();
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
	}

	initInput() {
		const inputEl = this.contentEl.getElementsByTagName("input")[0];
		inputEl.focus();
		inputEl.onkeydown = (e) => {
			const currentView = this.searchLeaf.view as SearchView;
			console.log(this.fileLeaf?.view);
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

				if((this.searchCtnEl as Node).contains(targetElement as Node)) {
					if(((this.searchLeaf.view as SearchView).searchComponent.inputEl as Node).contains(targetElement as Node) || ((this.searchLeaf.view as SearchView).headerDom.navHeaderEl as Node).contains(targetElement as Node)) {
						return;
					}

					while (targetElement) {
						if (targetElement.classList.contains('tree-item')) {
							break;
						}
						targetElement = targetElement.parentElement;
						}
					const fileInnerEl = targetElement?.getElementsByClassName("tree-item-inner")[0] as HTMLElement;
					const innerText = fileInnerEl.innerText;
					const file = app.metadataCache.getFirstLinkpathDest(innerText, "");
					
					const currentView = this.searchLeaf.view as SearchView;
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
