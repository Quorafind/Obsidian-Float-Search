import { App, PluginSettingTab, Setting } from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import {
	CmdkTriggerKey,
	searchState,
	searchType,
	SORT_ORDER_LABELS,
	sortOrder,
	TRIGGER_KEY_OPTIONS,
	VIEW_TYPE_LABELS,
} from "./floatSearchTypes";

type BooleanSearchOption = "collapseAll" | "extraContext" | "explainSearch" | "matchingCase";

const SEARCH_TOGGLES: [BooleanSearchOption, string, string][] = [
	["collapseAll", "Collapse results", "Show only the file names, collapsed."],
	["extraContext", "Show more context", "Show more lines around each match."],
	["explainSearch", "Explain search term", "Show how the query is interpreted."],
	["matchingCase", "Match case", "Make searches case-sensitive."],
];

export class FloatSearchSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FloatSearchPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const { settings } = this.plugin;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default view type")
			.setDesc(
				"Where searches opened by commands, links, bookmarks and the ribbon icon are shown."
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(VIEW_TYPE_LABELS)
					.setValue(settings.defaultViewType)
					.onChange(async (value) => {
						settings.defaultViewType = value as searchType;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Show instructions")
			.setDesc("Show the keyboard shortcuts below the search modal.")
			.addToggle((toggle) =>
				toggle.setValue(settings.showInstructions).onChange(async (value) => {
					settings.showInstructions = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show file path")
			.setDesc("Show the folder of each result next to its file name.")
			.addToggle((toggle) =>
				toggle.setValue(settings.showFilePath).onChange((value) => {
					this.plugin.setFilePathVisibility(value);
				})
			);

		new Setting(containerEl)
			.setName("Preview while navigating")
			.setDesc(
				"Preview the focused result automatically when moving with the arrow keys. When off, press Tab to preview."
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.autoPreview).onChange(async (value) => {
					settings.autoPreview = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Focus result under the mouse")
			.setDesc(
				"Moving the mouse over a result focuses it, so the arrow keys and Enter continue from there."
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.hoverToFocus).onChange(async (value) => {
					settings.hoverToFocus = value;
					await this.plugin.saveSettings();
				})
			);

		this.displaySearchDefaults(containerEl);
		this.displayQuickSearch(containerEl);
	}

	/** Search options used by every search opened through Float Search (#77). */
	private displaySearchDefaults(containerEl: HTMLElement) {
		const state = this.plugin.settings.searchViewState;
		new Setting(containerEl)
			.setName("Search options")
			.setDesc(
				"Used by every search opened with Float Search. Changing an option inside a search view updates these too."
			)
			.setHeading();

		new Setting(containerEl).setName("Sort order").addDropdown((dropdown) => {
			dropdown
				.addOptions(SORT_ORDER_LABELS)
				.setValue(state.sortOrder ?? "alphabetical")
				.onChange(async (value) => {
					await this.plugin.updateSearchDefaults({ sortOrder: value as sortOrder });
				});
		});

		for (const [key, name, desc] of SEARCH_TOGGLES) {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((toggle) =>
					toggle.setValue(!!state[key]).onChange(async (value) => {
						const update: Partial<searchState> = { [key]: value };
						await this.plugin.updateSearchDefaults(update);
					})
				);
		}
	}

	private displayQuickSearch(containerEl: HTMLElement) {
		const { settings } = this.plugin;
		new Setting(containerEl).setName("Quick search").setHeading();

		new Setting(containerEl)
			.setName("Quick search trigger")
			.setDesc("Double-tap this key to open the quick search modal (CMDK).")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(TRIGGER_KEY_OPTIONS)
					.setValue(settings.cmdkTriggerKey)
					.onChange(async (value) => {
						settings.cmdkTriggerKey = value as CmdkTriggerKey;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Double-tap interval (ms)")
			.setDesc(
				"Maximum time between two key presses to trigger quick search. Default: 300ms."
			)
			.addSlider((slider) =>
				slider
					.setLimits(150, 600, 50)
					.setValue(settings.cmdkDoubleTapInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.cmdkDoubleTapInterval = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Quick create").setHeading();

		new Setting(containerEl)
			.setName("Enable quick create")
			.setDesc(
				"When no exact match is found in quick search, show an option to create a new note with the search text as content."
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.cmdkQuickCreate).onChange(async (value) => {
					settings.cmdkQuickCreate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Quick create folder")
			.setDesc("Folder to create new notes in. Leave empty for vault root.")
			.addText((text) =>
				text
					.setPlaceholder("e.g. Inbox")
					.setValue(settings.cmdkQuickCreateFolder)
					.onChange(async (value) => {
						settings.cmdkQuickCreateFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Title format")
			.setDesc("Timestamp format for the note title. Tokens: YYYY, MM, DD, HH, mm, ss.")
			.addText((text) =>
				text
					.setPlaceholder("YYYYMMDDHHmmss")
					.setValue(settings.cmdkQuickCreateTitleFormat)
					.onChange(async (value) => {
						settings.cmdkQuickCreateTitleFormat = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
