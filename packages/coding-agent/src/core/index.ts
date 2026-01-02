/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.js";
export { type BashExecutorOptions, type BashResult, executeBash } from "./bash-executor.js";
export type { CompactionResult } from "./compaction/index.js";
export {
	type CustomTool,
	type CustomToolAPI,
	type CustomToolFactory,
	type CustomToolsLoadResult,
	type CustomToolUIContext,
	discoverAndLoadCustomTools,
	type ExecResult,
	type LoadedCustomTool,
	loadCustomTools,
	type RenderResultOptions,
} from "./custom-tools/index.js";
export {
	type HookAPI,
	type HookContext,
	type HookError,
	type HookEvent,
	type HookFactory,
	HookRunner,
	type HookUIContext,
	loadHooks,
} from "./hooks/index.js";
export {
	createMCPManager,
	discoverAndLoadMCPTools,
	expandEnvVars,
	loadAllMCPConfigs,
	type MCPConfigFile,
	type MCPLoadResult,
	MCPManager,
	type MCPServerConfig,
	type MCPServerConnection,
	type MCPToolDefinition,
	type MCPToolDetails,
	type MCPToolsLoadResult,
	type MCPTransport,
} from "./mcp/index.js";
