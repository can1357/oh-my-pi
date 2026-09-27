import { TERMINAL } from "@oh-my-pi/pi-tui";
import { SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";

/**
 * Where the settings panel reads and writes values: the live settings by default, or a profile
 * draft that must never reach them.
 */
export interface SettingsHostSource {
	/** Value the panel shows and edits for `setting`. */
	get(setting: AnySetting): unknown;
	set(setting: AnySetting, value: unknown): void;
	/** Drops the value so whatever lies beneath it applies again. */
	unset(setting: AnySetting): void;
}

export interface CreateSettingsHostOptions {
	/** Read/write source; supplying one keeps every panel edit away from the live settings. */
	source?: SettingsHostSource;
}

/** `ui.condition` predicates over the values `read` yields. */
function createConditions(read: (setting: AnySetting) => unknown): Record<string, () => boolean> {
	return {
		macOS: () => process.platform === "darwin",
		hasImageProtocol: () => !!TERMINAL.imageProtocol,
		advisorEnabled: () => read(cfgAdvisorEnabled) === true,
		vimModeEnabled: () => read(cfgTuiVimMode) === true,
		hindsightActive: () => read(cfgMemoryBackend) === "hindsight",
		mnemopiActive: () => read(cfgMemoryBackend) === "mnemopi",
		autolearnActive: () => read(cfgAutolearnEnabled) === true,
		autoThinkingActive: () => read(cfgDefaultThinkingLevel) === "auto",
		usageAwareFallbackEnabled: () => read(cfgRetryUsageAwareFallback) === true,
		planModeEnabled: () => read(cfgPlanEnabled) === true,
		planAutosaveEnabled: () => read(cfgPlanEnabled) === true && read(cfgPlanAutosave) === true,
	};
}

/** Conditions over the global settings; hidden (false) until they are initialized. */
const LIVE_CONDITIONS = createConditions(setting =>
	isSettingsInitialized() ? setting.get(Settings.instance) : undefined,
);

const LIVE_SOURCE: SettingsHostSource = {
	get: setting => setting.layered(settings),
	set: (setting, value) => setting.set(settings, value),
	unset: setting => setting.unset(settings),
};

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

/**
 * Adapt the application schema and a settings source to the terminal overlay. The live source shows
 * and edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 */
export function createSettingsHost(options: CreateSettingsHostOptions = {}): SettingsHost {
	const source = options.source ?? LIVE_SOURCE;
	const conditions = options.source ? createConditions(setting => source.get(setting)) : LIVE_CONDITIONS;
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? conditions[ui.condition] : undefined,
			});
		}
	}
	const resolve = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(`Unknown setting: ${path}`);
		return setting;
	};
	return {
		entries,
		get: path => {
			const setting = lookup(path);
			return setting ? source.get(setting) : undefined;
		},
		set: (path, value) => source.set(resolve(path), value),
		unset: path => source.unset(resolve(path)),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
