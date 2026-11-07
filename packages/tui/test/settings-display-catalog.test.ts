import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import {
	displayTemplate,
	getDisplayCatalog,
	getDisplayCatalogEpoch,
	setDisplayCatalog,
} from "@oh-my-pi/pi-tui/overlays/display-catalog";
import type { PluginSettingsHost } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import {
	getAllSettingDefs,
	groupDisplayName,
	TAB_METADATA,
	type SettingsDisplayEntry,
	type SettingsHost,
	tabDisplayLead,
	tabDisplayMetadata,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const ENTRIES: SettingsDisplayEntry[] = [
	{
		path: "theme.dark",
		type: "string",
		defaultValue: "dark",
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Dark theme",
			description: "Theme on dark",
			options: [
				{ value: "dark", label: "Dark" },
				{ value: "light", label: "Light" },
			],
		},
	},
	{
		path: "display.colorBlind",
		type: "boolean",
		defaultValue: false,
		ui: {
			tab: "appearance",
			group: "Theme",
			label: "Color-blind mode",
			description: "Blue additions",
			warning: "Can get you flagged",
		},
	},
	{
		path: "display.statusBar",
		type: "boolean",
		defaultValue: true,
		ui: { tab: "appearance", group: "Status Line", label: "Status bar", description: "Draw it" },
	},
];

/** The English rendering of ENTRIES: path, label, description, warning, group. */
type SettingRow = readonly [string, string, string, string | undefined, string | undefined];

const ENGLISH: SettingRow[] = [
	["theme.dark", "Dark theme", "Theme on dark", undefined, "Theme"],
	["display.colorBlind", "Color-blind mode", "Blue additions", "Can get you flagged", "Theme"],
	["display.statusBar", "Status bar", "Draw it", undefined, "Status Line"],
];

function englishRows(): SettingRow[] {
	return getAllSettingDefs(ENTRIES).map(def => [def.path, def.label, def.description, def.warning, def.group]);
}

