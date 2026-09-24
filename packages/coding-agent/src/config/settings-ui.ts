import { TERMINAL } from "@oh-my-pi/pi-tui";
import { SETTING_TABS, type SettingsDisplayEntry, type SettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { lookup } from "./registry";

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

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => {
		try {
			return cfgAdvisorEnabled.get(Settings.instance) === true;
		} catch {
			return false;
		}
	},
	vimModeEnabled: () => {
		try {
			return cfgTuiVimMode.get(Settings.instance) === true;
		} catch {
			return false;
		}
	},
	hindsightActive: () => {
		try {
			return cfgMemoryBackend.get(Settings.instance) === "hindsight";
		} catch {
			return false;
		}
	},
	mnemopiActive: () => {
		try {
			return cfgMemoryBackend.get(Settings.instance) === "mnemopi";
		} catch {
			return false;
		}
	},
	autolearnActive: () => {
		try {
			return cfgAutolearnEnabled.get(Settings.instance) === true;
		} catch {
			return false;
		}
	},
	autoThinkingActive: () => {
		try {
			return cfgDefaultThinkingLevel.get(Settings.instance) === "auto";
		} catch {
			return false;
		}
	},
	usageAwareFallbackEnabled: () => {
		try {
			return cfgRetryUsageAwareFallback.get(Settings.instance) === true;
		} catch {
			return false;
		}
	},
	planModeEnabled: () => {
		try {
			return cfgPlanEnabled.get(Settings.instance);
		} catch {
			return false;
		}
	},
	planAutosaveEnabled: () => {
		try {
			return cfgPlanEnabled.get(Settings.instance) && cfgPlanAutosave.get(Settings.instance);
		} catch {
			return false;
		}
	},
};

/** Adapt the application schema and settings store to the terminal overlay. */
export function createSettingsHost(): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	return {
		entries,
		get: path => lookup(path)?.get(settings),
		set: (path, value) => {
			const setting = lookup(path);
			if (!setting) throw new Error(`Unknown setting: ${path}`);
			setting.set(settings, value);
		},
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
	};
}
