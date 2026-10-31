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

/** Loads {@link writeHandEditedConfig}'s files read-only, without the ambient `PI_CONFIG_FILES` overlays. */
export async function loadHandEditedSettings(dir: TempDir, layers: HandEditedLayers): Promise<Settings> {
	const options = await writeHandEditedConfig(dir, layers);
	const ambient = process.env.PI_CONFIG_FILES;
	delete process.env.PI_CONFIG_FILES;
	try {
		return await Settings.loadReadOnly(options);
	} finally {
		if (ambient !== undefined) process.env.PI_CONFIG_FILES = ambient;
	}
}
