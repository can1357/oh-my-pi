/**
 * Settings Capability
 *
 * Configuration settings from various sources (JSON, TOML, etc.)
 */

import { defineCapability } from "./index";
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
	displayName: "Settings",
	description: "Configuration settings from various sources",
	// Settings are merged, not deduplicated by key
	key: () => undefined,
	validate: (settings) => {
		if (!settings.path) return "Missing path";
		if (!settings.data || typeof settings.data !== "object") return "Missing or invalid data";
		return undefined;
	},
});
