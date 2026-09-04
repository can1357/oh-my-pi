const USAGE = "Usage: /marketplace install [--force] [--scope user|project] <name@marketplace>";

export interface MarketplaceInstallArgs {
	force: boolean;
	scope: "user" | "project";
	installSpec: string;
}

/**
 * Parse the argument string following `/marketplace install`.
 *
 * Returns either the parsed args or an `{ error }` object whose message is
 * suitable for direct display to the user via `ctx.showStatus`.
 *
 * Accepted flags (any order):
 *   --force                 Force-reinstall even if already installed
 *   --scope user|project    Installation scope (default: user)
 *
 * Exactly one positional argument is required: `name@marketplace`.
 */
export function parseMarketplaceInstallArgs(rest: string): MarketplaceInstallArgs | { error: string } {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let force = false;
	let scope: "user" | "project" = "user";
	let installSpec = "";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--force") {
			force = true;
		} else if (tokens[i] === "--scope" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			const s = tokens[++i];
			if (s === "user" || s === "project") {
				scope = s;
			} else {
				return { error: `Invalid --scope value: "${s}". Must be "user" or "project".` };
			}
		} else if (tokens[i] === "--scope") {
			// --scope with no value, or next token is another flag
			return { error: '--scope requires a value: "user" or "project".' };
		} else if (tokens[i].startsWith("-")) {
			return { error: `Unknown flag: "${tokens[i]}". ${USAGE}` };
		} else {
			if (installSpec) {
				return { error: `Unexpected argument: "${tokens[i]}". ${USAGE}` };
			}
			installSpec = tokens[i];
		}
	}

	if (!installSpec.includes("@")) {
		return { error: USAGE };
	}

	return { force, scope, installSpec };
}

// ── `/marketplace add` ─────────────────────────────────────────────────────

/**
 * Parse `<source> [--force]`. `--force` repoints a marketplace that is already
 * registered under the same catalog name at the given source.
 *
 * The source is taken byte-for-byte after stripping the flag from either edge:
 * a local path may contain repeated interior whitespace, so tokenising and
 * re-joining would silently target a different directory. An empty source is
 * an error, not a fetch of "".
 */
export function parseAddArgs(rest: string): { source: string; force: boolean } | { error: string } {
	let source = rest.trim();
	let force = false;
	for (;;) {
		if (source === "--force") {
			force = true;
			source = "";
		} else if (source.startsWith("--force ")) {
			force = true;
			source = source.slice("--force ".length).trimStart();
			continue;
		} else if (source.endsWith(" --force")) {
			force = true;
			source = source.slice(0, -" --force".length).trimEnd();
			continue;
		}
		break;
	}
	if (!source) return { error: "Usage: /marketplace add <source> [--force]" };
	return { source, force };
}

// ── Shared scope+id parser for uninstall / upgrade / enable / disable ───────

export interface PluginScopeArgs {
	pluginId: string;
	scope?: "user" | "project";
}

/**
 * Parse `[--scope user|project] <name@marketplace>` for commands that accept a
 * single plugin ID and an optional scope flag.
 *
 * Returns parsed args or `{ error }` ready for `ctx.showStatus`.
 */
export function parsePluginScopeArgs(rest: string, usageHint: string): PluginScopeArgs | { error: string } {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let scope: "user" | "project" | undefined;
	let pluginId = "";

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--scope" && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
			const s = tokens[++i];
			if (s === "user" || s === "project") {
				scope = s;
			} else {
				return { error: `Invalid --scope value: "${s}". Must be "user" or "project".` };
			}
		} else if (tokens[i] === "--scope") {
			return { error: '--scope requires a value: "user" or "project".' };
		} else if (tokens[i].startsWith("-")) {
			return { error: `Unknown flag: "${tokens[i]}". ${usageHint}` };
		} else if (pluginId) {
			return { error: `Unexpected argument: "${tokens[i]}". ${usageHint}` };
		} else {
			pluginId = tokens[i];
		}
	}

	if (!pluginId) {
		return { error: usageHint };
	}

	return { pluginId, scope };
}
