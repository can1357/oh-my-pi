/**
 * Custom tool loader - loads TypeScript tool modules through the same loader
 * as extensions, so `@oh-my-pi/*` imports resolve to the host's bundled copy
 * (in the compiled binary there is no other copy to resolve).
 *
 * Dependencies are also injected through CustomToolAPI so tools loaded from
 * user directories need no workspace module resolution.
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
import { loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getCodingAgentApi } from "../host-api";
import * as typebox from "../legacy-typebox";
import { createNoOpUIContext, resolvePath, withHostGuard } from "../utils";
import type {
	CustomToolAPI,
	CustomToolFactory,
	CustomToolsLoadResult,
	CustomToolsRefresh,
	CustomToolsRefreshOptions,
	LoadedCustomTool,
	ToolLoadError,
	ToolPathWithSource,
} from "./types";

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
 * The factory a tool module exports. A CommonJS module's namespace `default` is
 * its whole `module.exports`, so transpiled output (`exports.default = factory`
 * with `__esModule`) carries the factory one level down.
 */
function customToolFactoryOf(module: { default?: unknown }): CustomToolFactory | undefined {
	const candidate = module.default ?? module;
	if (typeof candidate === "function") return candidate as CustomToolFactory;
	if (typeof candidate === "object" && candidate !== null && "default" in candidate) {
		const nested = candidate.default;
		if (typeof nested === "function") return nested as CustomToolFactory;
	}
	return undefined;
}

/**
 * Identity of a tool module's entry file: changes when the file is edited,
 * replaced, or deleted. `undefined` when the file cannot be stat'ed.
 */
