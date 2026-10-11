import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirPaths } from "../config";
import { type ClaudePluginRoot, getPreloadedPluginRoots } from "../discovery/helpers";

/** Turns raw file content (from `filePath`) into a config, or `null` to skip the file. */
export type JsonConfigAdapter<T> = (content: string, filePath: string) => T | null;

/** One entry of a config stack; `read` yields `null` for unreadable or rejected files. */
export interface JsonConfigSource<T> {
	read(): T | null;
}

/**
 * Read one JSON/YAML config file through `adapt`. Reading, parsing and rejecting
 * all happen inside one guard so an unreadable, malformed, or irrelevant file is
 * skipped instead of thrown. `adapt` receives the raw content because the YAML/JSON
 * split lives with the config files that consume this walk, not here.
 */
export function readJsonConfigFile<T>(filePath: string, adapt: JsonConfigAdapter<T>): T | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return adapt(content, filePath);
	} catch {
		return null;
	}
}

export interface JsonConfigSourcesOptions<T> {
	/** Extra source emitted right after each plugin root's config files (e.g. its marketplace catalog). */
	pluginRootSource?: (root: ClaudePluginRoot) => JsonConfigSource<T>;
}

/**
 * Config sources for base name `base` — `"lsp"` covers `lsp.json`/`.lsp.json`/`lsp.yaml`/`.lsp.yaml`/
 * `lsp.yml`/`.lsp.yml` — in priority order: cwd files, project config dirs, user config dirs,
 * plugin roots (plus {@link JsonConfigSourcesOptions.pluginRootSource} per root), then home-directory
 * files. Lowest priority comes last, so callers merge over a reversed list.
 */
export function jsonConfigSources<T>(
	base: string,
	cwd: string,
	adapt: JsonConfigAdapter<T>,
	options: JsonConfigSourcesOptions<T> = {},
): JsonConfigSource<T>[] {
	const filenames = [`${base}.json`, `.${base}.json`, `${base}.yaml`, `.${base}.yaml`, `${base}.yml`, `.${base}.yml`];
	const sources: JsonConfigSource<T>[] = [];
	const addDir = (dir: string): void => {
		for (const filename of filenames) {
			sources.push({ read: () => readJsonConfigFile(path.join(dir, filename), adapt) });
		}
	};

	addDir(cwd);

	for (const dir of getConfigDirPaths("", { user: false, project: true, cwd })) addDir(dir);

	for (const dir of getConfigDirPaths("", { user: true, project: false })) addDir(dir);

	for (const root of getPreloadedPluginRoots()) {
		addDir(root.path);
		const extra = options.pluginRootSource?.(root);
		if (extra) sources.push(extra);
	}

	addDir(os.homedir());

	return sources;
}
