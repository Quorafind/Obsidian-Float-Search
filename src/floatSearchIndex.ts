import {
	App,
	Modal, OpenViewState,
	Plugin, SearchView,
	TFile,
	Workspace,
	WorkspaceContainer, WorkspaceItem,
	WorkspaceLeaf
} from 'obsidian';
import { EmbeddedView, isDailyNoteLeaf, spawnLeafView } from "./leafView";
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
						if(isDailyNoteLeaf(this) && !pinned) this.setPinned(true);
					}
				},
				openFile(old) {
					return function (file: TFile, openState?: OpenViewState) {
						if (isDailyNoteLeaf(this)) {
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
	private embeddedView: EmbeddedView;
	private leaf: WorkspaceLeaf;

	constructor(app: App, plugin: FloatSearchPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen() {
		const { contentEl } = this;

		this.initCss(contentEl);
		await this.initView(contentEl);
		this.initInput();
		this.initContent();
	}

	onClose() {
		const { contentEl } = this;
		this.leaf.detach();
		this.embeddedView.unload();
		contentEl.empty();
	}

	initCss(contentEl: HTMLElement) {
		contentEl.classList.add("float-search-modal");
		contentEl.parentElement?.classList.add("float-search-modal-parent");
		contentEl.parentElement?.parentElement?.classList.add("float-search-modal-container");
	}

	async initView(contentEl: HTMLElement) {
		const [createdLeaf, embeddedView] = spawnLeafView(this.plugin, contentEl);
		this.leaf = createdLeaf;
		this.embeddedView = embeddedView;

		this.leaf.setPinned(true);
		await this.leaf.setViewState({
			type: "search",
		});
	}

	initInput() {
		const inputEl = this.contentEl.getElementsByTagName("input")[0];
		inputEl.focus();
		inputEl.onkeydown = (e) => {
			const currentView = this.leaf.view as SearchView;
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

			const target = e.target as HTMLElement;
			const classList = target.classList;

			const navElement = contentEl.getElementsByClassName('nav-header')[0];
			if (e.target !== navElement && navElement.contains(e.target as Node)) {
				return;
			}

			if(!(classList.contains("tree-item-icon") || classList.contains("float-search-modal") || classList.contains("right-triangle") || target.parentElement?.classList.contains("right-triangle") || classList.contains("search-input-container") || target?.parentElement?.classList.contains("search-input-container") || classList.contains("search-result-hover-button"))) {
				this.close();
			}
		}
	}
}
