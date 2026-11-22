import { type AnyUiMetadata, SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "./settings-defs";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";
import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgDefaultThinkingLevel,
	cfgRetryUsageAwareFallback,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgComposerPredictions, cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { cfgContextFilesExtra } from "../session/context-settings";
import { cfgTaskPerCallModelAllow } from "../task/settings";
import { cfgToolsRestrictedFolders } from "../tools/settings";
import { cfgAuthUnpausedProviders } from "./model-settings";
import { nativeRendering } from "@oh-my-pi/pi-tui";
import { terminalCapabilities } from "@oh-my-pi/pi-tui/driver/session";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowRead,
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxFallback,
	cfgSandboxMode,
	cfgSandboxListDrives,
	cfgSandboxLoopback,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "../sandbox/settings";
import { readSandboxConfig, sandboxEnabled } from "../sandbox/policy";
import { networkModeUnavailable } from "../sandbox/runtime";

/** Condition over the global settings; hidden (false) until they are initialized. */
function whenSettings(test: (settings: Settings) => boolean): () => boolean {
	return () => isSettingsInitialized() && test(Settings.instance);
}

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	windows: () => process.platform === "win32",
	hasImageProtocol: () => terminalCapabilities().images !== null,
	nativeRendering: () => nativeRendering(),
	advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
	vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
	composerPredictionsEnabled: whenSettings(s => cfgComposerPredictions.get(s) === true),
	hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
	mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
	autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
	autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
	usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
	planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
	planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
	// These editors write the global layer; hide them so a project-supplied list is never promoted to global.
	contextFilesExtraNotProject: whenSettings(s => cfgContextFilesExtra.provenance(s) !== "project"),
	restrictedFoldersNotProject: whenSettings(s => cfgToolsRestrictedFolders.provenance(s) !== "project"),
	perCallModelAllowNotProject: whenSettings(s => cfgTaskPerCallModelAllow.provenance(s) !== "project"),
	unpausedProvidersNotProject: whenSettings(s => cfgAuthUnpausedProviders.provenance(s) !== "project"),
	sandboxScopeNotProject: whenSettings(s => cfgSandboxScope.provenance(s) !== "project"),
	sandboxAllowWriteNotProject: whenSettings(s => cfgSandboxAllowWrite.provenance(s) !== "project"),
	sandboxAllowReadNotProject: whenSettings(s => cfgSandboxAllowRead.provenance(s) !== "project"),
	sandboxDenyReadNotProject: whenSettings(s => cfgSandboxDenyRead.provenance(s) !== "project"),
	sandboxAllowedHostsNotProject: whenSettings(s => cfgSandboxAllowedHosts.provenance(s) !== "project"),
};

/**
 * Rows that show the value in force rather than the layered one. The sandbox drops project values
 * that would loosen it, so its scalar rows show what {@link readSandboxConfig} applies; edits still
 * write the global layer.
 */
const EFFECTIVE_VALUES = new Map<string, (settings: Settings) => unknown>([
	[cfgSandboxEnabled.id, s => sandboxEnabled(s)],
	[cfgSandboxMode.id, s => readSandboxConfig(s).mode],
	[cfgSandboxFallback.id, s => readSandboxConfig(s).fallback],
	[cfgSandboxReadScope.id, s => readSandboxConfig(s).readScope],
	[cfgSandboxNetworkMode.id, s => readSandboxConfig(s).networkMode],
	[cfgSandboxListDrives.id, s => readSandboxConfig(s).listDrives],
	[cfgSandboxLoopback.id, s => readSandboxConfig(s).loopback],
]);

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

/**
 * `sandbox.network.mode` choices this host cannot enforce stay listed but disabled and labelled
 * `(unavailable)`. The reasons are also appended to the row's description: a plain terminal cuts a
 * disabled option's own description to one line, while the focused row's and the submenu's
 * description wrap, so the missing packages stay readable at 80 columns (docs/sandbox.md, "Network").
 */
function networkModeUi(ui: AnyUiMetadata): AnyUiMetadata {
	if (ui.options === undefined || ui.options === "runtime") return ui;
	const reasons: string[] = [];
	const options = ui.options.map(option => {
		const reason = networkModeUnavailable(cfgSandboxNetworkMode.parse(option.value));
		if (!reason) return option;
		reasons.push(reason);
		return { ...option, label: `${option.label} (unavailable)`, description: reason, disabled: true };
	});
	if (reasons.length === 0) return ui;
	return { ...ui, description: [ui.description.replace(/\.?$/, "."), ...reasons].join(" "), options };
}

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows and
 * edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 * Rows in {@link EFFECTIVE_VALUES} show the value in force instead.
 */
export function createSettingsHost(): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			const shown = setting === cfgSandboxNetworkMode ? networkModeUi(ui) : ui;
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...shown, description: `${shown.description}${note}` } : shown,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? CONDITIONS[ui.condition] : undefined,
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
			const effective = EFFECTIVE_VALUES.get(path);
			return effective ? effective(settings) : lookup(path)?.layered(settings);
		},
		set: (path, value) => {
			// Refused here too: a disabled choice cannot be picked, but a caller may still pass one.
			if (path === cfgSandboxNetworkMode.id) {
				const unavailable = networkModeUnavailable(cfgSandboxNetworkMode.parse(String(value)));
				if (unavailable) throw new Error(unavailable);
			}
			resolve(path).set(settings, value);
		},
		unset: path => resolve(path).unset(settings),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
