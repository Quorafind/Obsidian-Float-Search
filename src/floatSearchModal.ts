import { debounce, Keymap, Modal, Platform, SearchView, WorkspaceLeaf } from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import type { searchState } from "./floatSearchTypes";
import { EmbeddedView, spawnLeafView } from "./leafView";
import { PreviewPane } from "./previewPane";
import {
	findResultItem,
	isComposingEvent,
	isMainAreaLeaf,
	openInBackgroundTab,
	openStateForItem,
	ResolvedResult,
	resolveResultItem,
	SearchResultDom,
	SearchResultItem,
} from "./searchResults";

const MOD = Platform.isMacOS ? "Cmd" : "Ctrl";

const INSTRUCTIONS: [cls: string, key: string, text: string][] = [
	["navigate", "↑↓", "Navigate"],
	["collapse", "Shift+↑↓", "Expand/Collapse"],
	["enter", "↵", "Open in background"],
	["ctrl-enter", `${MOD}+↵`, "Open in new tab (background)"],
	["alt-enter", "Alt+↵", "Open and close"],
	["ctrl-shift-enter", `${MOD}+Shift+↵`, "Create file when not exist"],
	["tab", "Tab/Shift+Tab", "Preview/Close preview"],
	["switch", "Ctrl+G", "Switch between search and preview"],
	["esc", "Esc", "Back to search (in preview)"],
	["click", "Alt+Click", "Open and close while previewing"],
];

export function createInstructionElement(
	parentEl: HTMLElement,
	divCls: string,
	keyText: string,
	text: string
) {
	const divEl = parentEl.createDiv({ cls: divCls });
	const iconEl = divEl.createSpan({
		cls: "float-search-modal-instructions-key",
		text: keyText,
	});
	const textEl = divEl.createSpan({
		cls: "float-search-modal-instructions-text",
		text,
	});
	return { divEl, iconEl, textEl };
}

export class FloatSearchModal extends Modal {
	searchLeaf: WorkspaceLeaf | null = null;

	private searchEmbeddedView: EmbeddedView | null = null;
	private preview: PreviewPane | null = null;
	private searchCtnEl: HTMLElement;
	private inputEl: HTMLInputElement | null = null;

	/** The tab the user was in when the modal opened; new tabs open next to it. */
	private readonly anchorLeaf: WorkspaceLeaf | null;
	private isClosed = false;
	private composing = false;
	/** The user typed something before the initial query was applied. */
	private userTyped = false;

	private schedulePreview = debounce(
		() => void this.previewFocusedItem(),
		150,
		true
	);

	constructor(
		private readonly plugin: FloatSearchPlugin,
		private readonly state: searchState,
		private readonly onStateChange: (state: searchState) => void
	) {
		super(plugin.app);
		const active = plugin.app.workspace.activeLeaf;
		this.anchorLeaf = isMainAreaLeaf(plugin.app, active) ? active : null;
		// The modal's scope traps Tab for focus cycling before the input sees it,
		// so preview handling has to be registered on the scope itself.
		this.scope.register([], "Tab", (e) => this.onTabKey(e, false));
		this.scope.register(["Shift"], "Tab", (e) => this.onTabKey(e, true));
	}

	private get searchView(): SearchView | null {
		const view = this.searchLeaf?.view;
		return view?.getViewType() === "search" ? (view as SearchView) : null;
	}

	private get dom(): SearchResultDom | null {
		return (this.searchView?.dom as SearchResultDom | undefined) ?? null;
	}

	async onOpen() {
		const { contentEl, modalEl, containerEl } = this;
		contentEl.addClass("float-search-modal-content");
		modalEl.addClass("float-search-modal");
		containerEl.addClass("float-search-modal-container");

		this.searchCtnEl = contentEl.createDiv({
			cls: "float-search-modal-search-ctn",
		});
		this.renderInstructions(
			modalEl.createDiv({ cls: "float-search-modal-instructions" })
		);
		this.registerMouseHandlers();
		await this.initSearchView();
	}

