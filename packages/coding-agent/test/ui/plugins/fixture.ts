/**
 * The plugin settings capture builders (`settings-overlays/plugin-settings.ts`):
 * the same plugins, host and per-case steps, driving pi-tui plugin settings.
 */
import { batch, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import type {
	InstalledPlugin,
	InstalledPluginSummary,
	PluginListEntry,
	PluginSettingsHost,
	PluginSettingsManager,
} from "../../../src/modes/view-model/overlays/plugin-settings";
import { createPluginSettings, type PluginStart } from "../../../src/ui/overlays/plugins/settings";
import type { Driven } from "../settings/harness";

const npm = (name: string, o: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
	name,
	version: "1.2.3",
	enabled: true,
	enabledFeatures: null,
	manifest: { description: `desc ${name}` },
	...o,
});
const mkt = (
	id: string,
	o: Partial<InstalledPluginSummary> = {},
	entry: Record<string, unknown> = {},
): InstalledPluginSummary => ({
	id,
	scope: "user",
	entries: [
		{
			installPath: `/cache/marketplace/${id}`,
			version: "0.4.2",
			installedAt: "2026-01-02",
			lastUpdated: "2026-02-03",
			enabled: true,
			...entry,
		},
	],
	...o,
});
const rich = npm("rich-plugin", {
	enabledFeatures: ["alpha"],
	manifest: {
		description: "Rich plugin with features and settings",
		features: { alpha: { description: "Alpha feature", default: true }, beta: { default: false }, gamma: {} },
		settings: {
			apiKey: { type: "string", secret: true, description: "API key" },
			endpoint: { type: "string", description: "Endpoint URL" },
			retries: { type: "number", min: 0, max: 9, default: 3 },
			mode: { type: "enum", values: ["fast", "slow", "日本語"], default: "fast", description: "Mode" },
			verbose: { type: "boolean", default: false },
		},
	},
});
const manager: PluginSettingsManager = {
	list: async () => [rich, npm("plain", { enabled: false })],
	getPlugin: async name => (name === "with-settings" ? { ...rich, name: "with-settings" } : undefined),
	getPluginSettings: async () => ({ apiKey: "s3cret", endpoint: "https://x" }),
	setEnabled: async () => {},
	getEnabledFeatures: async () => ["alpha"],
	setEnabledFeatures: async () => {},
	setPluginSetting: async () => {},
};
const host: PluginSettingsHost = {
	manager,
	createMarketplaceManager: async () => ({
		listInstalledPlugins: async () => [
			mkt("with-settings@mkt", { shadowedBy: "project" }, { gitCommitSha: "abc1234" }),
			mkt("bare@mkt", { scope: "project" }, { enabled: false }),
		],
		setPluginEnabled: async () => {},
	}),
	parsePluginId: id => ({ name: id.split("@")[0]! }),
};
const entries: PluginListEntry[] = [
	{ kind: "npm", plugin: rich },
	{ kind: "npm", plugin: npm("plain", { enabled: false }) },
	{ kind: "marketplace", plugin: mkt("shared@mkt", { shadowedBy: "project" }) },
	{
		kind: "marketplace",
		plugin: mkt(
			"a-very-long-marketplace-plugin-name-that-overflows@some-marketplace-日本",
			{ scope: "project" },
			{ enabled: false },
		),
	},
];

const DOWN = "\x1b[B";
const UP = "\x1b[A";
type Step = { keys?: string[]; event?: UiEvent };
const ev = (event: Record<string, unknown>): Step => ({ event: { key: "", mods: [], ...event } as unknown as UiEvent });

/** Named steps of each case (`prefsPage`/`settle` only take a snapshot). */
const STEPS: Record<string, Record<string, Step>> = {
	list: {
		select: ev({ type: "select", item: "npm:plain" }),
		open: ev({ type: "action", act: "open", value: "mkt:user:shared@mkt" }),
	},
	"npm detail": {
		"toggle enabled": { keys: [" "] },
		"feature down+toggle": { keys: [DOWN, " "] },
		"native change": ev({ type: "change", item: "feature:beta", value: true }),
		"native select": ev({ type: "select", item: "config:endpoint" }),
		"native edit": ev({ type: "action", act: "edit", value: "config:endpoint" }),
		type: { keys: ["a", "b", "\x1b[D", "c"] },
		"native close": ev({ type: "action", act: "close", value: "config:endpoint" }),
		"activate mode": ev({ type: "activate", item: "config:mode" }),
		"enum nav": { keys: [DOWN, DOWN] },
		"enum pick": { keys: ["\n"] },
		"to retries": { keys: [DOWN, DOWN, DOWN, DOWN, DOWN, DOWN, "\n"] },
		"type number": { keys: ["7"] },
		escape: { keys: ["\x1b"] },
		"down to secret": { keys: [UP, UP, "\n"] },
		"type secret": { keys: ["z", "\r"] },
	},
	"mkt detail with runtime settings": {
		toggle: { keys: [" "] },
		"open mode": { keys: [DOWN, DOWN, DOWN, DOWN, "\n"] },
		close: ev({ type: "action", act: "close", value: "config:mode" }),
	},
	"mkt detail bare": {
		change: ev({ type: "change", item: "__enabled__", value: true }),
	},
	"settings component": {
		select: ev({ type: "select", item: "mkt:user:with-settings@mkt" }),
		open: ev({ type: "action", act: "open", value: "mkt:user:with-settings@mkt" }),
		toggle: { keys: [" "] },
		back: { keys: ["\x1b"] },
		"npm detail": { keys: ["\n"] },
		"edit endpoint": { keys: [DOWN, DOWN, DOWN, DOWN, DOWN, "\n"] },
		type: { keys: ["q"] },
		cancel: { keys: ["\x1b"] },
	},
};

const STARTS: Record<string, PluginStart | undefined> = {
	list: { kind: "list", entries },
	"list empty": { kind: "list", entries: [] },
	"npm detail": { kind: "npm", plugin: rich },
	"mkt detail with runtime settings": {
		kind: "mkt",
		plugin: mkt("with-settings@mkt", { shadowedBy: "project" }, { gitCommitSha: "abc1234" }),
	},
	"mkt detail bare": { kind: "mkt", plugin: mkt("bare@mkt", { scope: "project" }, { enabled: false }) },
	"settings component": undefined,
};

/** A plugin settings case (`settings <name>`) and its step runner. */
export function buildPluginSettings(caseName: string): {
	driven: Driven;
	step: (label: string) => Promise<boolean>;
} {
	const name = caseName.replace(/^settings /, "");
	const settings = createPluginSettings(
		host,
		{ onClose: () => {}, onPluginChanged: () => {}, onOpen: () => {}, onBack: () => {} },
		STARTS[name],
	);
	// A view started on its own is its panel; the host-driven settings are the column holding it.
	const driven: Driven = {
		get root(): UiNode {
			return STARTS[name] ? settings.view.children()[0]! : settings.view;
		},
		key: key => batch(() => void settings.key(key)),
		event: event => settings.event(event),
	};
	const steps = STEPS[name] ?? {};
	return {
		driven,
		step: async label => {
			if (label === "prefsPage") return true;
			if (label === "settle") {
				await Bun.sleep(3);
				return true;
			}
			const step = steps[label];
			if (!step) return false;
			if (step.event) settings.event(step.event);
			for (const raw of step.keys ?? []) {
				const key = decodeKey(raw, { kitty: false, backspaceIsCtrl: false });
				if (key) batch(() => void settings.key(key));
			}
			await Bun.sleep(3);
			return true;
		},
	};
}
