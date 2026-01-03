/**
 * Custom tool loader - loads TypeScript tool modules using native Bun import.
 *
 * Dependencies (@sinclair/typebox and pi-coding-agent) are injected via the CustomToolAPI
 * to avoid import resolution issues with custom tools loaded from user directories.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as typebox from "@sinclair/typebox";
import { getAgentDir, getConfigDirPaths } from "../../config";
import * as piCodingAgent from "../../index";
import { theme } from "../../modes/interactive/theme/theme";
import type { ExecOptions } from "../exec";
import { execCommand } from "../exec";
import type { HookUIContext } from "../hooks/types";
import { logger } from "../logger";
import { getAllPluginToolPaths } from "../plugins/loader";
import type { CustomToolAPI, CustomToolFactory, CustomToolsLoadResult, LoadedCustomTool } from "./types";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

/**
 * Resolve tool path.
 * - Absolute paths used as-is
 * - Paths starting with ~ expanded to home directory
 * - Relative paths resolved from cwd
 */
function resolveToolPath(toolPath: string, cwd: string): string {
	const expanded = expandPath(toolPath);

	if (path.isAbsolute(expanded)) {
		return expanded;
	}

	// Relative paths resolved from cwd
	return path.resolve(cwd, expanded);
}

/**
 * Create a no-op UI context for headless modes.
 */
function createNoOpUIContext(): HookUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setStatus: () => {},
		custom: async () => undefined as never,
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		get theme() {
			return theme;
		},
	};
}

/**
 * Load a single tool module using native Bun import.
 */
async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
): Promise<{ tools: LoadedCustomTool[] | null; error: string | null }> {
	const resolvedPath = resolveToolPath(toolPath, cwd);

	try {
		const module = await import(resolvedPath);
		const factory = (module.default ?? module) as CustomToolFactory;

		if (typeof factory !== "function") {
			return { tools: null, error: "Tool must export a default function" };
		}

		const toolResult = await factory(sharedApi);
		const toolsArray = Array.isArray(toolResult) ? toolResult : [toolResult];

		const loadedTools: LoadedCustomTool[] = toolsArray.map((tool) => ({
			path: toolPath,
			resolvedPath,
			tool,
		}));

		return { tools: loadedTools, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tools: null, error: `Failed to load tool: ${message}` };
	}
}

/**
 * Load all tools from configuration.
 * @param paths - Array of tool file paths
 * @param cwd - Current working directory for resolving relative paths
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 */
export async function loadCustomTools(
	paths: string[],
	cwd: string,
	builtInToolNames: string[],
): Promise<CustomToolsLoadResult> {
	const tools: LoadedCustomTool[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const seenNames = new Set<string>(builtInToolNames);

	// Shared API object - all tools get the same instance
	const sharedApi: CustomToolAPI = {
		cwd,
		exec: (command: string, args: string[], options?: ExecOptions) =>
			execCommand(command, args, options?.cwd ?? cwd, options),
		ui: createNoOpUIContext(),
		hasUI: false,
		logger,
		typebox,
		pi: piCodingAgent,
	};

	for (const toolPath of paths) {
		const { tools: loadedTools, error } = await loadTool(toolPath, cwd, sharedApi);

		if (error) {
			errors.push({ path: toolPath, error });
			continue;
		}

		if (loadedTools) {
			for (const loadedTool of loadedTools) {
				// Check for name conflicts
				if (seenNames.has(loadedTool.tool.name)) {
					errors.push({
						path: toolPath,
						error: `Tool name "${loadedTool.tool.name}" conflicts with existing tool`,
					});
					continue;
				}

				seenNames.add(loadedTool.tool.name);
				tools.push(loadedTool);
			}
		}
	}

	return {
		tools,
		errors,
		setUIContext(uiContext, hasUI) {
			sharedApi.ui = uiContext;
			sharedApi.hasUI = hasUI;
		},
	};
}

/**
 * Discover tool files from a directory.
 * Only loads index.ts files from subdirectories (e.g., tools/mytool/index.ts).
 */
function discoverToolsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const tools: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				// Check for index.ts in subdirectory
				const indexPath = path.join(dir, entry.name, "index.ts");
				if (fs.existsSync(indexPath)) {
					tools.push(indexPath);
				}
			}
		}
	} catch {
		return [];
	}

	return tools;
}

/**
 * Discover and load tools from standard locations:
 * 1. agentDir/tools/*.ts (global)
 * 2. cwd/{.omp,.pi,.claude}/tools/*.ts (project-local, with fallbacks)
 * 3. Installed plugins (~/.omp/plugins/node_modules/*)
 *
 * Plus any explicitly configured paths from settings or CLI.
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI --tool flags
 * @param cwd - Current working directory
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 * @param agentDir - Agent config directory. Default: from getAgentDir()
 */
export async function discoverAndLoadCustomTools(
	configuredPaths: string[],
	cwd: string,
	builtInToolNames: string[],
	agentDir: string = getAgentDir(),
): Promise<CustomToolsLoadResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Global tools: agentDir/tools/
	const globalToolsDir = path.join(agentDir, "tools");
	addPaths(discoverToolsInDir(globalToolsDir));

	// 2. Project-local tools: cwd/{.omp,.pi,.claude}/tools/
	for (const localToolsDir of getConfigDirPaths("tools", { user: false, cwd })) {
		addPaths(discoverToolsInDir(localToolsDir));
	}

	// 3. Plugin tools: ~/.omp/plugins/node_modules/*/
	addPaths(getAllPluginToolPaths(cwd));

	// 4. Explicitly configured paths (can override/add)
	addPaths(configuredPaths.map((p) => resolveToolPath(p, cwd)));

	return loadCustomTools(allPaths, cwd, builtInToolNames);
}
