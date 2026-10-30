/**
 * Settings Capability
 *
 * Configuration settings from various sources (JSON, TOML, etc.)
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A settings file.
 */
export interface Settings {
	/** Absolute path to settings file */
	path: string;
	/** Parsed settings data */
	data: Record<string, unknown>;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const settingsCapability = defineCapability<Settings>({
	id: "settings",
	displayName: __ompTranslate("Settings"),
	description: __ompTranslate("Configuration settings from various sources"),
	// Settings are merged, not deduplicated by key
	key: () => undefined,
	validate: settings => {
		if (!settings.path) return __ompTranslate("Missing path");
		if (!settings.data || typeof settings.data !== "object") return __ompTranslate("Missing or invalid data");
		return undefined;
	},
});