	onClose() {
		this.isClosed = true;
		this.schedulePreview.cancel();

		const view = this.searchView;
		if (view) this.onStateChange(view.getState() as searchState);

		this.closePreview();
		this.searchLeaf?.detach();
		this.searchEmbeddedView?.unload();
		this.searchLeaf = null;
		this.searchEmbeddedView = null;
		this.contentEl.empty();
	}

	/** Escape inside the preview goes back to the search input instead of closing. */
	onEscapeKey(evt: KeyboardEvent) {
		if (
			!evt.defaultPrevented &&
			this.preview?.contains(activeDocument.activeElement) &&
			!this.isVimMode()
		) {
			evt.preventDefault();
			this.focusInput();
			return;
		}
		if (evt.defaultPrevented) return;
		evt.preventDefault();
		this.close();
	}

	/** Show a file in the preview pane, e.g. from the file menu. */
	async previewFile(file: Parameters<PreviewPane["open"]>[0]) {
		await this.showPreview({ file, key: file.path });
	}

	private isVimMode(): boolean {
		return !!(this.app.vault as unknown as { getConfig(key: string): unknown }).getConfig?.("vimMode");
	}

	private renderInstructions(instructionsEl: HTMLElement) {
		if (!this.plugin.settings.showInstructions) {
			instructionsEl.hide();
			return;
		}
		for (const [cls, key, text] of INSTRUCTIONS) {
			createInstructionElement(
				instructionsEl,
				`float-search-modal-instructions-${cls}`,
				key,
				text
			);
		}
	}

	private async initSearchView() {
		const [leaf, embeddedView] = spawnLeafView(this.plugin, this.searchCtnEl);
		this.searchLeaf = leaf;
		this.searchEmbeddedView = embeddedView;

		leaf.setPinned(true);
		await leaf.setViewState({
			type: "search",
			state: { ...this.state, triggerBySelf: true },
		});
		if (this.isClosed) return;

		this.bindInput();
		window.setTimeout(() => {
			void this.applyInitialQuery().catch((error) => {
				console.error("Float Search: failed to apply search state", error);
			});
		}, 0);
	}

	/**
	 * A freshly created search view does not always pick up the state passed to
	 * setViewState, so apply it again. Skip that when the user already started
	 * typing: resetting the query would swallow their input (#81).
	 */
	private async applyInitialQuery() {
		const view = this.searchView;
		const inputEl = this.inputEl;
		if (!view || !inputEl || this.isClosed) return;

		if (!this.userTyped && !this.composing) {
			await view.setState(
				{ ...this.state, triggerBySelf: true },
				{ history: false }
			);
		}
		if (this.isClosed || this.userTyped || this.composing) return;

		inputEl.focus();
		const query = inputEl.value;
		if (!query) return;
		// The search options popover opened while the input was empty; let it
		// react to the query so it does not cover the results (#78).
		inputEl.dispatchEvent(new Event("input"));
		window.requestAnimationFrame(() => {
			if (this.isClosed || this.userTyped) return;
			const { cursor, current } = this.state;
			if (typeof cursor === "number") inputEl.setSelectionRange(cursor, cursor);
			// "Search in current file" puts the caret before the path (#73).
			else if (current) inputEl.setSelectionRange(0, 0);
			else inputEl.setSelectionRange(0, query.length);
		});
	}

	private bindInput(retries = 10) {
		const inputEl =
			this.searchView?.searchComponent?.inputEl ??
			this.searchCtnEl.querySelector<HTMLInputElement>("input");
		if (!inputEl) {
			if (retries > 0 && !this.isClosed) {
				window.setTimeout(() => this.bindInput(retries - 1), 50);
			}
			return;
		}
		this.inputEl = inputEl;
		inputEl.focus();
		inputEl.addEventListener("keydown", this.onInputKeyDown);
		inputEl.addEventListener("input", (e) => {
			if (e.isTrusted) this.userTyped = true;
		});
		inputEl.addEventListener("compositionstart", () => {
			this.composing = true;
			this.userTyped = true;
		});
		inputEl.addEventListener("compositionend", () => {
			this.composing = false;
		});
	}

