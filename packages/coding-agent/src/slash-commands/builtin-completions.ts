import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { formatModelRoleAlias, getKnownRoleIds } from "../config/model-roles";
import { readMCPConfigFile } from "../mcp/config-writer";
import { collectMcpServerNames } from "../modes/controllers/mcp-command-controller";
import { expandTilde } from "../tools/path-utils";
import type { SubcommandDef, TuiSlashCommandRuntime } from "./types";

/**
 * Build getArgumentCompletions from declarative subcommand definitions.
 * Returns subcommand names filtered by prefix in the dropdown.
 */
export function buildArgumentCompletions(subcommands: SubcommandDef[]): (prefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null; // past the subcommand
		const lower = argumentPrefix.toLowerCase();
		const matches = subcommands
			.filter(s => s.name.startsWith(lower))
			.map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
		return matches.length > 0 ? matches : null;
	};
}

/** /mcp subcommands whose argument is a server name (per their `usage: "<name>..."`). */
const MCP_SERVER_NAME_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	test: true,
	remove: true,
	reconnect: true,
	reauth: true,
	unauth: true,
};

/** Subcommands that accept names found only in `userConfig.disabledServers`. */
const MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
};

/**
 * Subcommands that accept configured servers whose `enabled` flag is false.
 * `unauth` can clear persisted credentials without connecting; test,
 * reconnect, and reauth explicitly require an enabled server.
 */
const MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS: Readonly<Record<string, true>> = {
	enable: true,
	disable: true,
	unauth: true,
};

/**
 * Build getArgumentCompletions for /mcp. Delegates to the generic
 * declarative subcommand completer while the subcommand name itself is
 * still being typed, then switches to MCP server-name completion (sourced
 * from {@link collectMcpServerNames}) once a recognized server-name
 * subcommand (enable/disable/test/remove/reconnect/reauth/unauth) is
 * followed by a space. `remove` gets its own scope-aware completions (see
 * {@link buildMcpRemoveCompletions}) since — unlike the others —
 * it only ever succeeds against a config-file entry. Subcommands with a
 * different argument shape (add, smithery-search, ...) get no argument
 * completion.
 */
