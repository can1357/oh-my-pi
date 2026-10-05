import { beforeAll, describe, expect, it } from "bun:test";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { PluginSettingsHost } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import type { SettingsDisplayEntry, SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const ENTER = "\n";
const DOWN = "\x1b[B";

const ENTRIES: SettingsDisplayEntry[] = [
	{
		path: "theme.dark",
		type: "string",
		defaultValue: "dark",
		ui: { tab: "appearance", group: "Theme", label: "Dark theme", description: "Theme on dark", options: "runtime" },
	},
	{
		path: "display.colorBlind",
		type: "boolean",
		defaultValue: false,
		ui: { tab: "appearance", group: "Theme", label: "Color-blind mode", description: "Blue additions" },
	},
	{
		path: "display.risky",
		type: "boolean",
		defaultValue: false,
		ui: { tab: "appearance", group: "Status Line", label: "Risky", description: "d", warning: "Can get you flagged" },
	},
	{
		path: "compaction.thresholdPercent",
		type: "number",
		defaultValue: -1,
		ui: {
			tab: "context",
			group: "Compaction",
			label: "Threshold",
			description: "When to compact",
			options: [
				{ value: "default", label: "Default" },
				{ value: "50", label: "50%" },
				{ value: "80", label: "80%" },
			],
		},
	},
	{ path: "shell.path", type: "string", defaultValue: "", ui: { tab: "shell", label: "Shell path", description: "" } },
	{
		path: "providers.order",
		type: "array",
		defaultValue: ["a", "b"],
		ui: {
			tab: "providers",
			label: "Order",
			description: "",
			ordered: true,
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
			],
		},
	},
];

interface Harness {
	selector: SettingsSelectorComponent;
	values: Map<string, unknown>;
	changes: [string, unknown][];
	previews: string[];
}

function harness(initial: Record<string, unknown> = {}): Harness {
	const values = new Map<string, unknown>();
	for (const entry of ENTRIES) values.set(entry.path, entry.defaultValue);
	for (const key in initial) values.set(key, initial[key]);
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
	const changes: [string, unknown][] = [];
	const previews: string[] = [];
	const selector = new SettingsSelectorComponent(
		{
			settings,
			plugins,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark", "light", "titanium"],
			providers: [],
		},
		{
			onChange: (path, value) => changes.push([path, value]),
			onThemePreview: name => void previews.push(name),
			onCancel: () => {},
		},
	);
	return { selector, values, changes, previews };
}

const PREFS: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function prefs(selector: SettingsSelectorComponent): { node: NativeNode; props: TspPrefsProps } {
	const described = selector.describe(PREFS);
	if (described.k !== "prefs" || !described.p) throw new Error(`described ${described.k}, not prefs`);
	return { node: described, props: described.p };
}

function row(props: TspPrefsProps, id: string) {
	for (const section of props.sections) for (const r of section.rows) if (r.id === id) return r;
	throw new Error(`no row ${id}`);
}

function send(selector: SettingsSelectorComponent, event: NativeUiEvent): void {
	selector.handleNativeEvent(event);
}

