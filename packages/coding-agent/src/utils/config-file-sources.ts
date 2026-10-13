import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getConfigDirPaths } from "../config";
import { type ClaudePluginRoot, getPreloadedPluginRoots } from "../discovery/helpers";

/** Turns raw file content (from `filePath`) into a config, or `null` to skip the file. */
export type ConfigFileAdapter<T> = (content: string, filePath: string) => T | null;

/** Why an existing config file was not applied. Absent files are not rejections. */
export interface ConfigFileRejection {
	path: string;
	reason: "unreadable" | "invalid";
	message: string;
}

/** Detailed outcome of reading one config path. */
export type ConfigFileReadResult<T> =
	| { kind: "value"; value: T }
	| { kind: "absent" }
	| { kind: "rejected"; rejection: ConfigFileRejection };

/** One entry of a config stack. */
export interface ConfigFileSource<T> {
	/** Path this source reads when it is file-backed; omitted for synthetic sources. */
	readonly path?: string;
	readResult(): ConfigFileReadResult<T>;
	/** Convenience: value when present, otherwise `null` (absent or rejected). */
	read(): T | null;
}

function sourceFromResult<T>(
	pathHint: string | undefined,
	readResult: () => ConfigFileReadResult<T>,
): ConfigFileSource<T> {
	return {
		path: pathHint,
		readResult,
		read: () => {
			const result = readResult();
			return result.kind === "value" ? result.value : null;
		},
	};
}

/**
 * Read one JSON/YAML config file through `adapt`.
 *
 * - Missing path → `absent` (callers skip quietly).
 * - Unreadable path → `rejected` with reason `unreadable`.
 * - Adapter throw or `null` return → `rejected` with reason `invalid`.
 */
export function readConfigFileResult<T>(filePath: string, adapt: ConfigFileAdapter<T>): ConfigFileReadResult<T> {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		if (isEnoent(err)) return { kind: "absent" };
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "rejected",
			rejection: { path: filePath, reason: "unreadable", message },
		};
	}

	try {
		const value = adapt(content, filePath);
		if (value === null) {
			return {
				kind: "rejected",
				rejection: {
					path: filePath,
					reason: "invalid",
					message: "config did not contain a usable object",
				},
			};
		}
		return { kind: "value", value };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "rejected",
			rejection: { path: filePath, reason: "invalid", message },
		};
	}
}

/**
 * Read one JSON/YAML config file through `adapt`. Missing, unreadable, and
 * rejected files all become `null` so callers that only need a merge can stay
 * simple; use {@link readConfigFileResult} when diagnostics matter.
 */
export function readConfigFile<T>(filePath: string, adapt: ConfigFileAdapter<T>): T | null {
	const result = readConfigFileResult(filePath, adapt);
	return result.kind === "value" ? result.value : null;
}

export interface ConfigFileSourcesOptions<T> {
	/** Extra source emitted right after each plugin root's config files (e.g. its marketplace catalog). */
	pluginRootSource?: (root: ClaudePluginRoot) => ConfigFileSource<T>;
}

/**
 * Config sources for base name `base` — `"lsp"` covers `lsp.json`/`.lsp.json`/`lsp.yaml`/`.lsp.yaml`/
 * `lsp.yml`/`.lsp.yml` — in priority order: cwd files, project config dirs, user config dirs,
 * plugin roots (plus {@link ConfigFileSourcesOptions.pluginRootSource} per root), then home-directory
 * files. Lowest priority comes last, so callers merge over a reversed list.
 */
export function configFileSources<T>(
	base: string,
	cwd: string,
	adapt: ConfigFileAdapter<T>,
	options: ConfigFileSourcesOptions<T> = {},
): ConfigFileSource<T>[] {
	const filenames = [`${base}.json`, `.${base}.json`, `${base}.yaml`, `.${base}.yaml`, `${base}.yml`, `.${base}.yml`];
	const sources: ConfigFileSource<T>[] = [];
	const addDir = (dir: string): void => {
		for (const filename of filenames) {
			const filePath = path.join(dir, filename);
			sources.push(sourceFromResult(filePath, () => readConfigFileResult(filePath, adapt)));
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