export function buildMcpArgumentCompletions(
	subcommands: SubcommandDef[],
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => Promise<AutocompleteItem[] | null> {
	const genericCompletions = buildArgumentCompletions(subcommands);
	return async (argumentPrefix: string) => {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) return genericCompletions(argumentPrefix);

		const rawSubcommand = argumentPrefix.slice(0, spaceIndex);
		const lowerSubcommand = rawSubcommand.toLowerCase();
		if (MCP_SERVER_NAME_SUBCOMMANDS[lowerSubcommand] !== true) return null;
		const namePrefix = argumentPrefix.slice(spaceIndex + 1).toLowerCase();
		if (lowerSubcommand === "remove") {
			return await buildMcpRemoveCompletions(rawSubcommand, namePrefix);
		}

		let serverNames: string[];
		try {
			serverNames = await collectMcpServerNames(
				runtime.ctx,
				undefined,
				MCP_DISABLED_ONLY_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
				MCP_DISABLED_CONFIG_ELIGIBLE_SUBCOMMANDS[lowerSubcommand] === true,
			);
		} catch (error) {
			logger.warn("MCP server-name autocomplete failed to read config", { error });
			return null;
		}
		const matches: AutocompleteItem[] = serverNames
			.filter(name => name.toLowerCase().startsWith(namePrefix))
			.map(name => ({ value: `${rawSubcommand} ${name} `, label: name }));
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build `/mcp remove <name>` completions. Unlike the other server-name
 * subcommands, `#handleRemove` only ever succeeds against a config-file
 * `mcpServers` entry in the target scope (project by default, user with an
 * explicit `--scope user`) — a purely runtime-discovered server has no
 * config entry to remove and always fails with `Server "<name>" not found
 * in <scope> config.`. Completions are therefore restricted to config-file
 * names, and a name that exists only in the user config is completed with
 * `--scope user` appended so the inserted command is directly executable.
 */
async function buildMcpRemoveCompletions(
	rawSubcommand: string,
	namePrefix: string,
): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	let projectNames: string[];
	let userNames: string[];
	try {
		const [projectConfig, userConfig] = await Promise.all([
			readMCPConfigFile(getMCPConfigPath("project", cwd)),
			readMCPConfigFile(getMCPConfigPath("user", cwd)),
		]);
		projectNames = Object.keys(projectConfig.mcpServers ?? {});
		userNames = Object.keys(userConfig.mcpServers ?? {});
	} catch (error) {
		logger.warn("MCP remove autocomplete failed to read config", { error });
		return null;
	}

	const projectNameSet = new Set(projectNames);
	const allNames = new Set([...projectNames, ...userNames]);
	const matches: AutocompleteItem[] = [...allNames]
		.filter(name => name.toLowerCase().startsWith(namePrefix))
		.map(name =>
			projectNameSet.has(name)
				? { value: `${rawSubcommand} ${name} `, label: name }
				: { value: `${rawSubcommand} ${name} --scope user `, label: `${name} (user)` },
		)
		.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
	return matches.length > 0 ? matches : null;
}

/**
 * Build getInlineHint from declarative subcommand definitions.
 * Shows remaining completion + usage as dim ghost text after cursor.
 */
export function buildSubcommandInlineHint(subcommands: SubcommandDef[]): (argumentText: string) => string | null {
	return (argumentText: string) => {
		const trimmed = argumentText.trimStart();
		const spaceIndex = trimmed.indexOf(" ");

		if (spaceIndex === -1) {
			// Still typing subcommand name — show remaining chars + usage
			const prefix = trimmed.toLowerCase();
			if (prefix.length === 0) return null;
			const match = subcommands.find(s => s.name.startsWith(prefix));
			if (!match) return null;
			const remaining = match.name.slice(prefix.length);
			return remaining + (match.usage ? ` ${match.usage}` : "");
		}

		// Subcommand typed — show remaining usage params
		const subName = trimmed.slice(0, spaceIndex).toLowerCase();
		const afterSub = trimmed.slice(spaceIndex + 1);
		const sub = subcommands.find(s => s.name === subName);
		if (!sub?.usage) return null;

		if (afterSub.length > 0) {
			const usageParts = sub.usage.split(" ");
			const inputParts = afterSub.trim().split(/\s+/);
			const remaining = usageParts.slice(inputParts.length);
			return remaining.length > 0 ? remaining.join(" ") : null;
		}

		return sub.usage;
	};
}

/**
 * Build getInlineHint for commands with a simple static hint string.
 * Shows the hint only when no arguments have been typed yet.
 */
export function buildStaticInlineHint(hint: string): (argumentText: string) => string | null {
	return (argumentText: string) => (argumentText.trim().length === 0 ? hint : null);
}

/**
 * Build getArgumentCompletions for `/switch <model>`: configured `@role`
 * aliases first, then the session's cycle scope (or every authenticated
 * model) as `provider/id`, substring-filtered on the typed prefix. Any
 * `:level` suffix already typed is kept out of the match and re-appended.
 * Returning matches also keeps `@smol` from falling through to `@`-file
 * mention completion.
 */
export function buildModelSelectorCompletions(
	runtime: TuiSlashCommandRuntime,
): (argumentPrefix: string) => AutocompleteItem[] | null {
	return (argumentPrefix: string) => {
		if (argumentPrefix.includes(" ")) return null;
		const suffixIndex = argumentPrefix.indexOf(":");
		const suffix = suffixIndex === -1 ? "" : argumentPrefix.slice(suffixIndex);
		const query = (suffixIndex === -1 ? argumentPrefix : argumentPrefix.slice(0, suffixIndex)).toLowerCase();
		const { session, settings } = runtime.ctx;
		const matches: AutocompleteItem[] = [];
		for (const role of getKnownRoleIds(settings)) {
			const configured = settings.getModelRole(role);
			if (!configured) continue;
			const alias = formatModelRoleAlias(role);
			if (!alias.toLowerCase().includes(query)) continue;
			matches.push({ value: `${alias}${suffix} `, label: alias, description: configured });
		}
		const scoped = session.scopedModels.map(entry => entry.model);
		for (const model of scoped.length > 0 ? scoped : session.modelRegistry.getAvailable()) {
			const selector = `${model.provider}/${model.id}`;
			if (!selector.toLowerCase().includes(query)) continue;
			matches.push({ value: `${selector}${suffix} `, label: selector, description: model.name });
		}
		return matches.length > 0 ? matches : null;
	};
}

/**
 * Build getArgumentCompletions that suggests directories relative to the
 * current project directory. Used by /move so users can Tab-complete the
 * destination directory.
 */
export function buildDirectoryArgumentCompletions(): (prefix: string) => Promise<AutocompleteItem[] | null> {
	return async (argumentPrefix: string) => {
		const prefix = argumentPrefix.trim();

		const cwd = getProjectDir();
		const expandedPrefix = expandTilde(prefix);
		const isAbsolute = path.isAbsolute(expandedPrefix);

		let searchDir: string;
		let searchPrefix: string;
		if (
			prefix === "" ||
			prefix === "." ||
			prefix === "./" ||
			prefix === ".." ||
			prefix === "../" ||
			prefix === "~" ||
			prefix === "~/" ||
			prefix === "/"
		) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else if (expandedPrefix.endsWith("/")) {
			searchDir = isAbsolute ? expandedPrefix : path.join(cwd, expandedPrefix);
			searchPrefix = "";
		} else {
			const dir = path.dirname(expandedPrefix);
			searchDir = isAbsolute ? dir : path.join(cwd, dir);
			searchPrefix = path.basename(expandedPrefix);
		}

		try {
			const entries = await fs.readdir(searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;
				if (entry.name === ".git") continue;

				let isDirectory = entry.isDirectory();
				if (!isDirectory && entry.isSymbolicLink()) {
					try {
						isDirectory = (await fs.stat(path.join(searchDir, entry.name))).isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDirectory) continue;

				const absoluteValue = path.join(searchDir, entry.name);
				const displayValue = buildDirectoryCompletionDisplayValue(prefix, absoluteValue, cwd);
				suggestions.push({ value: displayValue, label: `${entry.name}/` });
			}
			suggestions.sort((a, b) => a.label.localeCompare(b.label));
			return suggestions.length > 0 ? suggestions : null;
		} catch {
			return null;
		}
	};
}
function buildDirectoryCompletionDisplayValue(prefix: string, absoluteValue: string, cwd: string): string {
	// Preserve the user's prefix style where possible, but always return a
	// value that /move can resolve (absolute or relative) without escaping.
	const normalized = path.normalize(absoluteValue);

	if (prefix.startsWith("~/")) {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "~") {
		const home = os.homedir();
		const homeRelative = path.relative(home, normalized);
		return `~/${homeRelative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("/")) {
		return `${normalized.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("./")) {
		const relative = path.relative(cwd, normalized);
		return `./${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix.startsWith("../")) {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}
	if (prefix === "..") {
		const relative = path.relative(cwd, normalized);
		return `${relative.replaceAll("\\", "/")}/`;
	}

	// Default: relative to cwd.
	const relative = path.relative(cwd, normalized);
	return `${relative.replaceAll("\\", "/")}/`;
}