	private focusInput() {
		this.inputEl?.focus();
	}

	private onInputKeyDown = (e: KeyboardEvent) => {
		// Keys pressed while an IME composes text belong to the IME (#81).
		if (this.composing || isComposingEvent(e)) return;
		const view = this.searchView;
		const dom = this.dom;
		if (!view || !dom) return;

		switch (e.key) {
			case "ArrowDown":
			case "ArrowUp":
			case "n":
			case "p": {
				const isEmacsKey = e.key === "n" || e.key === "p";
				if (isEmacsKey) {
					if (!e.ctrlKey || e.altKey || e.metaKey) return;
					e.preventDefault();
				}
				const down = e.key === "ArrowDown" || e.key === "n";
				if (e.shiftKey) {
					if (down) view.onKeyShowMoreAfter(e);
					else view.onKeyShowMoreBefore(e);
					const item = dom.focusedItem;
					if (down && item?.collapsible) item.setCollapse?.(false);
					if (!down && item?.collapseEl) item.setCollapse?.(true);
					return;
				}
				// Not view.onKeyArrowDownInFocus(): it blurs the input, after
				// which the arrow keys scroll the page behind the modal (#72).
				e.preventDefault();
				dom.changeFocusedItem(down ? "forwards" : "backwards");
				this.onFocusedItemChanged();
				return;
			}
			case "Enter":
				this.onEnter(e, view, dom);
				return;
			case "e":
				if (e.ctrlKey && !e.altKey && !e.metaKey && this.preview) {
					e.preventDefault();
					void this.preview
						.toggleMode()
						.then(() => this.focusInput())
						.catch((error) =>
							console.error("Float Search: failed to toggle preview mode", error)
						);
				}
				return;
			case "g":
				if (e.ctrlKey && !e.altKey && !e.metaKey && this.preview) {
					e.preventDefault();
					this.preview.focus();
				}
				return;
			case "C":
			case "c":
				if (e.ctrlKey && e.shiftKey && dom.focusedItem) {
					e.preventDefault();
					void navigator.clipboard
						.writeText(dom.focusedItem.el.innerText)
						.catch((error) =>
							console.error("Float Search: failed to copy result", error)
						);
				}
				return;
		}
	};

