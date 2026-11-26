/** @jsxImportSource @oh-my-pi/pi-tui */
/** The settings capture builder's host, rebuilt from a case's plain-JSON fixture. */
import { createRoot, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { CorpusCase } from "@oh-my-pi/pi-tui/testing/corpus";
import type { SettingsDisplayEntry, SettingsHost } from "../../../src/config/settings-defs";
import type { PluginSettingsHost } from "../../../src/modes/view-model/overlays/plugin-settings";
import { createPluginSettingsPage } from "../../../src/ui/overlays/plugins/settings";
import { SettingsWindow } from "../../../src/ui/overlays/settings/settings";
import type { Driven } from "./harness";

interface Fixture {
	readonly entries: SettingsDisplayEntry[];
	readonly options: { initial?: Record<string, unknown>; describePreview?: boolean; plugins?: boolean };
	readonly host: {
		availableThemes: string[];
		runtimeOptions: Record<string, { value: string; label: string; description?: string }[]>;
		providers: string[];
		plugin: { name: string; version: string; path: string; enabled: boolean };
	};
}

function normalize(value: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (!value || typeof value !== "object") return out;
	for (const k in value) {
		const v = (value as Record<string, unknown>)[k];
		if (typeof v === "number" && v > 0) out[k] = Math.floor(v);
	}
	return out;
}

/** The settings window over the case fixture. */
export function buildSettings(corpus: CorpusCase): Driven {
	const fixture = (corpus.inputs as { fixture: Fixture }).fixture;
	const o = fixture.options;
	const entries = fixture.entries.map(entry =>
		entry.path === "files.gated" ? { ...entry, condition: () => true } : entry,
	);
	const values = new Map<string, unknown>();
	for (const entry of entries) values.set(entry.path, entry.defaultValue);
	for (const key in o.initial) values.set(key, o.initial[key]);
	const settings: SettingsHost = {
		entries,
		get: p => values.get(p),
		set: (p, value) => void values.set(p, value),
		unset: p => void values.set(p, entries.find(entry => entry.path === p)?.defaultValue),
		normalizeProviderLimits: normalize,
		validateProviderLimits: normalize,
	};
	const plugin = { ...fixture.host.plugin, manifest: {}, enabledFeatures: null };
	const plugins = {
		manager: {
			list: async () => (o.plugins ? [plugin] : []),
			getPlugin: async () => (o.plugins ? plugin : undefined),
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
	} as PluginSettingsHost;
	let preview = "status";
	const runtimeOptions = new Map(Object.entries(fixture.host.runtimeOptions));
	const root = createRoot(
		() =>
			(
				<SettingsWindow
					pluginsPage={createPluginSettingsPage}
					context={{
						settings,
						plugins,
						availableThinkingLevels: [],
						availableThemes: fixture.host.availableThemes,
						runtimeOptions,
						providers: fixture.host.providers,
					}}
					callbacks={{
						onChange: () => {},
						onThemePreview: name => {
							preview = name;
						},
						currentThemeName: () => "<in-memory>",
						onStatusLinePreview: s => {
							preview = JSON.stringify(s).slice(0, 30);
						},
						getStatusLinePreview: (): TspSpan[] => [
							{ s: "accent", t: `◆ ${preview}` },
							{ s: "dim", t: " · main" },
						],
						describeStatusLinePreview: o.describePreview ? () => <text text={`bar ${preview}`} /> : undefined,
						onCancel: () => {},
					}}
				/>
			) as UiNode,
	);
	return { root, height: 40 };
}
