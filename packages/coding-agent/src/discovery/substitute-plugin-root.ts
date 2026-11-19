import * as path from "node:path";

/**
 * Recursively substitute ${CLAUDE_PLUGIN_ROOT} and ${OMP_PLUGIN_ROOT}
 * with the actual plugin root path in strings, arrays, and plain objects.
 */
// Use concatenation to avoid noTemplateCurlyInString lint rule on literal placeholder names
const CLAUDE_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";
const OMP_VAR = "$" + "{OMP_PLUGIN_ROOT}";

export function substitutePluginRoot<T>(value: T, rootPath: string): T {
	if (typeof value === "string") {
		return value.replaceAll(CLAUDE_VAR, rootPath).replaceAll(OMP_VAR, rootPath) as T;
	}
	if (Array.isArray(value)) {
		return value.map(v => substitutePluginRoot(v, rootPath)) as T;
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			Object.defineProperty(result, k, {
				value: substitutePluginRoot(v, rootPath),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result as T;
	}
	return value;
}

/**
 * Where a relative, path-like `command` is rooted by {@link resolvePluginStdioPaths}.
 *
 * - `"config-dir"` (default): the directory of the config file that declared the
 *   server — the plugin package root for `.mcp.json`. A plugin can ship its
 *   executable at the package root (`command: "./bin/server"`) yet run from a
 *   data subdir (`cwd: "work"`); the command stays `<pkg>/bin/server`.
 * - `"cwd"`: the rooted `cwd`, falling back to the config dir when no `cwd` is
 *   set. This matches how the OS resolves a relative command against the
 *   subprocess's working directory, which is the Codex `config.toml` contract:
 *   `cwd = "server"`, `command = "./bin/mcp"` → `<configDir>/server/bin/mcp`.
 */
export type StdioCommandBase = "config-dir" | "cwd";

/**
 * Rebase relative filesystem values in a discovered stdio server config against
 * the directory of the config file (`.mcp.json`/`config.toml`) that declared them.
 *
 * External configs (bundled ChatGPT/Codex plugins, Claude marketplace plugins)
 * express `command`/`cwd` relative to their own config file, but MCP stdio
 * spawning roots relative values at the session cwd — so a server shipping
 * `command: "./bin/server"`, `cwd: "."` launches from the wrong directory and
 * fails with ENOENT. This resolves those against `configDir` instead:
 *
 * - relative `cwd` → resolved against `configDir`;
 * - path-like `command` (`./`, `../`, or the Windows `.\`/`..\` forms) →
 *   resolved against the base selected by `commandBase` (see {@link StdioCommandBase});
 * - bare executables (`npx`, `uvx`, …) and absolute paths are left untouched.
 */
export function resolvePluginStdioPaths(
	config: { command?: string; cwd?: string },
	configDir: string,
	commandBase: StdioCommandBase = "config-dir",
): { command?: string; cwd?: string } {
	const resolved: { command?: string; cwd?: string } = {};
	if (typeof config.cwd === "string") {
		resolved.cwd = path.isAbsolute(config.cwd) ? config.cwd : path.resolve(configDir, config.cwd);
	}
	if (config.command !== undefined) {
		const isPathLike = /^\.\.?[/\\]/.test(config.command);
		const base = commandBase === "cwd" ? (resolved.cwd ?? configDir) : configDir;
		resolved.command = isPathLike ? path.resolve(base, config.command) : config.command;
	}
	return resolved;
}
