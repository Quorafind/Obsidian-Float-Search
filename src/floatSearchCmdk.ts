import {
	debounce,
	Keymap,
	Platform,
	prepareFuzzySearch,
	prepareSimpleSearch,
	renderResults,
	SearchResult,
	setIcon,
	SuggestModal,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import type { CmdkResult } from "./floatSearchTypes";
import { PreviewPane } from "./previewPane";

export type { CmdkResult };

const MOD = Platform.isMacOS ? "Cmd" : "Ctrl";
/** Larger files are skipped by the content search, they make it crawl. */
const MAX_CONTENT_SEARCH_FILE_SIZE = 2 * 1024 * 1024;

interface Chooser {
	setSuggestions(items: CmdkResult[]): void;
	addSuggestion(item: CmdkResult): void;
	useSelectedItem?(evt: KeyboardEvent): boolean;
}

export class FloatSearchCmdkModal extends SuggestModal<CmdkResult> {
	private bodyEl: HTMLElement;
	private preview: PreviewPane | null = null;
	private searchAbort: AbortController | null = null;
	private isClosed = false;
	private composing = false;

	constructor(private readonly plugin: FloatSearchPlugin) {
		super(plugin.app);
		this.limit = 50;
		this.setPlaceholder("Search files and content...");
		this.setInstructions([
			{ command: "↑↓", purpose: "Navigate" },
			{ command: "↵", purpose: "Open" },
			{ command: `${MOD} ↵`, purpose: "New tab" },
			{ command: "esc", purpose: "Close" },
		]);
		this.modalEl.addClass("float-search-cmdk");
		this.containerEl.addClass("float-search-cmdk-container");

		this.scope.register(["Mod"], "Enter", (evt) => {
			if (evt.isComposing) return;
			this.getChooser().useSelectedItem?.(evt);
			return false;
		});

		// While an IME composes text the input holds half-typed syllables
		// (pinyin, kana...). Searching and swapping previews on every one of
		// them steals focus from the input and breaks the composition (#81).
		this.inputEl.addEventListener("compositionstart", () => {
			this.composing = true;
			this.searchAbort?.abort();
			this.onSelectedChange.cancel();
		});
		this.inputEl.addEventListener("compositionend", () => {
			this.composing = false;
			if (!this.isClosed) this.updateSuggestions();
		});
	}

	// SuggestModal assigns its (internal) chooser in its constructor.
	private getChooser(): Chooser {
		return (this as unknown as { chooser: Chooser }).chooser;
	}

	onOpen() {
		void super.onOpen();
		const resultContainerEl = (
			this as unknown as { resultContainerEl: HTMLElement }
		).resultContainerEl;
		this.bodyEl = createDiv("float-search-cmdk-body");
		this.modalEl.insertBefore(this.bodyEl, resultContainerEl);
		this.bodyEl.appendChild(resultContainerEl);
	}

	onClose() {
		this.isClosed = true;
		this.searchAbort?.abort();
		this.onSelectedChange.cancel();
		this.preview?.destroy();
		this.preview = null;
	}

	// Required by SuggestModal but unused: the chooser is driven directly.
	getSuggestions(_query: string): CmdkResult[] {
		return [];
	}

	// Progressive rendering: file names first, then headings, then content.
	updateSuggestions() {
		if (this.composing || this.isClosed) return;

		this.searchAbort?.abort();
		const abort = (this.searchAbort = new AbortController());
		const { signal } = abort;

		const chooser = this.getChooser();
		const query = this.inputEl.value;
		const trimmed = query.trim();

		const files = this.app.vault
			.getFiles()
			.filter(
				(f: TFile) =>
					f.extension === "md" ||
					f.extension === "canvas" ||
					f.extension === "pdf"
			);

		if (!trimmed) {
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

		// Phase 1: file name / path fuzzy match (sync, instant)
		const fuzzy = prepareFuzzySearch(query);
		const fileResults: CmdkResult[] = [];
		for (const file of files) {
			const nameMatch = fuzzy(file.basename);
			const pathMatch = fuzzy(file.path);
			if (nameMatch || pathMatch) {
				fileResults.push({ file, nameMatch, pathMatch, type: "file" });
			}
		}

		const score = (r: CmdkResult) =>
			Math.max(
				r.nameMatch?.score ?? -Infinity,
				(r.pathMatch?.score ?? -Infinity) * 0.5
			);
		fileResults.sort((a, b) => score(b) - score(a));

		const queryLower = trimmed.toLowerCase();
		const hasExactMatch = fileResults.some(
			(r) => r.file.basename.toLowerCase() === queryLower
		);

		const resultsToShow = fileResults.slice(0, this.limit);
		if (this.plugin.settings.cmdkQuickCreate && !hasExactMatch) {
			resultsToShow.push({
				file: null as unknown as TFile,
				nameMatch: null,
				pathMatch: null,
				type: "create",
				createQuery: trimmed,
			});
		}
		chooser.setSuggestions(resultsToShow);

		if (trimmed.length >= 2) {
			// Phase 2: headings (progressive, batched)
			this.progressiveHeadingSearch(files, fuzzy, chooser, signal);
			// Phase 3: content (progressive, reads files)
			this.progressiveContentSearch(files, query, chooser, signal);
		}
	}

	private progressiveHeadingSearch(
		files: TFile[],
		fuzzy: (text: string) => SearchResult | null,
		chooser: Chooser,
		signal: AbortSignal
	) {
		const BATCH_SIZE = 50;
		const MAX_HEADING_RESULTS = 20;
		let idx = 0;
		let added = 0;

		const processBatch = () => {
			if (signal.aborted) return;
			const end = Math.min(idx + BATCH_SIZE, files.length);
			for (; idx < end; idx++) {
				const file = files[idx];
				const headings = this.app.metadataCache.getFileCache(file)?.headings;
				if (!headings) continue;
				for (const h of headings) {
					const headingMatch = fuzzy(h.heading);
					if (!headingMatch) continue;
					chooser.addSuggestion({
						file,
						nameMatch: null,
						pathMatch: null,
						heading: h.heading,
						headingMatch,
						type: "heading",
					});
					if (++added >= MAX_HEADING_RESULTS) return;
				}
			}
			if (idx < files.length) window.setTimeout(processBatch, 0);
		};

		// Next tick, so file results render first.
		window.setTimeout(processBatch, 0);
	}

	private progressiveContentSearch(
		files: TFile[],
		query: string,
		chooser: Chooser,
		signal: AbortSignal
	) {
		const BATCH_SIZE = 50;
		const MAX_CONTENT_RESULTS = 20;
		const DURATION_LIMIT = 5; // ms of work before yielding
		const simpleSearch = prepareSimpleSearch(query);
		let idx = 0;
		let added = 0;

		const processBatch = async () => {
			const start = performance.now();
			for (; idx < files.length; idx++) {
				if (signal.aborted || added >= MAX_CONTENT_RESULTS) return;

				if (idx % BATCH_SIZE === 0 && idx > 0 && performance.now() - start > DURATION_LIMIT) {
					window.setTimeout(run, 0);
					return;
				}

				const file = files[idx];
				if (file.extension !== "md") continue;
				if (file.stat.size > MAX_CONTENT_SEARCH_FILE_SIZE) continue;

				let text: string;
				try {
					text = await this.app.vault.cachedRead(file);
				} catch {
					continue;
				}
				if (signal.aborted) return;

				const result = simpleSearch(text);
				if (!result) continue;

				// Line number and line text of the first match
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

				chooser.addSuggestion({
					file,
					nameMatch: null,
					pathMatch: null,
					content: lineText,
					contentMatch: simpleSearch(lineText),
					line,
					type: "content",
				});
				added++;
			}
		};
		const run = () => {
			if (signal.aborted) return;
			void processBatch().catch((error) => {
				console.error("Float Search: quick search content search failed", error);
			});
		};

		// Give the heading search a chance to render first.
		window.setTimeout(run, 50);
	}

	renderSuggestion(result: CmdkResult, el: HTMLElement) {
		el.addClass("mod-complex");

		if (result.type === "create") {
			el.addClass("float-search-cmdk-create-item");
			const contentEl = el.createDiv("suggestion-content");
			contentEl.createDiv({ cls: "suggestion-title", text: "Create new note" });
			const folder = this.plugin.settings.cmdkQuickCreateFolder || "/";
			contentEl.createDiv({
				cls: "suggestion-note",
				text: `"${result.createQuery}" → ${folder}`,
			});
			setIcon(el.createDiv("suggestion-aux").createSpan("suggestion-flair"), "plus");
			return;
		}

		const contentEl = el.createDiv("suggestion-content");
		const titleEl = contentEl.createDiv("suggestion-title");
		const noteEl = contentEl.createDiv("suggestion-note");

		if (result.type === "content" && result.content) {
			if (result.contentMatch) renderResults(titleEl, result.content, result.contentMatch);
			else titleEl.setText(result.content);
			noteEl.setText(result.file.path);
		} else if (result.type === "heading" && result.heading) {
			if (result.headingMatch) renderResults(titleEl, result.heading, result.headingMatch);
			else titleEl.setText(result.heading);
			noteEl.setText(result.file.path);
		} else {
			if (result.nameMatch) renderResults(titleEl, result.file.basename, result.nameMatch);
			else titleEl.setText(result.file.basename);
			const parentPath = result.file.parent?.path || "/";
			if (result.pathMatch) renderResults(noteEl, parentPath, result.pathMatch);
			else noteEl.setText(parentPath);
		}

		if (result.file.extension !== "md") {
			el.createDiv("suggestion-aux")
				.createSpan("suggestion-flair")
				.setText(result.file.extension);
		}
	}

	onChooseSuggestion(result: CmdkResult, evt: MouseEvent | KeyboardEvent) {
		if (result.type === "create") {
			void this.quickCreateNote(result.createQuery ?? "", evt).catch((error) => {
				console.error("Float Search: failed to create note from quick search", error);
			});
			return;
		}

		const leaf = this.resolveTargetLeaf(evt);
		const eState = this.ephemeralStateFor(result);
		void leaf
			.setViewState({
				type: result.file.extension === "pdf" ? "pdf" : "markdown",
				state: { file: result.file.path },
				active: true,
			})
			.then(() => {
				if (eState) leaf.setEphemeralState(eState);
			})
			.catch((error) => {
				console.error("Float Search: failed to open quick search result", error);
			});
	}

	private ephemeralStateFor(result: CmdkResult): Record<string, unknown> | undefined {
		if (result.type === "heading" && result.heading) {
			return { subpath: "#" + result.heading };
		}
		if (result.type === "content" && result.line != null) {
			return { line: result.line };
		}
		return undefined;
	}

	private resolveTargetLeaf(evt: MouseEvent | KeyboardEvent): WorkspaceLeaf {
		return Keymap.isModEvent(evt)
			? this.app.workspace.getLeaf("tab")
			: this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf();
	}

	private async quickCreateNote(content: string, evt: MouseEvent | KeyboardEvent) {
		const settings = this.plugin.settings;
		const fmt = settings.cmdkQuickCreateTitleFormat || "YYYYMMDDHHmmss";
		const title = this.formatTimestamp(new Date(), fmt);

		let folderPath = settings.cmdkQuickCreateFolder.trim();
		if (folderPath === "/") folderPath = "";
		if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
			await this.app.vault.createFolder(folderPath);
		}

		const filePath = folderPath ? `${folderPath}/${title}.md` : `${title}.md`;
		const file = await this.app.vault.create(filePath, content);

		await this.resolveTargetLeaf(evt).setViewState({
			type: "markdown",
			state: { file: file.path },
			active: true,
		});
	}

	private formatTimestamp(date: Date, fmt: string): string {
		const pad = (n: number) => String(n).padStart(2, "0");
		const tokens: Record<string, string> = {
			YYYY: String(date.getFullYear()),
			YY: String(date.getFullYear()).slice(-2),
			MM: pad(date.getMonth() + 1),
			DD: pad(date.getDate()),
			HH: pad(date.getHours()),
			mm: pad(date.getMinutes()),
			ss: pad(date.getSeconds()),
		};
		let result = fmt;
		// Longest tokens first to avoid partial matches
		for (const token of ["YYYY", "YY", "MM", "DD", "HH", "mm", "ss"]) {
			result = result.split(token).join(tokens[token]);
		}
		return result;
	}

	// Called by the internal chooser when the selection changes.
	onSelectedChange = debounce(
		(result: CmdkResult | undefined, _evt: Event | null) => {
			if (this.isClosed || this.composing) return;
			if (!result || result.type === "create" || !result.file) {
				this.hidePreview();
				return;
			}
			void this.showPreview(result).catch((error) => {
				console.error("Float Search: failed to show quick search preview", error);
			});
		},
		100,
		true
	);

	private hidePreview() {
		this.preview?.el.hide();
		this.modalEl.removeClass("float-search-cmdk-expanded");
	}

	private async showPreview(result: CmdkResult) {
		if (!this.preview) {
			this.preview = new PreviewPane(
				this.plugin,
				this.bodyEl,
				"float-search-cmdk-preview"
			);
		}
		this.preview.el.show();
		this.modalEl.addClass("float-search-cmdk-expanded");

		const eState = this.ephemeralStateFor(result);
		await this.preview.open(result.file, eState, `${result.file.path}#${result.type}:${result.heading ?? result.line ?? ""}`);

		// Only hand focus back if the preview took it. Calling focus() on the
		// input in the middle of an IME composition would cancel it.
		if (!this.isClosed && !this.composing && activeDocument.activeElement !== this.inputEl) {
			this.inputEl.focus();
		}
	}
}
