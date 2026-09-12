import * as path from "node:path";

/** Synthetic plugin root for a --plugin-dir path. Shape-compatible with ClaudePluginRoot. */
export interface PluginDirRoot {
	id: string;
	marketplace: string;
	plugin: string;
	version: string;
	path: string;
	scope: "user" | "project";
	origin: "plugin-dir";
}

/**
 * Build a synthetic plugin root from a --plugin-dir resolved path.
 * @param resolvedPath Absolute path to the plugin directory
 * @param manifestName Plugin name from manifest; falls back to directory basename
 */
export function buildPluginDirRoot(resolvedPath: string, manifestName?: string): PluginDirRoot {
	const pluginName = manifestName || path.basename(resolvedPath);
	return {
		id: `${pluginName}@__local__`,
		marketplace: "__local__",
		plugin: pluginName,
		version: "local",
		path: resolvedPath,
		scope: "user",
		origin: "plugin-dir",
	};
}
