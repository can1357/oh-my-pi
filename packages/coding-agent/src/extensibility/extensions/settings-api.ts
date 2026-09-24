/**
 * Settings query facade exposed to extensions as `ctx.settings`.
 *
 * Read-only: values are cloned so extensions cannot mutate the live settings
 * instance or affect another extension's view.
 */
import type { SettingPath, Settings } from "../../config/settings";
import type { ExtensionSettingsQuery } from "./types";

/** Build the read-only settings facade for an extension context. */
export function createExtensionSettingsQuery(settings: Settings | undefined): ExtensionSettingsQuery {
	return {
		get: (path: string): unknown => {
			if (!settings) return undefined;
			try {
				return structuredClone(settings.get(path as SettingPath));
			} catch {
				return undefined;
			}
		},
	};
}
