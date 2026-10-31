import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, type SettingsOptions } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Config-file contents per settings layer, as a user would type them; an absent layer writes no file. */
export interface HandEditedLayers {
	global?: Record<string, unknown>;
	project?: Record<string, unknown>;
	/** `--config` overlay files, later ones winning, as repeated `--config` flags load them. */
	overlays?: Record<string, unknown>[];
}

/**
 * Writes `layers` under `dir` as the files a user edits by hand and returns the options that load them.
 * Only a file can hold a value the registry rejects: every write through a handle checks the value first.
 */
export async function writeHandEditedConfig(
	dir: TempDir,
	layers: HandEditedLayers,
): Promise<Required<Pick<SettingsOptions, "agentDir" | "cwd" | "configFiles">>> {
	const agentDir = dir.join("agent");
	const cwd = dir.join("project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const configFiles: string[] = [];
	if (layers.global) await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(layers.global));
	if (layers.project) await Bun.write(path.join(cwd, ".omp", "config.yml"), YAML.stringify(layers.project));
	for (const [index, overlay] of (layers.overlays ?? []).entries()) {
		const file = dir.join(`overlay-${index}.yml`);
		await Bun.write(file, YAML.stringify(overlay));
		configFiles.push(file);
	}
	return { agentDir, cwd, configFiles };
}

/**
 * Loads {@link writeHandEditedConfig}'s files without the ambient `PI_CONFIG_FILES` overlays: read-only,
 * or `reloadable` as an instance that `reloadFromDisk` re-reads.
 */
export async function loadHandEditedSettings(
	dir: TempDir,
	layers: HandEditedLayers,
	{ reloadable = false }: { reloadable?: boolean } = {},
): Promise<Settings> {
	const options = await writeHandEditedConfig(dir, layers);
	// The `Settings` constructor reads `PI_CONFIG_FILES` synchronously when a load starts, so the
	// variable is back before any await: a test file sharing this process never sees it unset.
	const ambient = process.env.PI_CONFIG_FILES;
	delete process.env.PI_CONFIG_FILES;
	let loading: Promise<Settings>;
	try {
		loading = reloadable ? Settings.loadIsolated(options) : Settings.loadReadOnly(options);
	} finally {
		if (ambient !== undefined) process.env.PI_CONFIG_FILES = ambient;
	}
	const settings = await loading;
	// Should the read ever move past an await, an ambient overlay would join the layers under test.
	if (settings.getConfigFiles().length !== options.configFiles.length) {
		throw new Error(`loadHandEditedSettings: ambient overlays joined the load: ${settings.getConfigFiles()}`);
	}
	return settings;
}