function harness(): SettingsSelectorComponent {
	const values = new Map<string, unknown>(ENTRIES.map(entry => [entry.path, entry.defaultValue]));
	const settings: SettingsHost = {
		entries: ENTRIES,
		get: path => values.get(path),
		set: (path, value) => void values.set(path, value),
		unset: path => void values.set(path, ENTRIES.find(entry => entry.path === path)?.defaultValue),
		normalizeProviderLimits: () => ({}),
		validateProviderLimits: () => ({}),
	};
	const plugins: PluginSettingsHost = {
		manager: {
			list: async () => [],
			getPlugin: async () => undefined,
			getPluginSettings: async () => ({}),
			setEnabled: async () => {},
			getEnabledFeatures: async () => null,
			setEnabledFeatures: async () => {},
			setPluginSetting: async () => {},
		},
		createMarketplaceManager: async () => ({
			listInstalledPlugins: async () => [],
			setPluginEnabled: async () => {},
		}),
		parsePluginId: () => null,
	};
	return new SettingsSelectorComponent(
		{
			settings,
			plugins,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

const PREFS: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function prefsProps(selector: SettingsSelectorComponent): TspPrefsProps {
	const described = selector.describe(PREFS);
	if (described.k !== "prefs" || !described.p) throw new Error(`described ${described.k}, not prefs`);
	return described.p;
}

describe("settings display catalog", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	afterEach(() => {
		setDisplayCatalog(undefined);
	});

	it("renders the English baseline and keeps the tab metadata identity when no catalog is installed", () => {
		expect(getDisplayCatalog()).toBeUndefined();
		expect(englishRows()).toEqual(ENGLISH);
		// Nothing was translated, so callers keep the very same objects.
		expect(tabDisplayMetadata("appearance")).toBe(TAB_METADATA.appearance);
		expect(tabDisplayLead("appearance")).toBe("Theme, composer, status line and how the transcript renders.");
		expect(groupDisplayName("appearance", "Theme")).toBe("Theme");
	});

	it("translates the labelled tab only, leaving every other label, path and group alone", () => {
		const baseline = englishRows();
		setDisplayCatalog({ locale: "ru", strings: { "tab.appearance.label": "Оформление" } });

		const appearance = tabDisplayMetadata("appearance");
		expect(appearance.label).toBe("Оформление");
		expect(appearance.icon).toBe("tab.appearance");
		expect(appearance).not.toBe(TAB_METADATA.appearance);
		// Tabs without a key keep their canonical metadata object.
		expect(tabDisplayMetadata("model")).toBe(TAB_METADATA.model);
		expect(getAllSettingDefs(ENTRIES).map(def => def.path)).toEqual(ENGLISH.map(([path]) => path));
		expect(englishRows()).toEqual(baseline);
	});

	it("keeps a string English when the catalog has no key for it", () => {
		setDisplayCatalog({
			locale: "ru",
			strings: {
				"setting.theme.dark.label": "Тёмная тема",
				"setting.theme.dark.option.light.label": "Светлая",
			},
		});
		const [themed, colorBlind, statusBar] = getAllSettingDefs(ENTRIES);

		expect(themed?.label).toBe("Тёмная тема");
		expect(themed?.description).toBe("Theme on dark");
		expect(themed?.type).toBe("submenu");
		if (themed?.type !== "submenu") throw new Error("theme.dark is not a submenu");
		expect(themed.options.map(option => [option.value, option.label])).toEqual([
			["dark", "Dark"],
			["light", "Светлая"],
		]);
		// Mixed output: the untranslated neighbours keep their English text, warning included.
		expect(colorBlind?.label).toBe("Color-blind mode");
		expect(colorBlind?.warning).toBe("Can get you flagged");
		expect(statusBar?.label).toBe("Status bar");
	});

	it("restores English when the catalog is cleared, rebuilding the cached definitions", () => {
		setDisplayCatalog({ locale: "ru", strings: { "setting.theme.dark.label": "Тёмная тема" } });
		const translated = getAllSettingDefs(ENTRIES);
		expect(translated[0]?.label).toBe("Тёмная тема");

		const epoch = getDisplayCatalogEpoch();
		setDisplayCatalog({ locale: "ru", strings: { "setting.theme.dark.label": "Тема" } });
		expect(getDisplayCatalogEpoch()).toBe(epoch + 1);
		const retranslated = getAllSettingDefs(ENTRIES);
		expect(retranslated).not.toBe(translated);
		expect(retranslated[0]?.label).toBe("Тема");

		setDisplayCatalog(undefined);
		expect(getDisplayCatalog()).toBeUndefined();
		expect(englishRows()).toEqual(ENGLISH);
	});

	it("fills template placeholders and falls back when the key or a placeholder is missing", () => {
		const english = " $SEARXNG_ENDPOINT overrides this setting while it is set.";
		const values = { env: "SEARXNG_ENDPOINT" };
		expect(displayTemplate("chrome.envNote.override", english, values)).toBe(english);

		setDisplayCatalog({
			locale: "ru",
			strings: { "chrome.envNote.override": " Переменная {env} перекрывает значение." },
		});
		expect(displayTemplate("chrome.envNote.override", english, values)).toBe(
			" Переменная SEARXNG_ENDPOINT перекрывает значение.",
		);
		expect(displayTemplate("chrome.envNote.fallback", english, values)).toBe(english);
		expect(displayTemplate("chrome.envNote.override", english, {})).toBe(english);
	});

	it("translates a section heading while its id and ordering stay canonical", () => {
		const selector = harness();
		expect(prefsProps(selector).sections.map(section => section.id)).toEqual(["theme", "status-line"]);

		setDisplayCatalog({ locale: "ru", strings: { "group.appearance.Theme": "Тема" } });
		const props = prefsProps(selector);
		expect(props.sections.map(section => section.id)).toEqual(["theme", "status-line"]);
		expect(props.sections.map(section => section.title)).toEqual(["Тема", "Status Line"]);
		// The definition still carries the canonical group, which drives ordering and section ids.
		expect(getAllSettingDefs(ENTRIES).find(def => def.path === "theme.dark")?.group).toBe("Theme");
	});
});
