/**
 * Settings files of a native `.omp` config directory: `settings.json`, then `config.yml`, the order
 * their values merge in. The native provider (`./builtin`) serves them as `settings` capability
 * items; the settings store (`config/settings-store.ts`) reads a project's through here too, so the
 * two never disagree on what a project configures. Kept free of the capability registry: the store
 * runs inside the daemon.
 */
import * as path from "node:path";
import { tryParseJson } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { readFile } from "../capability/fs";

/** Provider id native settings items carry; `disabledProviders: [native]` drops them. */
export const NATIVE_PROVIDER_ID = "native";
/** Display name prefixed to native provider warnings (`[OMP] …`). */
export const NATIVE_PROVIDER_DISPLAY_NAME = "OMP";

/** One parsed settings file. */
export interface NativeSettingsFile {
	path: string;
	data: Record<string, unknown>;
}

/**
 * Parses the settings files in `dir`; a file that fails to parse is skipped with a
 * `Failed to parse <path>` warning. `read` returns a file's text, or null when it is absent.
 */
export async function readNativeSettingsFiles(
	dir: string,
	read: (filePath: string) => Promise<string | null> = readFile,
): Promise<{ files: NativeSettingsFile[]; warnings: string[] }> {
	const files: NativeSettingsFile[] = [];
	const warnings: string[] = [];

	const settingsPath = path.join(dir, "settings.json");
	const settingsContent = await read(settingsPath);
	if (settingsContent) {
		const data = tryParseJson<Record<string, unknown>>(settingsContent);
		if (data) files.push({ path: settingsPath, data });
		else warnings.push(`Failed to parse ${settingsPath}`);
	}

	const configPath = path.join(dir, "config.yml");
	const configContent = await read(configPath);
	if (configContent) {
		try {
			const data: unknown = YAML.parse(configContent);
			files.push({
				path: configPath,
				data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {},
			});
		} catch {
			warnings.push(`Failed to parse ${configPath}`);
		}
	}

	return { files, warnings };
}
