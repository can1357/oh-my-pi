import type { PluginRuntimeConfig } from "./types";

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config: Partial<PluginRuntimeConfig>): PluginRuntimeConfig {
	return {
		plugins: config.plugins ?? {},
		settings: config.settings ?? {},
	};
}
