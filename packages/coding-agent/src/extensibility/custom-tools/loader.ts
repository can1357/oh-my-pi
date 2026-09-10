/**
 * Custom tool loader - loads TypeScript tool modules using native Bun import.
 *
 * Dependencies are injected through CustomToolAPI so tools loaded from user
 * directories do not depend on workspace module resolution.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { toolCapability } from "../../capability/tool";
import { type CustomTool, loadCapability } from "../../discovery";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
import type { HookUIContext } from "../../extensibility/hooks/types";
import { getAllPluginToolPaths } from "../../extensibility/plugins/loader";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import * as typebox from "../legacy-typebox";
import { createNoOpUIContext, resolvePath, withHostGuard } from "../utils";
import type { CustomToolAPI, CustomToolFactory, LoadedCustomTool, ToolLoadError } from "./types";

interface LoadToolResult {
	tools: LoadedCustomTool[];
	errors: ToolLoadError[];
}

function isLoadableCustomTool(value: unknown): value is LoadedCustomTool["tool"] {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		value.name.length > 0 &&
		"description" in value &&
		typeof value.description === "string" &&
		"parameters" in value &&
		"execute" in value &&
		typeof value.execute === "function"
	);
}

function invalidToolError(path: string, index: number, source: ToolLoadError["source"]): ToolLoadError {
	return {
		path,
		error: `Tool factory returned invalid tool at index ${index}: expected object with string name, string description, parameters, and execute function`,
		source,
	};
}

/**
 * Engine wording for an exhausted call stack. V8 and JSC both say "Maximum
 * call stack size exceeded"; SpiderMonkey says "too much recursion".
 */
const STACK_EXHAUSTION_PATTERN = /maximum call stack size exceeded|stack overflow|too much recursion/i;

/**
 * A blown stack surfaces as a bare `RangeError` whose stack is empty or
 * collapsed onto the recursive frame, so the raw message names neither the
 * module nor the cause.
 *
 * The dominant trigger is a custom tool that *value*-imports the agent
 * package: `@oh-my-pi/pi-coding-agent` maps its `"."` export to the agent's
 * own entry module, so importing it from a tool re-enters the agent module
 * graph while custom tools are still being loaded. See #8900.
 */
const SELF_IMPORT_HINT =
	'This usually means the module re-entered the agent while it was still loading. Import "@oh-my-pi/pi-coding-agent" with `import type` only (type imports are erased at runtime) and take runtime values from the `pi` argument passed to the factory.';

function isStackExhaustion(err: unknown): boolean {
	return err instanceof Error && STACK_EXHAUSTION_PATTERN.test(err.message);
}

/**
 * Build the user-facing text for a tool module that failed to load.
 *
 * Always names the file that actually failed: the configured `toolPath` may be
 * relative or `~`-prefixed, so the resolved absolute path is appended whenever
 * it differs. Without it the only record of the offending file is
 * `~/.omp/logs/omp*.log`, which is unreachable advice unless the reader
 * already knows the failure is tool-related (#8900).
 *
 * Exported for tests.
 */
export function describeToolLoadFailure(err: unknown, toolPath: string, resolvedPath: string): string {
	const location = resolvedPath === toolPath ? toolPath : `${toolPath} (resolved to ${resolvedPath})`;
	const raw = err instanceof Error ? err.message : String(err);
	const detail = raw.trim().length > 0 ? raw : `${err instanceof Error ? err.name : typeof err} with no message`;
	const hint = isStackExhaustion(err) ? ` ${SELF_IMPORT_HINT}` : "";
	return `Failed to load tool ${location}: ${detail}${hint}`;
}

/**
 * Load a single tool module using native Bun import.
 */
async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
	source?: { provider: string; providerName: string; level: "user" | "project" },
): Promise<LoadToolResult> {
	const resolvedPath = resolvePath(toolPath, cwd);

	// Skip declarative tool files (.md, .json) - these are metadata only, not executable modules
	if (resolvedPath.endsWith(".md") || resolvedPath.endsWith(".json")) {
		return {
			tools: [],
			errors: [
				{
					path: toolPath,
					error: "Declarative tool files (.md, .json) cannot be loaded as executable modules",
					source,
				},
			],
		};
	}

	try {
		const module = await withHostGuard(() => import(resolvedPath));
		const factory = (module.default ?? module) as CustomToolFactory;

		if (typeof factory !== "function") {
			return { tools: [], errors: [{ path: toolPath, error: "Tool must export a default function", source }] };
		}

		const toolResult: unknown = await withHostGuard(async () => factory(sharedApi));
		const toolsArray = Array.isArray(toolResult) ? toolResult : [toolResult];

		const loadedTools: LoadedCustomTool[] = [];
		const errors: ToolLoadError[] = [];
		for (const [index, tool] of toolsArray.entries()) {
			if (!isLoadableCustomTool(tool)) {
				errors.push(invalidToolError(toolPath, index, source));
				continue;
			}

			loadedTools.push({
				path: toolPath,
				resolvedPath,
				tool,
				source,
			});
		}

		return { tools: loadedTools, errors };
	} catch (err) {
		return {
			tools: [],
			errors: [{ path: toolPath, error: describeToolLoadFailure(err, toolPath, resolvedPath), source }],
		};
	}
}

/** Tool path with optional source metadata, suitable for forwarding from a
 * parent session to a subagent so the subagent can re-bind tools to its own
 * `CustomToolAPI` without redoing the filesystem scan. */
