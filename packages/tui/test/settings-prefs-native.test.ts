import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import type { TspPrefsProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { PluginSettingsHost } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import type { SettingsDisplayEntry, SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { applyLinkMapSetting } from "@oh-my-pi/pi-tui/render/link-map";
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
		path: "edit.mode",
		type: "enum",
		enumValues: ["apply_patch", "hashline", "patch", "replace", "sloppy", "none"],
		defaultValue: "hashline",
		ui: { tab: "files", group: "Editing", label: "Edit Mode", description: "" },
	},
	{
		path: "tui.linkMap",
		type: "record",
		defaultValue: {},
		ui: { tab: "shell", label: "Link Map", description: "", editor: "linkMap" },
	},
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
	{
		path: "providers.tokens",
		type: "array",
		defaultValue: [],
		credential: true,
		ui: { tab: "providers", label: "Tokens", description: "", editor: "json" },
	},
];

interface Harness {
	selector: SettingsSelectorComponent;
	values: Map<string, unknown>;
	changes: [string, unknown][];
	previews: string[];
	/** Each `setEntry` call: path, key, value. */
	entryWrites: [string, string, unknown][];
}

/** @param shadowed - record keys a layer above the global config supplies, by that layer's name */
function harness(initial: Record<string, unknown> = {}, shadowed: Record<string, string> = {}): Harness {
	const values = new Map<string, unknown>();
	for (const entry of ENTRIES) values.set(entry.path, entry.defaultValue);
	for (const key in initial) values.set(key, initial[key]);
	const settings: SettingsHost = {
		entries: ENTRIES,
		get: path => values.get(path),
		set: (path, value) => void values.set(path, value),
		setEntry: (path, key, value) => {
			entryWrites.push([path, key, value]);
			const record = { ...(values.get(path) as Record<string, unknown>) };
			if (value === undefined) delete record[key];
			else record[key] = value;
			values.set(path, record);
		},
		unset: path => void values.set(path, ENTRIES.find(entry => entry.path === path)?.defaultValue),
		shadowingLayer: (_path, key) => shadowed[key],
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
	const entryWrites: [string, string, unknown][] = [];
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
	return { selector, values, changes, previews, entryWrites };
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

	it("opens an enum's menu on activate and closes it on a pick", () => {
		const { selector, values, changes } = harness();
		send(selector, { type: "action", key: "", act: "page", value: "files", mods: [] });
		send(selector, { type: "activate", key: "", item: "edit.mode" });
		expect(prefs(selector).props.editing).toEqual({ row: "edit.mode", option: "hashline" });

		send(selector, { type: "select", key: "", item: "edit.mode=sloppy" });
		expect(prefs(selector).props.editing).toEqual({ row: "edit.mode", option: "sloppy" });

		send(selector, { type: "change", key: "", item: "edit.mode", value: "sloppy" });
		expect(values.get("edit.mode")).toBe("sloppy");
		expect(changes).toEqual([["edit.mode", "sloppy"]]);
		expect(prefs(selector).props.editing).toBeNull();
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

	describe("tui.linkMap editor", () => {
		const ESC = "\x1b";
		const BACKSPACE = "\x7f";
		const type = (selector: SettingsSelectorComponent, keys: string) => {
			for (const ch of keys) selector.handleInput(ch);
		};
		const screen = (selector: SettingsSelectorComponent) => Bun.stripANSI(selector.render(160).join("\n"));

		afterEach(() => applyLinkMapSetting({}));

		it("adds, refuses and removes entries without leaving the editor, then shows the count on the row", () => {
			const { selector, values, changes } = harness({ "tui.linkMap": { "~": "file:///Z:/" } });
			send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
			expect(row(prefs(selector).props, "tui.linkMap").control).toEqual({
				k: "action",
				label: "Edit…",
				act: "edit",
			});

			send(selector, { type: "activate", key: "", item: "tui.linkMap" });
			expect(screen(selector)).toContain("→ file:///Z:/");
			selector.handleInput(DOWN);
			selector.handleInput(ENTER);
			type(selector, "/mnt/projects");
			selector.handleInput(ENTER);
			// A target with a query is refused on save.
			type(selector, "ftp?");
			selector.handleInput(ENTER);
			expect(values.get("tui.linkMap")).toEqual({ "~": "file:///Z:/" });
			for (let i = 0; i < 4; i++) selector.handleInput(BACKSPACE);
			// The sample link follows the target as it is typed, before anything is saved.
			type(selector, "https://files.contoso.example/projects");
			expect(screen(selector)).toContain("https://files.contoso.example/projects/example.md");
			expect(values.get("tui.linkMap")).toEqual({ "~": "file:///Z:/" });
			selector.handleInput(ENTER);
			const added = { "~": "file:///Z:/", "/mnt/projects": "https://files.contoso.example/projects" };
			expect(values.get("tui.linkMap")).toEqual(added);
			expect(changes.at(-1)).toEqual(["tui.linkMap", added]);

			// Still in the editor: the list shows the new entry, and clearing a target removes its entry.
			expect(screen(selector)).toContain("→ https://files.contoso.example/projects");
			selector.handleInput(ENTER);
			selector.handleInput("\x01");
			selector.handleInput("\x0b");
			selector.handleInput(ENTER);
			expect(values.get("tui.linkMap")).toEqual({ "~": "file:///Z:/" });

			selector.handleInput(ESC);
			expect(prefs(selector).props.editing).toBeNull();
			expect(row(prefs(selector).props, "tui.linkMap").control).toEqual({
				k: "action",
				label: "Edit…",
				act: "edit",
			});
			expect(screen(selector)).toContain("1 entry: ~");
		});

		it("keeps an entry a higher layer supplies read-only and saves a new entry on its own", () => {
			const { selector, entryWrites } = harness(
				{ "tui.linkMap": { "/work": "file:///W:/" } },
				{ "/work": "--config overlay" },
			);
			send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
			send(selector, { type: "activate", key: "", item: "tui.linkMap" });
			// Rows: the higher layer's entry, Add entry…, Test a path…. Choosing the entry does not open its target form.
			selector.handleInput(ENTER);
			expect(screen(selector)).not.toContain("/work/example.md");
			expect(screen(selector)).toContain("--config overlay");

			selector.handleInput(DOWN);
			selector.handleInput(ENTER);
			// Adding the same prefix is refused, naming the layer: a global entry for it would not reach links.
			type(selector, "/work");
			selector.handleInput(ENTER);
			expect(screen(selector)).toContain("--config overlay");
			for (let i = 0; i < 4; i++) selector.handleInput(BACKSPACE);
			type(selector, "mnt/projects");
			selector.handleInput(ENTER);
			type(selector, "file:///Z:/");
			selector.handleInput(ENTER);
			// The save is that one entry: the higher layer's entry is not written along with it.
			expect(entryWrites).toEqual([["tui.linkMap", "/mnt/projects", "file:///Z:/"]]);
		});

		it("keeps a refusal visible when a higher layer acquires an equivalent prefix during an open form", () => {
			const map = { "/work": "file:///W:/" };
			const shadowed: Record<string, string> = {};
			const { selector, values, entryWrites, changes } = harness({ "tui.linkMap": map }, shadowed);
			send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
			send(selector, { type: "activate", key: "", item: "tui.linkMap" });
			selector.handleInput(ENTER);
			values.set("tui.linkMap", { ...map, "//work": "file:///Overlay:/" });
			shadowed["//work"] = "--config overlay";
			selector.handleInput(ENTER);
			expect(screen(selector)).toContain("The --config overlay sets //work");
			// Typing a still-valid target must not clear the layer refusal after Enter.
			type(selector, "next");
			expect(screen(selector)).toContain("The --config overlay sets //work");
			selector.handleInput(ENTER);
			expect(screen(selector)).toContain("The --config overlay sets //work");
			expect(entryWrites).toEqual([]);
			expect(changes).toEqual([]);
			expect(values.get("tui.linkMap")).toEqual({ ...map, "//work": "file:///Overlay:/" });
		});

		it("refuses a nonempty edit to a later normalized duplicate but removes only that entry when cleared", () => {
			const map = { "/a/b": "file:///First:/", "/a//b": "file:///Later:/" };
			const { selector, values, entryWrites, changes } = harness({ "tui.linkMap": map });
			send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
			send(selector, { type: "activate", key: "", item: "tui.linkMap" });
			// Alphabetical display puts /a//b first, but insertion order grants /a/b ownership.
			expect(screen(selector)).toContain("ignored: same prefix as /a/b");
			selector.handleInput(ENTER);
			selector.handleInput(ENTER);
			expect(screen(selector)).toContain("/a/b is already the entry for that prefix");
			type(selector, "next");
			expect(screen(selector)).toContain("Clear the target to remove this ignored entry.");
			selector.handleInput(ENTER);
			expect(entryWrites).toEqual([]);
			expect(changes).toEqual([]);
			expect(values.get("tui.linkMap")).toEqual(map);
			selector.handleInput("\x01");
			selector.handleInput("\x0b");
			expect(screen(selector)).not.toContain("already the entry for that prefix");
			selector.handleInput(ENTER);
			expect(entryWrites).toEqual([["tui.linkMap", "/a//b", undefined]]);
			expect(values.get("tui.linkMap")).toEqual({ "/a/b": "file:///First:/" });
			expect(changes).toEqual([["tui.linkMap", { "/a/b": "file:///First:/" }]]);
		});

		for (const invalidFirst of [true, false]) {
			it(`repairs an invalid stored target using its ${invalidFirst ? "earlier" : "later"} insertion position`, () => {
				const map = invalidFirst
					? { "/a/b": "bad?", "/a//b": "file:///Valid:/" }
					: { "/a/b": "file:///Valid:/", "/a//b": "bad?" };
				const key = invalidFirst ? "/a/b" : "/a//b";
				const { selector, values, entryWrites, changes } = harness({ "tui.linkMap": map });
				send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
				send(selector, { type: "activate", key: "", item: "tui.linkMap" });
				expect(screen(selector)).not.toContain("ignored: same prefix");
				if (invalidFirst) selector.handleInput(DOWN);
				selector.handleInput(ENTER);
				selector.handleInput(ENTER);
				expect(screen(selector)).toContain("Use a URI with a scheme");
				selector.handleInput("\x01");
				selector.handleInput("\x0b");
				type(selector, "file:///Repaired:/");
				selector.handleInput(ENTER);
				if (invalidFirst) {
					expect(entryWrites).toEqual([["tui.linkMap", key, "file:///Repaired:/"]]);
					expect(values.get("tui.linkMap")).toEqual({ ...map, [key]: "file:///Repaired:/" });
					expect(screen(selector)).toContain("ignored: same prefix as /a/b");
				} else {
					expect(screen(selector)).toContain("/a/b is already the entry for that prefix");
					expect(entryWrites).toEqual([]);
					expect(changes).toEqual([]);
					expect(values.get("tui.linkMap")).toEqual(map);
				}
			});
		}

		it.skipIf(process.platform === "win32")("a rejected home alias does not reserve its other physical prefix", () => {
			const home = spyOn(os, "homedir").mockReturnValue("/logical/home");
			const real = spyOn(fs, "realpathSync").mockReturnValue("/physical/home");
			try {
				const map = {
					"/logical/home": "file:///First:/",
					"~": "file:///Ignored:/",
					"/physical/home": "file:///Physical:/",
				};
				const { selector, values, entryWrites } = harness({ "tui.linkMap": map });
				send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
				send(selector, { type: "activate", key: "", item: "tui.linkMap" });
				expect(screen(selector)).toContain("ignored: same prefix as /logical/home");
				expect(screen(selector)).not.toContain("ignored: same prefix as ~");
				selector.handleInput(DOWN);
				selector.handleInput(ENTER);
				selector.handleInput(ENTER);
				expect(entryWrites).toEqual([["tui.linkMap", "/physical/home", "file:///Physical:/"]]);
				expect(values.get("tui.linkMap")).toEqual(map);
			} finally {
				real.mockRestore();
				home.mockRestore();
			}
		});

		it.skipIf(process.platform === "win32")("tests a path against the map links use, and clears every entry", () => {
			const map = { "/srv/handbook": "https://git.contoso.example/handbook/blob/main" };
			const { selector, values } = harness({ "tui.linkMap": map });
			// The host's setting effect pushes the stored map; this harness has none.
			applyLinkMapSetting(map);
			send(selector, { type: "action", key: "", act: "page", value: "shell", mods: [] });
			send(selector, { type: "activate", key: "", item: "tui.linkMap" });
			// Rows: the entry, Add entry…, Test a path…, Clear all entries.
			selector.handleInput(DOWN);
			selector.handleInput(DOWN);
			selector.handleInput(ENTER);
			type(selector, "/srv/handbook/a b.md");
			selector.handleInput(ENTER);
			expect(screen(selector)).toContain("https://git.contoso.example/handbook/blob/main/a%20b.md");

			for (let i = 0; i < 3; i++) selector.handleInput(DOWN);
			selector.handleInput(ENTER);
			expect(values.get("tui.linkMap")).toEqual({});
		});
	});

	it("masks credential arrays in rows and drafts without saving mask glyphs", () => {
		const { selector, values } = harness({ "providers.tokens": ["private-token"] });
		send(selector, { type: "action", key: "", act: "page", value: "providers", mods: [] });
		const control = row(prefs(selector).props, "providers.tokens").control;
		expect(JSON.stringify(control)).not.toContain("private-token");
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("private-token");

		send(selector, { type: "activate", key: "", item: "providers.tokens" });
		expect(prefs(selector).props.editing?.draft).toMatch(/^•+$/);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("private-token");
		selector.handleInput("\x01");
		selector.handleInput("\x0b");
		for (const character of '["replacement-token"]') selector.handleInput(character);
		expect(prefs(selector).props.editing?.draft).toMatch(/^•+$/);
		expect(Bun.stripANSI(selector.render(120).join("\n"))).not.toContain("replacement-token");
		selector.handleInput(ENTER);
		expect(values.get("providers.tokens")).toEqual(["replacement-token"]);
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
