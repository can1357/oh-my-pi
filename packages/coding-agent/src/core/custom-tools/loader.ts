/**
 * Custom tool loader - loads TypeScript tool modules using native Bun import.
 *
 * Dependencies (@sinclair/typebox and pi-coding-agent) are injected via the CustomToolAPI
 * to avoid import resolution issues with custom tools loaded from user directories.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as typebox from "@sinclair/typebox";
import { toolCapability } from "../../capability/tool";
import { type CustomTool, loadSync } from "../../discovery";
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

/** Error with source metadata */
interface ToolLoadError {
	path: string;
	error: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/**
 * Load a single tool module using native Bun import.
 */
async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
	source?: { provider: string; providerName: string; level: "user" | "project" },
): Promise<{ tools: LoadedCustomTool[] | null; error: ToolLoadError | null }> {
	const resolvedPath = resolveToolPath(toolPath, cwd);

	// Skip declarative tool files (.md, .json) - these are metadata only, not executable modules
	if (resolvedPath.endsWith(".md") || resolvedPath.endsWith(".json")) {
		return {
			tools: null,
			error: {
				path: toolPath,
				error: "Declarative tool files (.md, .json) cannot be loaded as executable modules",
				source,
			},
		};
	}

	try {
		const module = await import(resolvedPath);
		const factory = (module.default ?? module) as CustomToolFactory;

		if (typeof factory !== "function") {
			return { tools: null, error: { path: toolPath, error: "Tool must export a default function", source } };
		}

		const toolResult = await factory(sharedApi);
		const toolsArray = Array.isArray(toolResult) ? toolResult : [toolResult];

		const loadedTools: LoadedCustomTool[] = toolsArray.map((tool) => ({
			path: toolPath,
			resolvedPath,
			tool,
			source,
		}));

		return { tools: loadedTools, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tools: null, error: { path: toolPath, error: `Failed to load tool: ${message}`, source } };
	}
}

/** Tool path with optional source metadata */
interface ToolPathWithSource {
	path: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/**
 * Load all tools from configuration.
 * @param pathsWithSources - Array of tool paths with optional source metadata
 * @param cwd - Current working directory for resolving relative paths
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 */
export async function loadCustomTools(
	pathsWithSources: ToolPathWithSource[],
	cwd: string,
	builtInToolNames: string[],
): Promise<CustomToolsLoadResult> {
	const tools: LoadedCustomTool[] = [];
	const errors: ToolLoadError[] = [];
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

	for (const { path: toolPath, source } of pathsWithSources) {
		const { tools: loadedTools, error } = await loadTool(toolPath, cwd, sharedApi, source);

		if (error) {
			errors.push(error);
			continue;
		}

		if (loadedTools) {
			for (const loadedTool of loadedTools) {
				// Check for name conflicts
				if (seenNames.has(loadedTool.tool.name)) {
					errors.push({
						path: toolPath,
						error: `Tool name "${loadedTool.tool.name}" conflicts with existing tool`,
						source,
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
 * Discover and load tools from standard locations via capability system:
 * 1. User and project tools discovered by capability providers
 * 2. Installed plugins (~/.omp/plugins/node_modules/*)
 * 3. Explicitly configured paths from settings or CLI
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI --tool flags
 * @param cwd - Current working directory
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 */
export async function discoverAndLoadCustomTools(
	configuredPaths: string[],
	cwd: string,
	builtInToolNames: string[],
): Promise<CustomToolsLoadResult> {
	const allPathsWithSources: ToolPathWithSource[] = [];
	const seen = new Set<string>();

	// Helper to add paths without duplicates
	const addPath = (p: string, source?: { provider: string; providerName: string; level: "user" | "project" }) => {
		const resolved = path.resolve(p);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			allPathsWithSources.push({ path: p, source });
		}
	};

	// 1. Discover tools via capability system (user + project from all providers)
	const discoveredTools = loadSync<CustomTool>(toolCapability.id, { cwd });
	for (const tool of discoveredTools.items) {
		addPath(tool.path, {
			provider: tool._source.provider,
			providerName: tool._source.providerName,
			level: tool.level,
		});
	}

	// 2. Plugin tools: ~/.omp/plugins/node_modules/*/
	for (const pluginPath of getAllPluginToolPaths(cwd)) {
		addPath(pluginPath, { provider: "plugin", providerName: "Plugin", level: "user" });
	}

	// 3. Explicitly configured paths (can override/add)
	for (const configPath of configuredPaths) {
		addPath(resolveToolPath(configPath, cwd), { provider: "config", providerName: "Config", level: "project" });
	}

	return loadCustomTools(allPathsWithSources, cwd, builtInToolNames);
}
