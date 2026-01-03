// Core session management

// Re-export TUI components for custom tool rendering
export { Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./core/agent-session";
// Auth and model registry
export { type ApiKeyCredential, type AuthCredential, AuthStorage, type OAuthCredential } from "./core/auth-storage";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	findCutPoint,
	findTurnStartIndex,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	generateSummary,
	getLastAssistantUsage,
	prepareBranchEntries,
	serializeConversation,
	shouldCompact,
} from "./core/compaction/index";
// Custom commands
export type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandFactory,
	CustomCommandSource,
	CustomCommandsLoadResult,
	LoadedCustomCommand,
} from "./core/custom-commands/types";
// Custom tools
export type {
	AgentToolUpdateCallback,
	CustomTool,
	CustomToolAPI,
	CustomToolContext,
	CustomToolFactory,
	CustomToolSessionEvent,
	CustomToolsLoadResult,
	CustomToolUIContext,
	ExecResult,
	LoadedCustomTool,
	RenderResultOptions,
} from "./core/custom-tools/index";
export { discoverAndLoadCustomTools, loadCustomTools } from "./core/custom-tools/index";
export type * from "./core/hooks/index";
// Hook system types and type guards
export {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "./core/hooks/index";
export { convertToLlm } from "./core/messages";
export { ModelRegistry } from "./core/model-registry";
// SDK for programmatic usage
export {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	// Factory
	createAgentSession,
	createBashTool,
	// Tool factories (for custom cwd)
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	// Discovery
	discoverAuthStorage,
	discoverContextFiles,
	discoverCustomTools,
	discoverHooks,
	discoverModels,
	discoverSkills,
	discoverSlashCommands,
	type FileSlashCommand,
	// Hook types
	type HookAPI,
	type HookContext,
	type HookFactory,
	loadSettings,
	// Pre-built tools (use process.cwd())
	readOnlyTools,
} from "./core/sdk";
export {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	SessionManager,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager";
export {
	type CompactionSettings,
	type LspSettings,
	type RetrySettings,
	type Settings,
	SettingsManager,
	type SkillsSettings,
} from "./core/settings-manager";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
	type SkillWarning,
} from "./core/skills";
// Tools
export {
	type BashToolDetails,
	bashTool,
	type CodingToolsOptions,
	codingTools,
	editTool,
	type FindToolDetails,
	findTool,
	type GrepToolDetails,
	grepTool,
	type LsToolDetails,
	lsTool,
	type ReadToolDetails,
	readTool,
	type TruncationResult,
	type WriteToolDetails,
	type WriteToolOptions,
	writeTool,
} from "./core/tools/index";
export type { FileDiagnosticsResult } from "./core/tools/lsp/index";
// Main entry point
export { main } from "./main";
// UI components for hooks and custom tools
export { BorderedLoader } from "./modes/interactive/components/bordered-loader";
// Theme utilities for custom tools
export { getMarkdownTheme } from "./modes/interactive/theme/theme";

// TypeBox helper for string enums (convenience for custom tools)
import { type TSchema, Type } from "@sinclair/typebox";
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TSchema {
	return Type.Union(
		values.map((v) => Type.Literal(v)),
		options,
	);
}
