/**
 * Resolution and validation for `resources_discover` handler results.
 *
 * Handlers return raw path strings. This module turns them into absolute,
 * de-duplicated, kind-checked paths that `AgentSession` merges into skill,
 * prompt-template, and theme discovery. Relative paths resolve against the
 * session cwd (upstream pi semantics) and a leading `~` expands to the home
 * directory. Problems become warnings; nothing here throws for bad input.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBuiltinThemes, readThemeFile } from "@oh-my-pi/pi-tui/theme/loader";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { expandTilde } from "../../tools/path-utils";
import type { DiscoveredResourcePath, DiscoveredResourcePaths } from "./runner";

/** A contributed path that was skipped, attributed to the extension that returned it. */
export interface ExtensionResourceWarning {
	extensionPath: string;
	message: string;
}

/** A validated extension theme file. */
export interface ExtensionThemeFile {
	name: string;
	path: string;
}

/** Validated contributions ready to merge into discovery. */
export interface ResolvedExtensionResources {
	/** Skills roots, single skill directories, or `SKILL.md` files, tagged with their extension. */
	skillPaths: DiscoveredResourcePath[];
	/** Prompt-template directories or `.md` files, tagged with their extension. */
	promptPaths: DiscoveredResourcePath[];
	/** Theme files expanded from directories and `.json` paths, first name wins. */
	themes: ExtensionThemeFile[];
	warnings: ExtensionResourceWarning[];
}

interface ResourceKindRule {
	label: string;
	expected: string;
	acceptsFile(filePath: string): boolean;
}

const SKILL_RULE: ResourceKindRule = {
	label: "skill",
	expected: "a directory or a SKILL.md file",
	acceptsFile: filePath => path.basename(filePath).toLowerCase() === "skill.md",
};
const PROMPT_RULE: ResourceKindRule = {
	label: "prompt",
	expected: "a directory or a .md file",
	acceptsFile: filePath => filePath.toLowerCase().endsWith(".md"),
};
const THEME_RULE: ResourceKindRule = {
	label: "theme",
	expected: "a directory or a .json file",
	acceptsFile: filePath => filePath.toLowerCase().endsWith(".json"),
};

/**
 * Resolve, de-duplicate, and validate every path the handlers returned. Missing
 * paths, wrong file types, unreadable directories, invalid theme files, and
 * duplicate theme names produce warnings instead of errors.
 */
export async function resolveExtensionResources(
	discovered: DiscoveredResourcePaths,
	cwd: string,
): Promise<ResolvedExtensionResources> {
	const warnings: ExtensionResourceWarning[] = [];
	const [skills, prompts, themeRoots] = await Promise.all([
		resolveKind(discovered.skillPaths, SKILL_RULE, cwd, warnings),
		resolveKind(discovered.promptPaths, PROMPT_RULE, cwd, warnings),
		resolveKind(discovered.themePaths, THEME_RULE, cwd, warnings),
	]);
	const themes = await collectThemeFiles(themeRoots, warnings);
	return {
		skillPaths: skills.map(({ path, extensionPath }) => ({ path, extensionPath })),
		promptPaths: prompts.map(({ path, extensionPath }) => ({ path, extensionPath })),
		themes,
		warnings,
	};
}

/** A contributed path that exists and has an accepted type; `isDirectory` comes from its stat. */
interface ResolvedResourcePath extends DiscoveredResourcePath {
	isDirectory: boolean;
}

async function resolveKind(
	entries: readonly DiscoveredResourcePath[],
	rule: ResourceKindRule,
	cwd: string,
	warnings: ExtensionResourceWarning[],
): Promise<ResolvedResourcePath[]> {
	const resolved: ResolvedResourcePath[] = [];
	const seen = new Set<string>();
	for (const { path: rawPath, extensionPath } of entries) {
		const absolute = path.resolve(cwd, expandTilde(rawPath));
		// Windows paths are case-insensitive; the same directory spelled twice is one contribution.
		const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
		if (seen.has(key)) continue;
		seen.add(key);

		let stat: Stats;
		try {
			stat = await fs.stat(absolute);
		} catch (error) {
			warnings.push({
				extensionPath,
				message: isEnoent(error)
					? `${rule.label} path not found: ${absolute}`
					: `Cannot read ${rule.label} path ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		if (!stat.isDirectory() && !(stat.isFile() && rule.acceptsFile(absolute))) {
			warnings.push({
				extensionPath,
				message: `Ignoring ${rule.label} path ${absolute}: expected ${rule.expected}`,
			});
			continue;
		}
		resolved.push({ path: absolute, extensionPath, isDirectory: stat.isDirectory() });
	}
	return resolved;
}

/**
 * Expand theme directories to their top-level `.json` files (the same layout as the
 * custom themes directory) and validate each file. Theme names come from file names.
 */
async function collectThemeFiles(
	roots: readonly ResolvedResourcePath[],
	warnings: ExtensionResourceWarning[],
): Promise<ExtensionThemeFile[]> {
	const builtinThemes = getBuiltinThemes();
	const themes: ExtensionThemeFile[] = [];
	const claimed = new Map<string, string>();
	for (const { path: root, extensionPath, isDirectory } of roots) {
		let files: string[];
		if (!isDirectory) {
			files = [root];
		} else {
			try {
				const entries = await fs.readdir(root, { withFileTypes: true });
				files = entries
					.filter(entry => !entry.isDirectory() && entry.name.toLowerCase().endsWith(".json"))
					.map(entry => path.join(root, entry.name))
					.sort();
			} catch (error) {
				warnings.push({
					extensionPath,
					message: `Cannot read theme directory ${root}: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
		}

		for (const file of files) {
			const name = path.basename(file).slice(0, -".json".length);
			if (name in builtinThemes) {
				warnings.push({ extensionPath, message: `Ignoring theme ${file}: "${name}" is a built-in theme name` });
				continue;
			}
			const claimedBy = claimed.get(name);
			if (claimedBy !== undefined) {
				if (claimedBy !== file) {
					warnings.push({
						extensionPath,
						message: `Ignoring theme ${file}: "${name}" is already provided by ${claimedBy}`,
					});
				}
				continue;
			}
			try {
				await readThemeFile(name, file);
			} catch (error) {
				warnings.push({
					extensionPath,
					message: `Ignoring theme ${file}: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			claimed.set(name, file);
			themes.push({ name, path: file });
		}
	}
	return themes;
}
