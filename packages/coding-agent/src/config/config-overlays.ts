/**
 * `--config` / `PI_CONFIG_FILES` overlay files, located and read without the settings registry so the
 * CLI can check them before its first frame (`overlaysKeepPrepaint` in `modes/startup-composer.ts`);
 * `Settings` migrates and merges them into its overlay layer.
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { expandTilde } from "@oh-my-pi/pi-utils/path";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { YAML } from "bun";

/** Overlay files in merge order: `PI_CONFIG_FILES` entries, then `files` (the `--config` values), resolved against `cwd`. */
export function configOverlayPaths(cwd: string, files: readonly string[] = []): string[] {
	const env = process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
	return [...env, ...files].map(file => path.resolve(cwd, expandTilde(file)));
}

/**
 * The settings mapping in one overlay file; an empty file is `{}`.
 *
 * @throws Error when the file is missing or unreadable, is not YAML, or holds no mapping: an explicit
 * overlay never falls back to the persistent settings silently.
 */
export async function readConfigOverlay(filePath: string): Promise<Record<string, unknown>> {
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch (error) {
		throw new Error(
			isEnoent(error)
				? `Config overlay not found: ${filePath}`
				: `Failed to read config overlay ${filePath}: ${String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse config overlay ${filePath}: ${String(error)}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (!isRecord(parsed)) throw new Error(`Config overlay must be a YAML mapping: ${filePath}`);
	return parsed;
}
