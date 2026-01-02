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
} from "./core/agent-session.js";
// Auth and model registry
export { type ApiKeyCredential, type AuthCredential, AuthStorage, type OAuthCredential } from "./core/auth-storage.js";
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
} from "./core/compaction/index.js";
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
} from "./core/custom-tools/index.js";
export { discoverAndLoadCustomTools, loadCustomTools } from "./core/custom-tools/index.js";
export type * from "./core/hooks/index.js";
// Hook system types and type guards
export {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "./core/hooks/index.js";
export { convertToLlm } from "./core/messages.js";
export { ModelRegistry } from "./core/model-registry.js";
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
} from "./core/sdk.js";
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
} from "./core/session-manager.js";
export {
	type CompactionSettings,
	type RetrySettings,
	type Settings,
	SettingsManager,
	type SkillsSettings,
} from "./core/settings-manager.js";
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
} from "./core/skills.js";
// Tools
export {
	type BashToolDetails,
	bashTool,
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
	writeTool,
} from "./core/tools/index.js";
// Main entry point
export { main } from "./main.js";
// UI components for hooks and custom tools
export { BorderedLoader } from "./modes/interactive/components/bordered-loader.js";
// Theme utilities for custom tools
export { getMarkdownTheme } from "./modes/interactive/theme/theme.js";

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