async function moduleSignature(resolvedPath: string): Promise<string | undefined> {
	try {
		const stat = await Bun.file(resolvedPath).stat();
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

/**
 * Load a single tool module through the host-package loader.
 *
 * `reload: false` (startup) evaluates a module and its helpers once per process
 * and shares them, as a native `import()` would. `reload: true` re-evaluates the
 * entry and its relative imports so an edited module is picked up.
 */
async function loadTool(
	toolPath: string,
	cwd: string,
	sharedApi: CustomToolAPI,
	reload: boolean,
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
		// Each session calls the factory with its own API regardless of `reload`.
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath, { reload }))) as {
			default?: unknown;
		};
		const factory = customToolFactoryOf(module);

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
		const message = err instanceof Error ? err.message : String(err);
		return { tools: [], errors: [{ path: toolPath, error: `Failed to load tool: ${message}`, source }] };
	}
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
	#builtInToolNames: readonly string[];
	/** Entry-file signature sampled at each module's last import attempt. */
	#signatures = new Map<string, string | undefined>();
	/** Modules whose last import attempt produced nothing but errors. */
	#failedModules = new Set<string>();

	constructor(
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
			get pi() {
				return getCodingAgentApi();
			},
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
		this.#builtInToolNames = builtInToolNames;
	}

	async load(pathsWithSources: ToolPathWithSource[]): Promise<void> {
		const takenNames = new Set<string>(this.#builtInToolNames);
		for (const entry of pathsWithSources) {
			const imported = await this.#importModule(entry, false, takenNames);
			this.errors.push(...imported.errors);
			this.tools.push(...imported.tools);
		}
	}

	/**
	 * Re-read the tool sources against what is loaded. A module is re-imported (bypassing the
	 * module cache) only when it is new, its entry file changed, or, with `retryFailed`, it failed
	 * last time. Untouched modules keep their loaded tools, factories are not re-run, and a module
	 * that no longer exists drops its tools. Helpers a module imports are not watched: touch the
	 * entry file to pick up a helper edit.
	 *
	 * A module whose import fails outright keeps its previous tools, so a half-saved edit does not
	 * remove a working tool; the failure is reported in {@link CustomToolsRefresh.errors}.
	 */
	async refresh(
		pathsWithSources: ToolPathWithSource[],
		options: CustomToolsRefreshOptions = {},
	): Promise<CustomToolsRefresh> {
		const cwd = this.#sharedApi.cwd;
		const entries = pathsWithSources.map(entry => ({ entry, resolvedPath: resolvePath(entry.path, cwd) }));
		const previousByPath = Map.groupBy(this.tools, loaded => loaded.resolvedPath);
		const modulesToImport = new Set<string>();
		for (const { resolvedPath } of entries) {
			const unchanged =
				this.#signatures.has(resolvedPath) &&
				this.#signatures.get(resolvedPath) === (await moduleSignature(resolvedPath));
			if (!unchanged || (options.retryFailed && this.#failedModules.has(resolvedPath))) {
				modulesToImport.add(resolvedPath);
			}
		}

		// Names held by modules that stay as they are, plus the built-ins, are off limits to re-imported modules.
		const takenNames = new Set<string>(this.#builtInToolNames);
		for (const { resolvedPath } of entries) {
			if (modulesToImport.has(resolvedPath)) continue;
			for (const loaded of previousByPath.get(resolvedPath) ?? []) takenNames.add(loaded.tool.name);
		}

		const errors: ToolLoadError[] = [];
		const nextTools: LoadedCustomTool[] = [];
		for (const { entry, resolvedPath } of entries) {
			const previous = previousByPath.get(resolvedPath) ?? [];
			if (!modulesToImport.has(resolvedPath)) {
				nextTools.push(...previous);
				continue;
			}
			const imported = await this.#importModule(entry, true, takenNames);
			errors.push(...imported.errors);
			if (imported.failed && previous.length > 0) {
				for (const loaded of previous) takenNames.add(loaded.tool.name);
				nextTools.push(...previous);
			} else {
				nextTools.push(...imported.tools);
			}
		}

		const previousByName = new Map(this.tools.map(loaded => [loaded.tool.name, loaded]));
		const nextByName = new Map(nextTools.map(loaded => [loaded.tool.name, loaded]));
		const added = nextTools.filter(loaded => !previousByName.has(loaded.tool.name));
		const removed = this.tools.filter(loaded => !nextByName.has(loaded.tool.name));
		const replaced: Array<{ previous: LoadedCustomTool; next: LoadedCustomTool }> = [];
		for (const previous of this.tools) {
			const next = nextTools.find(loaded => loaded.tool.name === previous.tool.name);
			if (next && next !== previous) replaced.push({ previous, next });
		}

		const knownPaths = new Set(entries.map(({ resolvedPath }) => resolvedPath));
		for (const resolvedPath of this.#signatures.keys()) {
			if (knownPaths.has(resolvedPath)) continue;
			this.#signatures.delete(resolvedPath);
			this.#failedModules.delete(resolvedPath);
		}
		this.tools = nextTools;
		return { added, replaced, removed, errors };
	}

	/**
	 * Import one tool module and admit its tools. Names in `takenNames` are rejected as conflicts;
	 * admitted names are added to it. `failed` means the module produced nothing but errors.
	 */
	async #importModule(
		{ path: toolPath, source }: ToolPathWithSource,
		reload: boolean,
		takenNames: Set<string>,
	): Promise<{ tools: LoadedCustomTool[]; errors: ToolLoadError[]; failed: boolean }> {
		const resolvedPath = resolvePath(toolPath, this.#sharedApi.cwd);
		// Sampled before the import so an edit landing mid-import is seen as a change next time.
		const signature = await moduleSignature(resolvedPath);
		const result = await loadTool(toolPath, this.#sharedApi.cwd, this.#sharedApi, reload, source);
		const errors = [...result.errors];
		const tools: LoadedCustomTool[] = [];
		for (const loaded of result.tools) {
			if (takenNames.has(loaded.tool.name)) {
				errors.push({
					path: toolPath,
					error: `Tool name "${loaded.tool.name}" conflicts with existing tool`,
					source,
				});
				continue;
			}
			takenNames.add(loaded.tool.name);
			tools.push(loaded);
		}
		const failed = result.tools.length === 0 && errors.length > 0;
		this.#signatures.set(resolvedPath, signature);
		if (failed) this.#failedModules.add(resolvedPath);
		else this.#failedModules.delete(resolvedPath);
		return { tools, errors, failed };
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
): Promise<CustomToolsLoadResult> {
	const loader = new CustomToolLoader(cwd, builtInToolNames, pushPendingAction);
	await loader.load(pathsWithSources);
	return {
		// A getter: `refresh` replaces the loader's tool list.
		get tools() {
			return loader.tools;
		},
		errors: loader.errors,
		setUIContext: (uiContext: HookUIContext, hasUI: boolean) => {
			loader.setUIContext(uiContext, hasUI);
		},
		refresh: (paths, options) => loader.refresh(paths, options),
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
 * @param agentDir - Native user config dir. Default: getAgentDir()
 */
export async function discoverCustomToolPaths(
	configuredPaths: string[],
	cwd: string,
	agentDir?: string,
): Promise<ToolPathWithSource[]> {
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

	// Capability providers also expose metadata and scripts. Filter before deduplication
	// so those entries cannot shadow executable modules with the same name.
	const discoveredTools = await loadCapability<CustomTool>(toolCapability.id, {
		cwd,
		agentDir,
		filter: tool => /\.(ts|js|mjs|cjs)$/.test(tool.path) && !tool.path.endsWith(".d.ts"),
	});
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
 * @param agentDir - Native user config dir. Default: getAgentDir()
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
	agentDir?: string,
) {
	const pathsWithSources = await discoverCustomToolPaths(configuredPaths, cwd, agentDir);
	return loadCustomTools(pathsWithSources, cwd, builtInToolNames, pushPendingAction);
}