	private onEnter(e: KeyboardEvent, view: SearchView, dom: SearchResultDom) {
		const item = dom.focusedItem;
		const mod = Keymap.isModifier(e, "Mod");

		if (mod && e.shiftKey && !e.altKey && !item) {
			// Create (or open) a note named after the query.
			e.preventDefault();
			const name = (this.inputEl?.value ?? "")
				.trim()
				.replace(/[/\\?%*:|"<>]/g, "-");
			if (!name) return;
			void this.app.workspace.openLinkText(name, "", true);
			this.close();
			return;
		}

		if (!item) return;

		if (mod && !e.altKey) {
			// Open in a new tab without leaving the search (#64).
			e.preventDefault();
			void this.openItemInBackgroundTab(item);
			return;
		}

		view.onKeyEnterInFocus(e);
		if (e.altKey) this.close();
	}

	private async openItemInBackgroundTab(item: SearchResultItem) {
		const resolved = resolveResultItem(item);
		if (!resolved) return;
		try {
			await openInBackgroundTab(
				this.app,
				resolved.file,
				openStateForItem(item),
				this.anchorLeaf
			);
		} catch (error) {
			console.error("Float Search: failed to open result in a new tab", error);
		}
		this.focusInput();
	}

	private onTabKey(e: KeyboardEvent, shift: boolean): false | void {
		if (this.composing || isComposingEvent(e)) return;
		const active = activeDocument.activeElement;

		if (this.preview?.contains(active)) {
			if (!shift) return; // Let the editor handle Tab.
			this.focusInput();
			return false;
		}
		if (!this.inputEl || active !== this.inputEl) return;

		if (shift) {
			this.closePreview();
			return false;
		}

		const resolved = resolveResultItem(this.dom?.focusedItem);
		if (resolved) {
			if (this.preview && this.preview.key === resolved.key) {
				// Already previewing this result: Tab moves into the preview.
				this.preview.focus();
			} else {
				void this.showPreview(resolved);
			}
		}
		return false;
	}

	private onFocusedItemChanged() {
		if (this.preview || this.plugin.settings.autoPreview) {
			this.schedulePreview();
		}
	}

	private async previewFocusedItem() {
		if (this.isClosed || this.composing) return;
		const resolved = resolveResultItem(this.dom?.focusedItem);
		if (!resolved || resolved.key === this.preview?.key) return;
		await this.showPreview(resolved);
	}

	private async showPreview(resolved: ResolvedResult) {
		if (this.isClosed) return;
		if (!this.preview || this.preview.isDestroyed) {
			this.preview = new PreviewPane(
				this.plugin,
				this.contentEl,
				"float-search-modal-file-ctn"
			);
			this.preview.el.addEventListener("keydown", this.onPreviewKeyDown, true);
			this.modalEl.addClass("float-search-width");
		}
		const opened = await this.preview.open(
			resolved.file,
			resolved.eState,
			resolved.key
		);
		if (opened && !this.isClosed && !this.composing) this.focusInput();
	}

	private onPreviewKeyDown = (e: KeyboardEvent) => {
		if (!e.ctrlKey || e.altKey || e.metaKey) return;
		if (e.key === "g" || e.key === "Tab") {
			e.preventDefault();
			e.stopPropagation();
			this.focusInput();
		}
	};

	private closePreview() {
		this.schedulePreview.cancel();
		if (!this.preview) return;
		this.preview.destroy();
		this.preview = null;
		this.modalEl.removeClass("float-search-width");
	}

	private registerMouseHandlers() {
		const ctn = this.searchCtnEl;

		// Moving the mouse over a result focuses it, so the keyboard continues from there (#75).
		ctn.addEventListener("mousemove", (e) => {
			if (!this.plugin.settings.hoverToFocus) return;
			const dom = this.dom;
			const item = findResultItem(dom ?? undefined, e.target);
			if (!dom || !item || item === dom.focusedItem) return;
			dom.setFocusedItem(item);
			if (this.preview) this.schedulePreview();
		});

		// Capture phase: decide before Obsidian's own result click handler runs.
		const onResultClick = (e: MouseEvent) => {
			const dom = this.dom;
			const target = e.target as HTMLElement | null;
			if (!dom || !target) return;
			if (target.closest(".tree-item-icon, .search-result-hover-button, .collapse-icon")) return;
			const item = findResultItem(dom, target);
			if (!item) return;

			const mod = Keymap.isModifier(e, "Mod");
			if ((mod && !e.altKey) || e.button === 1) {
				// Mod+click / middle click: open in a background tab and keep searching (#64).
				e.preventDefault();
				e.stopPropagation();
				dom.setFocusedItem(item);
				void this.openItemInBackgroundTab(item);
				return;
			}
			if (e.button !== 0) return;

			if (this.preview && !e.altKey) {
				// While previewing, a click previews the result instead of opening it.
				e.preventDefault();
				e.stopPropagation();
				dom.setFocusedItem(item);
				const resolved = resolveResultItem(item);
				if (resolved) void this.showPreview(resolved);
				return;
			}

			// Let Obsidian open the file, then close the modal.
			window.setTimeout(() => this.close(), 0);
		};
		ctn.addEventListener("click", onResultClick, true);
		ctn.addEventListener("auxclick", onResultClick, true);
	}
}