describe("settings as a native prefs page", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme");
		setThemeInstance(dark);
	});

	it("falls back to the overlay card when the terminal lacks prefs", () => {
		const { selector } = harness();
		const card = selector.describe({ ...PREFS, supports: kind => kind !== "prefs" });
		expect(card.k).toBe("card");
	});

	it("docks beside the transcript only where the terminal advertises aside", () => {
		const { selector } = harness();
		expect(selector.nativeSheet(PREFS)).toBe(true);
		expect(selector.nativeSheet({ ...PREFS, feature: name => name !== "aside" })).toBe(false);
		expect(selector.nativeSheet({ ...PREFS, supports: kind => kind !== "prefs" })).toBe(false);
	});

	it("draws tabs as pages with changed counts, groups as sections and settings as typed controls", () => {
		const { selector } = harness({ "display.colorBlind": true, "compaction.thresholdPercent": 80 });
		const { props } = prefs(selector);
		expect(props.page).toBe("appearance");
		expect(props.lead).toBeTruthy();
		expect(props.pages.find(p => p.id === "appearance")?.changed).toBe(1);
		expect(props.pages.find(p => p.id === "context")?.changed).toBe(1);
		expect(props.pages.find(p => p.id === "shell")?.changed).toBeUndefined();
		expect(props.pages.at(-1)).toMatchObject({ id: "plugins", group: "Plugins" });
		expect(props.sections.map(s => s.id)).toEqual(["theme", "status-line"]);

		expect(row(props, "theme.dark").control).toMatchObject({ k: "choice", value: "dark", style: "menu", mono: true });
		expect(row(props, "display.colorBlind")).toMatchObject({
			changed: true,
			defaultLabel: "Off",
			control: { k: "switch", on: true },
		});
		expect(row(props, "display.risky").warning).toBe("Can get you flagged");
		expect(props.focus).toBe("theme.dark");
	});

	it("puts the status-line preview after its section on Appearance only", () => {
		const { selector } = harness();
		const roles = (n: NativeNode) => (n.c ?? []).map(c => ("k" in c && c.p && "role" in c.p ? c.p.role : undefined));
		expect(roles(prefs(selector).node)).toContain("omp.prefs.preview.status");
		send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
		const shell = prefs(selector);
		expect(shell.props.page).toBe("shell");
		expect(roles(shell.node)).not.toContain("omp.prefs.preview.status");
	});

	it("maps number-like choices to a stepper and sets the chosen step like the submenu", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "context", mods: [] });
		expect(row(prefs(selector).props, "compaction.thresholdPercent").control).toEqual({
			k: "number",
			value: -1,
			labels: { "-1": "Default", "50": "50%", "80": "80%" },
		});
		send(selector, { type: "change", key: "", item: "compaction.thresholdPercent", value: 50 });
		expect(values.get("compaction.thresholdPercent")).toBe(50);
		expect(changes.at(-1)).toEqual(["compaction.thresholdPercent", "50"]);
		send(selector, { type: "change", key: "", item: "compaction.thresholdPercent", value: -1 });
		expect(values.get("compaction.thresholdPercent")).toBe(-1);
		// The submenu closed after the pick, as Enter closes it.
		expect(prefs(selector).props.editing).toBeNull();
	});

	it("flips a switch through the list's change path and resets to the default with null", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "change", key: "", item: "display.colorBlind", value: true });
		expect(values.get("display.colorBlind")).toBe(true);
		expect(changes).toEqual([["display.colorBlind", true]]);
		expect(row(prefs(selector).props, "display.colorBlind").changed).toBe(true);

		send(selector, { type: "change", key: "", item: "display.colorBlind", value: null });
		expect(values.get("display.colorBlind")).toBe(false);
		expect(row(prefs(selector).props, "display.colorBlind").changed).toBeUndefined();
	});

	it("opens a choice menu, previews on hover, and reverts the preview when the menu closes", () => {
		const { selector, values, previews } = harness();
		send(selector, { type: "activate", key: "", item: "theme.dark" });
		expect(prefs(selector).props.editing).toEqual({ row: "theme.dark", option: "dark" });

		send(selector, { type: "select", key: "", item: "theme.dark=titanium" });
		expect(previews).toEqual(["titanium"]);
		expect(prefs(selector).props.editing).toEqual({ row: "theme.dark", option: "titanium" });

		send(selector, { type: "action", key: "", act: "close", value: "theme.dark", mods: [] });
		expect(prefs(selector).props.editing).toBeNull();
		expect(previews.length).toBe(2);
		expect(values.get("theme.dark")).toBe("dark");
	});

	it("picks a menu option like Enter in the submenu", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "change", key: "", item: "theme.dark", value: "light" });
		expect(values.get("theme.dark")).toBe("light");
		expect(changes.at(-1)).toEqual(["theme.dark", "light"]);
		expect(row(prefs(selector).props, "theme.dark").control).toMatchObject({ value: "light" });
	});

	it("shows the text editor's draft and cursor while the keys edit it, and submits a pointer change", () => {
		const { selector, values } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
		send(selector, { type: "activate", key: "", item: "shell.path" });
		for (const ch of "/bin/zsh") selector.handleInput(ch);
		expect(prefs(selector).props.editing).toEqual({ row: "shell.path", draft: "/bin/zsh", cursor: 8 });
		selector.handleInput(ENTER);
		expect(values.get("shell.path")).toBe("/bin/zsh");

		send(selector, { type: "change", key: "", item: "shell.path", value: "/bin/fish" });
		expect(values.get("shell.path")).toBe("/bin/fish");
		expect(prefs(selector).props.editing).toBeNull();
	});

	it("applies a reordered multiselect as the submenu would", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		expect(row(prefs(selector).props, "providers.order").control).toMatchObject({
			k: "multi",
			values: ["a", "b"],
			ordered: true,
		});
		send(selector, { type: "change", key: "", item: "providers.order", value: ["c", "a"] });
		expect(values.get("providers.order")).toEqual(["c", "a"]);
		expect(changes.at(-1)).toEqual(["providers.order", ["c", "a"]]);
		expect(row(prefs(selector).props, "providers.order")).toMatchObject({
			changed: true,
			control: { values: ["c", "a"] },
		});
	});

	it("refreshes the chip row and its tab badge when a chip is toggled while the submenu is open", () => {
		const { selector, values } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		send(selector, { type: "activate", key: "", item: "providers.order" });
		expect(prefs(selector).props.editing?.row).toBe("providers.order");

		send(selector, { type: "change", key: "", item: "providers.order", value: ["a", "c"] });
		expect(values.get("providers.order")).toEqual(["a", "c"]);
		const after = prefs(selector).props;
		expect(row(after, "providers.order")).toMatchObject({
			changed: true,
			control: { values: ["a", "c"] },
		});
		expect(after.pages.find(p => p.id === "providers")?.changed).toBe(1);
		// The user keeps working in the submenu the toggle came from.
		expect(after.editing?.row).toBe("providers.order");
		// The submenu itself took the new order, so the refresh did not come
		// from silently dropping the toggle and letting the row catch up.
		const openRows = selector
			.render(100)
			.map(line => Bun.stripANSI(line))
			.filter(line => /[0-9]\. [AC]|·  B/.test(line));
		expect(openRows.length).toBe(3);
		expect(openRows.some(line => line.includes("1. A"))).toBe(true);
		expect(openRows.some(line => line.includes("2. C"))).toBe(true);
		expect(openRows.some(line => line.includes("·  B"))).toBe(true);
	});

	it("searches across pages, grouping results by page and section, and a page click leaves the search", () => {
		const { selector } = harness();
		selector.handleInput("t");
		selector.handleInput("h");
		const { props } = prefs(selector);
		expect(props.query).toBe("th");
		expect(props.sections.every(s => s.page !== undefined)).toBe(true);
		expect(props.sections.some(s => s.id === "appearance/theme")).toBe(true);

		send(selector, { type: "action", key: "", act: "page", value: "context", mods: [] });
		const after = prefs(selector).props;
		expect(after.query).toBeUndefined();
		expect(after.page).toBe("context");
	});

	it("keyboard focus follows the list selection", () => {
		const { selector } = harness();
		selector.handleInput(DOWN);
		expect(prefs(selector).props.focus).toBe("display.colorBlind");
		send(selector, { type: "select", key: "", item: "display.risky" });
		expect(prefs(selector).props.focus).toBe("display.risky");
	});
});
