import {
	App,
	PluginSettingTab,
	Setting,
	SettingControl,
	SettingDefinitionItem,
} from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import {
	FloatSearchSettings,
	searchState,
	SORT_ORDER_LABELS,
	TRIGGER_KEY_OPTIONS,
	VIEW_TYPE_LABELS,
} from "./floatSearchTypes";

/** Default search options are stored in `searchViewState`, under these keys. */
const SEARCH_KEY_PREFIX = "search.";

type SearchOptionKey = "sortOrder" | "collapseAll" | "extraContext" | "explainSearch" | "matchingCase";
type SettingKey =
	| Exclude<keyof FloatSearchSettings, "searchViewState">
	| `${typeof SEARCH_KEY_PREFIX}${SearchOptionKey}`;

export class FloatSearchSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FloatSearchPlugin) {
		super(app, plugin);
	}

	/** Obsidian 1.13+ renders these itself and indexes them for the settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.definitions();
	}

	getControlValue(key: string): unknown {
		return this.readValue(key);
	}

	setControlValue(key: string, value: unknown): Promise<void> {
		return this.writeValue(key, value);
	}

	/** Obsidian before 1.13 only calls display(): render the same definitions. */
	display() {
		const { containerEl } = this;
		containerEl.empty();
		this.renderItems(containerEl, this.definitions());
	}

	private definitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				type: "group",
				items: [
					{
						name: "Default view type",
						desc: "Where searches opened by commands, links, bookmarks and the ribbon icon are shown.",
						control: { type: "dropdown", key: "defaultViewType", options: VIEW_TYPE_LABELS },
					},
					{
						name: "Show instructions",
						desc: "Show the keyboard shortcuts below the search modal.",
						control: { type: "toggle", key: "showInstructions" },
					},
					{
						name: "Show file path",
						desc: "Show the folder of each result next to its file name.",
						control: { type: "toggle", key: "showFilePath" },
					},
					{
						name: "Preview while navigating",
						desc: "Preview the focused result automatically when moving with the arrow keys. When off, press Tab to preview.",
						control: { type: "toggle", key: "autoPreview" },
					},
					{
						name: "Focus result under the mouse",
						desc: "Moving the mouse over a result focuses it, so the arrow keys and Enter continue from there.",
						control: { type: "toggle", key: "hoverToFocus" },
					},
				],
			},
			// Search options used by every search opened through Float Search (#77).
			{
				type: "group",
				heading: "Search defaults",
				items: [
					{
						name: "Sort order",
						desc: "Used, like the toggles below, by every search opened with Float Search. Changing it inside a search view updates it here too.",
						control: {
							type: "dropdown",
							key: "search.sortOrder",
							options: SORT_ORDER_LABELS,
							defaultValue: "alphabetical",
						},
					},
					{
						name: "Collapse results",
						desc: "Show only the file names, collapsed.",
						control: { type: "toggle", key: "search.collapseAll", defaultValue: false },
					},
					{
						name: "Show more context",
						desc: "Show more lines around each match.",
						control: { type: "toggle", key: "search.extraContext", defaultValue: false },
					},
					{
						name: "Explain search term",
						desc: "Show how the query is interpreted.",
						control: { type: "toggle", key: "search.explainSearch", defaultValue: false },
					},
					{
						name: "Match case",
						desc: "Make searches case-sensitive.",
						control: { type: "toggle", key: "search.matchingCase", defaultValue: false },
					},
				],
			},
			{
				type: "group",
				heading: "Quick search",
				items: [
					{
						name: "Quick search trigger",
						desc: "Double-tap this key to open the quick search modal (CMDK).",
						control: { type: "dropdown", key: "cmdkTriggerKey", options: TRIGGER_KEY_OPTIONS },
					},
					{
						name: "Double-tap interval (ms)",
						desc: "Maximum time between two key presses to trigger quick search. Default: 300ms.",
						control: { type: "slider", key: "cmdkDoubleTapInterval", min: 150, max: 600, step: 50 },
					},
				],
			},
			{
				type: "group",
				heading: "Quick create",
				items: [
					{
						name: "Enable quick create",
						desc: "When no exact match is found in quick search, show an option to create a new note with the search text as content.",
						control: { type: "toggle", key: "cmdkQuickCreate" },
					},
					{
						name: "Quick create folder",
						desc: "Folder to create new notes in. Leave empty for vault root.",
						control: { type: "text", key: "cmdkQuickCreateFolder", placeholder: "e.g. Inbox" },
					},
					{
						name: "Title format",
						desc: "Timestamp format for the note title. Tokens: YYYY, MM, DD, HH, mm, ss.",
						control: {
							type: "text",
							key: "cmdkQuickCreateTitleFormat",
							placeholder: "YYYYMMDDHHmmss",
						},
					},
				],
			},
		];
	}

	private readValue(key: string): unknown {
		const { settings } = this.plugin;
		if (key.startsWith(SEARCH_KEY_PREFIX)) {
			return settings.searchViewState[key.slice(SEARCH_KEY_PREFIX.length)];
		}
		return (settings as unknown as Record<string, unknown>)[key];
	}

	private async writeValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith(SEARCH_KEY_PREFIX)) {
			const update: Partial<searchState> = { [key.slice(SEARCH_KEY_PREFIX.length)]: value };
			await this.plugin.updateSearchDefaults(update);
			return;
		}
		if (key === "showFilePath") {
			// Also updates the open search views; saves the settings.
			this.plugin.setFilePathVisibility(value === true);
			return;
		}
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	private renderItems(containerEl: HTMLElement, items: SettingDefinitionItem[]) {
		for (const item of items) {
			if ("type" in item) {
				// Groups (and lists); this tab has no sub-pages.
				if (item.type === "page") continue;
				if (item.heading) new Setting(containerEl).setName(item.heading).setHeading();
				this.renderItems(containerEl, item.items ?? []);
				continue;
			}
			if (!item.control) continue;
			const setting = new Setting(containerEl).setName(item.name);
			if (item.desc) setting.setDesc(item.desc);
			this.renderControl(setting, item.control);
		}
	}

	private renderControl(setting: Setting, control: SettingControl) {
		const value = this.readValue(control.key);
		const save = (newValue: unknown) => this.writeValue(control.key, newValue);

		switch (control.type) {
			case "toggle":
				setting.addToggle((toggle) =>
					toggle
						.setValue(typeof value === "boolean" ? value : control.defaultValue ?? false)
						.onChange(save)
				);
				break;
			case "dropdown":
				setting.addDropdown((dropdown) =>
					dropdown
						.addOptions(control.options)
						.setValue(typeof value === "string" ? value : control.defaultValue ?? "")
						.onChange(save)
				);
				break;
			case "slider": {
				// Shown inline next to the slider, as Obsidian 1.13+ does.
				const current = typeof value === "number" ? value : control.defaultValue ?? control.min;
				const valueEl = setting.controlEl.createSpan({
					cls: "float-search-setting-value",
					text: String(current),
				});
				setting.addSlider((slider) =>
					slider
						.setLimits(control.min, control.max, control.step)
						.setValue(current)
						.onChange((newValue) => {
							valueEl.setText(String(newValue));
							return save(newValue);
						})
				);
				break;
			}
			case "text":
				setting.addText((text) =>
					text
						.setPlaceholder(control.placeholder ?? "")
						.setValue(typeof value === "string" ? value : control.defaultValue ?? "")
						.onChange(save)
				);
				break;
		}
	}
}