export interface ToolPathWithSource {
	path: string;
	source?: { provider: string; providerName: string; level: "user" | "project" };
}

/**
 * Loads custom tools from paths with conflict detection and error handling.
 *
 * Manages a shared API instance passed to all tool factories, providing access to
 * execution context, UI, logger, and injected dependencies. The UI context can be
 * updated after loading via setUIContext().
 */
export class CustomToolLoader {
	tools: LoadedCustomTool[] = [];
	errors: ToolLoadError[] = [];
	#sharedApi: CustomToolAPI;
	#seenNames: Set<string>;

	constructor(
		pi: typeof PiCodingAgent,
		cwd: string,
		builtInToolNames: string[],
		pushPendingAction?: (action: {
			label: string;
			sourceToolName: string;
			apply(reason: string): Promise<AgentToolResult<unknown>>;
			reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
		}) => void,
	) {
		this.#sharedApi = {
			cwd,
			exec: (command: string, args: string[], options?: ExecOptions) =>
				execCommand(command, args, options?.cwd ?? cwd, options),
			ui: createNoOpUIContext(),
			hasUI: false,
			logger,
			typebox,
			arktype: type,
			zod,
			pi,
			pushPendingAction: action => {
				if (!pushPendingAction) {
					throw new Error("Pending action store unavailable for custom tools in this runtime.");
				}
				pushPendingAction({
					label: action.label,
					sourceToolName: action.sourceToolName ?? "custom_tool",
					apply: action.apply,
					reject: action.reject,
				});
			},
		};
		this.#seenNames = new Set<string>(builtInToolNames);
	}

	async load(pathsWithSources: ToolPathWithSource[]): Promise<void> {
		for (const { path: toolPath, source } of pathsWithSources) {
			const { tools: loadedTools, errors } = await loadTool(toolPath, this.#sharedApi.cwd, this.#sharedApi, source);
			this.errors.push(...errors);

			for (const loadedTool of loadedTools) {
				// Check for name conflicts
				if (this.#seenNames.has(loadedTool.tool.name)) {
					this.errors.push({
						path: toolPath,
						error: `Tool name "${loadedTool.tool.name}" conflicts with existing tool`,
						source,
					});
					continue;
				}

				this.#seenNames.add(loadedTool.tool.name);
				this.tools.push(loadedTool);
			}
		}
	}

	setUIContext(uiContext: HookUIContext, hasUI: boolean): void {
		this.#sharedApi.ui = uiContext;
		this.#sharedApi.hasUI = hasUI;
	}
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
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
) {
	const loader = new CustomToolLoader(PiCodingAgent, cwd, builtInToolNames, pushPendingAction);
	await loader.load(pathsWithSources);
	return {
		tools: loader.tools,
		errors: loader.errors,
		setUIContext: (uiContext: HookUIContext, hasUI: boolean) => {
			loader.setUIContext(uiContext, hasUI);
		},
	};
}

/**
 * Collect the absolute tool-source paths to load, without importing or
 * binding factories. Hot path on session startup — the scan walks
 * `.omp/tools/`, `.claude/tools/`, the plugin tree, and any configured paths.
 *
 * Subagents reuse the parent's collected paths via the SDK's
 * `preloadedCustomToolPaths` option, then call `loadCustomTools` themselves
 * so each session re-binds factories with its own session-scoped
 * `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI --tool flags
 * @param cwd - Current working directory
 */
export async function discoverCustomToolPaths(configuredPaths: string[], cwd: string): Promise<ToolPathWithSource[]> {
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
	const discoveredTools = await loadCapability<CustomTool>(toolCapability.id, { cwd });
	for (const tool of discoveredTools.items) {
		addPath(tool.path, {
			provider: tool._source.provider,
			providerName: tool._source.providerName,
			level: tool.level,
		});
	}

	// 2. Plugin tools: ~/.omp/plugins/node_modules/*/
	for (const pluginPath of await getAllPluginToolPaths(cwd)) {
		addPath(pluginPath, { provider: "plugin", providerName: "Plugin", level: "user" });
	}

	// 3. Explicitly configured paths (can override/add)
	for (const configPath of configuredPaths) {
		addPath(resolvePath(configPath, cwd), { provider: "config", providerName: "Config", level: "project" });
	}

	return allPathsWithSources;
}

/**
 * Discover and load tools from standard locations via capability system:
 * 1. User and project tools discovered by capability providers
 * 2. Installed plugins (~/.omp/plugins/node_modules/*)
 * 3. Explicitly configured paths from settings or CLI
 *
 * Composed of {@link discoverCustomToolPaths} (FS scan) + {@link loadCustomTools}
 * (per-session binding). Subagents skip the first step and just call
 * `loadCustomTools` against the parent's collected paths.
 *
 * @param configuredPaths - Explicit paths from settings.json and CLI --tool flags
 * @param cwd - Current working directory
 * @param builtInToolNames - Names of built-in tools to check for conflicts
 */
export async function discoverAndLoadCustomTools(
	configuredPaths: string[],
	cwd: string,
	builtInToolNames: string[],
	pushPendingAction?: (action: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	}) => void,
) {
	const pathsWithSources = await discoverCustomToolPaths(configuredPaths, cwd);
	return loadCustomTools(pathsWithSources, cwd, builtInToolNames, pushPendingAction);
}
