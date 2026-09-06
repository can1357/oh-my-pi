/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { isPromise } from "node:util/types";

import type { InMemorySnapshotStore } from "@pk-nerdsaver-ai/hashline";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	AgentBusyError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolContext,
	type AgentTurnEndContext,
	AppendOnlyContextManager,
	type AsideMessage,
	CacheAttributionTracker,
	type CacheStats,
	type CompactionSummaryMessage,
	countTokens,
	resolveTelemetry,
	type StreamFn,
	ThinkingLevel,
	type ToolChoiceDirective,
} from "@pk-nerdsaver-ai/pi-agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	applyShakeRegions,
	CompactionCancelledError,
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	calculatePromptTokens,
	collectEntriesForBranchSummary,
	collectShakeRegions,
	compact,
	compactionContextTokens,
	createCompactionSummaryMessage,
	DEFAULT_SHAKE_CONFIG,
	effectiveReserveTokens,
	estimateTokens,
	generateBranchSummary,
	generateHandoffFromContext,
	prepareCompaction,
	renderHandoffPrompt,
	resolveThresholdTokens,
	type SessionEntry,
	type SessionMessageEntry,
	type ShakeConfig,
	type ShakeRegion,
	type SummaryOptions,
	shouldCompact,
	shouldUseOpenAiRemoteCompaction,
} from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import {
	DEFAULT_PRUNE_CONFIG,
	maskConsumedObservations,
	pruneSupersededToolResults,
	pruneToolOutputs,
	readToolSupersedeKey,
} from "@pk-nerdsaver-ai/pi-agent-core/compaction/pruning";
import type {
	ProtectedToolContext,
	ProtectedToolMatcher,
} from "@pk-nerdsaver-ai/pi-agent-core/compaction/tool-protection";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ProviderResponseMetadata,
	ProviderSessionState,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
	ServiceTier,
	SimpleStreamOptions,
	TextContent,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	Usage,
	UsageReport,
} from "@pk-nerdsaver-ai/pi-ai";
import {
	calculateRateLimitBackoffMs,
	clearAnthropicFastModeFallback,
	deriveClaudeDeviceId,
	Effort,
	parseRateLimitReason,
	resolveServiceTier,
	streamSimple,
} from "@pk-nerdsaver-ai/pi-ai";
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { isContextOverflow, isUsageLimit as isUsageLimitError } from "@pk-nerdsaver-ai/pi-ai/error";
import { stripToolDescriptions } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import {
	GeminiHeaderRunDetector,
	isGeminiThinkingModel,
	THINKING_LOOP_ERROR_MARKER,
} from "@pk-nerdsaver-ai/pi-ai/utils/thinking-loop";
import { getSupportedEfforts } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { modelsAreEqual } from "@pk-nerdsaver-ai/pi-catalog/models";
import { MacOSPowerAssertion } from "@pk-nerdsaver-ai/pi-natives";
import {
	extractRetryHint,
	formatDuration,
	getAgentDbPath,
	getInstallId,
	isBunTestRuntime,
	isEnoent,
	isUnexpectedSocketCloseMessage,
	logger,
	prompt,
	relativePathWithinRoot,
	Snowflake,
	withTimeout,
} from "@pk-nerdsaver-ai/pi-utils";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";
import {
	AdviseTool,
	type AdvisorAgent,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorRuntime,
	type AdvisorSeverity,
	AdvisorTranscriptRecorder,
	formatAdvisorBatchContent,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
	resolveAdvisorDeliveryChannel,
} from "../advisor";
import { composeAdvisorSystemPrompt } from "../advisor/task-contract-block";
import { type AsyncJob, type AsyncJobDeliveryState, AsyncJobManager } from "../async";
import { classifyDifficulty } from "../auto-thinking/classifier";
import { reset as resetCapabilities } from "../capability";
import type { Rule } from "../capability/rule";
import { shouldEnableAppendOnlyContext } from "../config/append-only-context-mode";
import type { ModelRegistry } from "../config/model-registry";
import {
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelString,
	type ResolvedModelRoleValue,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveRoleSelection,
} from "../config/model-resolver";
import { MODEL_ROLE_IDS, MODEL_ROLES } from "../config/model-roles";
import { expandPromptTemplate, type PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import { onAppendOnlyModeChanged } from "../config/settings";
import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { loadCapability } from "../discovery";
import { expandApplyPatchToEntries, normalizeDiff, normalizeToLF, ParseError, previewPatch, stripBom } from "../edit";
import { getFileSnapshotStore } from "../edit/file-snapshot-store";
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import { type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { TtsrManager, TtsrMatchContext } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../extensibility/custom-tools/wrapper";
import type {
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionStopEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensibility/extensions";
import { createExtensionModelQuery } from "../extensibility/extensions/model-api";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { HookCommandContext } from "../extensibility/hooks/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import { expandSlashCommand, type FileSlashCommand } from "../extensibility/slash-commands";
import { GoalRuntime } from "../goals/runtime";
import type { Goal, GoalModeState } from "../goals/state";
import type { HindsightSessionState } from "../hindsight/state";
import { type LocalProtocolOptions, resolveLocalUrlToPath, type XdevWriteResult } from "../internal-urls";
import { IrcBus, type IrcMessage } from "../irc/bus";
import { resolveMemoryBackend } from "../memory-backend";
import { shutdownMnemopiEmbedClient } from "../mnemopi/embed-client";
import { getMnemopiSessionState, type MnemopiSessionState, setMnemopiSessionState } from "../mnemopi/state";
import { containsOrchestrate, ORCHESTRATE_NOTICE } from "../modes/orchestrate";
import { getCurrentThemeName, theme } from "../modes/theme/theme";
import { parseTurnBudget } from "../modes/turn-budget";
import { containsUltrathink, ULTRATHINK_NOTICE } from "../modes/ultrathink";
import {
	computeNonMessageBreakdown,
	computeNonMessageTokens,
	estimateToolSchemaTokens,
} from "../modes/utils/context-usage";
import { containsWorkflow, WORKFLOW_NOTICE } from "../modes/workflow";
import { ApproachRegistry } from "../orchestration/approach-registry";
import { authorizeIrcDelivery, type CollaborationPolicy } from "../orchestration/collaboration-policy";
import {
	type CompletionGateEvaluation,
	type CompletionGateInput,
	evaluateCompletionGate,
} from "../orchestration/completion-gate";
import { buildContractInjectionBlock, type InjectionBlock } from "../orchestration/contract-injector";
import {
	type AssumptionRecord,
	type ContractGap,
	compileIntent,
	patchContractFromAnswer,
	type QuestionSpec,
} from "../orchestration/intent-compiler";
import {
	createOrchestrationTelemetrySink,
	type OrchestrationTelemetrySink,
	recordAdvisorInterventionTelemetry,
} from "../orchestration/orchestration-telemetry";
import { computeTaskContractDigest } from "../orchestration/reasoning-plan";
import { buildCompletionGateInputFromTranscript } from "../orchestration/root-completion-gate";
import {
	type ActiveTaskContractSnapshot,
	isSubstantialRequest,
	startsWithSubstantialAction,
	type TaskContractV1,
	toActiveTaskContractSnapshot,
} from "../orchestration/task-contract";
import { createPlanReadMatcher } from "../plan-mode/plan-protection";
import type { PlanModeState } from "../plan-mode/state";
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import autoContinuePrompt from "../prompts/system/auto-continue.md" with { type: "text" };
import eagerTaskPrompt from "../prompts/system/eager-task.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import emptyStopRetryTemplate from "../prompts/system/empty-stop-retry.md" with { type: "text" };
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import planModeActivePrompt from "../prompts/system/plan-mode-active.md" with { type: "text" };
import planModeReferencePrompt from "../prompts/system/plan-mode-reference.md" with { type: "text" };
import planModeToolDecisionReminderPrompt from "../prompts/system/plan-mode-tool-decision-reminder.md" with {
	type: "text",
};
import sideChannelNoToolsPrompt from "../prompts/system/side-channel-no-tools.md" with { type: "text" };
import ttsrInterruptTemplate from "../prompts/system/ttsr-interrupt.md" with { type: "text" };
import ttsrToolReminderTemplate from "../prompts/system/ttsr-tool-reminder.md" with { type: "text" };
import unexpectedStopRetryTemplate from "../prompts/system/unexpected-stop-retry.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import type { ScreenpipeSessionManager } from "../screenpipe/session-state";
import {
	deobfuscateAssistantContent,
	deobfuscateSessionContext,
	obfuscateMessages,
	obfuscateProviderContext,
	obfuscateProviderTools,
	type SecretObfuscator,
} from "../secrets/obfuscator";
import { invalidateHostMetadata } from "../ssh/connection-manager";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	parseConfiguredThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";
import { shutdownTinyTitleClient } from "../tiny/title-client";
import {
	countToolsForAutoDiscovery,
	resolveEffectiveToolDiscoveryMode,
	TOOL_DISCOVERY_SCHEMA_TOKEN_BUDGET,
	TOOL_DISCOVERY_SEARCH_TOOL_NAME,
} from "../tool-discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "../tool-discovery/tool-index";
import { formatApprovalPrompt, resolveApproval, truncateForPrompt } from "../tools/approval";
import { assertEditableFile } from "../tools/auto-generated-guard";
import { normalizeToolNames } from "../tools/builtin-names";
import type { CheckpointState } from "../tools/checkpoint";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, isAllowedByToolProfile } from "../tools/index";
import { outputMeta, wrapToolWithMetaNotice } from "../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";
import { isAutoQaEnabled } from "../tools/report-tool-issue";
import { buildResolveReminderMessage } from "../tools/resolve";
import { getLatestTodoPhasesFromEntries, type TodoItem, type TodoPhase } from "../tools/todo";
import { ToolAbortError, ToolError } from "../tools/tool-errors";
import type { ResolvedToolProfile, ToolSource } from "../tools/tool-profiles";
import { clampTimeout } from "../tools/tool-timeouts";
import { XdevRegistry } from "../tools/xdev";
import { parseCommandArgs } from "../utils/command-args";
import { type EditMode, resolveEditMode } from "../utils/edit-mode";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../utils/file-mentions";
import { normalizeModelContextImages } from "../utils/image-loading";
import { describeAttachedImagesForTextModel } from "../utils/image-vision-fallback";
import { buildNamedToolChoice, isToolChoiceActive } from "../utils/tool-choice";
import type { AuthStorage } from "./auth-storage";
import type { ClientBridge, ClientBridgePermissionOption, ClientBridgePermissionOutcome } from "./client-bridge";
import {
	type CodexAutoRedeemRedeemDecision,
	defaultCodexAutoRedeemCoordinator,
	evaluateCodexAutoRedeem,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import { findCompactMode, SNAPCOMPACT_RETIREMENT_ERROR } from "./compact-modes";
import {
	classifyFusionRoute,
	type FusionPoolTier,
	type FusionRoute,
	parseFusionPoolEntries,
	resolveEffectiveFusionRoute,
	resolveSidekickRoute,
	shouldRunFusionCompactionSwitch,
} from "./fusion-router";
import { emptyFusionUsage, sumFusionUsage, type UsageSplit } from "./fusion-usage";
import {
	type BashExecutionMessage,
	type CustomMessage,
	convertToLlm,
	GENERIC_ABORT_SENTINEL,
	type PythonExecutionMessage,
	readQueueChipText,
	SILENT_ABORT_MARKER,
	SKILL_PROMPT_MESSAGE_TYPE,
	stripImagesFromMessage,
	USER_INTERRUPT_LABEL,
} from "./messages";
import { buildOffloadTraceCanvas, type OffloadTraceSettings, renderOffloadTraceCanvasMarkdown } from "./offload-trace";
import type { SessionContext } from "./session-context";
import { getLatestCompactionEntry, getRestorableSessionModels } from "./session-context";
import { formatSessionDumpText } from "./session-dump-format";
import type { BranchSummaryEntry, CompactionEntry, NewSessionOptions } from "./session-entries";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import { cleanupEmptyMoveSession, type SessionManager } from "./session-manager";
import type { ShakeMode, ShakeResult } from "./shake-types";
import { ToolChoiceQueue } from "./tool-choice-queue";
import { classifyUnexpectedStop, isUnexpectedStopCandidate } from "./unexpected-stop-classifier";
import { YieldQueue } from "./yield-queue";

type SessionSwitchReconciler = (() => Promise<void>) | { before?: () => Promise<void>; after?: () => Promise<void> };

const SESSION_STOP_CONTINUATION_CAP = 8;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "auto_compaction_start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			/** @deprecated Never emitted anymore; kept so existing listener switch cases still compile. */
			action: "context-full" | "handoff" | "shake" | "snapcompact";
	  }
	| {
			type: "auto_compaction_end";
			/** @deprecated Never emitted anymore; kept so existing listener switch cases still compile. */
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			/** True when compaction was skipped for a benign reason (no model, no candidates, nothing to compact). */
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "ttsr_triggered"; rules: Rule[] }
	| { type: "todo_reminder"; todos: TodoItem[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: CustomMessage }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			/** The user-configured selector when it differs from the effective level (e.g. `auto`). */
			configured?: ConfiguredThinkingLevel;
			/** The level `auto` resolved to this turn, once classified. */
			resolved?: Effort;
	  }
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState };
/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

const UNEXPECTED_STOP_MAX_RETRIES = 3;
const UNEXPECTED_STOP_TIMEOUT_MS = 4000;
const EMPTY_STOP_MAX_RETRIES = 3;
const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;

type CompactionCheckResult = Readonly<{
	deferredHandoff: boolean;
	continuationScheduled: boolean;
	paused: boolean;
}>;

const COMPACTION_CHECK_NONE: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
	paused: false,
};
const COMPACTION_CHECK_DEFERRED_HANDOFF: CompactionCheckResult = {
	deferredHandoff: true,
	continuationScheduled: true,
	paused: false,
};
const COMPACTION_CHECK_CONTINUATION: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: true,
	paused: false,
};
const COMPACTION_CHECK_PAUSED: CompactionCheckResult = {
	deferredHandoff: false,
	continuationScheduled: false,
	paused: true,
};

/**
 * Per-turn prune cache window. A tool result whose all-message suffix exceeds
 * this is in the warm, already-sent prompt-cache prefix: re-writing it costs the
 * cacheWrite premium on the whole suffix. Per-turn passes only reclaim inside
 * this tail (matches the supersede pass's default `suffixTokenLimit`); deeper
 * stale/age victims are left to compaction/shake, which rebuild the cache anyway.
 */
const PRUNE_CACHE_WARM_SUFFIX_TOKENS = 8_000;

/**
 * Idle gap after which the supersede pass may flush the whole sent region (the
 * provider cache is cold, so re-writing it is free). MUST exceed the maximum
 * Anthropic prompt-cache TTL — "long" retention (the OAuth default) is 1h — or a
 * still-warm prefix is busted by the flush. 90 min leaves margin over the 1h TTL.
 */
const PRUNE_IDLE_FLUSH_MS = 90 * 60_000;

/**
 * Prefix of the per-tool TTSR reminder folded into a matched tool's result (see
 * `#ttsrAfterToolCall`). Results carrying it must survive the
 * consumed-observation mask, or the in-band rule reminder is blanked away.
 */
const TTSR_TOOL_REMINDER_MARKER = '<system-reminder reason="rule_violation"';

function isTtsrReminderToolResult({ toolResult }: ProtectedToolContext): boolean {
	return toolResult.content.some(part => part.type === "text" && part.text.includes(TTSR_TOOL_REMINDER_MARKER));
}
export type CommandMetadataChangedListener = () => void | Promise<void>;
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

const RETRY_BACKOFF_JITTER_RATIO = 0.25;
/**
 * Hysteresis band for the post-maintenance "did we actually create headroom?"
 * checks. A shake or summary compaction counts as having resolved threshold
 * pressure only when residual context lands at or below
 * `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against the raw threshold
 * lets a pass keep reclaiming a trickle of the previous turn's output and land
 * just under the line every turn, sustaining the auto-continue dead loop
 * reported in #2275.
 */
const COMPACTION_RECOVERY_BAND = 0.8;

function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/**
 * Slack added past a sibling credential's block expiry before retrying, so
 * the next getApiKey lands after the block has actually lapsed.
 */
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type { ShakeMode, ShakeResult };

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/** External client capabilities installed before this session can execute tools. */
	clientBridge?: ClientBridge;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Prompt templates for expansion */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion */
	slashCommands?: FileSlashCommand[];
	/** Extension runner (created in main.ts with wrapped tools) */
	extensionRunner?: ExtensionRunner;
	/** Loaded skills (already discovered by SDK) */
	skills?: Skill[];
	/** Skill loading warnings (already captured by SDK) */
	skillWarnings?: SkillWarning[];
	/**
	 * Discovery closure used by `reloadSkills()`. Only provided when skills were
	 * auto-discovered; callers that passed explicit `options.skills` intentionally
	 * own that list and must not have it replaced by a disk re-scan.
	 */
	reloadSkills?: () => Promise<{ skills: Skill[]; warnings?: SkillWarning[] }>;
	/** Invoked by `reloadSkills()` after `#skills` is replaced, so the SDK can refresh its prompt snapshot and the global active-skills registry. */
	onSkillsChanged?: (skills: Skill[]) => void;
	/** Custom commands (TypeScript slash commands) */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Tool registry for LSP and settings */
	toolRegistry?: Map<string, AgentTool>;
	/** Names of the built-in tools in the registry (provenance, not the active set); lets
	 *  mode transitions force-activate genuine builtins hidden by tool discovery (#3165). */
	builtInToolNames?: Iterable<string>;
	/** Stream function for the advisor's own agent; defaults to the standard stream. */
	advisorStreamFn?: StreamFn;
	/** Provider-context transform applied to the advisor's requests (parity with the primary agent). */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	/** Current session pre-LLM message transform pipeline */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider payload hook used by the active session request path */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** System prompt builder that can consider tool availability. Returns ordered provider-facing blocks. */
	rebuildSystemPrompt?: (toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>;
	/** Rebuild the SSH tool from current capability discovery results. */
	reloadSshTool?: () => Promise<AgentTool | null>;
	requestedToolNames?: ReadonlySet<string>;
	/**
	 * Optional accessor for live MCP server instructions. Read by the session's
	 * `rebuildSystemPrompt`-skip optimization to detect server-side instruction
	 * changes (e.g. an MCP server upgrade) that would otherwise pass the tool-set
	 * signature comparison and silently keep a stale prompt cached.
	 */
	getMcpServerInstructions?: () => Map<string, string> | undefined;
	/** Enable hidden-by-default MCP tool discovery for this session. */
	mcpDiscoveryEnabled?: boolean;
	/** MCP tool names to activate for the current session when discovery mode is enabled. */
	initialSelectedMCPToolNames?: string[];
	/** Whether constructor-provided MCP defaults should be persisted immediately. */
	persistInitialMCPToolSelection?: boolean;
	/** MCP server names whose tools should seed discovery-mode sessions whenever those servers are connected. */
	defaultSelectedMCPServerNames?: string[];
	/** MCP tool names that should seed brand-new sessions created from this AgentSession. */
	defaultSelectedMCPToolNames?: string[];
	/** TTSR manager for time-traveling stream rules */
	ttsrManager?: TtsrManager;
	/** Secret obfuscator for deobfuscating streaming edit content */
	obfuscator?: SecretObfuscator;
	/** Inherited eval executor session id from a parent agent. */
	parentEvalSessionId?: string;
	/** Logical owner for retained Python kernels created by this session. */
	evalKernelOwnerId?: string;
	/**
	 * AsyncJobManager that this session installed as the process-global instance.
	 * Only the creating root receives ownership; every other root and subagent
	 * shares it without gaining disposal authority.
	 */
	ownedAsyncJobManager?: AsyncJobManager;
	moa?: { laneLabels: readonly string[] };
	/**
	 * Shared AsyncJobManager reachable by this session for owner-scoped actions.
	 * Queries, cancellation, and completion delivery are filtered by `agentId`.
	 */
	asyncJobManager?: AsyncJobManager;
	/** Agent identity (registry id like "Main" or "Alice") used for IRC routing. */
	agentId?: string;
	/** Collaboration authorization for roster, IRC delivery, and busy-side replies. */
	collaborationPolicy?: CollaborationPolicy;
	/** Immutable source-qualified tool ceiling enforced on activation/refresh. */
	toolProfile?: ResolvedToolProfile;
	/** Source resolver captured when the registry is built; unknown sources fail closed under a profile. */
	toolSourceOf?: (name: string) => ToolSource | undefined;
	/** Whether this session is the top-level agent or a subagent. Drives eager-task
	 *  prelude gating so a top-level session created with a custom `agentId` still
	 *  receives the always-mode reminder. Defaults to "main". */
	agentKind?: "main" | "sub";
	/**
	 * Override the provider-facing session ID for all API requests from this session.
	 * When absent, `sessionManager.getSessionId()` is used. Needed when benchmark or
	 * SDK callers issue probes / prewarming with an explicit `--provider-session-id`
	 * so that credential sticky selection is consistent with the session's streaming calls.
	 */
	providerSessionId?: string;
	/**
	 * Hard-isolated read-only tools (read/search/find) for the advisor agent,
	 * pre-built in `createAgentSession` against a distinct `ToolSession` so the
	 * advisor's reads never share the primary's snapshot/seen-lines/conflict
	 * caches. Undefined when the advisor is disabled.
	 */
	advisorReadOnlyTools?: AgentTool[];
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/**
	 * Strip tool descriptions from provider-bound tool specs on side requests
	 * (handoff). Must match the session-start value used to build the system
	 * prompt so inline descriptors are not also sent through provider schemas.
	 */
	pruneToolDescriptions?: boolean;
	/**
	 * Disconnect this session's OWNED MCP manager on dispose. Provided only when
	 * the session created the manager (top-level sessions); subagents reuse a
	 * parent's manager via `options.mcpManager` and omit this so a child's
	 * teardown never tears down the shared servers.
	 */
	disconnectOwnedMcpManager?: () => Promise<void>;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). */
	streamingBehavior?: "steer" | "followUp";
	/** Optional tool choice override for the next LLM call. */
	toolChoice?: ToolChoice;
	/** Send as developer/system message instead of user. Providers that support it use the developer role; others fall back to user. */
	synthetic?: boolean;
	/** Marks this prompt as a deliberate user action (typed message, `.`/`c`
	 *  continue). Clears advisor auto-resume suppression that a user interrupt set.
	 *  Defaults to `!synthetic`; manual-continue is synthetic yet user-initiated, so
	 *  it sets this explicitly. Agent-initiated synthetic prompts (auto-continue,
	 *  plan re-prime, reminders) leave it unset and keep suppression latched. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution for the prompt. Defaults to user prompts as `user` and synthetic prompts as `agent`. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt (internal use for maintenance flows). */
	skipCompactionCheck?: boolean;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Result from cycleRoleModels() */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model, used by role cycling and
 *  the plan-approval model slider. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** The set of resolvable role models plus the index of the currently active
 *  one within {@link ResolvedRoleModel.role} order. */
export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
}

/** Advisor statistics for /advisor status command. */
export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};
}

export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Internal marker for hook messages queued through the agent loop */
// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */

type RetryFallbackChains = Record<string, string[]>;

type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

interface ActiveRetryFallbackState {
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

const EPHEMERAL_REPLY_MAX_BYTES = 4096;

/**
 * Collapse degenerate ephemeral replies (/btw, /omfg side-channel turns).
 * Models occasionally loop on a single line (~16 reports of N-times-repeated
 * replies); compress runs longer than 3 down to one instance + `[…N×]`, then
 * cap at 4 KiB so a runaway reply can't flood the channel.
 */
function dedupeEphemeralReply(text: string): string {
	if (!text) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const runLen = j - i;
		if (runLen > 3) {
			out.push(lines[i], `[…${runLen}×]`);
		} else {
			for (let k = 0; k < runLen; k++) out.push(lines[i]);
		}
		i = j;
	}
	let result = out.join("\n");
	if (Buffer.byteLength(result, "utf8") > EPHEMERAL_REPLY_MAX_BYTES) {
		// Trim by characters until we're under the byte budget — handles multi-byte
		// glyphs at the boundary without splitting them.
		const suffix = "\n[…truncated]";
		const budget = EPHEMERAL_REPLY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
		while (Buffer.byteLength(result, "utf8") > budget) {
			result = result.slice(0, -1);
		}
		result += suffix;
	}
	return result;
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
): Record<string, unknown> {
	const userId: Record<string, string> = { session_id: sessionId };
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both omp's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: JSON.stringify(userId) };
}

const noOpUIContext: ExtensionUIContext = {
	select: async (_title, _options, _dialogOptions) => undefined,
	confirm: async (_title, _message, _dialogOptions) => false,
	input: async (_title, _placeholder, _dialogOptions) => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWidget: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	setEditorText: () => {},
	pasteToEditor: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => Promise.resolve([]),
	getTheme: () => Promise.resolve(undefined),
	setTheme: _theme => Promise.resolve({ success: false, error: "UI not available" }),
	setFooter: () => {},
	setHeader: () => {},
	setEditorComponent: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

function createHandoffContext(document: string): string {
	return `<handoff-context>\n${document}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`;
}

function createHandoffFileName(date = new Date()): string {
	const fileTimestamp = date.toISOString().replace(/[:.]/g, "-");
	return `handoff-${fileTimestamp}.md`;
}

// ============================================================================
// ACP Permission Gate
// ============================================================================

/** Tools that require user permission before execution when an ACP client is connected. */
const PERMISSION_REQUIRED_TOOLS = new Set(["bash", "edit", "delete", "move"]);

/** Permission options presented to the client on each gated tool call. */
const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

function formatClientBridgeApprovalDetails(tool: AgentTool, args: unknown, reason?: string): string {
	try {
		return truncateForPrompt(formatApprovalPrompt(tool, args, reason));
	} catch {
		return `Allow tool: ${tool.name}`;
	}
}

function getStringProperty(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const a = args as Record<string, unknown>;

	const edits = Array.isArray(a.edits) ? a.edits : undefined;
	if (edits) {
		const path = getStringProperty(a, "path");
		if (path) {
			for (const edit of edits) {
				if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
				const op = getStringProperty(edit as Record<string, unknown>, "op");
				if (op === "delete") return { kind: "delete", paths: [path] };
			}
		}
		for (const edit of edits) {
			if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
			const entry = edit as Record<string, unknown>;
			const op = getStringProperty(entry, "op");
			const rename = getStringProperty(entry, "rename");
			if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] };
		}
	}

	const input = getStringProperty(a, "input");
	if (input) {
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {
			// If the edit input is not an apply_patch envelope, it is not a delete/move operation.
		}
	}

	return undefined;
}

function getPermissionIntent(
	toolName: string,
	args: unknown,
): { toolName: string; title: string; paths?: string[]; cacheKey: string } | undefined {
	const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	if (toolName === "bash") {
		const cmd = getStringProperty(a, "command")?.slice(0, 80);
		return { toolName, title: cmd || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const p = getStringProperty(a, "path");
		return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName };
	}
	if (toolName === "move") {
		const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from");
		const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === "edit") {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		// ACP locations carry file paths that the editor host will open or focus;
		// they must be absolute or the client cannot resolve them. Resolve raw
		// tool args (often cwd-relative) against the session cwd before sending.
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const p of explicitPaths) {
			pushPath(p);
		}
		return out;
	}
	pushPath(a.path);
	pushPath(a.file);
	for (const p of collectStringPaths(a.paths)) {
		pushPath(p);
	}
	pushPath(a.oldPath);
	pushPath(a.newPath);
	pushPath(a.from);
	pushPath(a.to);
	pushPath(a.source);
	pushPath(a.destination);
	return out;
}

// ============================================================================
// AgentSession Class
// ============================================================================

/** Entry returned by {@link AgentSession.clearQueue} / {@link AgentSession.popLastQueuedMessage}. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	return content.find((part): part is TextContent => part.type === "text")?.text;
}

function queuedImageContent(message: AgentMessage): ImageContent[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	return images.length > 0 ? images : undefined;
}

function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

/**
 * A queued message the user can restore to the editor / pull back as a draft.
 * Only genuinely user-authored messages qualify: plain user turns, or custom
 * messages explicitly attributed to the user (e.g. `/skill` invocations).
 * Agent-authored queued cards — advisor concern/blocker notes, IRC asides,
 * extension notices, hidden goal/plan/budget steers — ride the same
 * steer/follow-up queues but must never be dumped into the editor on Esc/Alt+Up.
 */
function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Custom-message types of the hidden magic-keyword notices that `#createMagicKeywordNotices`
 *  enqueues alongside a user prompt. Keep in sync with that method. */
const MAGIC_KEYWORD_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"ultrathink-notice",
	"orchestrate-notice",
	"workflow-notice",
]);

/** Custom-message type of the hidden companion carrying vision descriptions of image
 *  attachments sent to a text-only model (see `#buildImageDescriptionNotice`). */
const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/**
 * A hidden, user-attributed companion of a queued user prompt: magic-keyword
 * notices and task contracts. It is not editor-restorable; removing its prompt
 * must also remove this stale steering context.
 */
function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES.has(message.customType) ||
			message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE ||
			message.customType === "task-contract-notice")
	);
}

function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	return queuedImageContent(message) ? "[Image]" : "";
}

function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return { text: queueChipText(message), images: queuedImageContent(message) };
}

function appendTraceSection(summary: string, traceMarkdown: string): string {
	if (summary.includes("## Trace")) return summary;
	return `${summary.trimEnd()}\n\n${traceMarkdown}`;
}

interface ActiveCompiledTaskContract {
	readonly contract: TaskContractV1;
	readonly digest: string;
	readonly executorBlock: InjectionBlock;
	readonly advisorBlock: InjectionBlock;
	readonly gaps: readonly ContractGap[];
	readonly assumptions: readonly AssumptionRecord[];
	readonly pendingClarification?: QuestionSpec;
	readonly clarificationAnswered: boolean;
	readonly unresolvedBlocked: boolean;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly yieldQueue: YieldQueue;
	fileSnapshotStore?: InMemorySnapshotStore;
	#autoApprove: boolean;

	#powerAssertion: MacOSPowerAssertion | undefined;

	readonly configWarnings: string[] = [];

	#scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Effective, metadata-clamped thinking level applied to the agent (never `auto`). */
	#thinkingLevel: ThinkingLevel | undefined;
	/** True when the user configured `auto`; the effective level is resolved per turn. */
	#autoThinking: boolean = false;
	/** The level `auto` last resolved to (for UI); undefined until a turn is classified. */
	#autoResolvedLevel: Effort | undefined;
	#promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];

	// Event subscription state
	#unsubscribeAgent?: () => void;
	#unsubscribeAppendOnly?: () => void;
	/** Last (enable, providerId) tuple resolved by `#syncAppendOnlyContext` — used to skip no-op invalidations. */
	#lastAppendOnlyResolution?: { enable: boolean; providerId: string | undefined };
	#eventListeners: AgentSessionEventListener[] = [];
	#commandMetadataChangedListeners: CommandMetadataChangedListener[] = [];

	/** Messages queued to be included with the next user prompt as context ("asides"). */
	#pendingNextTurnMessages: CustomMessage[] = [];
	#scheduledHiddenNextTurnGeneration: number | undefined = undefined;
	#queuedMessageDrainScheduled = false;
	/** Latched true when the user deliberately interrupts (USER_INTERRUPT_LABEL);
	 *  suppresses advisor concern/blocker auto-resume until the user next resumes.
	 *  Advisor advice is still recorded into the transcript, just not auto-run. */
	#advisorAutoResumeSuppressed = false;
	#advisorPrimaryTurnsCompleted = 0;
	#advisorInterruptImmuneTurnStart: number | undefined;
	#planModeState: PlanModeState | undefined;
	#goalModeState: GoalModeState | undefined;
	#goalRuntime: GoalRuntime;
	#fusionSidekickId: string | undefined;
	#fusionCompactionSwitched = false;
	/** Original frontier model captured before the first automated Fusion switch (dynamic routing). */
	#fusionBaseModel: Model | undefined;
	/** Model last set by automated Fusion routing; a mismatch with the live model means the user switched manually. */
	#fusionLastAutoModel: Model | undefined;
	/** Latched off once the user manually overrides an automated Fusion switch. */
	#fusionRoutingDisabled = false;
	/** Consecutive failed tool results on this session; fuels the Fusion failure-streak escalation. */
	#fusionToolFailureStreak = 0;
	#advisorRuntime?: AdvisorRuntime;
	#cacheAttribution = new CacheAttributionTracker({
		onTrace: trace => {
			if (trace.broke) {
				logger.debug("Prompt cache break", {
					model: trace.model,
					causes: trace.causes,
					rewriteReason: trace.rewriteReason,
					firstDivergence: trace.firstDivergence,
					hitRatio: trace.hitRatio === undefined ? undefined : Number(trace.hitRatio.toFixed(3)),
					previousPromptTokens: trace.previousPromptTokens,
					cacheReadTokens: trace.cacheReadTokens,
					cacheWriteTokens: trace.cacheWriteTokens,
					promptTokens: trace.promptTokens,
				});
			}
		},
	});
	#advisorEnabled = false;
	/** Screenpipe activity-bridge manager; built when `screenpipe.enabled` is on, re-bound on
	 *  every session transition, torn down in dispose. Undefined when the feature is off. */
	#screenpipeManager?: ScreenpipeSessionManager;
	/** Resolves once the (dynamically imported) manager has been constructed. Set only when the
	 *  feature is enabled; dispose and session re-binds await it so a slow start cannot leak the poller. */
	#screenpipeManagerReady?: Promise<void>;
	/** Session file minted empty by /move; cleaned up at dispose if it never gained real messages. */
	#movedFromEmptySessionFile?: string;
	/** Provenance set of built-in tool names in the registry (see AgentSessionConfig.builtInToolNames). */
	#builtInToolNames: ReadonlySet<string> = new Set();
	/** Custom stream function for the advisor agent, when the host injects one. */
	#advisorStreamFn?: StreamFn;
	#transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	/** The advisor's own agent, retained so `/dump advisor` can serialize its transcript. Undefined when no advisor is active. */
	#advisorAgent?: Agent;
	#advisorReadOnlyTools?: AgentTool[];
	#advisorWatchdogPrompt?: string;
	#activeTaskContract?: ActiveTaskContractSnapshot;
	/** Ephemeral compiled root contract, adapted into the shared completion-gate snapshot. */
	#activeCompiledTaskContract?: ActiveCompiledTaskContract;
	#taskContractActivatedAt?: number;
	#completionGateReminderCount = 0;
	#completionGateAwaitingProgress = false;
	#approachRegistry = new ApproachRegistry();
	#orchestrationTelemetry: OrchestrationTelemetrySink = createOrchestrationTelemetrySink();
	#advisorYieldQueueUnsubscribe?: () => void;
	/** Persists the advisor agent's turns to `<session>/__advisor.jsonl` for stats
	 *  attribution and Agent Hub observability. Undefined when no advisor is active. */
	#advisorTranscriptRecorder?: AdvisorTranscriptRecorder;
	/** Unsubscribe for the advisor agent's event stream feeding the recorder. */
	#advisorAgentUnsubscribe?: () => void;
	#moaLaneLabels: readonly string[] = [];
	/** Latest advisor-recorder close, awaited by dispose() so the final turn lands on disk. */
	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	#goalTurnCounter = 0;
	#planReferenceSent = false;
	#planReferencePath = "local://PLAN.md";
	#clientBridge: ClientBridge | undefined;
	#allowAcpAgentInitiatedTurns = false;
	/** Per-session memory of allow_always / reject_always decisions for gated tools. */
	#acpPermissionDecisions: Map<string, "allow_always" | "reject_always"> = new Map();
	/** Ephemeral ceiling applied to every runtime active-tool mutation (e.g. Ask mode). */
	#activeToolCeiling: ReadonlySet<string> | undefined;
	/**
	 * Serializes `#applyActiveToolsByName` runs. Concurrent applies race across
	 * the awaited system-prompt rebuild: a wide apply started before a ceiling
	 * was installed could commit `agent.setTools` AFTER the ceiling-restricted
	 * apply, silently re-widening Ask mode. Chaining makes each apply observe
	 * the ceiling state left by the previous one.
	 */
	#applyActiveToolsChain: Promise<void> = Promise.resolve();
	/** Serializes discovery selection so concurrent searches cannot bypass the schema budget. */
	#discoveredToolActivationChain: Promise<void> = Promise.resolve();

	// Compaction state
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	// Branch summarization state
	#branchSummaryAbortController: AbortController | undefined = undefined;

	// Handoff state
	#handoffAbortController: AbortController | undefined = undefined;
	#skipPostTurnMaintenanceAssistantTimestamp: number | undefined = undefined;

	// Retry state
	#retryAbortController: AbortController | undefined = undefined;
	#retryAttempt = 0;
	#retryPromise: Promise<void> | undefined = undefined;
	#retryResolve: (() => void) | undefined = undefined;
	#activeRetryFallback: ActiveRetryFallbackState | undefined = undefined;
	// Todo completion reminder state
	#todoReminderCount = 0;
	/**
	 * Set true after a todo reminder is appended; cleared when the agent makes any tool-level
	 * progress (toolResult) or a new user prompt arrives. Suppresses follow-up reminders within
	 * the same agent self-continuation chain so a text-only acknowledgement ("paused at your
	 * instruction") does not drive 1/3 → 2/3 → 3/3 without user input.
	 */
	#todoReminderAwaitingProgress = false;
	#todoPhases: TodoPhase[] = [];
	#toolChoiceQueue = new ToolChoiceQueue();

	// Bash execution state
	#bashAbortControllers = new Set<AbortController>();
	#pendingBashMessages: BashExecutionMessage[] = [];

	// Python execution state
	#evalAbortControllers = new Set<AbortController>();
	#evalKernelOwnerId: string;
	#parentEvalSessionId: string | undefined;
	/**
	 * Process AsyncJobManager owned only by the root that created the singleton.
	 * Sharing roots and subagents leave this undefined and cannot dispose it.
	 */
	readonly #ownedAsyncJobManager: AsyncJobManager | undefined;
	/** Shared manager used with this session's agent id as the owner scope. */
	readonly #asyncJobManager: AsyncJobManager | undefined;
	#pendingPythonMessages: PythonExecutionMessage[] = [];
	#activeEvalExecutions = new Set<Promise<unknown>>();
	#evalExecutionDisposing = false;

	// Incoming IRC messages received while a turn was streaming; drained as
	// non-interrupting asides at the next step boundary (see the aside provider).
	#pendingIrcAsides: CustomMessage[] = [];
	// Agent identity (registry id) used for IRC routing and job ownership.
	#agentId: string | undefined;
	#agentKind: "main" | "sub" = "main";
	#collaborationPolicy: CollaborationPolicy | undefined;
	#toolProfile: ResolvedToolProfile | undefined;
	#toolSourceOf: ((name: string) => ToolSource | undefined) | undefined;
	#providerSessionId: string | undefined;
	#freshProviderSessionId: string | undefined;
	#isDisposed = false;
	// Extension system
	#extensionRunner: ExtensionRunner | undefined = undefined;
	#turnIndex = 0;

	#skills: Skill[];
	#skillWarnings: SkillWarning[];
	/** Re-discovers skills from disk for `reloadSkills()`; absent when the caller supplied explicit `options.skills`. */
	#reloadSkillsDiscovery: (() => Promise<{ skills: Skill[]; warnings?: SkillWarning[] }>) | undefined;
	/** Notifies the SDK layer so the prompt-closure snapshot and the process-global active-skills stay in sync. */
	#onSkillsChanged: ((skills: Skill[]) => void) | undefined;

	// Custom commands (TypeScript slash commands)
	#customCommands: LoadedCustomCommand[] = [];
	/** MCP prompt commands (updated dynamically when prompts are loaded) */
	#mcpPromptCommands: LoadedCustomCommand[] = [];

	#skillsSettings: SkillsSettings | undefined;

	// Model registry for API key resolution
	#modelRegistry: ModelRegistry;

	// Tool registry and prompt builder for extensions
	#toolRegistry: Map<string, AgentTool>;
	#transformContext: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	#onPayload: SimpleStreamOptions["onPayload"] | undefined;
	#onResponse: SimpleStreamOptions["onResponse"] | undefined;
	#onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	#convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	#rebuildSystemPrompt:
		| ((toolNames: string[], tools: Map<string, AgentTool>) => Promise<{ systemPrompt: string[] }>)
		| undefined;
	#getMcpServerInstructions: (() => Map<string, string> | undefined) | undefined;
	#reloadSshTool: (() => Promise<AgentTool | null>) | undefined;
	#disconnectOwnedMcpManager: (() => Promise<void>) | undefined;
	#requestedToolNames: ReadonlySet<string> | undefined;
	#baseSystemPrompt: string[];
	/**
	 * First-turn memory block promoted into the stable prompt. Once a memory
	 * backend injects recall via `beforeAgentStartPrompt`, later turns must keep
	 * that segment byte-identical or the provider prompt-cache prefix (and any
	 * append-only context) is invalidated. Cleared on every session-identity
	 * transition (new/switch/branch/fork/handoff) alongside the backends'
	 * conversation-tracking resets.
	 */
	#promotedMemoryPrompt: string | undefined;
	/**
	 * Signature of the (toolNames, tool descriptions) tuple passed to the most
	 * recent successful `rebuildSystemPrompt` call. Used to skip redundant rebuilds
	 * when MCP servers reconnect without changing their tool definitions, which is
	 * the dominant cause of prompt-cache invalidation in long sessions.
	 */
	#lastAppliedToolSignature: string | undefined;
	/**
	 * Model identifier (`provider/id`) currently rendered into `#baseSystemPrompt`.
	 * The prompt surfaces the active model to the agent, so a model switch must
	 * trigger a rebuild. Compared against the live model after every model change
	 * to decide whether the cached prompt is stale.
	 */
	#promptModelKey: string | undefined;
	#mcpDiscoveryEnabled = false;
	#discoverableMCPTools = new Map<string, DiscoverableTool>();
	#selectedMCPToolNames = new Set<string>();
	// Generic tool discovery (covers built-in + MCP + extension when tools.discoveryMode === "all")
	#discoverableToolSearchIndex: DiscoverableToolSearchIndex | null = null;
	#selectedDiscoveredToolNames = new Set<string>();
	/** Tools activated by search discovery during the current user turn.
	 *  They stay callable for the turn's tool loop, then leave the next turn's schema. */
	#turnDiscoveredToolNames = new Set<string>();
	#rpcHostToolNames = new Set<string>();
	#xdevRegistry: XdevRegistry | undefined;
	#defaultSelectedMCPServerNames = new Set<string>();
	#defaultSelectedMCPToolNames = new Set<string>();
	#sessionDefaultSelectedMCPToolNames = new Map<string, string[]>();

	// TTSR manager for time-traveling stream rules
	#ttsrManager: TtsrManager | undefined = undefined;
	#pendingTtsrInjections: Rule[] = [];
	/** Per-tool TTSR rules whose `interruptMode` opted out of aborting the stream.
	 *  These are folded into the matched tool call's `toolResult` content as an
	 *  in-band system reminder, instead of spawning a separate follow-up turn. */
	#perToolTtsrInjections = new Map<string, Rule[]>();
	#ttsrAbortPending = false;
	#ttsrRetryToken = 0;
	#ttsrResumePromise: Promise<void> | undefined = undefined;
	#ttsrResumeResolve: (() => void) | undefined = undefined;

	/** One-shot flag for expected internal plan-mode aborts. Approval actions may
	 *  abort the post-`resolve` continuation before compaction, execution, or
	 *  manual refinement. Consumed inside `#handleAgentEvent` for the matching
	 *  `message_end` + `stopReason: "aborted"`; callers clear it in `finally` so
	 *  it cannot leak into later unrelated aborts. */
	#planInternalAbortPending = false;

	#postPromptTasks = new Set<Promise<unknown>>();
	#postPromptTasksPromise: Promise<void> | undefined = undefined;
	#postPromptTasksResolve: (() => void) | undefined = undefined;
	#postPromptTasksAbortController = new AbortController();

	#streamingEditAbortTriggered = false;
	#streamingEditCheckedLineCounts = new Map<string, number>();

	#streamingEditPrecheckedToolCallIds = new Set<string>();

	#streamingEditFileCache = new Map<string, string>();
	#promptInFlightCount = 0;
	#abortInProgress = false;
	// Wire-level agent_end emission deferred until #promptInFlightCount drops to 0.
	// Internal extension hooks and post-emit work (auto-retry, auto-compaction, todo
	// checks in #handleAgentEvent) still fire on the original schedule — only the
	// `#emit(event)` that reaches external subscribers (rpc-mode stdout, ACP bridge,
	// Cursor exec, TUI listeners) is held back. Without this, a client that resumes
	// on `agent_end` can fire its next `prompt` before #promptWithMessage's finally
	#emptyStopRetryCount = 0;
	#unexpectedStopRetryCount = 0;
	#promptGeneration = 0;
	#pendingAgentEndEmit: AgentSessionEvent | undefined;
	#pendingContextSnapshot:
		| {
				promptTokens: number;
				nonMessageTokens: number;
				cutoffCount: number;
		  }
		| undefined = undefined;
	#sessionStopContinuationCount = 0;
	#sessionStopHookActive = false;
	// Bumped whenever the pending in-flight snapshot is set/cleared. The
	// status-line context memo includes this so clearing the snapshot on
	// turn-end/abort invalidates the cache even though the message list is
	// unchanged — otherwise a mid-turn estimate would survive into idle.
	#contextUsageRevision = 0;
	#obfuscator: SecretObfuscator | undefined;
	/** Session-start value of `inlineToolDescriptors`; drives handoff tool pruning. */
	#pruneToolDescriptions = false;
	#checkpointState: CheckpointState | undefined = undefined;
	#pendingRewindReport: string | undefined = undefined;
	#lastSuccessfulYieldToolCallId: string | undefined = undefined;
	#providerSessionState = new Map<string, ProviderSessionState>();
	#hindsightSessionState: HindsightSessionState | undefined = undefined;
	readonly rawSseDebugBuffer: RawSseDebugBuffer;

	#acquirePowerAssertion(): void {
		if (process.platform !== "darwin") return;
		if (isBunTestRuntime()) return;
		if (this.#powerAssertion) return;
		const mode = this.settings.get("power.sleepPrevention");
		if (mode === "off") return;
		try {
			this.#powerAssertion = MacOSPowerAssertion.start({
				reason: "Oh My Pi agent session",
				idle: true,
				display: mode === "display" || mode === "system",
				system: mode === "system",
				user: mode === "system",
			});
		} catch (error) {
			logger.warn("Failed to acquire macOS power assertion", { error: String(error) });
		}
	}

	#releasePowerAssertion(): void {
		const assertion = this.#powerAssertion;
		this.#powerAssertion = undefined;
		if (!assertion) return;
		try {
			assertion.stop();
		} catch (error) {
			logger.warn("Failed to release macOS power assertion", { error: String(error) });
		}
	}

	#beginInFlight(): void {
		this.#promptInFlightCount++;
		if (this.#promptInFlightCount === 1) {
			this.#acquirePowerAssertion();
		}
	}

	#endInFlight(): void {
		this.#promptInFlightCount = Math.max(0, this.#promptInFlightCount - 1);
		if (this.#promptInFlightCount === 0) {
			this.#releasePowerAssertion();
			this.#flushPendingAgentEnd();
			this.#drainStrandedQueuedMessages();
		}
	}

	/** A steer/follow-up can land after the agent loop's final queue poll, or
	 *  after an abort stops an auto-continued queued turn. In both cases the
	 *  agent-core queue still owns the message, but no loop is left to poll it.
	 *  Runs whenever the session settles; the guard makes it a no-op when the
	 *  queue was consumed normally or a new turn already started. */
	#drainStrandedQueuedMessages(): void {
		if (this.#abortInProgress) return;
		// A concern steered into a resumed streaming run after a user interrupt can
		// strand at the turn tail (steered past the loop's final boundary poll). While
		// that interrupt's suppression is still in effect, reclaim such advisor steers
		// as visible advice once idle — mirroring abort's #extractQueuedAdvisorCards —
		// so they neither auto-resume the run the user stopped (a non-empty steer queue
		// otherwise bypasses the latch in #canAutoContinueForFollowUp) nor linger to
		// flush at the next prompt. Real user steers/follow-ups are left untouched.
		if (this.#advisorAutoResumeSuppressed && !this.isStreaming) {
			for (const card of this.#extractQueuedAdvisorCards()) {
				this.#preserveAdvisorCard(card);
			}
		}
		this.#scheduleQueuedMessageDrain();
		this.#resumeStrandedIrcAsides();
	}

	/** IRC asides that arrive after the loop's final aside poll — or while an abort skipped that
	 *  poll — land in #pendingIrcAsides with no loop left to drain them; the queued-message drain's
	 *  gate (agent.hasQueuedMessages()) does not count them. Once idle, wake a turn so the agent
	 *  responds to the peer. Skip only when a queued steer/follow-up will itself drive a resume turn
	 *  whose aside poll already consumes these (no double-wake). */
	#resumeStrandedIrcAsides(): void {
		if (this.#isDisposed || this.isStreaming) return;
		if (this.#pendingIrcAsides.length === 0) return;
		if (this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages()) return;
		const records = this.#pendingIrcAsides;
		const wakeable = records.filter(record => {
			const details = record.details;
			const from =
				typeof details === "object" && details !== null && "from" in details && typeof details.from === "string"
					? details.from
					: undefined;
			return from ? this.#allowsIrcWake(from) : this.#collaborationPolicy === undefined;
		});
		if (wakeable.length === 0) return;
		this.#pendingIrcAsides = records.filter(record => !wakeable.includes(record));
		this.#wakeForIrc(wakeable);
	}

	/** Fire-and-forget wake turn for incoming IRC — idle delivery and stranded-aside resume both
	 *  route here. Wrapped in #beginInFlight/#endInFlight so the turn is tracked and its settle
	 *  re-drains anything that stranded during it. A user interrupt may have intentionally left a
	 *  follow-up queued behind an invalid tail (seam #5); the wake turn's loop would otherwise drain
	 *  it, so park the follow-up queue across the wake and restore it after. It stays queued post-wake
	 *  because #canAutoContinueForFollowUp suppresses follow-up auto-resume while a user interrupt is
	 *  in effect, even though the wake left a provider-valid tail. */
	#wakeForIrc(records: CustomMessage[]): void {
		// Park only a *blocked* follow-up (one a user interrupt is intentionally holding); an
		// already-resumable follow-up can ride the wake turn normally without reordering.
		const parkedFollowUps =
			this.agent.peekSteeringQueue().length === 0 &&
			this.agent.peekFollowUpQueue().length > 0 &&
			!this.#canAutoContinueForFollowUp()
				? [...this.agent.peekFollowUpQueue()]
				: [];
		if (parkedFollowUps.length > 0) {
			this.agent.replaceQueues([...this.agent.peekSteeringQueue()], []);
		}
		this.#beginInFlight();
		void this.agent
			.prompt(records)
			.catch(error => {
				logger.warn("IRC wake turn failed", { error: String(error) });
			})
			.finally(() => {
				if (parkedFollowUps.length > 0) {
					this.agent.replaceQueues(
						[...this.agent.peekSteeringQueue()],
						[...parkedFollowUps, ...this.agent.peekFollowUpQueue()],
					);
				}
				this.#endInFlight();
			});
	}

	/** Remove advisor concern/blocker cards from the agent-core steer/follow-up
	 *  queues and return them. Used on a deliberate user interrupt so the post-abort
	 *  stranded-message drain cannot auto-resume the run on an advisor card that was
	 *  steered in just before the user stopped; real user follow-ups stay queued.
	 *  Synchronous and await-free so it runs before the abort path polls the queue. */
	#extractQueuedAdvisorCards(): CustomMessage[] {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const cards = [...steering, ...followUp].filter(isAdvisorCard);
		if (cards.length === 0) return [];
		this.agent.replaceQueues(
			steering.filter(m => !isAdvisorCard(m)),
			followUp.filter(m => !isAdvisorCard(m)),
		);
		return cards;
	}

	/** Record a suppressed advisor concern as visible, persisted advice without
	 *  triggering a turn. When the agent is idle (the normal post-interrupt case,
	 *  including the post-prompt unwind window where the core loop has ended), emit
	 *  message_start/message_end like #flushPendingIrcAsides so #handleAgentEvent
	 *  renders it live (TUI/ACP) and persists it as a CustomMessageEntry. Only while
	 *  an abort is still tearing a live turn down do we park it hidden, so abort's
	 *  settle step replays it once idle — never appended into a live streamMessage. */
	#preserveAdvisorCard(card: CustomMessage): void {
		if (this.#abortInProgress && this.isStreaming) {
			this.#pendingNextTurnMessages.push(card);
			return;
		}
		this.agent.emitExternalEvent({ type: "message_start", message: card });
		this.agent.emitExternalEvent({ type: "message_end", message: card });
	}

	#resetInFlight(): void {
		this.#promptInFlightCount = 0;
		this.#releasePowerAssertion();
		this.#flushPendingAgentEnd();
		this.#drainStrandedQueuedMessages();
	}

	#flushPendingAgentEnd(): void {
		const pending = this.#pendingAgentEndEmit;
		if (!pending) return;
		this.#pendingAgentEndEmit = undefined;
		this.#emit(pending);
	}

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.agent.setCacheAttribution(this.#cacheAttribution);
		this.sessionManager = config.sessionManager;
		this.settings = config.settings;
		this.#autoApprove = config.autoApprove === true;
		// Power assertions are taken per turn (see #beginInFlight); nothing acquired here.
		this.#evalKernelOwnerId = config.evalKernelOwnerId ?? `agent-session:${Snowflake.next()}`;
		this.#parentEvalSessionId = config.parentEvalSessionId;
		this.#ownedAsyncJobManager = config.ownedAsyncJobManager;
		this.#asyncJobManager = config.asyncJobManager ?? config.ownedAsyncJobManager;
		this.#scopedModels = config.scopedModels ?? [];
		if (config.thinkingLevel === AUTO_THINKING) {
			// `auto` is session-level: keep the flag and show a provisional concrete
			// level (the agent's initial effort was already set by the caller) until
			// the first user turn is classified.
			this.#autoThinking = true;
			this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
		} else {
			this.#thinkingLevel = config.thinkingLevel;
		}
		this.#applyThinkingLevelToAgent(this.#thinkingLevel);
		this.#promptTemplates = config.promptTemplates ?? [];
		this.#slashCommands = config.slashCommands ?? [];
		this.#extensionRunner = config.extensionRunner;
		this.#skills = config.skills ?? [];
		this.#skillWarnings = config.skillWarnings ?? [];
		this.#reloadSkillsDiscovery = config.reloadSkills;
		this.#onSkillsChanged = config.onSkillsChanged;
		this.#customCommands = config.customCommands ?? [];
		this.#skillsSettings = config.skillsSettings;
		this.#modelRegistry = config.modelRegistry;
		this.#advisorReadOnlyTools = config.advisorReadOnlyTools;
		this.#advisorWatchdogPrompt = config.advisorWatchdogPrompt;
		this.#pruneToolDescriptions = config.pruneToolDescriptions === true;
		this.#validateRetryFallbackChains();
		this.#toolRegistry = config.toolRegistry ?? new Map();
		this.#builtInToolNames = new Set(config.builtInToolNames ?? []);
		this.#advisorStreamFn = config.advisorStreamFn;
		this.#transformProviderContext = config.transformProviderContext;
		this.#requestedToolNames = config.requestedToolNames;
		this.#moaLaneLabels = config.moa?.laneLabels ?? [];
		this.#transformContext = config.transformContext ?? (messages => messages);
		this.#onPayload = config.onPayload;
		this.rawSseDebugBuffer = config.rawSseDebugBuffer ?? new RawSseDebugBuffer();
		// Avoid wrapping in an `async` closure when no user callback is configured: the
		// outer await on `#onResponse` (provider-response.ts) tolerates a sync void return,
		// and skipping the wrapper drops a per-event `newPromiseCapability` allocation that
		// shows up as ~3.5% self time in streaming profiles.
		const configuredOnResponse = config.onResponse;
		this.#onResponse = configuredOnResponse
			? async (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#ingestProviderUsageHeaders(response, model);
					await configuredOnResponse(response, model);
				}
			: (response, model) => {
					this.rawSseDebugBuffer.recordResponse(response, model);
					this.#ingestProviderUsageHeaders(response, model);
				};
		const configuredOnSseEvent = config.onSseEvent;
		this.#onSseEvent = configuredOnSseEvent
			? (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
					configuredOnSseEvent(event, model);
				}
			: (event, model) => {
					this.rawSseDebugBuffer.recordEvent(event, model);
				};
		this.agent.setProviderResponseInterceptor(this.#onResponse);
		this.agent.setRawSseEventInterceptor(this.#onSseEvent);
		this.agent.setOnTurnEnd(async (messages, signal, context) => {
			if (signal?.aborted) return;
			this.#advisorPrimaryTurnsCompleted++;
			if (this.#advisorRuntime && !this.#advisorRuntime.disposed) {
				this.#advisorRuntime.onTurnEnd(messages);
				const syncBacklog = this.settings.get("advisor.syncBacklog");
				if (syncBacklog !== "off") {
					const threshold = parseInt(syncBacklog, 10);
					await this.#advisorRuntime.waitForCatchup(30000, threshold, signal);
				}
			}
			await this.#maybeApplyRewindMidRun(messages, signal, context);
			await this.#maybeCompactMidTurn(messages, signal, context);
		});
		this.yieldQueue = new YieldQueue({
			isStreaming: () => this.isStreaming,
			injectIdle: async messages => {
				const first = messages[0];
				if (!first) return;
				await this.agent.prompt(messages.length === 1 ? first : messages);
			},
			scheduleIdleFlush: run => {
				this.#schedulePostPromptTask(
					async () => {
						await run();
					},
					{ delayMs: 1 },
				);
			},
		});
		// Background-job completions / late diagnostics are pulled into the run at
		// each step boundary as non-interrupting asides (see Agent.getAsideMessages),
		// so they reach the model between requests without waiting for a yield.
		this.agent.setAsideMessageProvider(() => {
			const pendingIrc = this.#pendingIrcAsides;
			this.#pendingIrcAsides = [];
			const thunks: AsideMessage[] = pendingIrc.map(record => () => record);
			thunks.push(...this.yieldQueue.drainLazy());
			return thunks;
		});
		this.#convertToLlm = config.convertToLlm ?? convertToLlm;
		this.#rebuildSystemPrompt = config.rebuildSystemPrompt;
		this.#getMcpServerInstructions = config.getMcpServerInstructions;
		this.#reloadSshTool = config.reloadSshTool;
		this.#disconnectOwnedMcpManager = config.disconnectOwnedMcpManager;
		this.#baseSystemPrompt = this.agent.state.systemPrompt;
		this.#promptModelKey = this.#currentPromptModelKey();
		this.#mcpDiscoveryEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
		this.#selectedMCPToolNames = new Set(config.initialSelectedMCPToolNames ?? []);
		this.#defaultSelectedMCPServerNames = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultSelectedMCPToolNames = new Set(config.defaultSelectedMCPToolNames ?? []);
		this.#pruneSelectedMCPToolNames();
		const persistedSelectedMCPToolNames = this.buildDisplaySessionContext().selectedMCPToolNames;
		const currentSelectedMCPToolNames = this.getSelectedMCPToolNames();
		const persistInitialMCPToolSelection =
			config.persistInitialMCPToolSelection ?? this.sessionManager.getBranch().length === 0;
		if (
			this.#mcpDiscoveryEnabled &&
			persistInitialMCPToolSelection &&
			!this.#selectedMCPToolNamesMatch(persistedSelectedMCPToolNames, currentSelectedMCPToolNames)
		) {
			this.sessionManager.appendMCPToolSelection(currentSelectedMCPToolNames);
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionManager.getSessionFile(),
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		this.#ttsrManager = config.ttsrManager;
		this.#obfuscator = config.obfuscator;
		this.#agentId = config.agentId;
		this.#agentKind = config.agentKind ?? "main";
		this.#collaborationPolicy = config.collaborationPolicy;
		this.#toolProfile = config.toolProfile;
		this.#toolSourceOf = config.toolSourceOf;
		this.#reconcileXdevRegistry();
		this.#providerSessionId = config.providerSessionId;
		this.agent.setAssistantMessageEventInterceptor((message, assistantMessageEvent) => {
			this.#watchGeminiHeaderRunaway(assistantMessageEvent);
			const event: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent,
			};
			this.#preCacheStreamingEditFile(event);
			this.#maybeAbortStreamingEdit(event);
		});
		// Per-tool TTSR reminders are folded into the matched tool's result via this hook.
		this.agent.afterToolCall = ctx => this.#ttsrAfterToolCall(ctx);
		this.agent.providerSessionState = this.#providerSessionState;
		this.#syncAgentSessionId();
		this.#syncTodoPhasesFromBranch();
		this.#goalRuntime = new GoalRuntime({
			getState: () => this.#goalModeState,
			setState: state => {
				this.#goalModeState = state;
			},
			getCurrentUsage: () => {
				const usage = this.getSessionStats().tokens;
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				};
			},
			emit: event => {
				if (event.type === "goal_updated") {
					return this.#emitSessionEvent({ type: "goal_updated", goal: event.goal, state: event.state });
				}
			},
			persist: (mode, state) => {
				if (mode === "none") {
					this.sessionManager.appendModeChange("none");
				} else if (state) {
					this.sessionManager.appendModeChange(mode, { goal: state.goal });
				}
			},
			sendHiddenMessage: async message => {
				await this.sendCustomMessage(
					{
						customType: message.customType,
						content: message.content,
						display: false,
						attribution: "agent",
					},
					{ deliverAs: message.deliverAs },
				);
			},
		});

		this.#advisorEnabled = this.settings.get("advisor.enabled") as boolean;
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();

		if (this.settings.get("screenpipe.enabled") as boolean) this.#startScreenpipeBridge();

		// Note: gopk-clips activity ingestion is deliberately NOT started here.
		// The always-on `gopk-ingest` daemon is the single consumer of the
		// journal-handoff queue and the single writer of the activity ledger;
		// a session-scoped second consumer would race it on file deletion and
		// contend for the SQLite write lock. Sessions read the ledger instead.

		// Always subscribe to agent events for internal handling
		// (session persistence, hooks, auto-compaction, retry logic)
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
		// Re-evaluate append-only context mode when the setting changes at runtime.
		this.#unsubscribeAppendOnly = onAppendOnlyModeChanged(_value => this.#syncAppendOnlyContext(this.model));
		if (config.clientBridge) this.setClientBridge(config.clientBridge);
	}

	// A broken bridge (unwritable agent dir, corrupt ledger) must never stop
	// the session from starting — the bridge is a passive, opt-in observer.
	// Loaded dynamically: the bridge stack lives in private workspace packages
	// (devDependencies), so a static import would make every library consumer
	// of this module resolve packages that are never published.
	#startScreenpipeBridge(): void {
		const mediaRoot = this.settings.get("screenpipe.mediaRoot") as string | undefined;
		const config = {
			baseUrl: this.settings.get("screenpipe.baseUrl") as string,
			pollIntervalMs: this.settings.get("screenpipe.pollIntervalMs") as number,
			...(mediaRoot ? { mediaRoot } : {}),
		};
		this.#screenpipeManagerReady = import("../screenpipe/session-state")
			.then(({ createScreenpipeSessionManager }) => {
				this.#screenpipeManager = createScreenpipeSessionManager(config);
				// Bind to whatever session is current now — the id may have advanced
				// while this dynamic import was in flight.
				return this.#screenpipeManager.syncTo(this.sessionId);
			})
			.catch(error => {
				logger.warn("Failed to start screenpipe activity bridge", { error: String(error) });
			});
	}

	// Re-bind screenpipe capture to the current session id. Fire-and-forget: the
	// manager serializes transitions and disposes the old bridge before the new
	// one, so no post-transition activity is attributed to the prior session and
	// only one poller is ever live. Guarded on `#screenpipeManagerReady` so it is
	// a no-op when the feature is disabled, and chained after startup so a
	// transition racing the manager's dynamic import still re-binds.
	#rekeyScreenpipeForCurrentSessionId(): void {
		const ready = this.#screenpipeManagerReady;
		if (!ready) return;
		const sessionId = this.sessionId;
		void ready.then(() => this.#screenpipeManager?.syncTo(sessionId));
	}

	// -------------------------------------------------------------------------
	// Advisor runtime lifecycle
	// -------------------------------------------------------------------------
	#advisorImmuneTurnLimit(): number {
		const immuneTurns = this.settings.get("advisor.immuneTurns") as number;
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isAdvisorInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#advisorPrimaryTurnsCompleted,
			immuneTurnStart: this.#advisorInterruptImmuneTurnStart,
			immuneTurns: this.#advisorImmuneTurnLimit(),
		});
	}

	// The next primary turn number starts the immune-turn window. While the
	// interrupting steer is still in flight, completedTurns is lower than this
	// start, so duplicate concern/blocker advice is also downgraded.
	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window
	 * (`#advisorPrimaryTurnsCompleted`, `#advisorInterruptImmuneTurnStart`) and the
	 * user-interrupt auto-resume suppression flag. It also drops advisor deliveries
	 * still queued against the prior conversation — pending asides in the yield
	 * queue (advisor entries use `skipIdleFlush`, so they linger until the next
	 * `drainLazy` rather than self-flushing), interrupting cards parked in the
	 * agent steer/follow-up queues, and preserved cards deferred to the next turn —
	 * so none of them inject into the new conversation.
	 */
	#resetAdvisorSessionState(): void {
		// Mute the recorder across the re-prime: AdvisorRuntime.reset() aborts the advisor
		// loop, and that abort can emit an `aborted` message_end we must not attribute to
		// either session's transcript. Detach, reset, then re-attach the live agent's feed.
		this.#advisorAgentUnsubscribe?.();
		this.#advisorAgentUnsubscribe = undefined;
		this.#advisorRuntime?.reset();
		this.#attachAdvisorRecorderFeed();
		this.#advisorPrimaryTurnsCompleted = 0;
		this.#advisorInterruptImmuneTurnStart = undefined;
		this.#advisorAutoResumeSuppressed = false;
		this.yieldQueue.clear("advisor");
		this.#extractQueuedAdvisorCards();
		if (this.#pendingNextTurnMessages.some(isAdvisorCard)) {
			this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
		}
	}
	/**
	 * Reset all per-session Fusion state so a new session starts with a clean slate.
	 * Called when switching to a different session; prevents fusion routing latch,
	 * compaction-switch state, failure streak, and sidekick id from leaking across
	 * sessions. If the old session had a tracked sidekick, release it before
	 * clearing the id so Agent Hub does not accumulate stale Sidekick refs.
	 */
	async #resetFusionState(): Promise<void> {
		const staleId = this.#fusionSidekickId;
		if (staleId && AgentRegistry.global().get(staleId)) {
			try {
				await AgentLifecycleManager.global().release(staleId);
			} catch (error) {
				logger.warn("Fusion sidekick release failed during session switch", {
					id: staleId,
					error: String(error),
				});
			}
		}
		this.#fusionSidekickId = undefined;
		this.#fusionBaseModel = undefined;
		this.#fusionCompactionSwitched = false;
		this.#fusionRoutingDisabled = false;
		this.#fusionLastAutoModel = undefined;
		this.#fusionToolFailureStreak = 0;
	}

	#buildAdvisorRuntime(seedToCurrent = false): boolean {
		if (this.#isDisposed) return false;
		if (this.#advisorRuntime) return true;
		if (!this.#advisorEnabled) return false;
		if (this.#agentKind !== "main" && !this.settings.get("advisor.subagents")) return false;

		const advisorSel = resolveRoleSelection(
			["advisor"],
			this.settings,
			this.#modelRegistry.getAvailable(),
			this.#modelRegistry,
		);
		if (!advisorSel) {
			logger.debug("advisor enabled but no model assigned to the 'advisor' role; advisor inactive");
			return false;
		}

		// Concern and blocker interrupt the running agent through the steering
		// channel (aborting in-flight tools at the next steering boundary); when the
		// loop has already yielded, triggerTurn resumes it so the advice is acted on
		// immediately rather than waiting for the next user prompt. After a deliberate
		// user interrupt the auto-resume is suppressed — but only while the agent is
		// idle or still tearing the interrupted turn down: a concern is then recorded
		// as a visible card and re-enters context when the user resumes. Once a turn
		// is streaming again (a resume the user already drove) it is steered in live,
		// since steering an active run auto-resumes nothing; parking it there would
		// strand the advice and dump the backlog as one burst at the next prompt. A
		// plain nit always rides the non-interrupting YieldQueue aside.
		const enqueueAdvice = (note: string, severity?: AdvisorSeverity) => {
			if (severity) {
				recordAdvisorInterventionTelemetry(this.#orchestrationTelemetry, {
					sessionId: this.sessionId ?? undefined,
					advisorSeverity: severity,
				});
			}
			const interrupting = isInterruptingSeverity(severity);
			const channel = resolveAdvisorDeliveryChannel({
				severity,
				autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
				// Key on the live agent-core loop, not session `isStreaming` (which also
				// counts `#promptInFlightCount` during post-turn unwind). Only a running
				// loop will consume a steer at its next boundary; steering into the unwind
				// window would strand the card and let #drainStrandedQueuedMessages
				// auto-resume it despite the user's interrupt.
				streaming: this.agent.state.isStreaming,
				aborting: this.#abortInProgress,
				interruptImmuneTurnActive: interrupting && this.#isAdvisorInterruptImmuneTurnActive(),
			});
			if (channel === "aside") {
				this.yieldQueue.enqueue("advisor", { note, severity });
				return;
			}
			const notes: AdvisorNote[] = [{ note, severity }];
			const content = formatAdvisorBatchContent(notes);
			const details = { notes } satisfies AdvisorMessageDetails;
			if (channel === "preserve") {
				this.#preserveAdvisorCard({
					role: "custom",
					customType: "advisor",
					content,
					display: true,
					attribution: "agent",
					details,
					timestamp: Date.now(),
				});
				return;
			}
			this.#recordAdvisorInterruptDelivered();
			void this.sendCustomMessage(
				{ customType: "advisor", content, display: true, attribution: "agent", details },
				{ deliverAs: "steer", triggerTurn: true },
			).catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
		};

		const adviseTool = new AdviseTool(enqueueAdvice);
		const advisorReadOnlyTools = this.#advisorReadOnlyTools ?? [];

		const appendOnlyContext = new AppendOnlyContextManager();
		const advisorThinkingLevel = advisorSel.thinkingLevel ?? ThinkingLevel.Medium;
		const systemPrompt = composeAdvisorSystemPrompt({
			basePrompt: advisorSystemPrompt,
			watchdogPrompt: this.#advisorWatchdogPrompt,
			activeTaskContract: this.#activeTaskContract,
			compiledTaskContractBlock: this.#activeCompiledTaskContract?.advisorBlock.text,
		});
		const advisorSessionId = this.sessionId ? `${this.sessionId}-advisor` : undefined;

		// Thread the primary's telemetry into the advisor loop so the advisor
		// model's GenAI spans + usage/cost hooks fire like every other model call,
		// stamped with the advisor's own identity. `conversationId` is cleared so
		// the advisor loop falls back to its own `-advisor` session id for
		// `gen_ai.conversation.id` instead of inheriting the primary's
		// conversation; undefined telemetry stays undefined (zero-overhead no-op).
		const advisorTelemetry = this.agent.telemetry
			? {
					...this.agent.telemetry,
					agent: {
						id: advisorSessionId,
						name: MODEL_ROLES.advisor.name,
						description: formatModelString(advisorSel.model),
					},
					conversationId: undefined,
				}
			: undefined;
		const advisorAgent = new Agent({
			initialState: {
				systemPrompt,
				model: advisorSel.model,
				thinkingLevel: toReasoningEffort(advisorThinkingLevel),
				tools: [adviseTool, ...advisorReadOnlyTools],
			},
			appendOnlyContext,
			sessionId: advisorSessionId,
			getApiKey: requestModel => this.#modelRegistry.resolver(requestModel, advisorSessionId),
			// Provider-options parity with the primary agent (issue #3639): the
			// SDK's stream wrapper, the session's provider hooks (already wrapped
			// to feed the RawSseDebugBuffer), and the shared transport/fast-mode
			// state map all reach advisor requests too. The cache key pins
			// consecutive advisor turns to the advisor's own cache shard.
			streamFn: this.#advisorStreamFn,
			promptCacheKey: advisorSessionId,
			providerSessionState: this.agent.providerSessionState,
			onPayload: this.#onPayload,
			onResponse: this.#onResponse,
			onSseEvent: this.#onSseEvent,
			transformProviderContext: this.#transformProviderContext,
			intentTracing: false,
			telemetry: advisorTelemetry,
		});
		advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
		if (advisorSel.serviceTier) advisorAgent.serviceTier = advisorSel.serviceTier;

		const advisorAgentFacade: AdvisorAgent = {
			prompt: input => advisorAgent.prompt(input),
			abort: reason => advisorAgent.abort(reason),
			reset: () => {
				advisorAgent.reset();
				appendOnlyContext.log.clear();
			},
			state: advisorAgent.state,
		};

		this.#advisorAgent = advisorAgent;
		// Persist the advisor's turns to `<session>/__advisor.jsonl` (resolved lazily
		// so it follows session switches) so its model usage is attributed in stats
		// and its transcript shows in the Agent Hub — without registering it as a peer.
		const recorder = new AdvisorTranscriptRecorder(
			() => this.sessionManager.getSessionFile(),
			() => this.sessionManager.getCwd(),
			// On the advisor on→off→on toggle, wait for the prior recorder's close so
			// two SessionManagers never hold the same __advisor.jsonl at once.
			this.#advisorRecorderClosed,
		);
		this.#advisorTranscriptRecorder = recorder;
		this.#attachAdvisorRecorderFeed();
		this.#advisorRuntime = new AdvisorRuntime(advisorAgentFacade, {
			snapshotMessages: () => this.agent.state.messages,
			enqueueAdvice,
			maintainContext: incomingTokens => this.#maintainAdvisorContext(incomingTokens),
		});
		if (seedToCurrent) {
			this.#advisorRuntime.seedTo(this.agent.state.messages.length);
		}

		// Batch non-blocking advisor notes into one injected custom message.
		this.#advisorYieldQueueUnsubscribe = this.yieldQueue.register<AdvisorNote>("advisor", {
			build: entries =>
				entries.length === 0
					? null
					: ({
							role: "custom",
							customType: "advisor",
							display: true,
							attribution: "agent",
							timestamp: Date.now(),
							content: formatAdvisorBatchContent(entries),
							details: { notes: entries } satisfies AdvisorMessageDetails,
						} satisfies CustomMessage),
			skipIdleFlush: true,
		});

		return true;
	}

	#stopAdvisorRuntime(): void {
		// Detach the recorder feed BEFORE aborting the advisor agent: dispose() aborts
		// the loop, and an abort emits a final `message_end` we must not enqueue against
		// a closing recorder (it would reopen and resurrect an already-released file).
		this.#advisorAgentUnsubscribe?.();
		this.#advisorAgentUnsubscribe = undefined;
		if (this.#advisorRuntime) {
			this.#advisorRuntime.dispose();
			this.#advisorRuntime = undefined;
		}
		if (this.#advisorTranscriptRecorder) {
			// Capture the close so dispose()/`/drop` can await the queued open+append+close —
			// the last advisor turn would otherwise be lost on a fast process exit.
			this.#advisorRecorderClosed = this.#advisorTranscriptRecorder.close();
			this.#advisorTranscriptRecorder = undefined;
		}
		if (this.#advisorAgent) {
			this.#advisorAgent = undefined;
		}
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
	#attachAdvisorRecorderFeed(): void {
		const agent = this.#advisorAgent;
		const recorder = this.#advisorTranscriptRecorder;
		if (!agent || !recorder) return;
		this.#advisorAgentUnsubscribe = agent.subscribe(event => {
			if (event.type === "message_end") recorder.record(event.message);
		});
	}

	async #promoteAdvisorContextModel(currentModel: Model): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		const advisorSel = resolveRoleSelection(
			["advisor"],
			this.settings,
			this.#modelRegistry.getAvailable(),
			this.#modelRegistry,
		);
		const advisorThinkingLevel = advisorSel?.thinkingLevel ?? ThinkingLevel.Medium;

		try {
			this.#advisorAgent?.setModel(targetModel);
			this.#advisorAgent?.setThinkingLevel(toReasoningEffort(advisorThinkingLevel));
			this.#advisorAgent?.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
			this.#advisorAgent?.appendOnlyContext?.invalidateForModelChange();
			logger.debug("Advisor context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Advisor context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #maintainAdvisorContext(incomingTokens: number): Promise<boolean> {
		const advisor = this.#advisorAgent;
		if (!advisor) return false;

		const compactionSettings = this.settings.getGroup("compaction");
		if (compactionSettings.strategy === "off") return false;
		if (!compactionSettings.enabled) return false;

		const advisorModel = advisor.state.model;
		const contextWindow = advisorModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = advisor.state.messages;
		let contextTokens = incomingTokens;
		for (const message of messages) {
			contextTokens += estimateTokens(message);
		}

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		// 1. Try promotion first
		if (await this.#promoteAdvisorContextModel(advisorModel)) {
			// Promotion succeeded, check if new model has enough space
			const newModel = advisor.state.model;
			const newWindow = newModel.contextWindow ?? 0;
			if (newWindow > 0) {
				const stillNeedsCompaction = shouldCompact(contextTokens, newWindow, compactionSettings);
				if (!stillNeedsCompaction) return false;
			}
		}

		// 2. Run compaction on advisor messages
		const pathEntries: SessionEntry[] = messages.map((message, i) => {
			const id = `msg-${i}`;
			const parentId = i > 0 ? `msg-${i - 1}` : null;
			const timestamp = String(message.timestamp || Date.now());

			if (message.role === "compactionSummary") {
				return {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: message.summary,
					shortSummary: message.shortSummary,
					firstKeptEntryId: (message as any).firstKeptEntryId || `msg-${i + 1}`,
					tokensBefore: message.tokensBefore,
				} satisfies CompactionEntry;
			}

			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message,
			} satisfies SessionMessageEntry;
		});

		const preparation = prepareCompaction(pathEntries, compactionSettings);
		if (!preparation) {
			// Cannot prepare compaction, fallback to re-prime
			return true;
		}

		const advisorCompactionThinkingLevel: ThinkingLevel | undefined = advisor.state.disableReasoning
			? ThinkingLevel.Off
			: advisor.state.thinkingLevel;

		// Advisor state is in-memory-only, so maintenance always uses a native-text LLM summary.
		const availableModels = this.#modelRegistry.getAvailable();
		const candidates = this.#resolveCompactionModelCandidates(advisorModel, availableModels);
		if (candidates.length === 0) {
			// No compaction candidates, fallback to re-prime
			return true;
		}

		let compactResult: CompactionResult | undefined;
		let lastError: unknown;
		const advisorSessionId = this.sessionId ? `${this.sessionId}-advisor` : undefined;
		// Instrument the advisor's overflow-compaction one-shot like the primary
		// compaction path so the advisor model's maintenance call also emits spans.
		const telemetry = resolveTelemetry(advisor.telemetry, advisorSessionId);

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, advisorSessionId);
			if (!apiKey) continue;

			try {
				compactResult = await compact(
					preparation,
					candidate,
					this.#modelRegistry.resolver(candidate, advisorSessionId),
					undefined,
					undefined,
					{
						thinkingLevel: advisorCompactionThinkingLevel,
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,
					},
				);
				break;
			} catch (error) {
				lastError = error;
			}
		}

		if (!compactResult) {
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: String(lastError) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;

		// Rebuild messages with the compaction summary
		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), shortSummary),
			firstKeptEntryId,
		} as CompactionSummaryMessage & { firstKeptEntryId?: string };

		advisor.replaceMessages([summaryMessage, ...preparation.recentMessages]);
		return false;
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get asyncJobManager(): AsyncJobManager | undefined {
		return this.#asyncJobManager;
	}

	getAgentId(): string | undefined {
		return this.#agentId;
	}

	getCollaborationPolicy(): CollaborationPolicy | undefined {
		return this.#collaborationPolicy;
	}

	setCollaborationPolicy(policy: CollaborationPolicy | undefined): void {
		this.#collaborationPolicy = policy;
	}

	/** Dequeue the next HARD forced tool choice for the upcoming LLM call, dropping
	 *  (and rejecting) one whose named tool is no longer active. */
	#nextHardToolChoice(): ToolChoice | undefined {
		const choice = this.#toolChoiceQueue.nextToolChoice();
		if (isToolChoiceActive(choice, this.agent.state.tools)) {
			return choice;
		}
		this.#toolChoiceQueue.reject("unavailable");
		return undefined;
	}

	/**
	 * The per-turn tool-choice directive for the agent loop's `getToolChoice`. Priority:
	 *   1. a HARD forced choice from the queue (genuine forces: user-force, eager-todo, …) —
	 *      consuming (advances the queue generator);
	 *   2. else, when a non-forcing preview is pending, a {@link SoftToolRequirement} — a
	 *      PEEK (advances/pops nothing), so the agent-loop injects the reminder once per head
	 *      and escalates to a forced `resolve` only if the model declines. A compliant turn
	 *      pays ZERO tool_choice change (no prompt-cache messages-cache invalidation);
	 *   3. else undefined.
	 */
	nextToolChoiceDirective(): ToolChoiceDirective | undefined {
		const hard = this.#nextHardToolChoice();
		if (hard !== undefined) return hard;
		const head = this.#toolChoiceQueue.peekPendingHead();
		if (head !== undefined) {
			return {
				soft: true,
				id: head.id,
				toolName: "resolve",
				reminder: [buildResolveReminderMessage(head.sourceToolName)],
			};
		}
		return undefined;
	}

	/** Peek the head non-forcing pending preview invoker, for the `resolve` tool's dispatch. */
	peekPendingInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekPendingInvoker();
	}

	/** Clear stale non-forcing pending preview invokers after `resolve` proves none can run. */
	clearPendingInvokers(): void {
		this.#toolChoiceQueue.clearPendingInvokers();
	}

	/**
	 * Force the next model call to target a specific active tool, then terminate
	 * the agent loop. Pushes a two-step sequence [forced, "none"] so the model
	 * calls exactly the forced tool once and then cannot call another.
	 */
	setForcedToolChoice(toolName: string): void {
		if (!this.getActiveToolNames().includes(toolName)) {
			throw new Error(`Tool "${toolName}" is not currently active.`);
		}

		const forced = buildNamedToolChoice(toolName, this.model);
		if (!forced || typeof forced === "string") {
			throw new Error("Current model does not support forcing a specific tool.");
		}

		this.#toolChoiceQueue.pushSequence([forced, "none"], {
			label: "user-force",
			onRejected: () => "requeue",
		});
	}

	/** The tool-choice queue: forces forthcoming tool invocations and carries handlers. */
	get toolChoiceQueue(): ToolChoiceQueue {
		return this.#toolChoiceQueue;
	}

	/** Peek the in-flight directive's invocation handler for use by the resolve tool. */
	peekQueueInvoker(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#toolChoiceQueue.peekInFlightInvoker();
	}

	/** Standing (long-lived) handler the `resolve` tool falls back to when no
	 *  queue invoker is in flight. Used by plan mode so the agent can submit
	 *  approval via `resolve` without forcing the tool choice every turn. */
	#standingResolveHandler: ((input: unknown) => Promise<unknown> | unknown) | undefined;

	peekStandingResolveHandler(): ((input: unknown) => Promise<unknown> | unknown) | undefined {
		return this.#standingResolveHandler;
	}

	setStandingResolveHandler(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void {
		this.#standingResolveHandler = handler ?? undefined;
	}

	#sessionSwitchReconciler: { before?: () => Promise<void>; after?: () => Promise<void> } | undefined;

	setSessionSwitchReconciler(reconciler: SessionSwitchReconciler | null): void {
		if (!reconciler) {
			this.#sessionSwitchReconciler = undefined;
		} else if (typeof reconciler === "function") {
			this.#sessionSwitchReconciler = { after: reconciler };
		} else {
			this.#sessionSwitchReconciler = reconciler;
		}
	}

	/** Provider-scoped mutable state store for transport/session caches. */
	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	getHindsightSessionState(): HindsightSessionState | undefined {
		return this.#hindsightSessionState;
	}

	setHindsightSessionState(state: HindsightSessionState | undefined): HindsightSessionState | undefined {
		const previous = this.#hindsightSessionState;
		this.#hindsightSessionState = state;
		return previous;
	}

	getMnemopiSessionState(): MnemopiSessionState | undefined {
		return getMnemopiSessionState(this);
	}

	/** TTSR manager for time-traveling stream rules */
	get ttsrManager(): TtsrManager | undefined {
		return this.#ttsrManager;
	}

	/** Secret obfuscator, when secrets are configured; /share redaction reuses it. */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/** Whether a TTSR abort is pending (stream was aborted to inject rules) */
	get isTtsrAbortPending(): boolean {
		return this.#ttsrAbortPending;
	}

	/** Whether an expected internal plan-mode abort is pending. Consumed by
	 *  `#handleAgentEvent` to stamp `SILENT_ABORT_MARKER` on the next aborted
	 *  assistant message_end; callers clear it in `finally`. */
	get isPlanInternalAbortPending(): boolean {
		return this.#planInternalAbortPending;
	}

	/** Arm the silent-abort marker for the next aborted assistant message_end.
	 *  Caller MUST clear via `clearPlanInternalAbortPending()` in a `finally`
	 *  to guarantee no leak. */
	markPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = true;
	}

	/** Unconditionally clear the silent-abort flag. Idempotent: safe when the
	 *  flag was never set OR was already consumed by `#handleAgentEvent`. */
	clearPlanInternalAbortPending(): void {
		this.#planInternalAbortPending = false;
	}

	getAsyncJobSnapshot(options?: { recentLimit?: number }): AsyncJobSnapshot | null {
		const manager = this.#asyncJobManager;
		if (!manager) return null;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const running = manager.getRunningJobs(ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const recent = manager.getRecentJobs(options?.recentLimit ?? 5, ownerFilter).map(job => ({
			id: job.id,
			type: job.type,
			status: job.status,
			label: job.label,
			startTime: job.startTime,
		}));
		const delivery = manager.getDeliveryState(ownerFilter);
		return { running, recent, delivery };
	}

	/**
	 * Cancel async jobs registered by *this* agent only. Used by lifecycle
	 * transitions (newSession, switchSession, handoff, dispose) so a subagent
	 * cleans up its own background work without touching its parent's jobs.
	 *
	 * Cancellation runs against the shared manager with this session's unique
	 * agent id, so roots and subagents clean up only their own jobs.
	 *
	 * No-op when no manager is reachable or this session has no agent id.
	 */
	#cancelOwnAsyncJobs(): void {
		if (!this.#agentId) return;
		const manager = this.#asyncJobManager;
		manager?.cancelAll({ ownerId: this.#agentId });
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	#emit(event: AgentSessionEvent): void {
		// Copy array before iteration to avoid mutation during iteration.
		const listeners = [...this.#eventListeners];
		for (const l of listeners) {
			try {
				const result = l(event) as unknown;
				// Listener may be an async function whose returned Promise we don't await;
				// attach a catch so a rejection does not become an unhandled rejection.
				if (isPromise(result)) {
					result.catch(err => {
						logger.warn("AgentSession listener rejected", {
							error: err instanceof Error ? err.message : String(err),
						});
					});
				}
			} catch (err) {
				logger.warn("AgentSession listener threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/**
	 * Emit a UI-only notice to the session. Surfaces in interactive mode as a
	 * `showWarning` / `showError` / `showStatus` line; non-interactive modes
	 * receive the event through the normal subscribe stream.
	 *
	 * Notices are NOT added to agent state and never reach the LLM — use this
	 * for out-of-band conditions the user should see but the model shouldn't
	 * react to (e.g. background queue flush failures).
	 */
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void {
		this.#emit({ type: "notice", level, message, source });
	}

	#queuedExtensionEvents: Promise<void> = Promise.resolve();

	#queueExtensionEvent(event: AgentSessionEvent): Promise<void> {
		const emit = async () => {
			await this.#emitExtensionEvent(event);
		};
		const queued = this.#queuedExtensionEvents.then(emit, emit);
		this.#queuedExtensionEvents = queued.catch(() => {});
		return queued;
	}

	async #emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_update") {
			this.#emit(event);
			void this.#queueExtensionEvent(event);
			return;
		}
		await this.#emitExtensionEvent(event);
		// Hold the wire-level agent_end until in-flight prompts unwind. Subscribers
		// (rpc-mode, ACP, Cursor) treat agent_end as the "session is idle" signal;
		// emitting while #promptInFlightCount > 0 lets a client fire its next
		// `prompt` into a session that still reports isStreaming === true. Flush
		// happens in #endInFlight / #resetInFlight. A later agent_end (e.g. from
		// an auto-compaction turn that starts before the original prompt unwinds)
		// supersedes the pending one, which is what subscribers want — they only
		// care about the final settle.
		if (event.type === "agent_end" && this.#promptInFlightCount > 0) {
			this.#pendingAgentEndEmit = event;
			return;
		}
		this.#emit(event);
	}

	// Track last assistant message for auto-compaction check
	#lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect.
	 *
	 * `agent_end` handling schedules deferred post-prompt recovery work
	 * (compaction/handoff, context-promotion continuations). It is invoked
	 * fire-and-forget by the agent's synchronous `#emit`, and only reaches
	 * `#checkCompaction` after several internal awaits. `prompt()` runs
	 * `#waitForPostPromptRecovery()` the instant `agent.prompt()` resolves — which
	 * can land BEFORE the handler registers its tasks, so the wait would observe an
	 * empty task set and return early, letting a deferred handoff/promotion race
	 * prompt completion. Tracking the `agent_end` handler as a post-prompt task
	 * that is registered SYNCHRONOUSLY (before the first await) closes that window:
	 * `#postPromptTasksPromise` is set the moment `#emit` invokes this handler, so
	 * the recovery wait always sees the in-flight handler and blocks until it — and
	 * everything it schedules — settles. */
	/** Tail of the ordered message_end processing chain (see #handleAgentEvent). */
	#queuedMessageEndEvents: Promise<void> = Promise.resolve();

	#handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		if (event.type === "message_end") {
			// Chain message_end processing so persistence lands in stream order even
			// when an extension's message_end hook is still pending: without this, a
			// fast toolResult hook could persist its message ahead of the turn's
			// still-parked assistant, corrupting branch order (the assistant that
			// carries a toolCall must precede its toolResult). Mid-turn compaction
			// awaits this chain before snapshotting the branch.
			const process = () => this.#processAgentEvent(event);
			const queued = this.#queuedMessageEndEvents.then(process, process);
			this.#queuedMessageEndEvents = queued.catch(() => {});
			return queued;
		}
		if (event.type !== "agent_end") {
			return this.#processAgentEvent(event);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#trackPostPromptTask(promise);
		try {
			// agent_end maintenance depends on message_end side effects (persistence,
			// #lastAssistantMessage, progress-flag clears); drain the ordered chain so
			// maintenance never races a still-running message_end handler.
			let tail: Promise<void>;
			do {
				tail = this.#queuedMessageEndEvents;
				await tail;
			} while (tail !== this.#queuedMessageEndEvents);
			await this.#processAgentEvent(event);
		} finally {
			resolve();
		}
	};

	#processAgentEvent = async (event: AgentEvent): Promise<void> => {
		// Plan-mode internal transition: stamp `SILENT_ABORT_MARKER` on the
		// persisted message BEFORE the obfuscator's display-side copy below.
		// Invariant (must hold across refactors): this branch precedes the
		// `let displayEvent = event; ... displayEvent = { ...event, message: { ...message, content: deobfuscated } }`
		// block. After stamping, both `displayEvent.message` (via the spread)
		// and `event.message` (in-place mutation, used by SessionManager
		// persistence) carry the marker, guaranteeing streaming render and
		// history replay branch identically. The one-shot flag is consumed
		// here, scoped strictly to this aborted message_end; callers still clear it
		// in `finally` so a leaked flag cannot silence a later unrelated abort.
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "aborted" &&
			this.#planInternalAbortPending
		) {
			(event.message as AssistantMessage).errorMessage = SILENT_ABORT_MARKER;
			(event.message as AssistantMessage).errorId = AIError.create(AIError.Flag.SilentAbort);
			this.#planInternalAbortPending = false;
		}

		// Deobfuscate assistant message content for display emission — the LLM echoes back
		// obfuscated placeholders, but listeners (TUI, extensions, exporters) must see real
		// values. The original event.message stays obfuscated so the persistence path below
		// writes `#HASH#` tokens to the session file; convertToLlm re-obfuscates outbound
		// traffic on the next turn. Walks text, thinking, and toolCall arguments/intent.
		let displayEvent: AgentEvent = event;
		const obfuscator = this.#obfuscator;
		if (obfuscator && event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message;
			const deobfuscatedContent = deobfuscateAssistantContent(obfuscator, message.content);
			if (deobfuscatedContent !== message.content) {
				displayEvent = { ...event, message: { ...message, content: deobfuscatedContent } };
			}
		}

		if (event.type === "turn_start") {
			const usage = this.getSessionStats().tokens;
			this.#goalRuntime.onTurnStart(`turn-${++this.#goalTurnCounter}`, {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		}

		await this.#emitSessionEvent(displayEvent);

		if (event.type === "turn_start") {
			this.#resetStreamingEditState();
			// TTSR: Reset buffer on turn start
			this.#ttsrManager?.resetBuffer();
		}

		// TTSR: Increment message count on turn end (for repeat-after-gap tracking)
		if (event.type === "turn_end" && this.#ttsrManager) {
			this.#ttsrManager.incrementMessageCount();
		}
		// Finalize the tool-choice queue's in-flight yield after tools have executed.
		// This must happen at turn_end (not message_end) because onInvoked handlers
		// run during tool execution, which happens between message_end and turn_end.
		if (event.type === "turn_end" && this.#toolChoiceQueue.hasInFlight) {
			const msg = event.message as AssistantMessage;
			if (msg.stopReason === "aborted" || msg.stopReason === "error") {
				this.#toolChoiceQueue.reject(msg.stopReason === "error" ? "error" : "aborted");
			} else {
				this.#toolChoiceQueue.resolve();
			}
		}
		if (event.type === "tool_execution_end") {
			if (event.toolName === "goal") {
				await this.#goalRuntime.onGoalToolCompleted();
			} else {
				await this.#goalRuntime.onToolCompleted(event.toolName);
			}
		}
		if (event.type === "tool_execution_end" && event.toolName === "yield" && !event.isError) {
			this.#lastSuccessfulYieldToolCallId = event.toolCallId;
		}
		// TTSR: Check for pattern matches on assistant text/thinking and tool argument deltas
		if (event.type === "message_update" && this.#ttsrManager?.hasRules()) {
			const assistantEvent = event.assistantMessageEvent;
			let matchContext: TtsrMatchContext | undefined;
			let streamingToolCall: ToolCall | undefined;

			if (assistantEvent.type === "text_delta") {
				matchContext = { source: "text" };
			} else if (assistantEvent.type === "thinking_delta") {
				matchContext = { source: "thinking" };
			} else if (assistantEvent.type === "toolcall_delta") {
				streamingToolCall = this.#getStreamingToolCallBlock(event.message, assistantEvent.contentIndex);
				matchContext = this.#getTtsrToolMatchContext(streamingToolCall, assistantEvent.contentIndex);
			}

			if (matchContext && "delta" in assistantEvent) {
				const targetMessageTimestamp = event.message.role === "assistant" ? event.message.timestamp : undefined;
				const matches = this.#checkTtsrStream(assistantEvent.delta, matchContext, streamingToolCall);
				if (matches.length > 0 && this.#handleTtsrMatches(matches, matchContext, targetMessageTimestamp)) {
					return;
				}
				// ast-grep `astCondition` rules match against the reconstructed edit/write
				// snapshot, which only exists for tool argument streams. The native worker
				// call is async, so this path is awaited and self-throttled by the manager.
				if (matchContext.source === "tool" && this.#ttsrManager?.hasAstRules()) {
					const astMatches = await this.#checkTtsrAstStream(matchContext, streamingToolCall);
					if (astMatches.length > 0 && this.#handleTtsrMatches(astMatches, matchContext, targetMessageTimestamp)) {
						return;
					}
				}
			}
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_start" ||
				event.assistantMessageEvent.type === "toolcall_delta" ||
				event.assistantMessageEvent.type === "toolcall_end")
		) {
			void this.#preCacheStreamingEditFile(event);
		}

		if (
			event.type === "message_update" &&
			(event.assistantMessageEvent.type === "toolcall_end" || event.assistantMessageEvent.type === "toolcall_delta")
		) {
			this.#maybeAbortStreamingEdit(event);
		}

		// Handle session persistence
		if (event.type === "message_end") {
			// Task-contract notices are runtime-only context and must not follow a session.
			if (
				event.message.role === "hookMessage" ||
				(event.message.role === "custom" && event.message.customType !== "task-contract-notice")
			) {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					event.message.attribution ?? "agent",
				);
				if (event.message.role === "custom" && event.message.customType === "ttsr-injection") {
					this.#markTtsrInjected(this.#extractTtsrRuleNames(event.message.details));
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "developer" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult" ||
				event.message.role === "fileMention"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				if (event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;
					if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
						assistantMsg.contextSnapshot = {
							promptTokens: calculatePromptTokens(assistantMsg.usage),
							nonMessageTokens: this.#pendingContextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this),
						};
					}
				}
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this.#lastAssistantMessage = event.message;
				const assistantMsg = event.message as AssistantMessage;
				const currentGrantsAnthropicPriority =
					this.serviceTier === "priority" || this.serviceTier === "claude-only";
				if (assistantMsg.disabledFeatures?.includes("priority") && currentGrantsAnthropicPriority) {
					this.setServiceTier(undefined);
					this.emitNotice(
						"warning",
						"Priority/fast mode rejected for this model; retried without it. Fast mode is now off.",
						"priority",
					);
				}
				// Resolve TTSR resume gate before checking for new deferred injections.
				// Gate on #ttsrAbortPending, not stopReason: a non-TTSR abort (e.g. streaming
				// edit) also produces stopReason === "aborted" but has no continuation coming.
				// Only skip when #ttsrAbortPending is true (TTSR continuation is imminent).
				if (!this.#ttsrAbortPending) {
					this.#resolveTtsrResume();
				}
				this.#queueDeferredTtsrInjectionIfNeeded(assistantMsg);
				if (this.#handoffAbortController) {
					this.#skipPostTurnMaintenanceAssistantTimestamp = assistantMsg.timestamp;
				}
				if (
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted" &&
					!this.#isEmptyAssistantStop(assistantMsg) &&
					this.#retryAttempt > 0
				) {
					if (this.#activeRetryFallback && this.model) {
						await this.#emitSessionEvent({
							type: "retry_fallback_succeeded",
							model: formatRetryFallbackSelector(this.model, this.thinkingLevel),
							role: this.#activeRetryFallback.role,
						});
					}
					await this.#emitSessionEvent({
						type: "auto_retry_end",
						success: true,
						attempt: this.#retryAttempt,
					});
					this.#retryAttempt = 0;
				}
				if (assistantMsg.provider === "opencode-go") {
					this.#modelRegistry.authStorage.recordUsageCost(assistantMsg.provider, assistantMsg.usage.cost.total, {
						sessionId: this.#activeProviderSessionId(),
						recordedAt: assistantMsg.timestamp,
						baseUrl: this.#modelRegistry.getProviderBaseUrl?.(assistantMsg.provider),
					});
				}
			}
			if (event.message.role === "toolResult") {
				const { toolName, details, isError, content } = event.message as {
					toolName?: string;
					details?: { path?: string; phases?: TodoPhase[]; report?: string; startedAt?: string };
					isError?: boolean;
					content?: Array<TextContent | ImageContent>;
				};
				// A tool actually ran. Clear the post-reminder suppression: the agent did
				// productive work in response to the prior nudge, so the next text-only stop
				// is allowed to escalate to the next reminder if todos remain incomplete.
				this.#todoReminderAwaitingProgress = false;
				this.#completionGateAwaitingProgress = false;
				// Fusion failure-streak escalation: consecutive failed tool calls on a
				// downgraded main model force an early tier-up back to the frontier
				// baseline without waiting for the next compaction boundary.
				if (isError) {
					this.#fusionToolFailureStreak++;
					await this.#maybeEscalateFusionOnFailureStreak();
				} else {
					this.#fusionToolFailureStreak = 0;
				}
				// Invalidate streaming edit cache when edit tool completes to prevent stale data
				if (toolName === "edit" && details?.path) {
					this.#invalidateFileCacheForPath(details.path);
				}
				if (toolName === "todo" && !isError && Array.isArray(details?.phases)) {
					this.setTodoPhases(details.phases);
				}
				if (toolName === "todo" && isError) {
					const errorText = content?.find(part => part.type === "text")?.text;
					const reminderText = [
						"<system-reminder>",
						"todo failed, so todo progress is not visible to the user.",
						errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
						"Fix the todo payload and call todo again before continuing.",
						"</system-reminder>",
					].join("\n");
					await this.sendCustomMessage(
						{
							customType: "todo-error-reminder",
							content: reminderText,
							display: false,
							details: { toolName, errorText },
						},
						{ deliverAs: "nextTurn" },
					);
				}
				if (toolName === "checkpoint" && !isError) {
					const checkpointEntryId = this.sessionManager.getEntries().at(-1)?.id ?? null;
					this.#checkpointState = {
						checkpointMessageCount: this.agent.state.messages.length,
						checkpointEntryId,
						startedAt: details?.startedAt ?? new Date().toISOString(),
					};
					this.#pendingRewindReport = undefined;
				}
				if (toolName === "rewind" && !isError && this.#checkpointState) {
					const detailReport = typeof details?.report === "string" ? details.report.trim() : "";
					const textReport = content?.find(part => part.type === "text")?.text?.trim() ?? "";
					const report = detailReport || textReport;
					if (report.length > 0) {
						this.#pendingRewindReport = report;
					}
				}
			}
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const emitAgentEndNotification = async () => {
				await this.#emitAgentEndNotification(event.messages);
			};
			const usage = this.getSessionStats().tokens;
			await this.#goalRuntime.onAgentEnd({
				currentUsage: {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
				},
			});
			const fallbackAssistant = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			const msg = this.#lastAssistantMessage ?? fallbackAssistant;
			this.#lastAssistantMessage = undefined;
			if (!msg) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				await emitAgentEndNotification();
				return;
			}

			// Invalidate GitHub Copilot credentials on auth failure so stale tokens
			// aren't reused on the next request
			if (
				msg.stopReason === "error" &&
				msg.provider === "github-copilot" &&
				msg.errorMessage?.includes("GitHub Copilot authentication failed")
			) {
				await this.#modelRegistry.authStorage.remove("github-copilot");
			}

			if (this.#skipPostTurnMaintenanceAssistantTimestamp === msg.timestamp) {
				this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;
				this.#lastSuccessfulYieldToolCallId = undefined;
				await emitAgentEndNotification();
				return;
			}

			if (this.#assistantEndedWithSuccessfulYield(msg)) {
				this.#lastSuccessfulYieldToolCallId = undefined;
				if (this.#isGoalModeActive()) {
					// An active goal keeps running after a yield, so run threshold
					// maintenance now — the next goal turn would otherwise start on an
					// over-threshold context. No auto-continue: the yield settles this
					// run; the goal runtime owns what happens next.
					logger.debug("agent_end maintenance routing", {
						route: "yield-active-goal-checkCompaction",
						successfulYield: true,
					});
					const compactionTask = this.#checkCompaction(msg, true, false, false);
					this.#trackPostPromptTask(compactionTask);
					await compactionTask;
				}
				await emitAgentEndNotification();
				return;
			}
			// A successful yield followed by a trailing empty `stop` is still a
			// settled yield turn — the empty stop is a stray provider epilogue, not
			// a stall to retry. Route it through the same active-goal threshold
			// maintenance as a plain yield instead of the empty-stop handler.
			const postYieldTrailingStop =
				this.#lastSuccessfulYieldToolCallId !== undefined &&
				msg.stopReason === "stop" &&
				this.#isEmptyAssistantStop(msg) &&
				event.messages.some(
					message =>
						message.role === "assistant" && this.#assistantEndedWithSuccessfulYield(message as AssistantMessage),
				);
			this.#lastSuccessfulYieldToolCallId = undefined;
			if (postYieldTrailingStop) {
				if (this.#isGoalModeActive()) {
					logger.debug("agent_end maintenance routing", {
						route: "post-yield-trailing-stop-active-goal-checkCompaction",
						successfulYield: true,
					});
					const compactionTask = this.#checkCompaction(msg, true, false, false);
					this.#trackPostPromptTask(compactionTask);
					await compactionTask;
					await emitAgentEndNotification();
					return;
				}
				// Outside goal mode the yield already settled the run (the executor
				// treats it as the terminal result): retrying the stray epilogue via
				// the empty-stop path would resume an already-yielded child and
				// produce post-yield tool calls (issue #3389). Suppress it entirely.
				logger.debug("agent_end maintenance routing", {
					route: "post-yield-trailing-stop-suppressed",
					successfulYield: true,
				});
				await emitAgentEndNotification();
				return;
			}

			if (await this.#handleEmptyAssistantStop(msg)) {
				await emitAgentEndNotification();
				return;
			}
			if (await this.#handleUnexpectedAssistantStop(msg)) {
				await emitAgentEndNotification();
				return;
			}

			if (this.#isRetryableReasonlessAbort(msg)) {
				const didRetry = await this.#handleRetryableError(msg, { allowModelFallback: false });
				if (didRetry) {
					await emitAgentEndNotification();
					return;
				}
			}

			// Header-runaway interrupt: the stream interceptor aborted a
			// planning-only reasoning turn; discard it and re-drive the turn with a
			// hidden tool-call reminder instead of settling the abort.
			if (await this.#handleGeminiToolCallReminderInterrupt(msg)) {
				await emitAgentEndNotification();
				return;
			}

			// A deliberate abort should settle the current turn, not trigger queued continuations.
			if (msg.stopReason === "aborted") {
				this.#resolveRetry();
				this.#resetSessionStopContinuationState();
				await emitAgentEndNotification();
				return;
			}
			// Check for retryable errors first (overloaded, rate limit, server errors)
			if (this.#isRetryableError(msg)) {
				const didRetry = await this.#handleRetryableError(msg);
				if (didRetry) {
					await emitAgentEndNotification();
					return;
				}
			}
			this.#resolveRetry();

			const compactionTask = this.#checkCompaction(msg);
			this.#trackPostPromptTask(compactionTask);
			const compactionResult = await compactionTask;
			// Check for incomplete todos only after a final assistant stop, not intermediate tool-use turns.
			const hasToolCalls = msg.content.some(content => content.type === "toolCall");
			if (hasToolCalls) {
				await emitAgentEndNotification();
				return;
			}
			// When compaction queued recovery, skip the rewind/todo/session_stop passes:
			// any reminder or hook continuation we append here would race the handoff,
			// retry, auto-continue prompt, or queued-message drain that already owns the
			// next turn. A no-headroom pause blocks them too — a todo continuation would
			// re-enter the same oversized context the pause just refused to re-drive.
			if (compactionResult.deferredHandoff || compactionResult.continuationScheduled || compactionResult.paused) {
				await emitAgentEndNotification();
				return;
			}
			if (msg.stopReason !== "error") {
				if (this.#enforceRewindBeforeYield()) {
					await emitAgentEndNotification();
					return;
				}
				const completionGateScheduled = await this.#checkRootCompletionGate();
				if (completionGateScheduled) {
					await emitAgentEndNotification();
					return;
				}
				const todoContinuationScheduled = await this.#checkTodoCompletion();
				if (todoContinuationScheduled) {
					await emitAgentEndNotification();
					return;
				}
			}
			await this.#emitSessionStopEvent(event.messages);
			await emitAgentEndNotification();
		}
	};

	/** Resolve the pending retry promise */
	#resolveRetry(): void {
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	/** Create the TTSR resume gate promise if one doesn't already exist. */
	#ensureTtsrResumePromise(): void {
		if (this.#ttsrResumePromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#ttsrResumePromise = promise;
		this.#ttsrResumeResolve = resolve;
	}

	/** Resolve and clear the TTSR resume gate. */
	#resolveTtsrResume(): void {
		if (!this.#ttsrResumeResolve) return;
		this.#ttsrResumeResolve();
		this.#ttsrResumeResolve = undefined;
		this.#ttsrResumePromise = undefined;
	}

	#ensurePostPromptTasksPromise(): void {
		if (this.#postPromptTasksPromise) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#postPromptTasksPromise = promise;
		this.#postPromptTasksResolve = resolve;
	}

	#resolvePostPromptTasks(): void {
		if (!this.#postPromptTasksResolve) return;
		this.#postPromptTasksResolve();
		this.#postPromptTasksResolve = undefined;
		this.#postPromptTasksPromise = undefined;
	}

	#trackPostPromptTask(task: Promise<unknown>): void {
		this.#postPromptTasks.add(task);
		this.#ensurePostPromptTasksPromise();
		void task
			.catch(() => {})
			.finally(() => {
				this.#postPromptTasks.delete(task);
				if (this.#postPromptTasks.size === 0) {
					this.#resolvePostPromptTasks();
				}
			});
	}

	#schedulePostPromptTask(
		task: (signal: AbortSignal) => Promise<void>,
		options?: { delayMs?: number; generation?: number; onSkip?: () => void },
	): void {
		const delayMs = options?.delayMs ?? 0;
		const signal = this.#postPromptTasksAbortController.signal;
		const scheduled = (async () => {
			if (delayMs > 0) {
				try {
					await scheduler.wait(delayMs, { signal });
				} catch {
					return;
				}
			}
			if (signal.aborted) {
				options?.onSkip?.();
				return;
			}
			if (options?.generation !== undefined && this.#promptGeneration !== options.generation) {
				options.onSkip?.();
				return;
			}
			await task(signal);
		})();
		this.#trackPostPromptTask(scheduled);
	}

	#scheduleAgentContinue(options?: {
		delayMs?: number;
		generation?: number;
		shouldContinue?: () => boolean;
		onSkip?: () => void;
		onError?: () => void;
	}): void {
		this.#schedulePostPromptTask(
			async signal => {
				// Defense in depth: if compaction/handoff slipped onto the post-prompt queue
				// alongside us (e.g. via a scheduler we don't own), refuse to start a fresh
				// streaming turn — agent.continue() here would race the handoff's session
				// reset. The first-class fix is in #checkCompaction/the agent_end handler,
				// but this guard catches anything that bypasses that path.
				if (signal.aborted || this.#isDisposed || this.isCompacting || this.isGeneratingHandoff) {
					options?.onSkip?.();
					return;
				}
				if (options?.shouldContinue && !options.shouldContinue()) {
					options?.onSkip?.();
					return;
				}
				this.#beginInFlight();
				try {
					await this.#maybeRestoreRetryFallbackPrimary();
					if (signal.aborted || this.#isDisposed) {
						options?.onSkip?.();
						return;
					}
					const compiledContract = this.#activeCompiledTaskContract;
					const retainedContractNotice = this.agent.state.messages.some(
						message =>
							message.role === "custom" &&
							message.customType === "task-contract-notice" &&
							message.content === compiledContract?.executorBlock.text,
					);
					if (compiledContract && !retainedContractNotice) {
						this.agent.appendMessage({
							role: "custom",
							customType: "task-contract-notice",
							content: compiledContract.executorBlock.text,
							display: false,
							attribution: "agent",
							timestamp: Date.now(),
						});
					}

					await this.agent.continue();
				} catch (error) {
					logger.warn("agent.continue failed after scheduling", {
						error: error instanceof Error ? error.message : String(error),
					});
					options?.onError?.();
				} finally {
					this.#endInFlight();
				}
			},
			{
				delayMs: options?.delayMs,
				generation: options?.generation,
				onSkip: options?.onSkip,
			},
		);
	}

	#scheduleAutoContinuePrompt(generation: number): void {
		const continuePrompt = async () => {
			// Compaction summarizes away the first-message eager preludes, so re-assert the
			// delegate-via-tasks / phased-todo reminders on this auto-resumed turn. This runs
			// at invocation (past the abort check below), so an aborted continuation queues
			// nothing; scoped to this request via prependMessages, never the shared queue.
			const eagerNudges = this.#buildPostCompactionEagerNudges();
			await this.#promptWithMessage(
				{
					role: "developer",
					content: [{ type: "text", text: autoContinuePrompt }],
					attribution: "agent",
					timestamp: Date.now(),
				},
				autoContinuePrompt,
				{
					skipPostPromptRecoveryWait: true,
					prependMessages: eagerNudges.length > 0 ? eagerNudges : undefined,
				},
			);
		};
		this.#schedulePostPromptTask(
			async signal => {
				await Promise.resolve();
				if (signal.aborted) return;
				await continuePrompt();
			},
			{ generation },
		);
	}

	async #cancelPostPromptTasks(): Promise<void> {
		this.#postPromptTasksAbortController.abort();
		this.#postPromptTasksAbortController = new AbortController();
		this.#resolveTtsrResume();

		const pendingTasks = Array.from(this.#postPromptTasks);
		if (pendingTasks.length === 0) {
			this.#resolvePostPromptTasks();
			return;
		}

		await Promise.allSettled(pendingTasks);
		if (this.#postPromptTasks.size === 0) {
			this.#resolvePostPromptTasks();
		}
	}
	/**
	 * Wait for retry, TTSR resume, and any background continuation to settle.
	 * Loops because a TTSR continuation can trigger a retry (or vice-versa),
	 * and fire-and-forget `agent.continue()` may still be streaming after
	 * the TTSR resume gate resolves.
	 */
	async #waitForPostPromptRecovery(generation?: number): Promise<void> {
		while (true) {
			// An abort bumps #promptGeneration. When this wait runs on behalf of a
			// specific prompt turn, stop as soon as that turn has been superseded:
			// its promise must resolve on the abort, not block on a queued
			// steer/follow-up that the post-abort drain starts as a fresh turn.
			if (generation !== undefined && this.#promptGeneration !== generation) return;
			if (this.#retryPromise) {
				await this.#retryPromise;
				continue;
			}
			if (this.#ttsrResumePromise) {
				await this.#ttsrResumePromise;
				continue;
			}
			if (this.#postPromptTasksPromise) {
				await this.#postPromptTasksPromise;
				continue;
			}
			// Tracked post-prompt tasks cover deferred continuations scheduled from
			// event handlers. Keep the streaming fallback for direct agent activity
			// outside the scheduler.
			if (this.agent.state.isStreaming) {
				await this.agent.waitForIdle();
				continue;
			}
			break;
		}
	}

	#formatTtsrAbortReason(rules: Rule[]): string {
		const label = rules.length === 1 ? "rule" : "rules";
		const ruleNames = rules.map(rule => rule.name).join(", ");
		return `TTSR matched ${label}: ${ruleNames}`;
	}

	/** Get TTSR injection payload and clear pending injections. */
	#getTtsrInjectionContent(): { content: string; rules: Rule[] } | undefined {
		if (this.#pendingTtsrInjections.length === 0) return undefined;
		const rules = this.#pendingTtsrInjections;
		const content = rules
			.map(r =>
				prompt.render(ttsrInterruptTemplate, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: r.content,
				}),
			)
			.join("\n\n");
		this.#pendingTtsrInjections = [];
		return { content, rules };
	}

	/**
	 * Render a rule's file path for model-facing TTSR injections without leaking
	 * the absolute home directory: cwd-relative when the rule lives in the
	 * project, `~`-relative when it lives under home, else the raw path.
	 */
	#displayRulePath(rulePath: string): string {
		const cwdRel =
			relativePathWithinRoot(this.sessionManager.getCwd(), rulePath) ??
			this.#displayPathWithinRoot(this.sessionManager.getCwd(), rulePath);
		if (cwdRel) return cwdRel;
		const homeRel = relativePathWithinRoot(os.homedir(), rulePath);
		if (homeRel) return `~/${homeRel}`;
		return rulePath;
	}

	#displayPathWithinRoot(root: string, candidate: string): string | null {
		const relative = path.relative(path.resolve(root), path.resolve(candidate));
		return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
	}

	#addPendingTtsrInjections(rules: Rule[]): void {
		const seen = new Set(this.#pendingTtsrInjections.map(rule => rule.name));
		for (const rule of rules) {
			if (seen.has(rule.name)) continue;
			this.#pendingTtsrInjections.push(rule);
			seen.add(rule.name);
		}
	}

	/** Tool-call id whose argument deltas triggered a TTSR match, when known. */
	#extractTtsrToolCallId(matchContext: TtsrMatchContext): string | undefined {
		if (matchContext.source !== "tool") return undefined;
		const key = matchContext.streamKey;
		if (typeof key !== "string" || !key.startsWith("toolcall:")) return undefined;
		const id = key.slice("toolcall:".length);
		return id.length > 0 ? id : undefined;
	}

	#addPerToolTtsrInjections(toolCallId: string, rules: Rule[]): void {
		const bucket = this.#perToolTtsrInjections.get(toolCallId) ?? [];
		const seen = new Set(bucket.map(rule => rule.name));
		// Dedupe against rules already bucketed for other tool calls in this
		// same assistant message so one rule attaches to exactly one tool call.
		const claimedElsewhere = new Set<string>();
		for (const [otherId, otherBucket] of this.#perToolTtsrInjections) {
			if (otherId === toolCallId) continue;
			for (const rule of otherBucket) claimedElsewhere.add(rule.name);
		}
		const newlyAdded: string[] = [];
		for (const rule of rules) {
			if (seen.has(rule.name) || claimedElsewhere.has(rule.name)) continue;
			bucket.push(rule);
			seen.add(rule.name);
			newlyAdded.push(rule.name);
		}
		if (bucket.length === 0) return;
		this.#perToolTtsrInjections.set(toolCallId, bucket);
		// Claim the rules in the TTSR manager so subsequent deltas in this same
		// turn (e.g. a sibling tool call's argument stream) don't re-match them.
		// Persistence still happens in #ttsrAfterToolCall when the tool actually
		// produces a result we can fold the reminder into.
		if (newlyAdded.length > 0) {
			this.#ttsrManager?.markInjectedByNames(newlyAdded);
		}
	}

	/** `afterToolCall` hook: fold any per-tool TTSR reminders into the result. */
	#ttsrAfterToolCall(ctx: AfterToolCallContext): AfterToolCallResult | undefined {
		const rules = this.#perToolTtsrInjections.get(ctx.toolCall.id);
		if (!rules || rules.length === 0) return undefined;
		this.#perToolTtsrInjections.delete(ctx.toolCall.id);
		const reminder = rules
			.map(r =>
				prompt.render(ttsrToolReminderTemplate, {
					name: r.name,
					path: this.#displayRulePath(r.path),
					content: r.content,
				}),
			)
			.join("\n\n");
		// The TTSR manager was already claimed at bucket time; only persistence remains.
		const ruleNames = rules.map(r => r.name.trim()).filter(n => n.length > 0);
		if (ruleNames.length > 0) {
			this.sessionManager.appendTtsrInjection(ruleNames);
		}
		return {
			content: [{ type: "text", text: reminder }, ...ctx.result.content],
		};
	}

	#extractTtsrRuleNames(details: unknown): string[] {
		if (!details || typeof details !== "object" || Array.isArray(details)) {
			return [];
		}
		const rules = (details as { rules?: unknown }).rules;
		if (!Array.isArray(rules)) {
			return [];
		}
		return rules.filter((ruleName): ruleName is string => typeof ruleName === "string");
	}

	#markTtsrInjected(ruleNames: string[]): void {
		const uniqueRuleNames = Array.from(
			new Set(ruleNames.map(ruleName => ruleName.trim()).filter(ruleName => ruleName.length > 0)),
		);
		if (uniqueRuleNames.length === 0) {
			return;
		}
		this.#ttsrManager?.markInjectedByNames(uniqueRuleNames);
		this.sessionManager.appendTtsrInjection(uniqueRuleNames);
	}

	#findTtsrAssistantIndex(targetTimestamp: number | undefined): number {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") {
				continue;
			}
			if (targetTimestamp === undefined || message.timestamp === targetTimestamp) {
				return i;
			}
		}
		return -1;
	}

	#shouldInterruptForTtsrMatch(matches: Rule[], matchContext: TtsrMatchContext): boolean {
		const globalMode = this.#ttsrManager?.getSettings().interruptMode ?? "always";
		for (const rule of matches) {
			const mode = rule.interruptMode ?? globalMode;
			if (mode === "never") continue;
			if (mode === "prose-only" && (matchContext.source === "text" || matchContext.source === "thinking"))
				return true;
			if (mode === "tool-only" && matchContext.source === "tool") return true;
			if (mode === "always") return true;
		}
		return false;
	}

	#queueDeferredTtsrInjectionIfNeeded(assistantMsg: AssistantMessage): void {
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			// Tools that hadn't started by abort/error will never produce results to
			// fold injections into — drop their stale per-tool entries.
			this.#perToolTtsrInjections.clear();
		}
		if (this.#ttsrAbortPending || this.#pendingTtsrInjections.length === 0) {
			return;
		}
		if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") {
			this.#pendingTtsrInjections = [];
			return;
		}

		const injection = this.#getTtsrInjectionContent();
		if (!injection) {
			return;
		}
		this.agent.followUp({
			role: "custom",
			customType: "ttsr-injection",
			content: injection.content,
			display: false,
			details: { rules: injection.rules.map(rule => rule.name) },
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#ensureTtsrResumePromise();
		// Mark as injected after this custom message is delivered and persisted (handled in message_end).
		// followUp() only enqueues; resume on the next tick once streaming settles.
		this.#scheduleAgentContinue({
			delayMs: 1,
			generation: this.#promptGeneration,
			onSkip: () => {
				this.#resolveTtsrResume();
			},
			shouldContinue: () => {
				if (this.agent.state.isStreaming || !this.agent.hasQueuedMessages()) {
					this.#resolveTtsrResume();
					return false;
				}
				return true;
			},
			onError: () => {
				this.#resolveTtsrResume();
			},
		});
	}

	/** Extract the tool-call block a toolcall_delta event refers to, if present. */
	#getStreamingToolCallBlock(message: AgentMessage, contentIndex: number): ToolCall | undefined {
		if (message.role !== "assistant") {
			return undefined;
		}

		const content = message.content;
		if (!Array.isArray(content) || contentIndex < 0 || contentIndex >= content.length) {
			return undefined;
		}

		const block = content[contentIndex];
		if (!block || typeof block !== "object" || block.type !== "toolCall") {
			return undefined;
		}

		return block as ToolCall;
	}

	/** Build TTSR match context for tool call argument deltas. */
	#getTtsrToolMatchContext(toolCall: ToolCall | undefined, contentIndex: number): TtsrMatchContext {
		const context: TtsrMatchContext = { source: "tool" };
		if (!toolCall) {
			return context;
		}

		context.toolName = toolCall.name;
		context.streamKey = toolCall.id ? `toolcall:${toolCall.id}` : `tool:${toolCall.name}:${contentIndex}`;
		context.filePaths = this.#extractTtsrFilePathsFromArgs(toolCall.arguments);
		return context;
	}

	/**
	 * Match a stream delta against TTSR rules.
	 *
	 * Tool argument streams prefer the tool's `matcherDigest` normalization — the
	 * real content the call introduces — over the raw argument delta, so rule
	 * conditions written against source text keep working regardless of the
	 * tool's wire format (hashline patches, JSON-escaped strings, ...).
	 */
	#checkTtsrStream(delta: string, matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Rule[] {
		const manager = this.#ttsrManager;
		if (!manager) {
			return [];
		}
		const digest = this.#resolveTtsrMatcherDigest(toolCall);
		if (digest !== undefined) {
			return manager.checkSnapshot(digest, matchContext);
		}
		return manager.checkDelta(delta, matchContext);
	}

	/** Reconstruct the tool's normalized source snapshot via its `matcherDigest`, if any. */
	#resolveTtsrMatcherDigest(toolCall: ToolCall | undefined): string | undefined {
		if (!toolCall) {
			return undefined;
		}
		const tools = this.agent.state.tools;
		const tool =
			tools.find(t => t.name === toolCall.name) ??
			tools.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		return tool?.matcherDigest?.(toolCall.arguments ?? {});
	}

	/**
	 * Match ast-grep `astCondition` rules against the reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams expose a `matcherDigest`, which is the real source
	 * the call introduces; AST matching needs that (and a language inferred from the
	 * path argument), so non-digest streams never produce AST matches.
	 */
	async #checkTtsrAstStream(matchContext: TtsrMatchContext, toolCall: ToolCall | undefined): Promise<Rule[]> {
		const manager = this.#ttsrManager;
		if (!manager) {
			return [];
		}
		const digest = this.#resolveTtsrMatcherDigest(toolCall);
		if (digest === undefined) {
			return [];
		}
		return manager.checkAstSnapshot(digest, matchContext);
	}

	/**
	 * Route TTSR matches to either a per-tool injection or a stream-interrupting
	 * retry. Returns true when the stream was aborted and the caller should stop
	 * processing this event.
	 */
	#handleTtsrMatches(
		matches: Rule[],
		matchContext: TtsrMatchContext,
		targetMessageTimestamp: number | undefined,
	): boolean {
		// Decide first: a non-interrupting tool-source match attaches to the
		// specific tool call's result instead of driving a loop-wide follow-up.
		const shouldInterrupt = this.#shouldInterruptForTtsrMatch(matches, matchContext);
		const perToolId = shouldInterrupt ? undefined : this.#extractTtsrToolCallId(matchContext);
		if (perToolId) {
			this.#addPerToolTtsrInjections(perToolId, matches);
			this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
			return false;
		}

		// Queue rules for injection; mark as injected only after successful enqueue.
		this.#addPendingTtsrInjections(matches);
		if (!shouldInterrupt) {
			return false;
		}

		// Abort the stream immediately — do not gate on extension callbacks
		this.#ttsrAbortPending = true;
		this.#ensureTtsrResumePromise();
		this.agent.abort(this.#formatTtsrAbortReason(matches));
		// Notify extensions (fire-and-forget, does not block abort)
		this.#emitSessionEvent({ type: "ttsr_triggered", rules: matches }).catch(() => {});
		// Schedule retry after a short delay
		const retryToken = ++this.#ttsrRetryToken;
		const generation = this.#promptGeneration;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#ttsrRetryToken !== retryToken) {
					this.#resolveTtsrResume();
					return;
				}

				const targetAssistantIndex = this.#findTtsrAssistantIndex(targetMessageTimestamp);
				if (!this.#ttsrAbortPending || this.#promptGeneration !== generation || targetAssistantIndex === -1) {
					this.#ttsrAbortPending = false;
					this.#pendingTtsrInjections = [];
					this.#perToolTtsrInjections.clear();
					this.#resolveTtsrResume();
					return;
				}
				this.#ttsrAbortPending = false;
				this.#perToolTtsrInjections.clear();
				const ttsrSettings = this.#ttsrManager?.getSettings();
				if (ttsrSettings?.contextMode === "discard") {
					// Remove the partial/aborted assistant turn from agent state
					this.agent.replaceMessages(this.agent.state.messages.slice(0, targetAssistantIndex));
				}
				// Inject TTSR rules as system reminder before retry
				const injection = this.#getTtsrInjectionContent();
				if (injection) {
					const details = { rules: injection.rules.map(rule => rule.name) };
					this.agent.appendMessage({
						role: "custom",
						customType: "ttsr-injection",
						content: injection.content,
						display: false,
						details,
						attribution: "agent",
						timestamp: Date.now(),
					});
					this.sessionManager.appendCustomMessageEntry(
						"ttsr-injection",
						injection.content,
						false,
						details,
						"agent",
					);
					this.#markTtsrInjected(details.rules);
				}
				try {
					await this.agent.continue();
				} catch {
					this.#resolveTtsrResume();
				}
			},
			{ delayMs: 50 },
		);
		return true;
	}

	/** Extract path-like arguments from tool call payload for TTSR glob matching. */
	#extractTtsrFilePathsFromArgs(args: unknown): string[] | undefined {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			return undefined;
		}

		const rawPaths: string[] = [];
		for (const [key, value] of Object.entries(args)) {
			const normalizedKey = key.toLowerCase();
			if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
				rawPaths.push(value);
				continue;
			}
			if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
				for (const candidate of value) {
					if (typeof candidate === "string") {
						rawPaths.push(candidate);
					}
				}
			}
		}

		const normalizedPaths = rawPaths.flatMap(pathValue => this.#normalizeTtsrPathCandidates(pathValue));
		if (normalizedPaths.length === 0) {
			return undefined;
		}

		return Array.from(new Set(normalizedPaths));
	}

	/** Convert a path argument into stable relative/absolute candidates for glob checks. */
	#normalizeTtsrPathCandidates(rawPath: string): string[] {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const normalizedInput = trimmed.replaceAll("\\", "/");
		const candidates = new Set<string>([normalizedInput]);
		if (normalizedInput.startsWith("./")) {
			candidates.add(normalizedInput.slice(2));
		}

		const cwd = this.sessionManager.getCwd();
		const absolutePath = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
		candidates.add(absolutePath.replaceAll("\\", "/"));

		const relativePath = path.relative(cwd, absolutePath).replaceAll("\\", "/");
		if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
			candidates.add(relativePath);
		}

		return Array.from(candidates);
	}
	/** Find the last assistant message in agent state (including aborted ones) */
	#findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	#resetStreamingEditState(): void {
		this.#streamingEditAbortTriggered = false;
		this.#streamingEditCheckedLineCounts.clear();
		this.#streamingEditPrecheckedToolCallIds.clear();
		this.#streamingEditFileCache.clear();
	}

	#getStreamingEditToolCall(event: AgentEvent):
		| {
				toolCall: ToolCall;
				path: string;
				resolvedPath: string;
				diff?: string;
				op?: string;
				rename?: string;
		  }
		| undefined {
		if (event.type !== "message_update") return undefined;
		if (event.message.role !== "assistant") return undefined;

		const contentIndex = event.assistantMessageEvent.contentIndex ?? 0;
		const messageContent = event.message.content;
		if (!Array.isArray(messageContent) || contentIndex < 0 || contentIndex >= messageContent.length) {
			return undefined;
		}

		const toolCall = messageContent[contentIndex] as ToolCall;
		if (toolCall.name !== "edit") return undefined;

		const args = toolCall.arguments;
		if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
		if ("old_text" in args || "new_text" in args) return undefined;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) return undefined;

		// `local://` URLs (e.g. local://PLAN.md for plan-mode) resolve to a real
		// on-disk artifacts path; pre-caching works as long as we ask the
		// local-protocol handler. Other internal-scheme URLs (agent://, skill://,
		// rule://, mcp://, artifact://) have no stable filesystem representation;
		// skip pre-cache entirely for those — the edit tool itself will reject
		// them through its normal dispatch path.
		const resolvedPath = this.#resolveSessionFsPath(path);
		if (resolvedPath === undefined) return undefined;

		return {
			toolCall,
			path,
			resolvedPath,
			diff: typeof args.diff === "string" ? args.diff : undefined,
			op: typeof args.op === "string" ? args.op : undefined,
			rename: typeof args.rename === "string" ? args.rename : undefined,
		};
	}

	#lastStreamingEditToolCallId: string | undefined;
	#abortStreamingEditForAutoGeneratedPath(toolCall: ToolCall, path: string, resolvedPath: string): void {
		if (this.#lastStreamingEditToolCallId === toolCall.id) return;
		this.#lastStreamingEditToolCallId = toolCall.id;
		void assertEditableFile(resolvedPath, path).catch(err => {
			// peekFile and other I/O can reject with ENOENT, etc. Only ToolError means
			// auto-generated detection; other failures are left for the edit tool.
			if (!(err instanceof ToolError)) return;
			if (this.#lastStreamingEditToolCallId !== toolCall.id) return;

			if (!this.#streamingEditAbortTriggered) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to auto-generated file guard", {
					toolCallId: toolCall.id,
					path,
				});
				this.agent.abort();
			}
		});
	}

	#preCacheStreamingEditFile(event: AgentEvent): void {
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (
			assistantEvent.type !== "toolcall_start" &&
			assistantEvent.type !== "toolcall_delta" &&
			assistantEvent.type !== "toolcall_end"
		) {
			return;
		}

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit) return;

		// The auto-generated guard runs unconditionally: editing a generated file
		// is never the user's intent, and the cost of a false-positive abort is one
		// wasted turn vs. silently corrupting a regenerated source.
		const shouldCheckAutoGenerated =
			!streamingEdit.toolCall.id || !this.#streamingEditPrecheckedToolCallIds.has(streamingEdit.toolCall.id);
		if (shouldCheckAutoGenerated) {
			if (streamingEdit.toolCall.id) {
				this.#streamingEditPrecheckedToolCallIds.add(streamingEdit.toolCall.id);
			}
			this.#abortStreamingEditForAutoGeneratedPath(
				streamingEdit.toolCall,
				streamingEdit.path,
				streamingEdit.resolvedPath,
			);
		}

		// File-cache priming feeds #maybeAbortStreamingEdit's removed-lines check,
		// which is the optional patch-preview verification gated by
		// edit.streamingAbort. Skip the read when the setting is off.
		if (this.settings.get("edit.streamingAbort")) {
			this.#ensureFileCache(streamingEdit.resolvedPath);
		}
	}

	#ensureFileCache(resolvedPath: string): void {
		if (this.#streamingEditFileCache.has(resolvedPath)) return;

		try {
			const rawText = fs.readFileSync(resolvedPath, "utf-8");
			const { text } = stripBom(rawText);
			this.#streamingEditFileCache.set(resolvedPath, normalizeToLF(text));
		} catch {
			// Don't cache on read errors (including ENOENT) - let the edit tool handle them
		}
	}

	/** Invalidate cache for a file after an edit completes to prevent stale data */
	#invalidateFileCacheForPath(filePath: string): void {
		const resolvedPath = this.#resolveSessionFsPath(filePath);
		if (resolvedPath === undefined) return;
		this.#streamingEditFileCache.delete(resolvedPath);
	}

	/**
	 * Resolve a path supplied to a tool to a real filesystem path.
	 *
	 * - `local://` URLs route through the local-protocol handler so they map
	 *   onto the session's on-disk artifacts directory; pre-caching, ENOENT
	 *   handling, and post-edit invalidation all work normally.
	 * - Other internal-scheme URLs (agent://, skill://, rule://, mcp://,
	 *   artifact://) have no stable filesystem path; this returns `undefined`
	 *   so callers skip filesystem-only operations.
	 * - Cwd-relative and absolute paths resolve via `resolveToCwd`.
	 */
	#resolveSessionFsPath(filePath: string): string | undefined {
		const normalized = normalizeLocalScheme(filePath);
		if (normalized.startsWith("local:")) {
			return resolveLocalUrlToPath(normalized, this.#localProtocolOptions());
		}
		if (
			normalized.startsWith("agent://") ||
			normalized.startsWith("skill://") ||
			normalized.startsWith("rule://") ||
			normalized.startsWith("mcp://") ||
			normalized.startsWith("artifact://")
		) {
			return undefined;
		}
		return resolveToCwd(normalized, this.sessionManager.getCwd());
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.sessionManager.getArtifactsDir(),
			getSessionId: () => this.sessionManager.getSessionId(),
		};
	}

	#maybeAbortStreamingEdit(event: AgentEvent): void {
		if (!this.settings.get("edit.streamingAbort")) return;
		if (this.#streamingEditAbortTriggered) return;
		if (event.type !== "message_update") return;

		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type !== "toolcall_end" && assistantEvent.type !== "toolcall_delta") return;

		const streamingEdit = this.#getStreamingEditToolCall(event);
		if (!streamingEdit?.toolCall.id) return;

		const { toolCall, path, resolvedPath, diff, op, rename } = streamingEdit;
		if (!diff) return;
		if (op && op !== "update") return;

		if (!diff.includes("\n")) return;
		const lastNewlineIndex = diff.lastIndexOf("\n");
		if (lastNewlineIndex < 0) return;
		const diffForCheck = diff.endsWith("\n") ? diff : diff.slice(0, lastNewlineIndex + 1);
		if (diffForCheck.trim().length === 0) return;

		let normalizedDiff = normalizeDiff(diffForCheck.replace(/\r/g, ""));
		if (!normalizedDiff) return;
		// Deobfuscate the diff so removed lines match real file content
		if (this.#obfuscator) normalizedDiff = this.#obfuscator.deobfuscate(normalizedDiff);
		if (!normalizedDiff) return;
		const lines = normalizedDiff.split("\n");
		const hasChangeLine = lines.some(line => line.startsWith("+") || line.startsWith("-"));
		if (!hasChangeLine) return;

		const lineCount = lines.length;
		const lastChecked = this.#streamingEditCheckedLineCounts.get(toolCall.id);
		if (lastChecked !== undefined && lineCount <= lastChecked) return;
		this.#streamingEditCheckedLineCounts.set(toolCall.id, lineCount);

		const removedLines = lines
			.filter(line => line.startsWith("-") && !line.startsWith("--- "))
			.map(line => line.slice(1));
		if (removedLines.length > 0) {
			let cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			if (cachedContent === undefined) {
				this.#ensureFileCache(resolvedPath);
				cachedContent = this.#streamingEditFileCache.get(resolvedPath);
			}
			if (cachedContent !== undefined) {
				const missing = removedLines.find(line => !cachedContent.includes(normalizeToLF(line)));
				if (missing) {
					this.#streamingEditAbortTriggered = true;
					logger.warn("Streaming edit aborted due to patch preview failure", {
						toolCallId: toolCall.id,
						path,
						error: `Failed to find expected lines in ${path}:\n${missing}`,
					});
					this.agent.abort();
				}
				return;
			}
			if (assistantEvent.type === "toolcall_delta") return;
			void this.#checkRemovedLinesAsync(toolCall.id, path, resolvedPath, removedLines);
			return;
		}

		if (assistantEvent.type === "toolcall_delta") return;
		void this.#checkPreviewPatchAsync(toolCall.id, path, rename, normalizedDiff);
	}

	async #checkRemovedLinesAsync(
		toolCallId: string,
		path: string,
		resolvedPath: string,
		removedLines: string[],
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			const { text } = stripBom(await Bun.file(resolvedPath).text());
			const normalizedContent = normalizeToLF(text);
			const missing = removedLines.find(line => !normalizedContent.includes(normalizeToLF(line)));
			if (missing) {
				this.#streamingEditAbortTriggered = true;
				logger.warn("Streaming edit aborted due to patch preview failure", {
					toolCallId,
					path,
					error: `Failed to find expected lines in ${path}:\n${missing}`,
				});
				this.agent.abort();
			}
		} catch (err) {
			// Ignore ENOENT (file not found) - let the edit tool handle missing files
			// Also ignore other errors during async fallback
			if (!isEnoent(err)) {
				// Log unexpected errors but don't abort
			}
		}
	}

	async #checkPreviewPatchAsync(
		toolCallId: string,
		path: string,
		rename: string | undefined,
		normalizedDiff: string,
	): Promise<void> {
		if (this.#streamingEditAbortTriggered) return;
		try {
			await previewPatch(
				{ path, op: "update", rename, diff: normalizedDiff },
				{
					cwd: this.sessionManager.getCwd(),
					allowFuzzy: this.settings.get("edit.fuzzyMatch"),
					fuzzyThreshold: this.settings.get("edit.fuzzyThreshold"),
				},
			);
		} catch (error) {
			if (error instanceof ParseError) return;
			this.#streamingEditAbortTriggered = true;
			logger.warn("Streaming edit aborted due to patch preview failure", {
				toolCallId,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			this.agent.abort();
		}
	}

	#resetSessionStopContinuationState(): void {
		this.#sessionStopContinuationCount = 0;
		this.#sessionStopHookActive = false;
	}

	#clearPendingSessionStopContinuations(): void {
		if (!this.#pendingNextTurnMessages.some(message => message.customType === "session-stop-continuation")) {
			return;
		}
		this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(
			message => message.customType !== "session-stop-continuation",
		);
	}

	#sessionStopContinuationContext(result: SessionStopEventResult | undefined): string | undefined {
		if (!result) return undefined;
		const additionalContext =
			typeof result.additionalContext === "string" && result.additionalContext.length > 0
				? result.additionalContext
				: undefined;
		const reason = typeof result.reason === "string" && result.reason.length > 0 ? result.reason : undefined;
		if (result.continue === true) {
			return additionalContext ?? reason;
		}
		if (result.decision === "block") {
			return reason ?? additionalContext;
		}
		return undefined;
	}

	async #emitAgentEndNotification(messages: AgentMessage[]): Promise<void> {
		await this.#extensionRunner?.emit({ type: "agent_end", messages });
	}

	async #emitSessionStopEvent(messages: AgentMessage[]): Promise<void> {
		if (this.#agentKind === "sub" || !this.#extensionRunner?.hasHandlers("session_stop")) return;
		const generation = this.#promptGeneration;
		const result = await this.#extensionRunner.emitSessionStop({
			messages,
			turn_id: Math.max(0, this.#turnIndex - 1),
			last_assistant_message: this.getLastAssistantMessage(),
			session_id: this.sessionId,
			session_file: this.sessionFile,
			stop_hook_active: this.#sessionStopHookActive,
		});
		if (this.#promptGeneration !== generation || this.#abortInProgress || this.#isDisposed) {
			this.#resetSessionStopContinuationState();
			return;
		}
		const additionalContext = this.#sessionStopContinuationContext(result);
		if (!additionalContext) {
			this.#resetSessionStopContinuationState();
			return;
		}
		if (this.#sessionStopContinuationCount >= SESSION_STOP_CONTINUATION_CAP) {
			logger.warn("session_stop continuation cap reached", {
				sessionId: this.sessionId,
				cap: SESSION_STOP_CONTINUATION_CAP,
			});
			this.#resetSessionStopContinuationState();
			return;
		}
		this.#sessionStopContinuationCount++;
		this.#sessionStopHookActive = true;
		this.#queueHiddenNextTurnMessage(
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: additionalContext,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			},
			true,
		);
	}

	/** Emit extension events based on session events */
	async #emitExtensionEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.#extensionRunner) return;
		if (event.type === "agent_start") {
			this.#turnIndex = 0;
			await this.#extensionRunner.emit({ type: "agent_start" });
			return;
		}

		if (!this.#extensionRunner.hasHandlers(event.type)) return;
		if (event.type === "agent_end") {
			// `agent_end` extension notification is emitted from the settled
			// agent_end maintenance path so `session_stop` control hooks are not
			// blocked by unrelated notification-only work.
		} else if (event.type === "turn_start") {
			const hookEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.#turnIndex,
				timestamp: Date.now(),
			};
			await this.#extensionRunner.emit(hookEvent);
		} else if (event.type === "turn_end") {
			const hookEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.#turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.#extensionRunner.emit(hookEvent);
			this.#turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			await this.#extensionRunner.emit(extensionEvent);
		} else if (event.type === "auto_compaction_start") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_start",
				reason: event.reason,
				action: event.action,
			});
		} else if (event.type === "auto_compaction_end") {
			await this.#extensionRunner.emit({
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			});
		} else if (event.type === "auto_retry_start") {
			await this.#extensionRunner.emit({
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
			});
		} else if (event.type === "auto_retry_end") {
			await this.#extensionRunner.emit({
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
			});
		} else if (event.type === "ttsr_triggered") {
			await this.#extensionRunner.emit({ type: "ttsr_triggered", rules: event.rules });
		} else if (event.type === "todo_reminder") {
			await this.#extensionRunner.emit({
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			});
		} else if (event.type === "goal_updated") {
			await this.#extensionRunner.emit({
				type: "goal_updated",
				goal: event.goal,
				state: event.state,
			});
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this.#eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	subscribeCommandMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#commandMetadataChangedListeners.push(listener);
		return () => {
			const index = this.#commandMetadataChangedListeners.indexOf(listener);
			if (index !== -1) {
				this.#commandMetadataChangedListeners.splice(index, 1);
			}
		};
	}

	#notifyCommandMetadataChanged(): void {
		const listeners = [...this.#commandMetadataChangedListeners];
		for (const listener of listeners) {
			try {
				void listener();
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	#disconnectFromAgent(): void {
		if (this.#unsubscribeAgent) {
			this.#unsubscribeAgent();
			this.#unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	#reconnectToAgent(): void {
		if (this.#unsubscribeAgent) return; // Already connected
		this.#unsubscribeAgent = this.agent.subscribe(this.#handleAgentEvent);
	}

	#activeProviderSessionId(sessionId?: string): string {
		return this.#freshProviderSessionId ?? this.#providerSessionId ?? sessionId ?? this.sessionManager.getSessionId();
	}

	/**
	 * Set agent.sessionId from the session manager and install a dynamic
	 * metadata resolver so every Anthropic API request carries
	 * `metadata.user_id` shaped like real Claude Code's `getAPIMetadata` output:
	 * `{ session_id, account_uuid, device_id }`. `account_uuid` is included only
	 * when an Anthropic OAuth credential with a known account UUID is loaded;
	 * `device_id` is derived from both the persistent omp install id and that
	 * account UUID. Resolving live keeps the value in sync with auth-state changes
	 * (login/logout, token refresh that surfaces a new account UUID) without
	 * needing to re-call `#syncAgentSessionId()` on every such event.
	 */
	#syncAgentSessionId(sessionId?: string): void {
		const sid = this.#activeProviderSessionId(sessionId);
		this.agent.sessionId = sid;
		this.agent.setMetadataResolver((provider: string) =>
			buildSessionMetadata(sid, provider, this.#modelRegistry.authStorage),
		);
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (this.settings.get("memory.backend") !== "hindsight") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getHindsightSessionState()?.setSessionId(sid);
	}

	#rekeyMnemopiMemoryForCurrentSessionId(): void {
		if (this.settings.get("memory.backend") !== "mnemopi") return;
		const sid = this.agent.sessionId;
		if (!sid) return;
		this.getMnemopiSessionState()?.setSessionId(sid);
	}

	/** New session file: reset auto-recall / retain-threshold counters for the new transcript. */
	#resetHindsightConversationTrackingIfHindsight(): void {
		if (this.settings.get("memory.backend") !== "hindsight") return;
		const state = this.getHindsightSessionState();
		if (!state || state.aliasOf) return;
		state.resetConversationTracking();
	}

	#resetMnemopiConversationTrackingIfMnemopi(): void {
		if (this.settings.get("memory.backend") !== "mnemopi") return;
		const state = this.getMnemopiSessionState();
		if (!state || state.aliasOf) return;
		state.resetConversationTracking();
	}

	/** True once dispose() has begun; deferred background work (e.g. the deferred
	 *  MCP discovery task in sdk.ts) must not touch the session past this point. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	/**
	 * Synchronously mark the session as disposing so new work is rejected
	 * immediately: Python/eval starts throw, queued asides are dropped, and the
	 * aside provider is detached. Idempotent; `dispose()` runs it first.
	 *
	 * Wrappers that await other teardown before delegating to `dispose()` MUST
	 * call this before their first await — otherwise work started in that async
	 * gap slips past the disposal guards.
	 */
	beginDispose(): void {
		this.#isDisposed = true;
		this.#flushPendingIrcAsides();
		this.yieldQueue.clear();
		this.agent.setAsideMessageProvider(undefined);
		this.#stopAdvisorRuntime();
		this.#evalExecutionDisposing = true;
	}

	/**
	 * Remove all listeners, flush pending writes, and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	async dispose(): Promise<void> {
		this.beginDispose();
		try {
			if (this.#extensionRunner?.hasHandlers("session_shutdown")) {
				await this.#extensionRunner.emit({ type: "session_shutdown" });
			}
		} catch (error) {
			logger.warn("Failed to emit session_shutdown event", { error: String(error) });
		}
		// Abort post-prompt work so the drain below can complete. Without this, a
		// deferred-handoff task that has already advanced into
		// `await this.handoff(...) → generateHandoff(...)` keeps awaiting a live LLM stream
		// — Promise.allSettled() in #cancelPostPromptTasks then waits forever, freezing
		// /exit and Ctrl+C-double-tap. The post-prompt task's own AbortSignal does not
		// propagate into the inner handoff/compaction controllers, so we abort them
		// explicitly. agent.abort() is needed for an agent.continue() that may have
		// raced the deferred handoff (its streaming loop is awaited by the wrapper IIFE).
		//
		// Tool work (bash/eval/python) is NOT aborted here — those have their own
		// dispose paths and shared kernels are contractually allowed to survive a
		// session's dispose.
		this.abortRetry();
		this.abortCompaction();
		const postPromptDrain = this.#cancelPostPromptTasks();
		this.agent.abort();
		await postPromptDrain;
		// Cancel jobs this agent registered so a subagent's teardown doesn't
		// leak its background bash/task work into the parent's manager. Only
		// the session that owns the manager goes on to dispose it (which itself
		// nukes any leftover jobs and pending deliveries).
		this.#cancelOwnAsyncJobs();
		const ownedAsyncManager = this.#ownedAsyncJobManager;
		if (ownedAsyncManager) {
			const drained = await ownedAsyncManager.dispose({ timeoutMs: 3_000 });
			const deliveryState = ownedAsyncManager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
			if (AsyncJobManager.instance() === ownedAsyncManager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
		const pythonExecutionsSettled = await this.#prepareEvalExecutionsForDispose();
		if (!pythonExecutionsSettled) {
			logger.warn(
				"Detaching retained Python kernel ownership during dispose while Python execution is still active",
			);
		}
		await disposeKernelSessionsByOwner(this.#evalKernelOwnerId);
		await shutdownTinyTitleClient();
		this.#releasePowerAssertion();
		await this.sessionManager.close();
		// beginDispose() stopped the advisor and captured its recorder close; await
		// it so the final advisor turn is flushed before the process may exit.
		await this.#advisorRecorderClosed;
		this.#closeAllProviderSessions("dispose");
		// Disconnect the MCP manager this session OWNS so its stdio servers are
		// not orphaned at exit. Best-effort: a failure here must never throw out
		// of dispose. Only owning (top-level) sessions provide this callback;
		// subagents reuse a parent's manager and must not tear it down. Idempotent
		// with the deferred-discovery disconnect in `createAgentSession`.
		//
		// BOUNDED: an owned manager may hold an HTTP/SSE server whose session-
		// termination DELETE blocks up to the MCP request timeout (30s default,
		// unbounded when OMP_MCP_TIMEOUT_MS=0), so awaiting `disconnectAll()`
		// unbounded would stall /exit and print-mode shutdown on a broken remote
		// endpoint. Race it against a short deadline — stdio close (the subprocess
		// reap this targets) completes well within the bound; a slow transport
		// close is left to finish detached. Mirrors the bounded async-job teardown.
		if (this.#disconnectOwnedMcpManager) {
			try {
				await withTimeout(
					this.#disconnectOwnedMcpManager(),
					3_000,
					"Timed out disconnecting owned MCP manager during dispose",
				);
			} catch (error) {
				logger.warn("Failed to disconnect owned MCP manager during dispose", { error: String(error) });
			}
		}
		// Flush the retain queue BEFORE clearing the session's pointer so
		// `HindsightRetainQueue.#doFlush` still sees `session.getHindsightSessionState() === state`.
		// Reversed, the spliced batch survives just long enough to fail the
		// identity check and get dropped with a `session vanished` warning.
		const hindsightState = this.getHindsightSessionState();
		await hindsightState?.flushRetainQueue();
		this.setHindsightSessionState(undefined);
		hindsightState?.dispose();
		const mnemopiState = setMnemopiSessionState(this, undefined);
		await mnemopiState?.dispose();
		// Tear down the screenpipe poller (stops any in-flight poll and closes its
		// ledger). Startup is async, so wait for the manager to have been built
		// first — otherwise a dispose racing a slow start would leak the freshly
		// built poller. The manager itself serializes and awaits any in-flight
		// session re-bind. Best-effort: teardown must never throw out of dispose.
		if (this.#screenpipeManagerReady) {
			const ready = this.#screenpipeManagerReady;
			this.#screenpipeManagerReady = undefined;
			try {
				await ready;
				await this.#screenpipeManager?.dispose();
			} catch (error) {
				logger.warn("Failed to dispose screenpipe activity bridge", { error: String(error) });
			}
			this.#screenpipeManager = undefined;
		}
		// Tear down the embeddings subprocess AFTER mnemopi state.dispose:
		// consolidate-on-dispose may still call `embed()` to store the final
		// memories, and that round-trips through the worker we are about to
		// hard-kill (issue #3031).
		await shutdownMnemopiEmbedClient();
		// Drop a /move-minted session file that never gained real messages.
		// Best-effort: guarded inside cleanupEmptyMoveSession (owning marker +
		// still-current + still-empty), and never throws out of dispose.
		if (this.#movedFromEmptySessionFile) {
			try {
				await cleanupEmptyMoveSession(this.sessionManager, this.#movedFromEmptySessionFile);
			} catch (error) {
				logger.warn("Failed to clean up empty move session", { error: String(error) });
			}
			this.#movedFromEmptySessionFile = undefined;
		}
		this.#disconnectFromAgent();
		if (this.#unsubscribeAppendOnly) {
			this.#unsubscribeAppendOnly();
			this.#unsubscribeAppendOnly = undefined;
		}
		this.#eventListeners = [];
	}

	#closeAllProviderSessions(reason: string): void {
		for (const [providerKey, state] of this.#providerSessionState) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", {
					providerKey,
					reason,
					error: String(error),
				});
			}
		}

		this.#providerSessionState.clear();
	}

	freshSession(): FreshSessionResult | undefined {
		if (this.isStreaming) return undefined;
		const previousSessionId = this.sessionId;
		const closedProviderSessions = this.#providerSessionState.size;
		this.#closeAllProviderSessions("fresh session");
		this.#freshProviderSessionId = Bun.randomUUIDv7();
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#rekeyScreenpipeForCurrentSessionId();
		this.agent.appendOnlyContext?.invalidateForModelChange();
		return {
			previousSessionId,
			sessionId: this.sessionId,
			closedProviderSessions,
		};
	}

	/**
	 * Record that the current session file was minted empty by /move (see
	 * {@link SessionManager.createEmptySessionFile}). If it never gains a real
	 * user/assistant message, dispose deletes it via
	 * {@link cleanupEmptyMoveSession} so abandoned move targets don't litter
	 * the session directory.
	 */
	markMovedFromEmptySessionFile(sessionFile: string): void {
		this.#movedFromEmptySessionFile = sessionFile;
	}

	/**
	 * Serialize the current LLM request — model, system prompt, messages, and
	 * tool definitions exactly as the agent state holds them — to a JSON file
	 * in the OS tmp dir and return its path. Debug sidecar for /copy; the file
	 * persists on disk and may contain raw context/secrets.
	 */
	async dumpLlmRequestToTmpDir(): Promise<string> {
		const state = this.agent.state;
		const request = {
			sessionId: this.sessionId,
			timestamp: new Date().toISOString(),
			model: state.model ? { provider: state.model.provider, id: state.model.id, api: state.model.api } : undefined,
			systemPrompt: state.systemPrompt,
			messages: state.messages,
			tools: state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
		};
		const filePath = path.join(os.tmpdir(), `omp-llm-request-${this.sessionId}-${Date.now()}.json`);
		await fs.promises.writeFile(filePath, JSON.stringify(request, null, "\t"), { flag: "wx" });
		return filePath;
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model | undefined {
		return this.agent.state.model;
	}

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get thinkingLevel(): ThinkingLevel | undefined {
		return this.#thinkingLevel;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined {
		return this.#autoThinking ? AUTO_THINKING : this.#thinkingLevel;
	}

	/** True when `auto` thinking mode is active. */
	get isAutoThinking(): boolean {
		return this.#autoThinking;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedThinkingLevel(): Effort | undefined {
		return this.#autoResolvedLevel;
	}

	get serviceTier(): ServiceTier | undefined {
		return this.agent.serviceTier;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming || this.#promptInFlightCount > 0;
	}

	get isAborting(): boolean {
		return this.agent.isAborting;
	}

	/** Wait until streaming and deferred recovery work are fully settled. */
	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
		await this.#waitForPostPromptRecovery();
	}

	async drainAsyncJobDeliveriesForAcp(options?: { timeoutMs?: number }): Promise<boolean> {
		const manager = this.#asyncJobManager;
		if (!manager) return false;
		const ownerFilter = this.#agentId ? { ownerId: this.#agentId } : undefined;
		const before = manager.getDeliveryState(ownerFilter);
		if (before.queued === 0 && !before.delivering) return false;
		const previousAllowAcpAgentInitiatedTurns = this.#allowAcpAgentInitiatedTurns;
		this.#allowAcpAgentInitiatedTurns = true;
		try {
			const drained = await manager.drainDeliveries({ timeoutMs: options?.timeoutMs, filter: ownerFilter });
			const after = manager.getDeliveryState(ownerFilter);
			return drained && (before.queued !== after.queued || before.delivering !== after.delivering);
		} finally {
			this.#allowAcpAgentInitiatedTurns = previousAllowAcpAgentInitiatedTurns;
		}
	}

	/** Most recent assistant message in agent state. */
	getLastAssistantMessage(): AssistantMessage | undefined {
		return this.#findLastAssistantMessage();
	}
	/** Current effective system prompt blocks (includes any per-turn extension modifications) */
	get systemPrompt(): string[] {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this.#retryAttempt;
	}

	#collectDiscoverableMCPToolsFromRegistry(): Map<string, DiscoverableTool> {
		const mcpTools = filterBySource(collectDiscoverableTools(this.#toolRegistry.values()), "mcp");
		return new Map(mcpTools.map(tool => [tool.name, tool] as const));
	}

	#setDiscoverableMCPTools(discoverableMCPTools: Map<string, DiscoverableTool>): void {
		this.#discoverableMCPTools = discoverableMCPTools;
		this.#invalidateDiscoveryCaches();
	}

	/** Single point for invalidating cached discovery indices. Call after any change that can
	 *  affect which tools should be discoverable: registry mutations (refreshMCPTools,
	 *  refreshRpcHostTools) or active-tool mutations (#applyActiveToolsByName). */
	#invalidateDiscoveryCaches(): void {
		this.#discoverableToolSearchIndex = null;
	}

	#filterSelectableMCPToolNames(toolNames: Iterable<string>): string[] {
		return Array.from(toolNames).filter(
			name =>
				this.#discoverableMCPTools.has(name) &&
				this.#toolRegistry.has(name) &&
				this.#isToolNameAllowedByProfile(name),
		);
	}

	#getConfiguredDefaultSelectedMCPToolNames(): string[] {
		return this.#filterSelectableMCPToolNames([
			...this.#defaultSelectedMCPToolNames,
			...selectDiscoverableToolNamesByServer(
				this.#discoverableMCPTools.values(),
				this.#defaultSelectedMCPServerNames,
			),
		]);
	}

	#pruneSelectedMCPToolNames(): void {
		this.#selectedMCPToolNames = new Set(this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames));
	}

	#selectedMCPToolNamesMatch(left: string[], right: string[]): boolean {
		return left.length === right.length && left.every((name, index) => name === right[index]);
	}

	#rememberSessionDefaultSelectedMCPToolNames(
		sessionFile: string | null | undefined,
		toolNames: Iterable<string>,
	): void {
		if (!sessionFile) return;
		this.#sessionDefaultSelectedMCPToolNames.set(
			path.resolve(sessionFile),
			this.#filterSelectableMCPToolNames(toolNames),
		);
	}

	#getSessionDefaultSelectedMCPToolNames(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaultSelectedMCPToolNames.get(path.resolve(sessionFile)) ?? [];
	}

	#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames: string[]): void {
		if (!this.#mcpDiscoveryEnabled) return;
		const persistentSelections = (toolNames: Iterable<string>): string[] =>
			Array.from(toolNames).filter(name => !this.#turnDiscoveredToolNames.has(name));
		const previousPersistentMCPToolNames = persistentSelections(previousSelectedMCPToolNames);
		const nextSelectedMCPToolNames = persistentSelections(this.getSelectedMCPToolNames());
		if (this.#selectedMCPToolNamesMatch(previousPersistentMCPToolNames, nextSelectedMCPToolNames)) {
			return;
		}
		this.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames);
	}

	#getActiveNonMCPToolNames(): string[] {
		return this.getActiveToolNames().filter(name => !isMCPToolName(name) && this.#toolRegistry.has(name));
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map(t => t.name);
	}

	/** Whether the edit tool is registered in this session. */
	get hasEditTool(): boolean {
		return this.#toolRegistry.has("edit");
	}

	/**
	 * Get a tool by name from the registry.
	 */
	getToolByName(name: string): AgentTool | undefined {
		return this.#toolRegistry.get(name);
	}

	getXdevRegistry(): XdevRegistry | undefined {
		this.#reconcileXdevRegistry();
		return this.#xdevRegistry;
	}

	#reconcileXdevRegistry(): void {
		if (!this.settings.get("tools.xdev")) {
			this.#xdevRegistry = undefined;
			return;
		}
		this.#xdevRegistry ??= new XdevRegistry({
			enabled: true,
			sourceOf: name => (this.#rpcHostToolNames.has(name) ? "custom" : this.#toolSourceOf?.(name)),
		});
		this.#xdevRegistry.reconcile(
			Array.from(this.#toolRegistry.values()).filter(tool => this.#isToolNameAllowedByProfile(tool.name)),
		);
	}

	async executeXdevTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<XdevWriteResult> {
		const registry = this.getXdevRegistry();
		const tool = registry?.get(name);
		if (!registry || !tool) throw new ToolError(`Tool is not mounted under xd://: ${name}`);

		if (!this.getActiveToolNames().includes(name)) {
			await this.activateDiscoveredTools([name]);
			if (!this.getActiveToolNames().includes(name)) {
				throw new ToolError(`Mounted tool could not be activated: ${name}`);
			}
		}

		const result = await tool.execute(`xd-${name}-${crypto.randomUUID()}`, args, signal, undefined, context);
		if (result.isError) {
			const message = result.content
				.filter((block): block is TextContent => block.type === "text")
				.map(block => block.text)
				.join("\n");
			throw new ToolError(message || `xd://${name} execution failed`);
		}
		return {
			content: result.content.length > 0 ? result.content : [{ type: "text", text: "(tool returned no content)" }],
			details: result.details,
		};
	}

	/**
	 * Get all configured tool names (built-in via --tools or default, plus custom tools).
	 */
	getAllToolNames(): string[] {
		return Array.from(this.#toolRegistry.keys());
	}

	#getEditModeSession() {
		return {
			settings: this.settings,
			getActiveModelString: () => (this.model ? formatModelString(this.model) : undefined),
		} as const;
	}

	#resolveActiveEditMode(): EditMode {
		return resolveEditMode(this.#getEditModeSession());
	}

	/**
	 * Model key (`provider/id`) currently surfaced in the system prompt, or
	 * undefined when the model is unset or `includeModelInPrompt` is disabled.
	 */
	#currentPromptModelKey(): string | undefined {
		if (!this.settings.get("includeModelInPrompt")) return undefined;
		return this.model ? formatModelString(this.model) : undefined;
	}

	async #syncAfterModelChange(previousEditMode: EditMode): Promise<void> {
		const currentEditMode = this.#resolveActiveEditMode();
		const editModeChanged = previousEditMode !== currentEditMode && this.getActiveToolNames().includes("edit");
		// The system prompt may surface the active model; a switch makes the cached prompt stale.
		const modelChanged = this.#currentPromptModelKey() !== this.#promptModelKey;
		if (editModeChanged || modelChanged) {
			await this.refreshBaseSystemPrompt();
		}
	}

	isMCPDiscoveryEnabled(): boolean {
		return this.#mcpDiscoveryEnabled;
	}

	/**
	 * Flip MCP discovery on after deferred discovery learns the real tool count.
	 * UI sessions resolve `tools.discoveryMode: "auto"` before MCP servers
	 * connect, so a large MCP toolset discovered later must be able to upgrade
	 * the session from the force-activate path to the discovery path. One-way:
	 * discovery is never downgraded mid-session.
	 */
	enableMCPDiscovery(): void {
		this.#mcpDiscoveryEnabled = true;
	}

	getSelectedMCPToolNames(): string[] {
		if (!this.#mcpDiscoveryEnabled) {
			return this.getActiveToolNames().filter(name => isMCPToolName(name) && this.#toolRegistry.has(name));
		}
		return this.#filterSelectableMCPToolNames(this.#selectedMCPToolNames);
	}

	async #runDiscoveredToolMutation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#discoveredToolActivationChain.then(operation);
		this.#discoveredToolActivationChain = run.then(
			() => undefined,
			() => undefined,
		);
		return await run;
	}

	async activateDiscoveredMCPTools(toolNames: string[]): Promise<string[]> {
		return await this.#runDiscoveredToolMutation(async () => {
			const nextSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
			const activeNames = new Set(this.getActiveToolNames());
			const activated: string[] = [];
			const newlyMarkedNames: string[] = [];
			for (const name of toolNames) {
				if (
					!isMCPToolName(name) ||
					!this.#discoverableMCPTools.has(name) ||
					!this.#toolRegistry.has(name) ||
					!this.#isToolNameAllowedByProfile(name)
				) {
					continue;
				}
				if (!activeNames.has(name) && !this.#turnDiscoveredToolNames.has(name)) {
					this.#turnDiscoveredToolNames.add(name);
					newlyMarkedNames.push(name);
				}
				nextSelectedMCPToolNames.add(name);
				activated.push(name);
			}
			if (activated.length === 0) {
				return [];
			}
			const nextActive = [
				...this.#getActiveNonMCPToolNames(),
				...this.#filterSelectableMCPToolNames(nextSelectedMCPToolNames),
			];
			try {
				await this.#applyActiveToolsByName(nextActive, { persistMCPSelection: false });
			} catch (error) {
				for (const name of newlyMarkedNames) {
					this.#turnDiscoveredToolNames.delete(name);
				}
				throw error;
			}
			return [...new Set(activated)];
		});
	}

	// ── Generic tool discovery (covers built-in + MCP + extension) ────────────

	/** Resolve effective discovery mode from the current registry size and schema spend. */
	#resolveEffectiveDiscoveryMode(): "off" | "mcp-only" | "all" {
		const configuredMode = this.settings.get("tools.discoveryMode");
		if (configuredMode === "all" || configuredMode === "mcp-only") return configuredMode;
		if (this.settings.get("mcp.discoveryMode")) return "mcp-only";
		if (configuredMode !== "auto") return this.#mcpDiscoveryEnabled ? "mcp-only" : "off";

		// Auto mode alone needs schema accounting. The search tool's description is
		// derived from getDiscoverableTools(), which calls back into this resolver;
		// exclude that self-referential description just as the count excludes its
		// name. Explicit modes above never evaluate schemas at all.
		const toolsForSchemaEstimate = [...this.#toolRegistry.values()].filter(
			tool => tool.name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME,
		);
		const mode = resolveEffectiveToolDiscoveryMode(
			this.settings,
			countToolsForAutoDiscovery(this.#toolRegistry.keys()),
			estimateToolSchemaTokens(toolsForSchemaEstimate),
		);
		if (mode !== "off") return mode;
		return this.#mcpDiscoveryEnabled ? "mcp-only" : "off";
	}

	isToolDiscoveryEnabled(): boolean {
		return this.#resolveEffectiveDiscoveryMode() !== "off";
	}

	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		// For "all" mode we combine built-in registry entries + MCP tools.
		// For "mcp-only" mode we only return MCP tools.
		const mode = this.#resolveEffectiveDiscoveryMode();
		const activeNames = new Set(this.getActiveToolNames());
		const mcpTools = Array.from(this.#discoverableMCPTools.values()).filter(t => !activeNames.has(t.name));
		const builtinTools: DiscoverableTool[] = mode === "all" ? this.#collectDiscoverableBuiltinTools() : [];
		const allTools = [...builtinTools, ...mcpTools];
		return filter?.source ? allTools.filter(t => t.source === filter.source) : allTools;
	}

	/** Collect non-MCP discoverable tools for search_tool_bm25. Restricted to tool
	 *  definitions whose `loadMode === "discoverable"`. Labels by registration source
	 *  (via `#toolSourceOf`) so extension/custom tools are not mislabeled as built-ins. */
	#collectDiscoverableBuiltinTools(): DiscoverableTool[] {
		const activeNames = new Set(this.getActiveToolNames());
		const result: DiscoverableTool[] = [];
		for (const tool of this.#toolRegistry.values()) {
			if (tool.loadMode !== "discoverable") continue;
			if (activeNames.has(tool.name)) continue;
			if (isMCPToolName(tool.name)) continue;
			// With a registry classifier, unknown sources fail closed. Without one, a
			// registry tool that explicitly declared `loadMode: "discoverable"` counts
			// as built-in unless it is a known hidden/internal tool — declaring the
			// load mode is the opt-in.
			const source = this.#toolSourceOf
				? this.#toolSourceOf(tool.name)
				: tool.name in HIDDEN_TOOLS
					? "hidden"
					: "builtin";
			// Hidden/internal tools stay out of the discovery index.
			if (!source || source === "hidden") continue;
			const collected = collectDiscoverableTools([tool], { source });
			result.push(...collected);
		}
		return result;
	}

	getDiscoverableToolSearchIndex(): DiscoverableToolSearchIndex {
		if (!this.#discoverableToolSearchIndex) {
			this.#discoverableToolSearchIndex = buildDiscoverableToolSearchIndex(this.getDiscoverableTools());
		}
		return this.#discoverableToolSearchIndex;
	}

	getSelectedDiscoveredToolNames(): string[] {
		// Union of MCP-selected and generic non-MCP selected. Non-MCP selections are only
		// selected while they are still active; otherwise BM25 must be able to rediscover them.
		const activeNames = new Set(this.getActiveToolNames());
		const mcpSelected = this.getSelectedMCPToolNames();
		const nonMcpSelected = Array.from(this.#selectedDiscoveredToolNames).filter(
			name => activeNames.has(name) && this.#toolRegistry.has(name) && !isMCPToolName(name),
		);
		return [...new Set([...mcpSelected, ...nonMcpSelected])];
	}

	async #resetTurnDiscoveredTools(): Promise<void> {
		await this.#runDiscoveredToolMutation(async () => {
			if (this.#turnDiscoveredToolNames.size === 0) return;
			const discoveredNames = new Set(this.#turnDiscoveredToolNames);
			const nextActive = this.getActiveToolNames().filter(name => !discoveredNames.has(name));
			await this.#applyActiveToolsByName(nextActive, { persistMCPSelection: false });
			for (const name of discoveredNames) {
				this.#turnDiscoveredToolNames.delete(name);
			}
		});
	}

	async activateDiscoveredTools(toolNames: string[]): Promise<string[]> {
		return await this.#runDiscoveredToolMutation(() => this.#activateDiscoveredToolsWithinBudget(toolNames));
	}

	async #activateDiscoveredToolsWithinBudget(toolNames: string[]): Promise<string[]> {
		const currentActive = this.getActiveToolNames();
		const baseActive = currentActive.filter(name => !this.#turnDiscoveredToolNames.has(name));
		const baseActiveSet = new Set(baseActive);
		const requested = normalizeToolNames(toolNames).filter(
			name =>
				this.#toolRegistry.has(name) &&
				!baseActiveSet.has(name) &&
				this.#isToolNameAllowedByProfile(name) &&
				(isMCPToolName(name)
					? this.#discoverableMCPTools.has(name)
					: this.#toolRegistry.get(name)?.loadMode === "discoverable"),
		);
		if (requested.length === 0) return [];

		// New search matches take priority. Retain the newest tools from earlier
		// searches only while the complete active wire schema stays within budget.
		const requestedSet = new Set(requested);
		const older = Array.from(this.#turnDiscoveredToolNames)
			.reverse()
			.filter(name => !requestedSet.has(name) && this.#toolRegistry.has(name));
		const candidates = [...requested, ...older];
		const baseTools = baseActive.flatMap(name => {
			const tool = this.#toolRegistry.get(name);
			return tool ? [tool] : [];
		});
		let schemaTokens = estimateToolSchemaTokens(baseTools);
		const selected: string[] = [];
		for (const name of candidates) {
			const tool = this.#toolRegistry.get(name);
			if (!tool) continue;
			const toolTokens = estimateToolSchemaTokens([tool]);
			// A single required tool remains usable even when its own schema exceeds
			// the budget; subsequent discoveries replace it rather than accumulating.
			if (selected.length > 0 && schemaTokens + toolTokens > TOOL_DISCOVERY_SCHEMA_TOKEN_BUDGET) continue;
			selected.push(name);
			schemaTokens += toolTokens;
		}

		await this.#applyActiveToolsByName([...baseActive, ...selected], { persistMCPSelection: false });
		this.#turnDiscoveredToolNames.clear();
		for (const name of selected) {
			this.#turnDiscoveredToolNames.add(name);
			// Record non-MCP discoveries. `#applyActiveToolsByName` rebuilds the MCP
			// selection from the active set, but only ever *filters* the non-MCP one,
			// so without this the set stays empty and `getSelectedDiscoveredToolNames`
			// never reports a builtin that discovery just activated. Deactivation
			// still prunes it there, which is what lets BM25 rediscover the tool.
			if (!isMCPToolName(name)) this.#selectedDiscoveredToolNames.add(name);
		}
		return requested.filter(name => selected.includes(name));
	}

	/**
	 * Wrap a tool with a permission-gate proxy when an external client exposes
	 * `requestPermission`. Legacy ACP bridges retain the historical hard-coded
	 * bash/destructive-edit behavior. Bridges opting into `toolApprovalMode`
	 * instead gate every write/exec tier through normal approval metadata while
	 * read-tier calls pass through and explicit denies fail closed, independent
	 * of the session's global yolo setting.
	 */
	#wrapToolForAcpPermission<T extends AgentTool>(tool: T): T {
		const bridge = this.#clientBridge;
		// Match the capability+method gating pattern used by read/write/bash.
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) return tool;
		const bridgeApprovalMode = bridge.capabilities.toolApprovalMode;
		if (!bridgeApprovalMode && !PERMISSION_REQUIRED_TOOLS.has(tool.name)) return tool;
		// Preserve legacy ACP behavior when the bridge does not opt into generic
		// metadata-based gating. Explicit yolo still honours per-tool prompt/deny.
		if (!bridgeApprovalMode && this.#isExplicitAutoApproveMode()) {
			const userPolicies = (this.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
			const toolPolicy = userPolicies[tool.name];
			if (!toolPolicy || toolPolicy === "allow") return tool;
		}
		return new Proxy(tool, {
			get: (target, prop) => {
				if (prop !== "execute") return target[prop as keyof T];
				return async (
					toolCallId: string,
					args: unknown,
					signal: AbortSignal | undefined,
					onUpdate: never,
					ctx: never,
				) => {
					const userPolicies = (this.settings.get("tools.approval") ?? {}) as Record<string, unknown>;
					const resolvedApproval = bridgeApprovalMode
						? resolveApproval(target, args, bridgeApprovalMode, userPolicies)
						: undefined;
					if (resolvedApproval?.policy === "deny") {
						throw new ToolError(`Tool "${target.name}" is blocked by user policy`);
					}
					if (resolvedApproval?.tier === "read") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}

					const permissionIntent = bridgeApprovalMode
						? {
								title: truncateForPrompt(`Allow ${target.name}`, 200),
								cacheKey: `${target.name}:${resolvedApproval?.tier ?? "exec"}`,
							}
						: getPermissionIntent(target.name, args);
					if (!permissionIntent) {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					const command =
						target.name === "bash" && args && typeof args === "object" && !Array.isArray(args)
							? getStringProperty(args as Record<string, unknown>, "command")
							: undefined;
					const genericDetails = bridgeApprovalMode
						? formatClientBridgeApprovalDetails(target, args, resolvedApproval?.reason)
						: undefined;
					const callContent = genericDetails
						? [{ type: "content" as const, content: { type: "text" as const, text: genericDetails } }]
						: command
							? [{ type: "content" as const, content: { type: "text" as const, text: `$ ${command}` } }]
							: undefined;
					// Short-circuit on persisted decisions only after resolving the current
					// policy, so a newly configured explicit deny always remains authoritative.
					const persisted = this.#acpPermissionDecisions.get(permissionIntent.cacheKey);
					if (persisted === "allow_always") {
						return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
					}
					if (persisted === "reject_always") {
						throw new ToolError(`Tool call rejected by user (preference)`);
					}
					if (signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					type PermissionRaceResult =
						| { kind: "permission"; outcome: ClientBridgePermissionOutcome }
						| { kind: "aborted" };
					const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
					const onAbort = () => resolveAbort({ kind: "aborted" });
					signal?.addEventListener("abort", onAbort, { once: true });
					let raced: PermissionRaceResult;
					try {
						const permissionPromise = bridge.requestPermission!(
							{
								toolCallId,
								toolName: target.name,
								title: permissionIntent.title,
								...(resolvedApproval?.tier === "exec" || (!bridgeApprovalMode && target.name === "bash")
									? { kind: "execute" }
									: {}),
								status: "pending",
								rawInput: args,
								...(callContent ? { content: callContent } : {}),
								locations: extractPermissionLocations(
									args,
									this.sessionManager.getCwd(),
									"paths" in permissionIntent ? permissionIntent.paths : undefined,
								),
							},
							PERMISSION_OPTIONS,
							signal,
						).then(outcome => ({ kind: "permission" as const, outcome }));
						raced = await Promise.race([permissionPromise, abortPromise]);
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
					if (raced.kind === "aborted" || signal?.aborted) {
						throw new ToolAbortError("Permission request cancelled");
					}
					const outcome = raced.outcome;
					if (outcome.outcome === "cancelled") {
						throw new ToolAbortError("Permission request cancelled");
					}
					const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
					if (!selectedOption) {
						throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
					}
					if (selectedOption.kind === "allow_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "allow_always");
					} else if (selectedOption.kind === "reject_always") {
						this.#acpPermissionDecisions.set(permissionIntent.cacheKey, "reject_always");
					}
					if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
						throw new ToolError(`Tool call rejected by user (${target.name})`);
					}
					return await target.execute(toolCallId, args as never, signal, onUpdate, ctx);
				};
			},
		}) as T;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			(this.settings.isConfigured("tools.approvalMode") && this.settings.get("tools.approvalMode") === "yolo")
		);
	}

	/** Source-aware ceiling check for activation/refresh. Prefers registration source
	 *  (`#toolSourceOf`) over name-catalog inference; exact source only (no OR). */
	#isToolNameAllowedByProfile(name: string): boolean {
		if (!this.#toolProfile) return true;
		const source =
			this.#toolSourceOf?.(name) ??
			(this.#rpcHostToolNames.has(name)
				? "custom"
				: isMCPToolName(name)
					? "mcp"
					: name in BUILTIN_TOOLS
						? "builtin"
						: name in HIDDEN_TOOLS
							? "hidden"
							: undefined);
		return source !== undefined && isAllowedByToolProfile(this.#toolProfile, source, name);
	}

	#applyActiveToolsByName(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		const run = this.#applyActiveToolsChain.then(() => this.#applyActiveToolsByNameSerialized(toolNames, options));
		this.#applyActiveToolsChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #applyActiveToolsByNameSerialized(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		const previousSelectedMCPToolNames = options?.previousSelectedMCPToolNames ?? this.getSelectedMCPToolNames();
		const ceilingActive = this.#activeToolCeiling !== undefined;
		toolNames = normalizeToolNames(toolNames);
		if (ceilingActive) {
			toolNames = toolNames.filter(name => this.#activeToolCeiling?.has(name));
		}
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			if (!this.#isToolNameAllowedByProfile(name)) continue;
			const tool = this.#toolRegistry.get(name);
			if (tool) {
				tools.push(this.#wrapToolForAcpPermission(tool));
				validToolNames.push(name);
			}
		}
		// Auto-QA tool must survive runtime mutations only when not ceiling-restricted.
		if (
			isAutoQaEnabled(this.settings) &&
			!validToolNames.includes("report_tool_issue") &&
			this.#isToolNameAllowedByProfile("report_tool_issue") &&
			(!this.#activeToolCeiling || this.#activeToolCeiling.has("report_tool_issue"))
		) {
			const qaTool = this.#toolRegistry.get("report_tool_issue");
			if (qaTool) {
				tools.push(this.#wrapToolForAcpPermission(qaTool));
				validToolNames.push("report_tool_issue");
			}
		}
		const nextSelectedMCPToolNames = ceilingActive
			? this.#selectedMCPToolNames
			: this.#mcpDiscoveryEnabled
				? new Set(
						validToolNames.filter(
							name =>
								isMCPToolName(name) && this.#discoverableMCPTools.has(name) && this.#toolRegistry.has(name),
						),
					)
				: this.#selectedMCPToolNames;
		const activeNameSet = new Set(validToolNames);
		const nextSelectedDiscoveredToolNames = ceilingActive
			? this.#selectedDiscoveredToolNames
			: new Set(
					Array.from(this.#selectedDiscoveredToolNames).filter(
						name => activeNameSet.has(name) && !isMCPToolName(name) && this.#toolRegistry.has(name),
					),
				);

		// Rebuild base system prompt with new tool set, but only when the tool set
		// actually changed. MCP servers can reconnect at arbitrary times and call
		// `refreshMCPTools` -> `#applyActiveToolsByName` even though the resulting
		// tool list is byte-identical. Skipping the rebuild keeps the system prompt
		// stable, which is required for Anthropic prompt caching to keep hitting.
		if (this.#rebuildSystemPrompt) {
			const signature = this.#computeAppliedToolSignature(validToolNames, tools);
			if (signature !== this.#lastAppliedToolSignature) {
				const built = await this.#rebuildSystemPrompt(validToolNames, this.#toolRegistry);
				this.#baseSystemPrompt = built.systemPrompt;
				this.agent.setSystemPrompt(this.#baseSystemPrompt);
				this.#lastAppliedToolSignature = signature;
				this.#promptModelKey = this.#currentPromptModelKey();
			}
		}
		// Re-read the ceiling at commit time: it may have been installed while the
		// prompt rebuild above was awaited. Committing the stale wide set here
		// would pierce Ask mode for the rest of the session.
		const commitCeiling = this.#activeToolCeiling;
		const committedTools = commitCeiling ? tools.filter(tool => commitCeiling.has(tool.name.toLowerCase())) : tools;
		this.#selectedMCPToolNames = nextSelectedMCPToolNames;
		this.#selectedDiscoveredToolNames = nextSelectedDiscoveredToolNames;
		this.#invalidateDiscoveryCaches();
		this.agent.setTools(committedTools);
		if (options?.persistMCPSelection !== false && !this.#activeToolCeiling) {
			this.#persistSelectedMCPToolNamesIfChanged(previousSelectedMCPToolNames);
		}
	}

	/**
	 * Reload the SSH tool from disk-backed capability discovery and make the
	 * refreshed definition visible to the next model call without restarting.
	 */
	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		resetCapabilities();
		if (!this.#reloadSshTool) return;
		const previousSshTool = this.#toolRegistry.get("ssh");
		const previousActiveToolNames = this.getActiveToolNames();
		const hadSshTool = previousSshTool !== undefined;
		const wasActive = previousActiveToolNames.includes("ssh");
		const previousHostNames =
			previousSshTool && "hostNames" in previousSshTool && Array.isArray(previousSshTool.hostNames)
				? [...previousSshTool.hostNames]
				: [];
		const candidateHostNames = new Set(previousHostNames);
		const capability = await loadCapability<{ name: string }>("ssh", { cwd: this.sessionManager.getCwd() });
		for (const host of capability.items) {
			if (typeof host?.name === "string") {
				candidateHostNames.add(host.name);
			}
		}
		await invalidateHostMetadata(candidateHostNames);
		const sshAllowed = this.#requestedToolNames === undefined || this.#requestedToolNames.has("ssh");
		const refreshedTool = await this.#reloadSshTool();
		if (refreshedTool) {
			this.#toolRegistry.set(refreshedTool.name, refreshedTool);
		} else {
			this.#toolRegistry.delete("ssh");
			this.#selectedDiscoveredToolNames.delete("ssh");
		}

		const nextActive = previousActiveToolNames.filter(name => name !== "ssh" && this.#toolRegistry.has(name));
		if (refreshedTool && sshAllowed && (wasActive || (options?.activateIfAvailable && !hadSshTool))) {
			nextActive.push(refreshedTool.name);
		}
		await this.#applyActiveToolsByName(nextActive);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect before the next model call.
	 */
	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		await this.#runDiscoveredToolMutation(async () => {
			const normalizedToolNames = normalizeToolNames(toolNames);
			const promotedNames = normalizedToolNames.filter(name => this.#turnDiscoveredToolNames.delete(name));
			const previousSelectedMCPToolNames = this.getSelectedMCPToolNames().filter(
				name => !promotedNames.includes(name),
			);
			try {
				await this.#applyActiveToolsByName(normalizedToolNames, { previousSelectedMCPToolNames });
			} catch (error) {
				for (const name of promotedNames) {
					this.#turnDiscoveredToolNames.add(name);
				}
				throw error;
			}
		});
	}

	/** Apply an ephemeral runtime ceiling without persisting MCP selections. */
	async setActiveToolCeiling(
		toolNames: readonly string[] | undefined,
		desiredActiveNames: readonly string[] = this.getActiveToolNames(),
	): Promise<void> {
		const previousCeiling = this.#activeToolCeiling;
		this.#activeToolCeiling = toolNames ? new Set(toolNames.map(name => name.toLowerCase())) : undefined;
		try {
			await this.#applyActiveToolsByName([...desiredActiveNames], { persistMCPSelection: false });
		} catch (error) {
			this.#activeToolCeiling = previousCeiling;
			throw error;
		}
	}

	async #restoreMCPSelectionsForSessionContext(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#mcpDiscoveryEnabled) return;
		const nextActiveNonMCPToolNames = this.#getActiveNonMCPToolNames();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.#getConfiguredDefaultSelectedMCPToolNames();
		const restoredMCPToolNames = sessionContext.hasPersistedMCPToolSelection
			? this.#filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
			: this.#filterSelectableMCPToolNames(fallbackSelectedMCPToolNames);
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);
		await this.#applyActiveToolsByName([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}
	/** Rebuild the base system prompt using the current active tool set. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (!this.#rebuildSystemPrompt) return;
		const activeToolNames = this.getActiveToolNames();
		const built = await this.#rebuildSystemPrompt(activeToolNames, this.#toolRegistry);
		this.#baseSystemPrompt = built.systemPrompt;
		this.agent.setSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#currentPromptModelKey();
		// Refresh the cached signature so a subsequent `#applyActiveToolsByName` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#computeAppliedToolSignature(activeToolNames, activeTools);
	}

	async #buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		const backend = await resolveMemoryBackend(this.settings);
		if (backend.beforeAgentStartPrompt) {
			try {
				const injected = await backend.beforeAgentStartPrompt(this, promptText);
				if (injected) {
					this.#promotedMemoryPrompt = injected;
				}
			} catch (err) {
				logger.debug("Memory backend beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: String(err),
				});
			}
		}
		const promoted = this.#promotedMemoryPrompt;
		if (!promoted || this.#baseSystemPrompt.some(segment => segment.includes(promoted))) {
			return this.#baseSystemPrompt;
		}
		return [...this.#baseSystemPrompt, promoted];
	}

	/**
	 * Compose a stable signature for the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing identical signatures are guaranteed to produce identical
	 * system prompt bytes, so the rebuild can be skipped.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. When MCP discovery is on, every registry tool's name+label+description+
	 *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
	 *      tools that are not in the active set.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time `#applyActiveToolsByName` runs. Do not refactor `describeTool` to
	 * cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`, `secretsEnabled`). The
	 * closure-captured ones cannot change at runtime regardless of skip behavior.
	 * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
	 * after side-effecting changes; see e.g. the memory hooks and
	 * `#syncAfterModelChange`.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#computeAppliedToolSignature(toolNames: string[], tools: AgentTool[]): string {
		// Order-preserving join: any reorder must produce a different signature so
		// the rebuild fires and the new tool list reaches the API.
		const nameSegment = toolNames.join("\u0001");
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		const descriptionSegment = tools.map(describeTool).join("\u0002");
		let registrySegment = "";
		if (this.#mcpDiscoveryEnabled) {
			// Registry iteration order is not load-bearing for the prompt content, so we
			// sort to keep the signature insensitive to incidental insertion order.
			const entries: string[] = [];
			for (const tool of this.#toolRegistry.values()) {
				entries.push(describeTool(tool));
			}
			entries.sort();
			registrySegment = entries.join("\u0004");
		}
		let instructionsSegment = "";
		const serverInstructions = this.#getMcpServerInstructions?.();
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the signature.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			entries.sort();
			instructionsSegment = entries.join("\u0006");
		}
		const date = new Date().toISOString().slice(0, 10);
		return `${nameSegment}\u0003${descriptionSegment}\u0005${registrySegment}\u0007${instructionsSegment}|${date}`;
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 *
	 * @param mcpTools The new MCP tools to register.
	 * @param options.activateAll When true, force-activates every newly registered MCP tool
	 *   regardless of prior selection state. Used when an ACP client provisions MCP servers
	 *   for a session where MCP discovery is disabled.
	 */
	async refreshMCPTools(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		await this.#runDiscoveredToolMutation(async () => {
			mcpTools = mcpTools.filter(tool => this.#isToolNameAllowedByProfile(tool.name));
			const previousSelectedMCPToolNames = this.getSelectedMCPToolNames();
			const existingNames = Array.from(this.#toolRegistry.keys());
			for (const name of existingNames) {
				if (isMCPToolName(name)) {
					this.#toolRegistry.delete(name);
				}
			}

			const getCustomToolContext = (): CustomToolContext => ({
				sessionManager: this.sessionManager,
				modelRegistry: this.#modelRegistry,
				model: this.model,
				isIdle: () => !this.isStreaming,
				hasQueuedMessages: () => this.queuedMessageCount > 0,
				abort: () => {
					this.agent.abort();
				},
			});

			for (const customTool of mcpTools) {
				const wrapped = wrapToolWithMetaNotice(
					CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool,
				);
				const finalTool = (
					this.#extensionRunner ? new ExtensionToolWrapper(wrapped, this.#extensionRunner) : wrapped
				) as AgentTool;
				this.#toolRegistry.set(finalTool.name, finalTool);
			}
			this.#reconcileXdevRegistry();

			this.#setDiscoverableMCPTools(this.#collectDiscoverableMCPToolsFromRegistry());
			this.#pruneSelectedMCPToolNames();
			const sessionContext = this.buildDisplaySessionContext();
			const configuredDefaults = this.#getConfiguredDefaultSelectedMCPToolNames();
			if (!sessionContext.hasPersistedMCPToolSelection) {
				this.#selectedMCPToolNames = new Set([...this.#selectedMCPToolNames, ...configuredDefaults]);
			}
			this.#rememberSessionDefaultSelectedMCPToolNames(this.sessionFile, configuredDefaults);

			const newMcpNames = mcpTools.map(tool => tool.name).filter(name => this.#isToolNameAllowedByProfile(name));
			const durableMcpNames = new Set(
				options?.activateAll
					? newMcpNames
					: sessionContext.hasPersistedMCPToolSelection
						? this.#filterSelectableMCPToolNames(sessionContext.selectedMCPToolNames)
						: configuredDefaults,
			);
			const promotedNames = Array.from(durableMcpNames).filter(name => this.#turnDiscoveredToolNames.delete(name));
			try {
				if (options?.activateAll) {
					// Force-activate every newly registered MCP tool when discovery is disabled.
					const nextActive = [...new Set([...this.#getActiveNonMCPToolNames(), ...newMcpNames])];
					await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
					return;
				}

				const nextActive = [...this.#getActiveNonMCPToolNames(), ...this.getSelectedMCPToolNames()];
				await this.#applyActiveToolsByName(nextActive, { previousSelectedMCPToolNames });
			} catch (error) {
				for (const name of promotedNames) {
					this.#turnDiscoveredToolNames.add(name);
				}
				throw error;
			}
		});
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#toolRegistry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.getActiveToolNames();
		for (const name of previousRpcHostToolNames) {
			this.#toolRegistry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const metaWrapped = wrapToolWithMetaNotice(tool);
			const finalTool = (
				this.#extensionRunner ? new ExtensionToolWrapper(metaWrapped, this.#extensionRunner) : metaWrapped
			) as AgentTool;
			this.#toolRegistry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}
		this.#reconcileXdevRegistry();

		// Registry contents changed — invalidate discovery caches so the next BM25 lookup sees
		// the new RPC-host tool set. (#applyActiveToolsByName below also invalidates, but doing
		// it here too keeps the contract local to "registry mutated".)
		this.#invalidateDiscoveryCaches();

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.#applyActiveToolsByName(
			Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
		);
	}

	/** Whether auto-compaction is currently running */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/**
	 * Whether idle-flush tasks, auto-continuations, or other short-lived
	 * post-prompt work are pending.  True in the brief window after
	 * `session.prompt()` returns but before a scheduled background delivery
	 * (e.g. an async-job result) has finished its own streaming turn.
	 * Loop-mode and similar auto-submit paths should treat this as a block
	 * to avoid racing against the delivery turn.
	 */
	get hasPostPromptWork(): boolean {
		return this.#postPromptTasks.size > 0;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Latest image attachments addressable by tools as `Image #N` or `attachment://N`. */
	getImageAttachments(): { label: string; uri: string; image: ImageContent }[] {
		for (let i = this.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.agent.state.messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.map((image, index) => ({
				label: `Image #${index + 1}`,
				uri: `attachment://${index + 1}`,
				image,
			}));
		}
		return [];
	}

	buildDisplaySessionContext(): SessionContext {
		return deobfuscateSessionContext(this.sessionManager.buildSessionContext(), this.#obfuscator);
	}

	async resetToWarmPrefix(): Promise<void> {
		const sessionContext = this.buildDisplaySessionContext();
		const firstUserIndex = sessionContext.messages.findIndex(message => message.role === "user");
		const filteredMessages =
			firstUserIndex === -1 ? sessionContext.messages : sessionContext.messages.slice(0, firstUserIndex + 1);
		this.agent.replaceMessages(filteredMessages);
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.#pendingIrcAsides = [];
		this.#fusionToolFailureStreak = 0;
		this.#todoReminderCount = 0;
		this.#todoReminderAwaitingProgress = false;
		this.#retryAttempt = 0;
		logger.debug("Sidekick context reset to warm prefix");
	}
	/**
	 * Full-history transcript for TUI display: every path entry in
	 * chronological order with compactions rendered inline at the point they
	 * fired (instead of replacing prior history). Pass
	 * `collapseCompactedHistory: true` to render only the latest compacted
	 * tail (the live TUI surface); export/resume callers keep the full inline
	 * history. Display-only — NEVER feed the result to
	 * `agent.replaceMessages` or a provider.
	 */
	buildTranscriptSessionContext(options?: { collapseCompactedHistory?: boolean }): SessionContext {
		return deobfuscateSessionContext(
			this.sessionManager.buildSessionContext({
				transcript: true,
				collapseCompactedHistory: options?.collapseCompactedHistory,
			}),
			this.#obfuscator,
		);
	}

	#obfuscateTextArrayForProvider(value: readonly string[] | undefined): string[] | undefined {
		const obfuscator = this.#obfuscator;
		if (!value || !obfuscator?.hasSecrets()) return value ? [...value] : undefined;
		return value.map(text => obfuscator.obfuscate(text));
	}

	#obfuscateTextForProvider(text: string | undefined): string | undefined {
		if (!text || !this.#obfuscator?.hasSecrets()) return text;
		return this.#obfuscator.obfuscate(text);
	}

	#obfuscatePreserveDataForProvider(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		if (!preserveData || !this.#obfuscator?.hasSecrets()) return preserveData;
		const archive = snapcompact.getPreservedArchive(preserveData);
		if (!archive) return preserveData;
		return {
			...preserveData,
			[snapcompact.PRESERVE_KEY]: {
				...archive,
				text: this.#obfuscateTextForProvider(archive.text),
				textHead: this.#obfuscateTextForProvider(archive.textHead),
				textTail: this.#obfuscateTextForProvider(archive.textTail),
			} satisfies snapcompact.Archive,
		};
	}

	/** Remove legacy snapcompact frame archives from newly rebuilt context state. */
	#stripRetiredSnapcompactPreserveData(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		return snapcompact.stripPreservedArchive(preserveData);
	}

	#obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.#obfuscator?.hasSecrets()) return preparation;
		if (!preparation.previousSummary && !preparation.previousPreserveData) return preparation;
		return {
			...preparation,
			previousSummary: preparation.previousSummary
				? this.#obfuscator.obfuscate(preparation.previousSummary)
				: preparation.previousSummary,
			previousPreserveData: this.#obfuscatePreserveDataForProvider(preparation.previousPreserveData),
		};
	}

	#deobfuscateFromProvider(text: string): string {
		if (!this.#obfuscator?.hasSecrets()) return text;
		return this.#obfuscator.deobfuscate(text);
	}

	#deobfuscatedProviderTextReadyForDelta(text: string): string {
		const deobfuscated = this.#deobfuscateFromProvider(text);
		if (!this.#obfuscator?.hasSecrets()) return deobfuscated;
		const pendingPlaceholderStart = deobfuscated.match(/#[A-Z0-9]{0,4}$/);
		if (pendingPlaceholderStart?.index === undefined) return deobfuscated;
		return deobfuscated.slice(0, pendingPlaceholderStart.index);
	}

	#convertToLlmForSideRequest(messages: AgentMessage[]): Message[] {
		const converted = convertToLlm(messages);
		return this.#obfuscator ? obfuscateMessages(this.#obfuscator, converted) : converted;
	}

	/** Convert session messages using the same pre-LLM pipeline as the active session. */
	async convertMessagesToLlm(messages: AgentMessage[], signal?: AbortSignal): Promise<Message[]> {
		const transformedMessages = await this.#transformContext(messages, signal);
		return await this.#convertToLlm(transformedMessages);
	}

	/** Apply session-level stream hooks to a direct side request. */
	prepareSimpleStreamOptions(options: SimpleStreamOptions, provider = "anthropic"): SimpleStreamOptions {
		const sessionOnPayload = this.#onPayload;
		const sessionOnResponse = this.#onResponse;
		const sessionMetadata = this.agent.metadataForProvider(provider);
		const sessionOnSseEvent = this.#onSseEvent;
		const openrouterRoutingPreset =
			provider === "openrouter" ? this.settings.get("providers.openrouterVariant") : "default";
		const openrouterVariant =
			openrouterRoutingPreset !== "default" && options.openrouterVariant === undefined
				? openrouterRoutingPreset
				: undefined;
		const antigravityEndpointMode =
			provider === "google-antigravity" ? this.settings.get("providers.antigravityEndpoint") : undefined;

		const preparedOptions: SimpleStreamOptions = {
			...options,
			...(openrouterVariant !== undefined && { openrouterVariant }),
			...(antigravityEndpointMode !== undefined && { antigravityEndpointMode }),
			loopGuard: {
				enabled: this.settings.get("model.loopGuard.enabled"),
				checkAssistantContent: this.settings.get("model.loopGuard.checkAssistantContent"),
				...options.loopGuard,
			},
		};

		// Stamp session metadata (e.g. user_id={session_id}) onto direct-call requests so
		// they share the same session bucket as Agent.prompt-routed requests on Anthropic
		// OAuth. Caller-provided metadata wins so explicit overrides are respected.
		if (sessionMetadata && !options.metadata) {
			preparedOptions.metadata = sessionMetadata;
		}

		if (sessionOnPayload) {
			if (!options.onPayload) {
				preparedOptions.onPayload = sessionOnPayload;
			} else {
				const requestOnPayload = options.onPayload;
				preparedOptions.onPayload = async (payload, model) => {
					const sessionPayload = await sessionOnPayload(payload, model);
					const sessionResolvedPayload = sessionPayload ?? payload;
					const requestPayload = await requestOnPayload(sessionResolvedPayload, model);
					return requestPayload ?? sessionResolvedPayload;
				};
			}
		}

		if (sessionOnResponse) {
			if (!options.onResponse) {
				preparedOptions.onResponse = sessionOnResponse;
			} else {
				const requestOnResponse = options.onResponse;
				preparedOptions.onResponse = async (response, model) => {
					await sessionOnResponse(response, model);
					await requestOnResponse(response, model);
				};
			}
		}

		if (sessionOnSseEvent) {
			if (!options.onSseEvent) {
				preparedOptions.onSseEvent = sessionOnSseEvent;
			} else {
				const requestOnSseEvent = options.onSseEvent;
				preparedOptions.onSseEvent = (event, model) => {
					sessionOnSseEvent(event, model);
					requestOnSseEvent(event, model);
				};
			}
		}

		return preparedOptions;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.getSteeringMode();
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.getFollowUpMode();
	}

	/** Current interrupt mode */
	get interruptMode(): "immediate" | "wait" {
		return this.agent.getInterruptMode();
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.#activeProviderSessionId();
	}
	getEvalSessionId(): string | null {
		if (this.#parentEvalSessionId !== undefined) return this.#parentEvalSessionId;
		return defaultEvalSessionId({
			cwd: this.sessionManager.getCwd(),
			getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
		});
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
		return this.#scopedModels;
	}

	/** Prompt templates */
	getPlanModeState(): PlanModeState | undefined {
		return this.#planModeState;
	}

	setPlanModeState(state: PlanModeState | undefined): void {
		this.#planModeState = state;
		if (state?.enabled) {
			this.#planReferenceSent = false;
			this.#planReferencePath = state.planFilePath;
		}
	}

	getGoalModeState(): GoalModeState | undefined {
		return this.#goalModeState;
	}

	setGoalModeState(state: GoalModeState | undefined): void {
		this.#goalModeState = state;
	}

	get goalRuntime(): GoalRuntime {
		return this.#goalRuntime;
	}

	/**
	 * Track the warm Fusion sidekick's allocated agent id so the delegation prompt can
	 * address it precisely (it may be "Sidekick-2" on a resumed session) and the cost
	 * meter can read its real spend from the registry.
	 */
	setFusionSidekickId(id: string | undefined): void {
		this.#fusionSidekickId = id;
	}

	getFusionSidekickId(): string | undefined {
		return this.#fusionSidekickId;
	}

	/**
	 * Frontier-vs-sidekick token split for the Fusion meter. `sidekick` is the ACTUAL
	 * usage of the warm Fusion sidekick, read from its own (separate) session via the global
	 * registry — not inferred from `task` tool-results (which both miss the IRC-driven warm
	 * sidekick and over-count unrelated subagents). `frontier` is this main session's usage.
	 * Sidekick usage is zero when none is tracked/live (e.g. parked) — honest and conservative.
	 */
	getFusionUsageSplit(): UsageSplit {
		const frontier = this.sessionManager.getUsageStatistics();
		const ref = this.#fusionSidekickId ? AgentRegistry.global().get(this.#fusionSidekickId) : undefined;
		const sidekick = ref?.session?.sessionManager.getUsageStatistics() ?? emptyFusionUsage();
		return { total: sumFusionUsage(frontier, sidekick), frontier, sidekick };
	}

	markPlanReferenceSent(): void {
		this.#planReferenceSent = true;
	}

	setPlanReferencePath(path: string): void {
		this.#planReferencePath = path;
	}

	getPlanReferencePath(): string {
		return this.#planReferencePath;
	}

	/** Whether `name` is a genuine built-in registry tool (provenance, not the active set). */
	isBuiltInTool(name: string): boolean {
		return this.#builtInToolNames.has(name);
	}

	get clientBridge(): ClientBridge | undefined {
		return this.#clientBridge;
	}

	setClientBridge(bridge: ClientBridge | undefined): void {
		this.#clientBridge = bridge;
		this.#acpPermissionDecisions.clear();
		const activeToolNames = this.getActiveToolNames().filter(
			name => !this.#activeToolCeiling || this.#activeToolCeiling.has(name.toLowerCase()),
		);
		const activeTools = activeToolNames
			.map(name => this.#toolRegistry.get(name))
			.filter((tool): tool is AgentTool => tool !== undefined)
			.map(tool => this.#wrapToolForAcpPermission(tool));
		this.agent.setTools(activeTools);
	}

	getCheckpointState(): CheckpointState | undefined {
		return this.#checkpointState;
	}

	setCheckpointState(state: CheckpointState | undefined): void {
		this.#checkpointState = state;
		if (!state) {
			this.#pendingRewindReport = undefined;
		}
	}

	/**
	 * Inject the plan mode context message into the conversation history.
	 */
	async sendPlanModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = await this.#buildPlanModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	async sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void> {
		const message = this.#buildGoalModeMessage();
		if (!message) return;
		await this.sendCustomMessage(
			{
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				attribution: message.attribution,
			},
			options ? { deliverAs: options.deliverAs } : undefined,
		);
	}

	resolveRoleModel(role: string): Model | undefined {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model).model;
	}

	/**
	 * Resolve a role to its model AND thinking level.
	 * Unlike resolveRoleModel(), this preserves the thinking level suffix
	 * from role configuration (e.g., "anthropic/claude-sonnet-4-5:xhigh").
	 */
	resolveRoleModelWithThinking(role: string): ResolvedModelRoleValue {
		return this.#resolveRoleModelFull(role, this.#modelRegistry.getAvailable(), this.model);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace file-based slash commands used for prompt expansion. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands (TypeScript slash commands and MCP prompts) */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	/** Update the MCP prompt commands list. Called when server prompts are (re)loaded. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyCommandMetadataChanged();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Build a plan mode message.
	 * Returns null if plan mode is not enabled.
	 * @returns The plan mode message, or null if plan mode is not enabled.
	 */
	async #buildPlanReferenceMessage(): Promise<CustomMessage | null> {
		if (this.#planModeState?.enabled) return null;
		if (this.#planReferenceSent) return null;

		const planFilePath = this.#planReferencePath;
		const resolvedPlanPath = resolveLocalUrlToPath(planFilePath, this.#localProtocolOptions());
		let planContent: string;
		try {
			planContent = await Bun.file(resolvedPlanPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}

		const content = prompt.render(planModeReferencePrompt, {
			planFilePath,
			planContent,
		});

		this.#planReferenceSent = true;

		return {
			role: "custom",
			customType: "plan-mode-reference",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	async #buildPlanModeMessage(): Promise<CustomMessage | null> {
		const state = this.#planModeState;
		if (!state?.enabled) return null;
		const sessionPlanUrl = "local://PLAN.md";
		const resolvedPlanPath = state.planFilePath.startsWith("local:")
			? resolveLocalUrlToPath(normalizeLocalScheme(state.planFilePath), this.#localProtocolOptions())
			: resolveToCwd(state.planFilePath, this.sessionManager.getCwd());
		const resolvedSessionPlan = resolveLocalUrlToPath(sessionPlanUrl, this.#localProtocolOptions());
		const displayPlanPath =
			state.planFilePath.startsWith("local:") || resolvedPlanPath !== resolvedSessionPlan
				? state.planFilePath
				: sessionPlanUrl;

		const planExists = fs.existsSync(resolvedPlanPath);
		const content = prompt.render(planModeActivePrompt, {
			planFilePath: displayPlanPath,
			planExists,
			askToolName: "ask",
			writeToolName: "write",
			editToolName: "edit",
			reentry: state.reentry ?? false,
			iterative: state.workflow === "iterative",
		});

		return {
			role: "custom",
			customType: "plan-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#buildGoalModeMessage(): CustomMessage | null {
		const content = this.#goalRuntime.buildActivePrompt();
		if (!content) return null;
		return {
			role: "custom",
			customType: "goal-mode-context",
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	#normalizeImagesForModel(images: ImageContent[] | undefined): Promise<ImageContent[] | undefined> {
		return normalizeModelContextImages(images, { model: this.model });
	}

	/**
	 * Build a hidden companion message describing image attachments for a text-only
	 * model. Each image is saved under local:// and a vision-capable model describes
	 * it; the descriptions are returned as a `display: false` custom message (so the
	 * model reads them but the TUI does not render the blob) carrying one
	 * `<image path="local://…">…</image>` block per image. Returns `undefined` when
	 * the active model already accepts images, the feature is disabled, or no
	 * description could be produced. Never throws.
	 */
	async #buildImageDescriptionNotice(
		normalizedImages: ImageContent[],
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const model = this.model;
		const shouldDescribe =
			!!model &&
			!model.input.includes("image") &&
			!this.settings.get("images.blockImages") &&
			this.settings.get("images.describeForTextModels");
		if (!shouldDescribe || !model) {
			return undefined;
		}
		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(
				normalizedImages,
				{
					activeModel: model,
					modelRegistry: this.#modelRegistry,
					settings: this.settings,
					localProtocolOptions: this.#localProtocolOptions(),
					activeModelString: formatModelString(model),
					telemetryConfig: this.agent.telemetry,
					sessionId: this.sessionId,
				},
				signal,
			);
		} catch (err) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
		if (blocks.length === 0) {
			return undefined;
		}
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	async #normalizeMessageContentImages(
		content: string | (TextContent | ImageContent)[],
	): Promise<string | (TextContent | ImageContent)[]> {
		if (typeof content === "string") return content;
		const images = content.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) return content;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		if (!normalizedImages) return content;
		let imageIndex = 0;
		return content.map(part => (part.type === "image" ? normalizedImages[imageIndex++]! : part));
	}

	async #normalizeAgentMessageImages<T extends AgentMessage>(message: T): Promise<T> {
		if (!("content" in message)) return message;
		const content = message.content;
		if (typeof content !== "string" && !Array.isArray(content)) return message;
		const normalized = await this.#normalizeMessageContentImages(content as string | (TextContent | ImageContent)[]);
		if (normalized === content) return message;
		return { ...message, content: normalized } as T;
	}

	#magicKeywordEnabled(keyword: "orchestrate" | "ultrathink" | "workflow"): boolean {
		return this.settings.get("magicKeywords.enabled") && this.settings.get(`magicKeywords.${keyword}`);
	}

	/** Build immutable per-session root-turn state for executor, advisor, and completion-gate use. */
	#createActiveCompiledTaskContract(
		contract: TaskContractV1,
		gaps: readonly ContractGap[],
		assumptions: readonly AssumptionRecord[],
		pendingClarification: QuestionSpec | undefined,
		clarificationAnswered: boolean,
		unresolvedBlocked: boolean,
	): ActiveCompiledTaskContract {
		const digest = computeTaskContractDigest(contract);
		const injectedGaps = clarificationAnswered && !unresolvedBlocked ? [] : gaps;
		return Object.freeze({
			contract,
			digest,
			gaps: Object.freeze([...gaps]),
			assumptions: Object.freeze([...assumptions]),
			pendingClarification,
			clarificationAnswered,
			unresolvedBlocked,
			executorBlock: buildContractInjectionBlock(
				contract,
				digest,
				"executor",
				injectedGaps,
				assumptions,
				unresolvedBlocked,
			),
			advisorBlock: buildContractInjectionBlock(
				contract,
				digest,
				"advisor",
				injectedGaps,
				assumptions,
				unresolvedBlocked,
			),
		});
	}

	#activateCompiledTaskContract(contract: ActiveCompiledTaskContract | undefined): void {
		this.#activeCompiledTaskContract = contract;
		this.setActiveTaskContract(contract ? toActiveTaskContractSnapshot(contract.contract) : undefined);
	}

	#createTaskContractNotice(contract: ActiveCompiledTaskContract): CustomMessage {
		return {
			role: "custom",
			customType: "task-contract-notice",
			content: contract.executorBlock.text,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}

	/**
	 * Compile a root request into ephemeral runtime state and append its executor
	 * block to that turn. A pending material clarification consumes exactly one
	 * later user response; unresolved gaps remain context-only for the shared gate.
	 */
	#maybeCreateTaskContractNotice(text: string, synthetic?: boolean): CustomMessage | undefined {
		if (synthetic || this.#agentKind !== "main") return undefined;

		const active = this.#activeCompiledTaskContract;
		const startsFreshRootTask = startsWithSubstantialAction(text);
		if (active?.pendingClarification && !active.clarificationAnswered && !startsFreshRootTask) {
			const patchedContract = patchContractFromAnswer(active.contract, active.pendingClarification.field, text);
			const answer = text.trim();
			const answeredAssumptions = active.assumptions.map(assumption =>
				assumption.field === active.pendingClarification?.field
					? Object.freeze({
							...assumption,
							statement: `User-confirmed ${assumption.field}: "${answer}"`,
							confidence: 1,
							provenance: "explicit" as const,
							verified: true,
						})
					: assumption,
			);
			const answeredAssumptionsById = new Map(
				answeredAssumptions
					.filter(assumption => assumption.verified)
					.map(assumption => [assumption.id, assumption] as const),
			);
			const answeredContract = Object.freeze({
				...patchedContract,
				assumptions: Object.freeze(
					patchedContract.assumptions.map(assumption => {
						const answeredAssumption = answeredAssumptionsById.get(assumption.id);
						return answeredAssumption
							? Object.freeze({ ...assumption, statement: answeredAssumption.statement, verified: true })
							: assumption;
					}),
				),
			});
			const remainingGaps = active.gaps
				.filter(gap => gap.field !== active.pendingClarification?.field)
				.map(gap => Object.freeze({ ...gap, questionSpec: undefined }));
			const answered = this.#createActiveCompiledTaskContract(
				answeredContract,
				remainingGaps,
				answeredAssumptions,
				undefined,
				true,
				remainingGaps.length > 0,
			);
			this.#activateCompiledTaskContract(answered);
			return this.#createTaskContractNotice(answered);
		}

		if (!isSubstantialRequest(text)) return active ? this.#createTaskContractNotice(active) : undefined;
		const compiled = compileIntent(text);
		const next = this.#createActiveCompiledTaskContract(
			compiled.contract,
			compiled.unresolved,
			compiled.assumptions,
			compiled.topClarificationQuestion,
			false,
			false,
		);
		this.#activateCompiledTaskContract(next);
		return this.#createTaskContractNotice(next);
	}

	#createMagicKeywordNotices(text: string): CustomMessage[] {
		const timestamp = Date.now();
		const turnBudget = parseTurnBudget(text);
		this.sessionManager.beginTurnBudget(turnBudget?.total ?? null, turnBudget?.hard ?? false);
		const keywordNotices: CustomMessage[] = [];
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "ultrathink-notice",
				content: ULTRATHINK_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("orchestrate") && containsOrchestrate(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "orchestrate-notice",
				content: ORCHESTRATE_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		if (this.#magicKeywordEnabled("workflow") && containsWorkflow(text)) {
			keywordNotices.push({
				role: "custom",
				customType: "workflow-notice",
				content: WORKFLOW_NOTICE,
				display: false,
				attribution: "user",
				timestamp,
			});
		}
		return keywordNotices;
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	/**
	 * Returns `false` when the command was fully handled locally (extension or
	 * custom-TS command consumed without calling the LLM). Returns `true` when
	 * the prompt was forwarded to the agent — either directly or queued as a
	 * steer/follow-up. Callers that render a UI or manage turn lifecycle (e.g.
	 * the ACP agent) use this to know whether to expect an `agent_end` event.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<boolean> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const userInitiated = options?.userInitiated ?? !options?.synthetic;
		if (!this.isStreaming && userInitiated) {
			await this.#resetTurnDiscoveredTools();
		}

		// Handle extension commands first (execute immediately, even during streaming)
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this.#tryExecuteExtensionCommand(text);
			if (handled) {
				return false;
			}

			// Try custom commands (TypeScript slash commands)
			const customResult = await this.#tryExecuteCustomCommand(text);
			if (customResult !== null) {
				if (customResult === "") {
					return false;
				}
				text = customResult;
			}

			// Try file-based slash commands (markdown files from commands/ directories)
			// Only if text still starts with "/" (wasn't transformed by custom command)
			if (text.startsWith("/")) {
				text = expandSlashCommand(text, this.#slashCommands);
			}
		}

		// Expand file-based prompt templates if requested
		const expandedText = expandPromptTemplates ? expandPromptTemplate(text, [...this.#promptTemplates]) : text;

		// Magic keywords ("ultrathink", "orchestrate"): append hidden system notices after the
		// user's message that steer this turn. User-authored prompts only — synthetic /
		// agent-initiated turns never trigger them.
		const keywordNotices = options?.synthetic ? [] : this.#createMagicKeywordNotices(expandedText);

		// Root task contracts compile only on root user turns. A pending material
		// clarification consumes the next user response; later substantial root turns
		// replace the ephemeral contract and its shared completion-gate snapshot.
		const taskContractNotice = this.#maybeCreateTaskContractNotice(
			expandedText,
			options?.synthetic || options?.attribution === "agent",
		);

		// A user-initiated prompt (typed message or the `.`/`c` continue shortcut)
		// re-enables advisor auto-resume that a prior user interrupt suppressed.
		// Agent-initiated synthetic prompts (auto-continue, plan, reminders) do not.
		if (userInitiated) {
			this.#advisorAutoResumeSuppressed = false;
		}

		// If streaming, queue via steer() or followUp() based on option
		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			// Queue keyword and task-contract notices immediately before the user message
			// on the same delivery queue. A streaming follow-up must not activate a root
			// contract whose executor notice is stranded in #pendingNextTurnMessages:
			// the follow-up can be consumed by the live loop before that hidden notice.
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			if (taskContractNotice) {
				if (options.streamingBehavior === "followUp") {
					this.agent.followUp(taskContractNotice);
				} else {
					this.agent.steer(taskContractNotice);
				}
			}
			if (options.streamingBehavior === "followUp") {
				await this.#queueUserMessage(expandedText, options?.images, "followUp");
			} else {
				await this.#queueUserMessage(expandedText, options?.images, "steer");
			}
			return true;
		}

		// Skip eager preludes when the user has already queued a directive
		const hasPendingUserDirective = this.#toolChoiceQueue.inspect().includes("user-force");
		const eagerTodoPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTodoPrelude(expandedText) : undefined;
		const eagerTaskPrelude =
			!options?.synthetic && !hasPendingUserDirective ? this.#createEagerTaskPrelude(expandedText) : undefined;
		const normalizedImages = await this.#normalizeImagesForModel(options?.images);

		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
		if (normalizedImages?.length) {
			userContent.push(...normalizedImages);
		}
		// Text-only model + image attachment: describe via a vision model and inject the
		// description as a hidden companion (the image stays in the visible user message).
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;

		const promptAttribution = options?.attribution ?? (options?.synthetic ? "agent" : "user");
		const message = options?.synthetic
			? { role: "developer" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() }
			: { role: "user" as const, content: userContent, attribution: promptAttribution, timestamp: Date.now() };

		const preludeMessages: AgentMessage[] = [];
		if (eagerTodoPrelude) {
			if (eagerTodoPrelude.toolChoice) {
				this.#toolChoiceQueue.pushOnce(eagerTodoPrelude.toolChoice, {
					label: "eager-todo",
				});
			}
			preludeMessages.push(eagerTodoPrelude.message);
		}
		if (eagerTaskPrelude) {
			preludeMessages.push(eagerTaskPrelude);
		}

		try {
			await this.#promptWithMessage(message, expandedText, {
				...options,
				images: normalizedImages,
				prependMessages:
					preludeMessages.length > 0 || keywordNotices.length > 0 || imageDescriptionNotice || taskContractNotice
						? [
								...preludeMessages,
								...(taskContractNotice ? [taskContractNotice] : []),
								...keywordNotices,
								...(imageDescriptionNotice ? [imageDescriptionNotice] : []),
							]
						: undefined,
			});
		} finally {
			// Clean up residual eager-todo directive if the prompt never consumed it
			// (e.g., compaction aborted, validation failed).
			this.#toolChoiceQueue.removeByLabel("eager-todo");
		}
		if (!options?.synthetic) {
			await this.#enforcePlanModeToolDecision();
		}
		return true;
	}

	async promptCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: Pick<PromptOptions, "streamingBehavior" | "toolChoice"> & { queueChipText?: string },
	): Promise<void> {
		const textContent =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");

		let keywordNotices: CustomMessage[] = [];
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user") {
			const details = message.details;
			let skillArgs = "";
			if (details && typeof details === "object" && "args" in details && typeof details.args === "string") {
				skillArgs = details.args;
			}
			keywordNotices = this.#createMagicKeywordNotices(skillArgs);
		}

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new AgentBusyError();
			}
			for (const notice of keywordNotices) {
				await this.sendCustomMessage(notice, { deliverAs: options.streamingBehavior });
			}
			await this.sendCustomMessage(message, {
				deliverAs: options.streamingBehavior,
				queueChipText: options.queueChipText,
			});
			return;
		}

		const customMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};

		await this.#promptWithMessage(customMessage, textContent, {
			...options,
			prependMessages: keywordNotices.length > 0 ? keywordNotices : undefined,
		});
	}

	async #promptWithMessage(
		message: AgentMessage,
		expandedText: string,
		options?: Pick<PromptOptions, "toolChoice" | "images" | "skipCompactionCheck"> & {
			prependMessages?: AgentMessage[];
			skipPostPromptRecoveryWait?: boolean;
		},
	): Promise<void> {
		this.#beginInFlight();
		const generation = this.#promptGeneration;
		try {
			// Flush any pending bash messages before the new prompt
			this.#flushPendingBashMessages();
			this.#flushPendingPythonMessages();
			this.#flushPendingIrcAsides();

			// Reset todo reminder count on new user prompt
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			this.#completionGateReminderCount = 0;
			this.#completionGateAwaitingProgress = false;
			this.#emptyStopRetryCount = 0;
			this.#unexpectedStopRetryCount = 0;

			await this.#maybeRestoreRetryFallbackPrimary();

			// Validate model
			if (!this.model) {
				throw new Error(
					"No model selected.\n\n" +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}\n\n` +
						"Then use /model to select a model.",
				);
			}

			// Validate API key
			const apiKey = await this.#modelRegistry.getApiKey(this.model, this.sessionId);
			if (!apiKey) {
				throw new Error(
					`No API key found for ${this.model.provider}.\n\n` +
						`Use /login, set an API key environment variable, or create ${getAgentDbPath()}`,
				);
			}

			// Check if we need to compact before sending (catches aborted responses). Run
			// inline (allowDefer=false) so the handoff/maintenance fully settles before this
			// prompt's agent loop starts — otherwise a deferred handoff would fire on the
			// next microtask alongside the new turn.
			const lastAssistant = this.#findLastAssistantMessage();
			if (lastAssistant && !options?.skipCompactionCheck) {
				await this.#checkCompaction(lastAssistant, false, false, false);
			}

			// Build messages array (session context, eager todo prelude, then active prompt message)
			const messages: AgentMessage[] = [];
			const planReferenceMessage = await this.#buildPlanReferenceMessage?.();
			if (planReferenceMessage) {
				messages.push(planReferenceMessage);
			}
			const planModeMessage = await this.#buildPlanModeMessage();
			if (planModeMessage) {
				messages.push(planModeMessage);
			}
			const goalModeMessage = this.#buildGoalModeMessage();
			if (goalModeMessage) {
				messages.push(goalModeMessage);
			}
			if (options?.prependMessages) {
				messages.push(...options.prependMessages);
			}

			messages.push(message);

			// Early bail-out: if a newer abort/prompt cycle started during setup,
			// return before mutating shared state (nextTurn messages, system prompt).
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this.#pendingNextTurnMessages) {
				messages.push(msg);
			}
			this.#pendingNextTurnMessages = [];

			// Auto-read @filepath mentions
			const fileMentions = extractFileMentions(expandedText);
			if (fileMentions.length > 0) {
				const fileMentionMessages = await generateFileMentionMessages(fileMentions, this.sessionManager.getCwd(), {
					autoResizeImages: this.settings.get("images.autoResize"),
					useHashLines: resolveFileDisplayMode(this).hashLines,
					snapshotStore: getFileSnapshotStore(this),
				});
				for (const fileMentionMessage of fileMentionMessages) {
					messages.push(await this.#normalizeAgentMessageImages(fileMentionMessage));
				}
			}

			const beforeAgentStartSystemPrompt = await this.#buildSystemPromptForAgentStart(expandedText);

			// Emit before_agent_start extension event
			if (this.#extensionRunner) {
				const result = await this.#extensionRunner.emitBeforeAgentStart(
					expandedText,
					options?.images,
					beforeAgentStartSystemPrompt,
				);
				if (result?.messages) {
					const promptAttribution: "user" | "agent" | undefined =
						"attribution" in message ? message.attribution : undefined;
					for (const msg of result.messages) {
						messages.push(
							await this.#normalizeAgentMessageImages({
								role: "custom",
								customType: msg.customType,
								content: msg.content,
								display: msg.display,
								details: msg.details,
								attribution:
									msg.attribution ?? promptAttribution ?? (message.role === "user" ? "user" : "agent"),
								timestamp: Date.now(),
							}),
						);
					}
				}

				if (result?.systemPrompt !== undefined) {
					this.agent.setSystemPrompt(result.systemPrompt);
				} else {
					this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
				}
			} else {
				this.agent.setSystemPrompt(beforeAgentStartSystemPrompt);
			}

			// Bail out if a newer abort/prompt cycle has started since we began setup
			if (this.#promptGeneration !== generation) {
				return;
			}

			// Auto thinking: classify this real user turn and set the effective level
			// before the model request. Synthetic/tool-continuation turns (developer/
			// custom roles) and non-auto sessions are skipped. Never blocks the turn —
			// failures fall back to a concrete level inside the helper.
			if (this.#autoThinking && message.role === "user") {
				await this.#applyAutoThinkingLevel(expandedText, generation);
				if (this.#promptGeneration !== generation) {
					return;
				}
			}

			await this.#runPrePromptCompactionIfNeeded(messages);
			if (this.#promptGeneration !== generation) {
				return;
			}

			const agentPromptOptions = options?.toolChoice ? { toolChoice: options.toolChoice } : undefined;
			const nonMessageTokens = computeNonMessageTokens(this);
			const contextWindow = this.model?.contextWindow ?? 0;
			const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
			const promptTokens =
				breakdown?.usedTokens ??
				nonMessageTokens +
					this.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0) +
					messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
			this.#setPendingContextSnapshot({
				promptTokens,
				nonMessageTokens,
				cutoffCount: this.messages.length + messages.length,
			});
			try {
				await this.#promptAgentWithIdleRetry(messages, agentPromptOptions);
			} finally {
				this.#setPendingContextSnapshot(undefined);
			}
			if (!options?.skipPostPromptRecoveryWait) {
				await this.#waitForPostPromptRecovery(generation);
			}
		} finally {
			this.#endInFlight();
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	async #tryExecuteExtensionCommand(text: string): Promise<boolean> {
		if (!this.#extensionRunner) return false;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.#extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this.#extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this.#extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	#createCommandContext(): ExtensionCommandContext {
		if (this.#extensionRunner) {
			return this.#extensionRunner.createCommandContext();
		}

		return {
			ui: noOpUIContext,
			hasUI: false,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.#modelRegistry,
			model: this.model ?? undefined,
			models: createExtensionModelQuery(this.#modelRegistry, this.settings, () => this.model ?? undefined),
			getSetting: path => this.settings.get(path),
			isIdle: () => !this.isStreaming,
			abort: () => {
				void this.abort();
			},
			hasPendingMessages: () => this.queuedMessageCount > 0,
			shutdown: () => {
				void this.dispose();
				process.exit(0);
			},
			getContextUsage: () => this.getContextUsage(),
			waitForIdle: () => this.waitForIdle(),
			newSession: async options => {
				const success = await this.newSession({ parentSession: options?.parentSession });
				if (!success) {
					return { cancelled: true };
				}
				if (options?.setup) {
					await options.setup(this.sessionManager);
				}
				return { cancelled: false };
			},
			branch: async entryId => {
				const result = await this.branch(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await this.navigateTree(targetId, { summarize: options?.summarize });
				return { cancelled: result.cancelled };
			},
			compact: async instructionsOrOptions => {
				const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
				const options =
					instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
				await this.compact(instructions, options);
			},
			switchSession: async sessionPath => {
				const success = await this.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await this.reload();
			},
			getSystemPrompt: () => this.systemPrompt,
		};
	}

	/**
	 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
	 * If the command returns void, returns empty string to indicate it was handled.
	 */
	async #tryExecuteCustomCommand(text: string): Promise<string | null> {
		if (this.#customCommands.length === 0 && this.#mcpPromptCommands.length === 0) return null;

		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		// Find matching command
		const loaded =
			this.#customCommands.find(c => c.command.name === commandName) ??
			this.#mcpPromptCommands.find(c => c.command.name === commandName);
		if (!loaded) return null;

		// Get command context from extension runner (includes session control methods)
		const baseCtx = this.#createCommandContext();
		const ctx = {
			...baseCtx,
			hasQueuedMessages: baseCtx.hasPendingMessages,
		} as unknown as HookCommandContext;

		try {
			const args = parseCommandArgs(argsString);
			const result = await loaded.command.execute(args, ctx);
			// If result is a string, it's a prompt to send to LLM
			// If void/undefined, command handled everything
			return result ?? "";
		} catch (err) {
			// Emit error via extension runner
			if (this.#extensionRunner) {
				this.#extensionRunner.emitError({
					extensionPath: `custom-command:${commandName}`,
					event: "command",
					error: err instanceof Error ? err.message : String(err),
				});
			} else {
				const message = err instanceof Error ? err.message : String(err);
				logger.error("Custom command failed", { commandName, error: message });
			}
			return ""; // Command was handled (with error)
		}
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, "steer");
	}

	/**
	 * Queue a follow-up message to process after the agent would otherwise stop.
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		if (text.startsWith("/")) {
			this.#throwIfExtensionCommand(text);
		}

		const expandedText = expandPromptTemplate(text, [...this.#promptTemplates]);
		await this.#queueUserMessage(expandedText, images, "followUp");
	}

	async #queueUserMessage(
		text: string,
		images: ImageContent[] | undefined,
		mode: "steer" | "followUp",
	): Promise<void> {
		// A queued user message (RPC/SDK/collab steer or follow-up, or a typed message
		// while streaming) is a deliberate resume; re-enable advisor auto-resume that
		// a user interrupt suppressed.
		this.#advisorAutoResumeSuppressed = false;
		const normalizedImages = await this.#normalizeImagesForModel(images);
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (normalizedImages?.length) {
			content.push(...normalizedImages);
		}
		// Text-only model + image attachment: describe via a vision model and enqueue the
		// description as a hidden companion immediately before the user message.
		const imageDescriptionNotice = normalizedImages?.length
			? await this.#buildImageDescriptionNotice(normalizedImages)
			: undefined;
		if (mode === "followUp") {
			if (imageDescriptionNotice) this.agent.followUp(imageDescriptionNotice);
			this.agent.followUp({
				role: "user",
				content,
				attribution: "user",
				timestamp: Date.now(),
			});
		} else {
			if (imageDescriptionNotice) this.agent.steer(imageDescriptionNotice);
			this.agent.steer({
				role: "user",
				content,
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
		}
		this.#scheduleIdleQueueDrain();
	}

	#scheduleIdleQueueDrain(): void {
		this.#scheduleQueuedMessageDrain();
	}

	#scheduleQueuedMessageDrain(): void {
		if (this.#queuedMessageDrainScheduled || !this.#canAutoContinueForFollowUp() || !this.agent.hasQueuedMessages()) {
			return;
		}
		this.#queuedMessageDrainScheduled = true;
		this.#scheduleAgentContinue({
			shouldContinue: () => {
				this.#queuedMessageDrainScheduled = false;
				return this.#canAutoContinueForFollowUp() && this.agent.hasQueuedMessages();
			},
			onSkip: () => {
				this.#queuedMessageDrainScheduled = false;
			},
			onError: () => {
				this.#queuedMessageDrainScheduled = false;
			},
		});
	}

	/**
	 * Gate for idle-path queued-message auto-continue. See `#scheduleIdleQueueDrain` for rationale.
	 */
	#canAutoContinueForFollowUp(): boolean {
		if (this.isStreaming) return false;
		if (this.isRetrying) return false;
		// A queued steer resumes from ANY tail: Agent.continue() runs #runLoop(undefined),
		// whose initial steering poll injects the steer before the first provider call, so the
		// request tail becomes the steer (valid) regardless of any injected custom / bashExecution
		// / pythonExecution record a user interrupt left as the literal transcript tail. This is
		// why a queued user steer stranded behind a preserved advisor card (or a flushed IRC aside
		// / eval execution record) still resumes — no tail-role enumeration needed.
		if (this.agent.peekSteeringQueue().length > 0) return true;
		// Follow-up-only auto-resume stays suppressed while a deliberate user interrupt is in effect
		// (#advisorAutoResumeSuppressed, cleared on the next user prompt): the user stopped, so their
		// queued follow-up waits for an explicit resume — even if an interleaving IRC wake turn has
		// since left a provider-valid tail.
		if (this.#advisorAutoResumeSuppressed) return false;
		// Follow-up-only resume has no steer to inject, so Agent.continue() continues from the
		// existing context tail — which must itself be a valid provider tail. An injected
		// non-conversational tail (advisor card → `developer`, bash/python execution) would make
		// the first model call invalid, so leave the follow-up queued for the next explicit resume.
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	queueDeferredMessage(message: CustomMessage): void {
		this.#queueHiddenNextTurnMessage(message, true);
	}

	#queueHiddenNextTurnMessage(message: CustomMessage, triggerTurn: boolean): void {
		this.#pendingNextTurnMessages.push(message);
		if (!triggerTurn) return;
		const generation = this.#promptGeneration;
		if (this.#scheduledHiddenNextTurnGeneration === generation) {
			return;
		}
		this.#scheduledHiddenNextTurnGeneration = generation;
		this.#schedulePostPromptTask(
			async () => {
				if (this.#scheduledHiddenNextTurnGeneration === generation) {
					this.#scheduledHiddenNextTurnGeneration = undefined;
				}
				if (this.#pendingNextTurnMessages.length === 0) {
					return;
				}
				try {
					await this.#promptQueuedHiddenNextTurnMessages();
				} catch {
					// Leave the hidden next-turn messages queued for the next explicit prompt.
				}
			},
			{
				generation,
				onSkip: () => {
					if (this.#scheduledHiddenNextTurnGeneration === generation) {
						this.#scheduledHiddenNextTurnGeneration = undefined;
					}
				},
			},
		);
	}

	async #promptQueuedHiddenNextTurnMessages(): Promise<void> {
		if (this.#pendingNextTurnMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.#pendingNextTurnMessages];
		this.#pendingNextTurnMessages = [];
		const message = queuedMessages[queuedMessages.length - 1];
		if (!message) {
			return;
		}

		const prependMessages = queuedMessages.slice(0, -1);
		const textContent = this.#getCustomMessageTextContent(message);
		try {
			await this.#promptWithMessage(message, textContent, {
				prependMessages,
				skipPostPromptRecoveryWait: true,
			});
		} catch (error) {
			this.#pendingNextTurnMessages = [...queuedMessages, ...this.#pendingNextTurnMessages];
			throw error;
		}
	}

	#getCustomMessageTextContent(message: Pick<CustomMessage, "content">): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("");
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	#throwIfExtensionCommand(text: string): void {
		if (!this.#extensionRunner) return;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.#extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	async #promptAgentInitiatedMessage(message: CustomMessage): Promise<void> {
		this.#beginInFlight();
		try {
			await this.agent.prompt(message);
			await this.#waitForPostPromptRecovery();
		} finally {
			this.#endInFlight();
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queue as steer/follow-up or store for next turn
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn unless the client cannot own it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @returns true iff this call synchronously started a new turn (awaited
	 * `agent.prompt`); false when the message was queued/appended without a turn
	 * — including when `triggerTurn` is downgraded because the client defers
	 * agent-initiated turns. Callers that must mirror the resulting `agent_end`
	 * use this to avoid acting on a turn that never ran.
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn"; queueChipText?: string },
	): Promise<boolean> {
		const details =
			options?.queueChipText && options.deliverAs !== "nextTurn"
				? ({
						...((message.details && typeof message.details === "object" ? message.details : {}) as Record<
							string,
							unknown
						>),
						__queueChipText: options.queueChipText,
					} as T)
				: message.details;
		const appMessage: CustomMessage<T> = {
			role: "custom",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details,
			attribution: message.attribution ?? "agent",
			timestamp: Date.now(),
		};
		const normalizedAppMessage = await this.#normalizeAgentMessageImages(appMessage);
		if (this.isStreaming) {
			if (options?.deliverAs === "nextTurn") {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, options?.triggerTurn ?? false);
				return false;
			}

			if (options?.deliverAs === "followUp") {
				this.agent.followUp(normalizedAppMessage);
			} else {
				this.agent.steer(normalizedAppMessage);
			}
			this.#scheduleIdleQueueDrain();
			return false;
		}

		if (options?.deliverAs === "nextTurn") {
			if (options?.triggerTurn) {
				if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
					this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
					return false;
				}
				await this.#promptAgentInitiatedMessage(normalizedAppMessage);
				return true;
			}
			this.agent.appendMessage(normalizedAppMessage);
			if (normalizedAppMessage.customType !== "task-contract-notice") {
				this.sessionManager.appendCustomMessageEntry(
					normalizedAppMessage.customType,
					normalizedAppMessage.content,
					message.display,
					message.details,
					message.attribution ?? "agent",
				);
			}
			return false;
		}

		if (options?.triggerTurn) {
			if (this.#clientBridge?.deferAgentInitiatedTurns && !this.#allowAcpAgentInitiatedTurns) {
				this.#queueHiddenNextTurnMessage(normalizedAppMessage, false);
				return false;
			}
			await this.#promptAgentInitiatedMessage(normalizedAppMessage);
			return true;
		}

		this.agent.appendMessage(normalizedAppMessage);
		if (normalizedAppMessage.customType !== "task-contract-notice") {
			this.sessionManager.appendCustomMessageEntry(
				normalizedAppMessage.customType,
				normalizedAppMessage.content,
				message.display,
				message.details,
				message.attribution ?? "agent",
			);
		}
		return false;
	}

	/**
	 * Send a user message to the agent.
	 * When deliverAs is set, queue the message instead of starting a new turn.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		if (options?.deliverAs === "followUp") {
			await this.#queueUserMessage(text, images, "followUp");
			return;
		}
		if (options?.deliverAs === "steer") {
			await this.#queueUserMessage(text, images, "steer");
			return;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			images,
		});
	}

	/** Clear queued messages and return the user-restorable ones (text plus any attached images).
	 *  Only user-authored messages (plain user turns, `attribution:"user"` custom like `/skill`) are
	 *  returned for editor restore. Other queued messages stay in the agent-core queues so a continuing
	 *  stream still delivers them — EXCEPT on `forInterrupt` (Esc+abort), where only advisor cards are
	 *  kept (abort()'s #extractQueuedAdvisorCards preserves them as visible advice) and every other
	 *  non-user steer (hidden goal/plan/budget, IRC/extension asides) is dropped, so abort()'s
	 *  #drainStrandedQueuedMessages can't auto-resume the run the user just interrupted (the drain only
	 *  fires while agent.hasQueuedMessages()). Plain Alt+Up dequeue preserves those non-user steers. */
	clearQueue(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const steeringAll = this.agent.peekSteeringQueue();
		const followUpAll = this.agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		this.agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		const removedTaskContractNotice = [...steeringAll, ...followUpAll].some(
			message => message.role === "custom" && message.customType === "task-contract-notice",
		);
		if (removedTaskContractNotice) this.#activateCompiledTaskContract(undefined);
		return { steering, followUp };
	}

	/** Number of pending displayable messages (includes steering, follow-up, and next-turn messages).
	 *  Reflects actual queued work (advisor cards included) — feeds hasPendingMessages()/RPC and the
	 *  empty-submit abort gate. The user-restorable subset is surfaced by getQueuedMessages()/clearQueue(). */
	get queuedMessageCount(): number {
		return (
			this.agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			this.agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#pendingNextTurnMessages.length
		);
	}

	getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] } {
		return {
			steering: this.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: this.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	/**
	 * Pop the last queued message (steering first, then follow-up).
	 * Used by dequeue keybinding to restore messages to editor one at a time.
	 * Steps over agent-authored queued messages (advisor cards, hidden/internal steers).
	 */
	popLastQueuedMessage(): RestoredQueuedMessage | undefined {
		const steering = this.agent.peekSteeringQueue();
		const followUp = this.agent.peekFollowUpQueue();
		const lastUserIndex = (queue: readonly AgentMessage[]): number => {
			for (let i = queue.length - 1; i >= 0; i--) {
				if (isUserQueuedMessage(queue[i])) return i;
			}
			return -1;
		};
		// Notices queue immediately before their user message, so dropping the popped
		// prompt means also dropping the contiguous hidden-user companions right before
		// it — companions of other queued prompts stay put.
		const removeWithCompanions = (
			queue: readonly AgentMessage[],
			userIndex: number,
		): { queue: AgentMessage[]; removedTaskContractNotice: boolean } => {
			let start = userIndex;
			while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
			const removed = queue.slice(start, userIndex + 1);
			const next = queue.slice();
			next.splice(start, userIndex - start + 1);
			return {
				queue: next,
				removedTaskContractNotice: removed.some(
					message => message.role === "custom" && message.customType === "task-contract-notice",
				),
			};
		};
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			const removed = steering[fromSteer];
			const next = removeWithCompanions(steering, fromSteer);
			this.agent.replaceQueues(next.queue, followUp.slice());
			if (next.removedTaskContractNotice) this.#activateCompiledTaskContract(undefined);
			return toRestoredQueuedMessage(removed);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			const removed = followUp[fromFollowUp];
			const next = removeWithCompanions(followUp, fromFollowUp);
			this.agent.replaceQueues(steering.slice(), next.queue);
			if (next.removedTaskContractNotice) this.#activateCompiledTaskContract(undefined);
			return toRestoredQueuedMessage(removed);
		}
		return undefined;
	}

	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Skills loaded by SDK (empty if --no-skills or skills: [] was passed) */
	get skills(): readonly Skill[] {
		return this.#skills;
	}

	/** Skill loading warnings captured by SDK */
	get skillWarnings(): readonly SkillWarning[] {
		return this.#skillWarnings;
	}

	/**
	 * Re-discover skills from disk and propagate the new set everywhere it is
	 * read: `#skills`/`#skillWarnings` (prompt metadata + `/skill:*` commands),
	 * the SDK's prompt-closure snapshot (via `onSkillsChanged`), and the
	 * process-global active-skills registry that `skill://` reads resolve
	 * against. Returns false when the session was constructed with explicit
	 * `options.skills` — those are caller-owned and never re-discovered.
	 */
	async reloadSkills(): Promise<boolean> {
		if (!this.#reloadSkillsDiscovery) return false;
		const discovered = await this.#reloadSkillsDiscovery();
		this.#skills = discovered.skills;
		this.#skillWarnings = discovered.warnings ?? [];
		this.#onSkillsChanged?.(discovered.skills);
		await this.refreshBaseSystemPrompt();
		return true;
	}
	getTodoPhases(): TodoPhase[] {
		return this.#cloneTodoPhases(this.#todoPhases);
	}

	setTodoPhases(phases: TodoPhase[]): void {
		this.#todoPhases = this.#cloneTodoPhases(phases);
	}

	#syncTodoPhasesFromBranch(): void {
		const phases = getLatestTodoPhasesFromEntries(this.sessionManager.getBranch());
		// Strip completed/abandoned tasks — they were done in a previous run,
		// so they have no bearing on progress tracking for the new turn.
		for (const phase of phases) {
			phase.tasks = phase.tasks.filter(t => t.status !== "completed" && t.status !== "abandoned");
		}
		this.setTodoPhases(phases.filter(p => p.tasks.length > 0));
	}

	#cloneTodoPhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
		}));
	}

	// Auto-clear of completed/abandoned tasks was removed: the timer-driven
	// splice mutated canonical `#todoPhases` between tool calls, so the model
	// observed phase totals shrinking ("5 → 4") after marking tasks done. The
	// `tasks.todoClearDelay` setting is now inert; completed tasks survive
	// until the next explicit `todo` call removes them via `rm`/`drop`.

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * `reason` (e.g. `USER_INTERRUPT_LABEL`) rides the agent's `AbortController`
	 * and surfaces verbatim on the aborted assistant message's `errorMessage`, so
	 * the transcript can distinguish a deliberate user interrupt from an opaque
	 * abort. Omit it for internal/lifecycle aborts.
	 *
	 * `preserveCompaction` is for the manual `/compact` startup abort: the caller
	 * holds its own freshly installed `#compactionAbortController`, which this
	 * abort must NOT cancel. The in-flight auto-compaction pass IS still
	 * cancelled — synchronously, before this method's first await — so it cannot
	 * race the manual run and double-rewrite session history.
	 */
	async abort(options?: {
		goalReason?: "interrupted" | "internal";
		preserveCompaction?: boolean;
		reason?: string;
	}): Promise<void> {
		const userInterrupt = options?.reason === USER_INTERRUPT_LABEL;
		if (userInterrupt) this.#advisorAutoResumeSuppressed = true;
		// Pull advisor concerns out of the steer/follow-up queues before any await so
		// the post-abort stranded-message drain can't auto-resume the run on them.
		// They are re-recorded as visible advice once the agent settles (below).
		const strandedAdvisorCards = userInterrupt ? this.#extractQueuedAdvisorCards() : [];
		// Session switch/compact paths disconnect first; explicit aborts should
		// leave any queued steer/follow-up visible for the user rather than
		// auto-starting a fresh turn during cleanup.
		this.#abortInProgress = true;
		try {
			this.abortRetry();
			this.#promptGeneration++;
			this.#scheduledHiddenNextTurnGeneration = undefined;
			if (options?.preserveCompaction) {
				// Manual /compact startup: keep the caller's manual compaction
				// controller alive, but raise the auto-compaction abort signal now so
				// a parked auto pass observes it and unwinds without committing.
				this.#autoCompactionAbortController?.abort();
			} else {
				this.abortCompaction();
			}
			this.abortHandoff();
			this.abortBash();
			this.abortEval();
			const postPromptDrain = this.#cancelPostPromptTasks();
			this.agent.abort(options?.reason);
			await postPromptDrain;
			await this.agent.waitForIdle();
			await this.#goalRuntime.onTaskAborted({ reason: options?.goalReason ?? "interrupted" });
			// Clear prompt-in-flight state: waitForIdle resolves when the agent loop's finally
			// block runs, but nested prompt setup/finalizers may still be unwinding. Without this,
			// a subsequent prompt() can incorrectly observe the session as busy after an abort.
			this.#resetInFlight();
			this.#resetSessionStopContinuationState();
			this.#clearPendingSessionStopContinuations();
			// Safety net: if the agent loop aborted without producing an assistant
			// message (e.g. failed before the first stream), the in-flight yield was
			// never resolved or rejected by the normal message_end path. Reject it now
			// so any requeue callback still fires and the queue stays consistent.
			if (this.#toolChoiceQueue.hasInFlight) {
				this.#toolChoiceQueue.reject("aborted");
			}
			// Re-record advisor concerns the interrupt would otherwise strand, as
			// visible/persisted advice without triggering a turn (the agent is idle
			// now): cards steered into the queue before the user stopped, plus any
			// that arrived via enqueueAdvice mid-abort and were parked hidden in
			// #pendingNextTurnMessages while the turn was still tearing down. Other
			// deferred next-turn context (non-advisor) stays queued, in order.
			const parkedAdvisorCards = this.#pendingNextTurnMessages.filter(isAdvisorCard);
			if (parkedAdvisorCards.length > 0) {
				this.#pendingNextTurnMessages = this.#pendingNextTurnMessages.filter(m => !isAdvisorCard(m));
			}
			for (const card of [...strandedAdvisorCards, ...parkedAdvisorCards]) {
				this.#preserveAdvisorCard(card);
			}
		} finally {
			this.#abortInProgress = false;
			this.#drainStrandedQueuedMessages();
		}
	}

	/**
	 * Start a new session, optionally with initial messages and parent tracking.
	 * Clears all messages and starts a new session.
	 * Listeners are preserved and will continue receiving events.
	 * @param options - Optional initial messages and parent session path
	 * @returns true if completed, false if cancelled by hook
	 */
	async newSession(options?: NewSessionOptions): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "new" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}
		await this.#resetTurnDiscoveredTools();
		const nextDiscoverySessionToolNames = this.#mcpDiscoveryEnabled
			? [
					...this.#getActiveNonMCPToolNames(),
					...this.#filterSelectableMCPToolNames(this.#defaultSelectedMCPToolNames),
				]
			: undefined;

		const bgInstance = this.sessionManager.getBackgroundInstance();
		if (bgInstance && this.isStreaming && previousSessionFile) {
			this.#detachAsBackgroundAgent(bgInstance.name, previousSessionFile);
		} else {
			this.#disconnectFromAgent();
			await this.abort();
			this.#cancelOwnAsyncJobs();
			this.#closeAllProviderSessions("new session");
		}
		this.agent.reset();
		if (options?.drop && previousSessionFile) {
			// Detach the advisor recorder feed and drain its writer BEFORE deleting the
			// old artifacts dir: `await this.abort()` only stops the primary, so a still-
			// running advisor turn could otherwise finish, emit `message_end`, and recreate
			// `<old>/__advisor.jsonl`. #resetAdvisorSessionState (after newSession) re-primes
			// the advisor and re-attaches the feed at the new session's path.
			this.#advisorAgentUnsubscribe?.();
			this.#advisorAgentUnsubscribe = undefined;
			if (this.#advisorTranscriptRecorder) await this.#advisorTranscriptRecorder.close();
			try {
				await this.sessionManager.dropSession(previousSessionFile);
			} catch (err) {
				logger.error("Failed to delete session during /drop", { err });
			}
		} else {
			await this.sessionManager.flush();
		}
		await this.sessionManager.newSession(options);
		this.setTodoPhases([]);
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#rekeyScreenpipeForCurrentSessionId();
		this.#resetHindsightConversationTrackingIfHindsight();
		this.#resetMnemopiConversationTrackingIfMnemopi();
		this.#promotedMemoryPrompt = undefined;
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
		this.sessionManager.appendServiceTierChange(this.serviceTier ?? null);
		if (nextDiscoverySessionToolNames) {
			await this.#applyActiveToolsByName(nextDiscoverySessionToolNames, { persistMCPSelection: false });
			if (this.getSelectedMCPToolNames().length > 0) {
				this.sessionManager.appendMCPToolSelection(this.getSelectedMCPToolNames());
			}
		}
		this.#rememberSessionDefaultSelectedMCPToolNames(
			this.sessionFile,
			this.#getConfiguredDefaultSelectedMCPToolNames(),
		);

		this.#todoReminderCount = 0;
		this.#todoReminderAwaitingProgress = false;
		this.#planReferenceSent = false;
		this.#planReferencePath = "local://PLAN.md";
		this.setActiveTaskContract(undefined);
		this.#activateCompiledTaskContract(undefined);
		this.#resetAdvisorSessionState();
		this.#reconnectToAgent();

		// Emit session_switch event with reason "new" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "new",
				previousSessionFile,
			});
		}

		return true;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		return this.sessionManager.setSessionName(name, source);
	}

	/** Promote the current session into a persistent named background agent (resumable from the Agent Hub). */
	async backgroundCurrentSession(name: string): Promise<boolean> {
		const model = this.model ? `${this.model.provider}/${this.model.id}` : undefined;
		return await this.sessionManager.backgroundCurrentSession({ name, model, role: "default" });
	}

	/** Drop the current session out of the background roster (the session itself is preserved). */
	archiveBackgroundCurrentSession(): boolean {
		return this.sessionManager.archiveBackgroundInstance() !== undefined;
	}

	/**
	 * Detach the current running agent from the foreground and register it as a
	 * live background agent in the global registry. The agent continues running
	 * autonomously; the foreground session is free to switch to a new one.
	 */
	#detachAsBackgroundAgent(name: string, sessionFile: string): () => void {
		const agentId = `background:${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
		const registry = AgentRegistry.global();
		const registeredByThisCall = !registry.get(agentId);

		if (registeredByThisCall) {
			registry.register({
				id: agentId,
				displayName: name,
				kind: "sub",
				session: this as unknown as AgentSession,
				sessionFile,
				status: "running",
				cwd: this.sessionManager.getCwd(),
			});
		}

		const lifecycle = AgentLifecycleManager.global();
		const onEnd = () => {
			registry.setStatus(agentId, "idle");
			lifecycle.adopt(agentId, {
				idleTtlMs: 0,
				revive: async () => this as unknown as AgentSession,
			});
		};

		const agent = this.agent;
		let unsubscribeFromEnd: (() => void) | undefined;
		if (!agent.state.isStreaming) {
			onEnd();
		} else {
			unsubscribeFromEnd = agent.subscribe(event => {
				if (event.type !== "agent_end") return;
				unsubscribeFromEnd?.();
				unsubscribeFromEnd = undefined;
				onEnd();
			});
		}

		this.#disconnectFromAgent();
		logger.info("Detached background agent", { agentId, name, sessionFile });
		return () => {
			unsubscribeFromEnd?.();
			unsubscribeFromEnd = undefined;
			if (registeredByThisCall) registry.unregister(agentId);
			this.#reconnectToAgent();
		};
	}

	/**
	 * Fork the current session, creating a new session file with the exact same state.
	 * Copies all entries and artifacts to the new session.
	 * Unlike newSession(), this preserves all messages in the agent state.
	 * @returns true if completed, false if cancelled by hook or not persisting
	 */
	async fork(): Promise<boolean> {
		const previousSessionFile = this.sessionFile;

		// Emit session_before_switch event with reason "fork" (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "fork",
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		// Flush current session to ensure all entries are written
		await this.sessionManager.flush();

		// Fork the session (creates new session file with same entries)
		const forkResult = await this.sessionManager.fork();
		if (!forkResult) {
			return false;
		}

		// Copy artifacts directory if it exists
		const oldArtifactDir = forkResult.oldSessionFile.slice(0, -6);
		const newArtifactDir = forkResult.newSessionFile.slice(0, -6);

		try {
			const oldDirStat = await fs.promises.stat(oldArtifactDir);
			if (oldDirStat.isDirectory()) {
				await fs.promises.cp(oldArtifactDir, newArtifactDir, { recursive: true });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to copy artifacts during fork", {
					oldArtifactDir,
					newArtifactDir,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Update agent session ID
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#rekeyScreenpipeForCurrentSessionId();
		this.#resetMnemopiConversationTrackingIfMnemopi();
		this.#promotedMemoryPrompt = undefined;

		// Emit session_switch event with reason "fork" to hooks
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_switch",
				reason: "fork",
				previousSessionFile,
			});
		}

		return true;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs) and saves to the
	 * active session. Persists settings only when requested. The concrete key is
	 * resolved lazily per request, so switching never blocks the event loop.
	 * @throws Error if no API key available for the model
	 */
	async setModel(
		model: Model,
		role: string = "default",
		options?: { selector?: string; thinkingLevel?: ThinkingLevel; persist?: boolean },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		if (!this.#modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(`${model.provider}/${model.id}`, role);
		if (options?.persist) {
			this.settings.setModelRole(
				role,
				this.#formatRoleModelValue(role, model, options.selector, options.thinkingLevel),
			);
		}
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Re-apply thinking for the newly selected model. Prefer the model's
		// configured defaultLevel; otherwise preserve the current level (or auto).
		this.#reapplyThinkingLevel(model.thinking?.defaultLevel);
		await this.#syncAfterModelChange(previousEditMode);
	}

	/**
	 * Set model temporarily (for this session only).
	 * Validates that a credential source is configured (synchronously, without
	 * refreshing OAuth or running command-backed key programs), saves to session
	 * log but NOT to settings.
	 * @throws Error if no API key available for the model
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = this.#resolveActiveEditMode();
		if (!this.#modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(model);
		this.sessionManager.appendModelChange(
			`${model.provider}/${model.id}`,
			options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
		);
		this.settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);

		// Apply explicit thinking level if given; otherwise prefer the model's
		// configured defaultLevel; otherwise re-clamp the current level (or auto).
		if (thinkingLevel !== undefined) {
			this.setThinkingLevel(thinkingLevel);
		} else {
			this.#reapplyThinkingLevel(model.thinking?.defaultLevel);
		}
		await this.#syncAfterModelChange(previousEditMode);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	/**
	 * Resolve the configured role models in the given order plus the index of
	 * the currently active one. Roles that have no configured model, or whose
	 * configured model is not currently available, are skipped. The `default`
	 * role falls back to the active model when no explicit assignment exists.
	 *
	 * Returns `undefined` only when there is no current model or no available
	 * models at all; an empty `models` array is never returned (callers should
	 * still guard on `models.length`).
	 */
	getRoleModelCycle(roleOrder: readonly string[]): RoleModelCycle | undefined {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const matchPreferences = getModelMatchPreferences(this.settings);
		const models: ResolvedRoleModel[] = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.settings.getModelRole(role);
			if (!roleModelStr) continue;

			const resolved = resolveModelRoleValue(roleModelStr, availableModels, {
				settings: this.settings,
				matchPreferences,
				modelRegistry: this.#modelRegistry,
			});
			if (!resolved.model) continue;

			models.push({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
		}

		if (models.length === 0) return undefined;

		const lastRole = this.sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole ? models.findIndex(entry => entry.role === lastRole) : -1;
		if (currentIndex === -1) {
			currentIndex = models.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		}
		if (currentIndex === -1) currentIndex = 0;

		return { models, currentIndex };
	}

	/**
	 * Apply a resolved role model as the active model without changing global
	 * settings. Shared with role cycling and the plan-approval model slider.
	 */
	async applyRoleModel(entry: ResolvedRoleModel): Promise<void> {
		await this.setModel(entry.model, entry.role);
		if (entry.explicitThinkingLevel && entry.thinkingLevel !== undefined) {
			this.setThinkingLevel(entry.thinkingLevel);
		}
	}

	/**
	 * Cycle through configured role models in a fixed order.
	 * Skips missing roles and changes only the active session model.
	 * @param roleOrder - Order of roles to cycle through (e.g., ["slow", "default", "smol"])
	 * @param direction - "forward" (default) or "backward"
	 */
	async cycleRoleModels(
		roleOrder: readonly string[],
		direction: "forward" | "backward" = "forward",
	): Promise<RoleModelCycleResult | undefined> {
		const cycle = this.getRoleModelCycle(roleOrder);
		if (!cycle || cycle.models.length <= 1) return undefined;

		const step = direction === "backward" ? -1 : 1;
		const next = cycle.models[(cycle.currentIndex + step + cycle.models.length) % cycle.models.length];

		await this.applyRoleModel(next);

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel?: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel?: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		// Apply model
		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(next.model);
		this.sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		// Apply the scoped model's configured thinking level, preserving auto.
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : next.thinkingLevel);
		await this.#syncAfterModelChange(previousEditMode);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#resolveActiveEditMode();
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.#clearActiveRetryFallback();
		this.#setModelWithProviderSessionReset(nextModel);
		this.sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);
		// Re-apply the current thinking level (or auto) for the newly selected model
		this.#reapplyThinkingLevel();
		await this.#syncAfterModelChange(previousEditMode);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	/**
	 * Get all available models with valid API keys, filtered by `enabledModels` when configured.
	 * See {@link filterAvailableModelsByEnabledPatterns} for supported pattern forms and limitations.
	 */
	getAvailableModels(): Model[] {
		const all = this.#modelRegistry.getAvailable();
		const patterns = this.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns, this.#modelRegistry);
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	#applyThinkingLevelToAgent(level: ThinkingLevel | undefined): void {
		this.agent.setThinkingLevel(toReasoningEffort(level));
		this.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level. `auto` enables per-turn classification; resolved
	 * concrete levels are persisted alongside the `auto` selector when real user
	 * turns are classified, so resumed sessions restore `auto` pending and the
	 * next turn reclassifies.
	 */
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined, persist: boolean = false): void {
		if (level === AUTO_THINKING) {
			const provisional = resolveProvisionalAutoLevel(this.model);
			const wasAuto = this.#autoThinking;
			this.#autoThinking = true;
			this.#autoResolvedLevel = undefined;
			this.#thinkingLevel = provisional;
			this.#applyThinkingLevelToAgent(provisional);
			if (persist) {
				this.settings.set("defaultThinkingLevel", AUTO_THINKING);
			}
			if (!wasAuto || this.#thinkingLevel !== provisional) {
				// Persist the configured selector alongside the resolved level so a
				// resumed session restores "auto" rather than pinning the snapshot.
				this.sessionManager.appendThinkingLevelChange(provisional, AUTO_THINKING);
				this.#emit({ type: "thinking_level_changed", thinkingLevel: provisional, configured: AUTO_THINKING });
			}
			return;
		}
		const wasUltra = this.#thinkingLevel === ThinkingLevel.Ultra;
		const wasAuto = this.#autoThinking;
		this.#autoThinking = false;
		this.#autoResolvedLevel = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(this.model, level);
		const isChanging = wasAuto || effectiveLevel !== this.#thinkingLevel;

		this.#thinkingLevel = effectiveLevel;
		this.#applyThinkingLevelToAgent(effectiveLevel);

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
				this.settings.set("defaultThinkingLevel", effectiveLevel);
			}
			this.#emit({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
			if (wasUltra !== (effectiveLevel === ThinkingLevel.Ultra)) {
				void this.refreshBaseSystemPrompt();
			}
		}
	}

	/**
	 * Returns true if the session is running in Ultra mode (maximum reasoning
	 * with automatic proactive task delegation).
	 */
	isUltraMode(): boolean {
		return this.#thinkingLevel === ThinkingLevel.Ultra || this.configuredThinkingLevel() === ThinkingLevel.Ultra;
	}
	/**
	 * Re-apply the active thinking selection after a model change. Preserves `auto`
	 * (re-clamping the provisional level to the new model); otherwise re-applies the
	 * preferred default or the current effective level.
	 */
	#reapplyThinkingLevel(preferredDefault?: ThinkingLevel): void {
		this.setThinkingLevel(this.#autoThinking ? AUTO_THINKING : (preferredDefault ?? this.#thinkingLevel));
	}

	/**
	 * Cycle to next thinking level: off → auto → minimal..xhigh → off.
	 * @returns New selector, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ConfiguredThinkingLevel | undefined {
		if (!this.model?.reasoning) return undefined;

		const available = this.getAvailableThinkingLevels();
		const levels: ConfiguredThinkingLevel[] = [
			ThinkingLevel.Off,
			AUTO_THINKING,
			...available,
			...(available.includes(Effort.Ultra) ? [] : [ThinkingLevel.Ultra]),
		];
		const configured = this.configuredThinkingLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/** Timeout (ms) for per-turn auto-thinking classification before falling back. */
	static readonly #AUTO_THINKING_TIMEOUT_MS = 4000;

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * Bounded by a timeout + abort; on any failure (no smol model, timeout, parse
	 * error) it falls back to the provisional concrete level and continues. Never
	 * throws into the turn, and never clears `#autoThinking` (auto stays active).
	 */
	async #applyAutoThinkingLevel(promptText: string, generation: number): Promise<void> {
		const model = this.model;
		if (!model?.reasoning) return;

		let resolved: Effort | undefined;
		if (this.#magicKeywordEnabled("ultrathink") && containsUltrathink(promptText)) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// and jump straight to the highest auto-supported level for this model.
			resolved = clampAutoThinkingEffort(model, Effort.XHigh);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), AgentSession.#AUTO_THINKING_TIMEOUT_MS);
			try {
				resolved = await classifyDifficulty(promptText, {
					settings: this.settings,
					registry: this.#modelRegistry,
					model,
					sessionId: this.sessionId,
					signal: controller.signal,
					metadataResolver: provider => this.agent.metadataForProvider(provider),
				});
			} catch (error) {
				logger.debug("auto-thinking: classification failed; using fallback level", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#promptGeneration !== generation || !this.#autoThinking) return;

		const effort = resolved ?? resolveProvisionalAutoLevel(model);
		if (effort === undefined) return;
		const shouldPersistResolution = this.#autoResolvedLevel !== effort;
		this.#autoResolvedLevel = effort;
		this.#thinkingLevel = effort;
		this.#applyThinkingLevelToAgent(effort);
		if (shouldPersistResolution) {
			this.sessionManager.appendThinkingLevelChange(effort, AUTO_THINKING);
		}
		this.#emit({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
	}

	/**
	 * True when *any* fast-mode-granting service tier is configured, regardless
	 * of whether the active model's provider actually realizes it. Used by the
	 * toggle (`/fast on|off`) so re-toggling a scoped tier (`openai-only`,
	 * `claude-only`) doesn't silently broaden it to unscoped `priority`.
	 *
	 * For "is fast mode actually applied to the next request?" use
	 * {@link isFastModeActive} instead — that one respects the model's provider.
	 */
	isFastModeEnabled(): boolean {
		return (
			this.serviceTier === "priority" || this.serviceTier === "claude-only" || this.serviceTier === "openai-only"
		);
	}

	/**
	 * True when the configured `serviceTier` resolves to `"priority"` for the
	 * *currently selected model's provider*. Returns false for scoped tiers
	 * that don't match (e.g. `"openai-only"` on an anthropic model) and when
	 * no model is selected.
	 */
	isFastModeActive(): boolean {
		return resolveServiceTier(this.serviceTier, this.model?.provider) === "priority";
	}

	setServiceTier(serviceTier: ServiceTier | undefined): void {
		if (this.serviceTier === serviceTier) return;
		// Re-arming priority on Anthropic? Clear the per-session auto-fallback
		// sticky disable so the next request actually carries `speed: "fast"`
		// again. Without this, `/fast on` (or user switching to a tier that
		// grants anthropic priority) after an auto-disable is a silent no-op
		// and the warning notice fires every turn.
		if (serviceTier === "priority" || serviceTier === "claude-only") {
			clearAnthropicFastModeFallback(this.#providerSessionState);
		}
		this.agent.serviceTier = serviceTier;
		this.sessionManager.appendServiceTierChange(serviceTier ?? null);
	}

	setFastMode(enabled: boolean): void {
		if (enabled && this.isFastModeEnabled()) {
			// Already on under any scope — keep the user's scoped value.
			return;
		}
		if (!enabled) {
			this.setServiceTier(undefined);
			return;
		}
		const scope = this.settings.get("fastModeScope");
		this.setServiceTier(scope === "openai" ? "openai-only" : scope === "claude" ? "claude-only" : "priority");
	}

	toggleFastMode(): boolean {
		const enabled = !this.isFastModeEnabled();
		this.setFastMode(enabled);
		return enabled;
	}

	/**
	 * Get available thinking levels for current model.
	 */
	getAvailableThinkingLevels(): ReadonlyArray<Effort> {
		if (!this.model) return [];
		return getSupportedEfforts(this.model);
	}

	// =========================================================================
	// Message Queue Mode Management
	// =========================================================================

	/**
	 * Set steering mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setSteeringMode(mode);
		this.settings.set("steeringMode", mode);
	}

	/**
	 * Set follow-up mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.setFollowUpMode(mode);
		this.settings.set("followUpMode", mode);
	}

	/**
	 * Set interrupt mode.
	 * Saves to settings.
	 */
	setInterruptMode(mode: "immediate" | "wait"): void {
		this.agent.setInterruptMode(mode);
		this.settings.set("interruptMode", mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Append plan-read protection to a prune/shake config so the active plan
	 * file survives compaction alongside skill reads (the config defaults
	 * already carry skill protection). The matcher reads the current plan
	 * reference path at match time, so retitled plans are covered.
	 */
	#withPlanProtection<T extends { protectedTools: ProtectedToolMatcher[] }>(config: T): T {
		const planMatcher = createPlanReadMatcher(() => this.#planReferencePath);
		return { ...config, protectedTools: [...config.protectedTools, planMatcher] };
	}

	async prune(): Promise<{ prunedCount: number; tokensSaved: number }> {
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#withPlanProtection({
				supersedeKey: readToolSupersedeKey,
				pruneUseless: true,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				keepBoundaryId,
				idleFlushMs: 0,
				suffixTokenLimit: Number.POSITIVE_INFINITY,
			}),
		);
		if (this.settings.get("compaction.maskConsumedObservations")) {
			const maskResult = maskConsumedObservations(
				branchEntries,
				this.#withPlanProtection({
					protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools, isTtsrReminderToolResult],
				}).protectedTools,
				keepBoundaryId,
			);
			result.prunedCount += maskResult.prunedCount;
			result.tokensSaved += maskResult.tokensSaved;
		}
		if (result.prunedCount === 0) return result;

		await this.#commitHistoryRewrite("prune");
		return result;
	}

	/**
	 * Compaction-to-memory bridge (U13): LLM compaction summaries are lossy and
	 * die with the session, yet they are the last carrier of the discarded
	 * span's durable facts (file paths, decisions, invariants, error
	 * signatures). Retaining the summary into mnemopi with compaction
	 * provenance makes those facts recallable from any future session via the
	 * backend's own extraction pipeline. Deterministic rungs (mask, shake,
	 * snapcompact) lose no information, so only the LLM-summary path retains.
	 */
	#retainCompactionSummaryToMemory(summary: string, shortSummary: string | undefined, lossless: boolean): void {
		if (lossless) return;
		if (this.settings.get("memory.backend") !== "mnemopi") return;
		const state = this.getMnemopiSessionState();
		if (!state || !summary.trim()) return;
		try {
			state.rememberScoped(summary, {
				source: "compaction",
				importance: 0.6,
				metadata: {
					session_id: state.sessionId,
					cwd: this.sessionManager.getCwd(),
					short_summary: shortSummary ?? null,
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				memoryType: "fact",
			});
		} catch (error) {
			logger.warn("Compaction-to-memory retain failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Commit an in-place history rewrite: persist entries, rebuild the agent's
	 * message view, and reset every runtime that caches message identity. Every
	 * rewrite path MUST go through this (or replicate all of it) — skipping the
	 * Codex teardown corrupts provider sessions after a rewrite.
	 */
	async #commitHistoryRewrite(reason: "prune" | "compaction"): Promise<void> {
		this.#cacheAttribution.noteHistoryRewrite(reason);
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisorRuntime?.reset();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
	}
	async #pruneToolOutputs(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneToolOutputs(
			branchEntries,
			this.#withPlanProtection({
				...DEFAULT_PRUNE_CONFIG,
				pruneUseless: this.settings.getGroup("compaction").dropUseless,
				// Cache-stable boundary: never re-write the warm, already-sent prefix
				// (deep stale/age victims) or summarized-away entries every turn.
				keepBoundaryId,
				cacheWarmSuffixTokens: PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			}),
		);

		let maskResult: { prunedCount: number; tokensSaved: number } | undefined;
		if (this.settings.get("compaction.maskConsumedObservations")) {
			maskResult = maskConsumedObservations(
				branchEntries,
				this.#withPlanProtection({
					protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools, isTtsrReminderToolResult],
				}).protectedTools,
				keepBoundaryId,
				PRUNE_CACHE_WARM_SUFFIX_TOKENS,
			);
		}

		if (result.prunedCount === 0 && (!maskResult || maskResult.prunedCount === 0)) {
			return undefined;
		}
		const combined = {
			prunedCount: result.prunedCount + (maskResult?.prunedCount ?? 0),
			tokensSaved: result.tokensSaved + (maskResult?.tokensSaved ?? 0),
		};

		this.#cacheAttribution.noteHistoryRewrite("prune");
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisorRuntime?.reset();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return combined;
	}

	/**
	 * Per-turn stale-result pass: prune older `read` results that a newer read
	 * of the same file has made stale, plus results their tool flagged
	 * contextually useless. Cache-aware (only fires when the suffix after a
	 * candidate is small or the session has been idle long enough that the
	 * provider prompt cache is cold), so it is cheap to run every turn. Gated
	 * on the `compaction.supersedeReads` and `compaction.dropUseless` settings.
	 */
	async #pruneStaleToolResults(): Promise<{ prunedCount: number; tokensSaved: number } | undefined> {
		const {
			enabled: compactionEnabled,
			supersedeReads,
			dropUseless,
			maskConsumedObservations: maskConsumedSetting,
		} = this.settings.getGroup("compaction");
		const maskEnabled = compactionEnabled && maskConsumedSetting;
		if (!supersedeReads && !dropUseless && !maskEnabled) return undefined;
		const branchEntries = this.sessionManager.getBranch();
		const keepBoundaryId = getLatestCompactionEntry(branchEntries)?.firstKeptEntryId;
		const result = pruneSupersededToolResults(
			branchEntries,
			this.#withPlanProtection({
				supersedeKey: supersedeReads ? readToolSupersedeKey : undefined,
				pruneUseless: dropUseless,
				protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools],
				// Never re-write summarized-away entries; only flush the whole sent
				// region once the cache is genuinely cold (idle exceeds the 1h TTL).
				keepBoundaryId,
				idleFlushMs: PRUNE_IDLE_FLUSH_MS,
			}),
		);

		let maskResult: { prunedCount: number; tokensSaved: number } | undefined;
		if (maskEnabled) {
			maskResult = maskConsumedObservations(
				branchEntries,
				this.#withPlanProtection({
					protectedTools: [...DEFAULT_PRUNE_CONFIG.protectedTools, isTtsrReminderToolResult],
				}).protectedTools,
				keepBoundaryId,
			);
		}

		if (result.prunedCount === 0 && (!maskResult || maskResult.prunedCount === 0)) {
			return undefined;
		}
		const combined = {
			prunedCount: result.prunedCount + (maskResult?.prunedCount ?? 0),
			tokensSaved: result.tokensSaved + (maskResult?.tokensSaved ?? 0),
		};

		this.#cacheAttribution.noteHistoryRewrite("prune");
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisorRuntime?.reset();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return combined;
	}

	/**
	 * Strip image content blocks from every message on the current branch and
	 * persist the rewrite. Walks `SessionManager.getBranch()` in place — both
	 * `SessionMessageEntry.message` and `CustomMessageEntry.content` arrays
	 * are mutated, then `rewriteEntries` durably commits the new shape. The
	 * agent's runtime view is rebuilt from the freshly-mutated entries so any
	 * provider sessions caching message identity (Codex Responses) are torn
	 * down to force a clean replay on the next turn.
	 *
	 * No-op when the branch carries no images; returns `{ removed: 0 }` and
	 * skips the disk rewrite.
	 */
	async dropImages(): Promise<{ removed: number }> {
		const branchEntries = this.sessionManager.getBranch();
		let removed = 0;
		for (const entry of branchEntries) {
			if (entry.type === "message") {
				removed += stripImagesFromMessage(entry.message);
				continue;
			}
			if (entry.type === "custom_message" && typeof entry.content !== "string") {
				const kept: typeof entry.content = [];
				let dropped = 0;
				for (const part of entry.content) {
					if (part.type === "image") {
						dropped++;
					} else {
						kept.push(part);
					}
				}
				if (dropped > 0) {
					if (kept.length === 0) {
						kept.push({ type: "text", text: "[image removed]" });
					}
					entry.content = kept;
					removed += dropped;
				}
			}
		}
		if (removed === 0) {
			return { removed: 0 };
		}
		this.#cacheAttribution.noteHistoryRewrite("prune");
		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisorRuntime?.reset();
		this.#closeCodexProviderSessionsForHistoryRewrite();
		return { removed };
	}

	/**
	 * Surgically reduce context by dropping heavy content ("shake").
	 *
	 * - `images` delegates to {@link dropImages}.
	 * - `elide` replaces whole tool-call results and large fenced/XML blocks
	 *   with short placeholders that embed an `artifact://` recovery link.
	 *
	 * Mutates the branch in place, persists via `rewriteEntries`, replays the
	 * rebuilt context through the agent, and tears down provider sessions that
	 * cache message identity — same rewrite contract as {@link dropImages}.
	 *
	 * No-op (zero counts) when nothing is eligible.
	 */
	async shake(mode: ShakeMode, opts: { config?: ShakeConfig; signal?: AbortSignal } = {}): Promise<ShakeResult> {
		if (mode === "images") {
			const { removed } = await this.dropImages();
			return { mode, toolResultsDropped: 0, blocksDropped: 0, imagesDropped: removed, tokensFreed: 0 };
		}

		const branchEntries = this.sessionManager.getBranch();
		const config = this.#withPlanProtection({
			...(opts.config ?? AGGRESSIVE_SHAKE_CONFIG),
			// Skip entries summarized away by the latest compaction — shaking them
			// only churns persisted history with no prompt/cache effect.
			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		});
		const regions = collectShakeRegions(branchEntries, config);
		if (regions.length === 0) {
			return { mode, toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 };
		}

		const artifactId = await this.#saveShakeArtifact(regions);
		const replacements = regions.map((region, index) => this.#shakeElidePlaceholder(region, index, artifactId));

		let toolResultsDropped = 0;
		let blocksDropped = 0;
		let originalTokens = 0;
		let replacementTokens = 0;
		const items = regions.map((region, index) => {
			if (region.kind === "toolResult") toolResultsDropped++;
			else blocksDropped++;
			originalTokens += region.tokens;
			const replacement = replacements[index];
			if (replacement.length > 0) replacementTokens += countTokens(replacement);
			return { region, replacement };
		});

		applyShakeRegions(items);
		this.#cacheAttribution.noteHistoryRewrite("compaction");

		await this.sessionManager.rewriteEntries();
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisorRuntime?.reset();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return {
			mode,
			toolResultsDropped,
			blocksDropped,
			tokensFreed: Math.max(0, originalTokens - replacementTokens),
			artifactId,
		};
	}

	#shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string {
		if (artifactId) {
			return `[shaken ~${region.tokens} tokens — recover: artifact://${artifactId} (region ${index + 1})]`;
		}
		return `[shaken ~${region.tokens} tokens]`;
	}

	/**
	 * Concatenate the original region contents into one session artifact so the
	 * agent can read them back via `artifact://<id>`. Returns `undefined` when
	 * the session is not persisted or the write fails — callers degrade to a
	 * bare placeholder.
	 */
	async #saveShakeArtifact(regions: ShakeRegion[]): Promise<string | undefined> {
		const parts: string[] = [];
		for (let i = 0; i < regions.length; i++) {
			const region = regions[i];
			parts.push(`### region ${i + 1} (${region.label}, ~${region.tokens} tok)`, "", region.originalText, "");
		}
		try {
			return await this.sessionManager.saveArtifact(parts.join("\n"), "shake");
		} catch {
			return undefined;
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 * @param options Optional callbacks for completion/error handling
	 */
	async compact(customInstructions?: string, options?: CompactOptions): Promise<CompactionResult> {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		// Resolve the `/compact <mode>` subcommand up front so input validation
		// runs before we disconnect/abort the active agent operation below.
		const requestedMode = options?.mode;
		const compactMode = requestedMode !== undefined ? findCompactMode(requestedMode) : undefined;
		if (requestedMode !== undefined && !compactMode) {
			throw new Error(SNAPCOMPACT_RETIREMENT_ERROR);
		}
		this.#disconnectFromAgent();
		// Install the manual controller BEFORE the startup abort so isCompacting is
		// already true when the abort teardown yields to the event loop — a message
		// typed the instant the loader appears must route into the compaction queue,
		// not the core steering queue. The abort preserves this controller
		// (preserveCompaction) while still cancelling any in-flight auto pass.
		const compactionAbortController = new AbortController();
		this.#compactionAbortController = compactionAbortController;

		try {
			await this.abort({ goalReason: "internal", preserveCompaction: true });
			if (!this.model) {
				throw new Error("No model selected");
			}

			const compactionSettings = this.settings.getGroup("compaction");
			// The `/compact <mode>` override (resolved above) replaces the configured
			// strategy/remote flags for this one invocation. Merged before
			// prepareCompaction so the remote gating (preparation.settings.
			// remoteEnabled/endpoint) and the selected compaction path both see them.
			const effectiveSettings = compactMode
				? { ...compactionSettings, ...compactMode.overrides }
				: compactionSettings;
			let remoteOnly = false;
			if (compactMode?.requiresRemote) {
				const remoteReady =
					Boolean(effectiveSettings.remoteEndpoint) || shouldUseOpenAiRemoteCompaction(this.model);
				if (!remoteReady) {
					this.emitNotice(
						"warning",
						`remote compaction is unavailable for ${this.model.id} (no remote endpoint configured) — using a local summary instead`,
						"compaction",
					);
				} else if (!effectiveSettings.remoteEndpoint) {
					// Provider-native remote compaction only: drop candidates that would
					// silently run a local summary (e.g. a non-remote-capable compactionModel).
					remoteOnly = true;
				}
			}
			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, effectiveSettings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const result = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal: compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new CompactionCancelledError();
				}

				if (result?.compaction) {
					hookCompaction = result.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else {
				// Generate compaction result. Only convert known abort-shaped
				// rejections (AbortError raised while the abort signal is set,
				// or an already-typed sentinel) into `CompactionCancelledError`
				// so downstream callers can discriminate cancel from generic
				// failure via `instanceof` without inspecting message strings.
				// Real compaction bugs (network, server, parsing, etc.) keep
				// their original shape — they must not be silently relabeled
				// as cancellations even if the signal happens to be aborted
				// for an unrelated reason. Assignments live inside the try
				// block because every catch path throws — the post-try reads
				// of the result-derived locals are reachable only on success.
				try {
					const result = await this.#compactWithFallbackModel(
						preparation,
						customInstructions,
						compactionAbortController.signal,
						{
							promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
							extraContext: this.#obfuscateTextArrayForProvider(compactionPrep.hookContext),
							remoteInstructions: this.#obfuscateTextForProvider(this.#baseSystemPrompt.join("\n\n")),
							convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						},
						remoteOnly,
					);
					summary = result.summary;
					shortSummary = result.shortSummary;
					firstKeptEntryId = result.firstKeptEntryId;
					tokensBefore = result.tokensBefore;
					details = result.details;
					preserveData = { ...(compactionPrep.preserveData ?? {}), ...(result.preserveData ?? {}) };
				} catch (err) {
					if (err instanceof CompactionCancelledError) {
						throw err;
					}
					if (compactionAbortController.signal.aborted && err instanceof Error && err.name === "AbortError") {
						throw new CompactionCancelledError();
					}
					throw err;
				}
			}

			if (compactionAbortController.signal.aborted) {
				throw new CompactionCancelledError();
			}

			const tracedCompaction = await this.#attachOffloadTraceToCompaction({
				summary,
				shortSummary,
				preserveData,
				preparation,
			});
			summary = tracedCompaction.summary;
			preserveData = this.#stripRetiredSnapcompactPreserveData(tracedCompaction.preserveData);

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			this.#retainCompactionSummaryToMemory(summary, shortSummary, false);
			const newEntries = this.sessionManager.getEntries();
			this.#cacheAttribution.noteHistoryRewrite("compaction");
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#advisorRuntime?.reset();
			this.#syncTodoPhasesFromBranch();
			this.#closeCodexProviderSessionsForHistoryRewrite();

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			// Fusion cost mode: ramp the main model down at the manual /compact boundary too.
			await this.#applyFusionCompactionSwitch(summary);
			const compactionResult: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			options?.onComplete?.(compactionResult);
			return compactionResult;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options?.onError?.(err);
			throw error;
		} finally {
			if (this.#compactionAbortController === compactionAbortController) {
				this.#compactionAbortController = undefined;
			}
			this.#reconnectToAgent();
		}
	}

	async #attachOffloadTraceToCompaction(input: {
		summary: string;
		shortSummary?: string;
		preserveData?: Record<string, unknown>;
		preparation: {
			messagesToSummarize: AgentMessage[];
			turnPrefixMessages: AgentMessage[];
		};
	}): Promise<{ summary: string; preserveData?: Record<string, unknown> }> {
		const settings: OffloadTraceSettings = {
			enabled: this.settings.get("offloadTrace.enabled"),
			maxCanvasChars: this.settings.get("offloadTrace.maxCanvasChars"),
			maxNodes: this.settings.get("offloadTrace.maxNodes"),
			rawArtifactMinChars: this.settings.get("offloadTrace.rawArtifactMinChars"),
		};
		if (!settings.enabled) return { summary: input.summary, preserveData: input.preserveData };

		try {
			const canvas = await buildOffloadTraceCanvas({
				sessionId: this.sessionId,
				messagesToSummarize: input.preparation.messagesToSummarize,
				turnPrefixMessages: input.preparation.turnPrefixMessages,
				summary: input.summary,
				shortSummary: input.shortSummary,
				settings,
				artifactManager: this.sessionManager.getArtifactManager(),
			});
			if (!canvas) return { summary: input.summary, preserveData: input.preserveData };
			const traceMarkdown = renderOffloadTraceCanvasMarkdown(canvas, settings);
			const preserveData = { ...(input.preserveData ?? {}), offloadTrace: canvas };
			return {
				summary: appendTraceSection(input.summary, traceMarkdown),
				preserveData,
			};
		} catch (err) {
			logger.debug("Offload trace build failed", { error: String(err) });
			return { summary: input.summary, preserveData: input.preserveData };
		}
	}

	/**
	 * Ask the active memory backend for an extra-context block to splice into
	 * the compaction summary prompt. Both the manual and auto compaction paths
	 * funnel through this helper so the behaviour stays identical.
	 *
	 * Failures are swallowed: a memory backend going sideways MUST NOT block
	 * compaction (which is itself the recovery path for context overflow).
	 */
	async #collectMemoryBackendContext(preparation: {
		messagesToSummarize: AgentMessage[];
		turnPrefixMessages: AgentMessage[];
	}): Promise<string | undefined> {
		const backend = await resolveMemoryBackend(this.settings);
		if (!backend.preCompactionContext) return undefined;
		const messages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
		try {
			return await backend.preCompactionContext(messages, this.settings, this);
		} catch (err) {
			logger.debug("Memory backend preCompactionContext failed", {
				backend: backend.id,
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Cancel in-progress context maintenance (manual compaction, auto-compaction, or auto-handoff).
	 */
	abortCompaction(): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		this.#handoffAbortController?.abort();
	}

	/** Trigger idle compaction through the auto-compaction flow (with UI events). */
	async runIdleCompaction(): Promise<void> {
		if (this.isStreaming || this.isCompacting) return;
		await this.#runAutoCompaction("idle", false, true);
	}

	/**
	 * Mid-turn threshold compaction (`compaction.midTurnEnabled`): when a
	 * tool-call turn finishes over the compaction threshold and the loop is about
	 * to continue with another provider call, compact in place NOW instead of
	 * waiting for agent_end — a long tool loop can otherwise overflow before the
	 * run yields. Runs from the agent's awaited turn-end hook, so the pass
	 * completes before the next request is built. Always takes the in-place
	 * context-full path: a mid-run handoff would reset the session out from
	 * under the live loop.
	 *
	 * The loop owns its context array (`agent.replaceMessages` only updates
	 * post-run agent state), so after the branch rewrite the live `loopMessages`
	 * array is spliced in place with the rebuilt session context.
	 */
	async #maybeCompactMidTurn(
		loopMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (!context?.willContinue || signal?.aborted) return;
		const message = context.message;
		if (message.role !== "assistant") return;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return;
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || !compactionSettings.midTurnEnabled || compactionSettings.strategy === "off") {
			return;
		}
		if (this.isCompacting || this.isGeneratingHandoff) return;
		const contextWindow = this.model?.contextWindow ?? 0;
		const contextTokens = calculateContextTokens(assistant.usage);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// The turn's message_end events ride the agent event stream and may not
		// have been dispatched — or may be parked on a pending extension hook —
		// when the loop awaits this hook. Wait until the just-finished turn is
		// persisted so the branch snapshot carries it exactly once (never lost,
		// never duplicated by a late hook re-appending it after the rewrite).
		if (!(await this.#waitForTurnPersistence(assistant, context.toolResults))) {
			logger.warn("Mid-turn compaction skipped: turn persistence did not settle");
			return;
		}
		if (signal?.aborted || this.isCompacting) return;

		const before = getLatestCompactionEntry(this.sessionManager.getBranch());
		await this.#runAutoCompaction("threshold", false, true, false, {
			autoContinue: false,
			forceInPlace: true,
			triggerContextTokens: contextTokens,
		});
		const after = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (!after || after.id === before?.id) return;
		const rebuilt = this.buildDisplaySessionContext().messages;
		loopMessages.splice(0, loopMessages.length, ...rebuilt);
	}

	/**
	 * Wait until the given turn (assistant message + its tool results) has been
	 * persisted to the session branch. Alternates a macrotask yield — so the
	 * agent's event-stream consumption catches up (same trick as
	 * `syncContextBeforeModelCall`) — with a wait on the ordered message_end
	 * processing chain, which blocks while an extension's message_end hook is
	 * still pending. Bounded so a genuinely broken pipeline cannot spin forever.
	 */
	async #waitForTurnPersistence(assistant: AssistantMessage, toolResults: ToolResultMessage[]): Promise<boolean> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (this.#turnPersistedInBranch(assistant, toolResults)) return true;
			await Bun.sleep(0);
			await this.#queuedMessageEndEvents;
		}
		return this.#turnPersistedInBranch(assistant, toolResults);
	}

	#turnPersistedInBranch(assistant: AssistantMessage, toolResults: ToolResultMessage[]): boolean {
		const branch = this.sessionManager.getBranch();
		const assistantPersisted = branch.some(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				this.#isSameAssistantMessage(entry.message as AssistantMessage, assistant),
		);
		if (!assistantPersisted) return false;
		return toolResults.every(result =>
			branch.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					(entry.message as ToolResultMessage).toolCallId === result.toolCallId,
			),
		);
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this.#branchSummaryAbortController?.abort();
	}

	/**
	 * Cancel in-progress handoff generation.
	 */
	abortHandoff(): void {
		this.#handoffAbortController?.abort();
	}

	/**
	 * Check if handoff generation is in progress.
	 */
	get isGeneratingHandoff(): boolean {
		return this.#handoffAbortController !== undefined;
	}

	/**
	 * Generate a handoff document with a oneshot LLM call, then start a new session with it.
	 *
	 * @param customInstructions Optional focus for the handoff document
	 * @param options Handoff execution options
	 * @returns The handoff document text, or undefined if cancelled/failed
	 */
	async handoff(customInstructions?: string, options?: SessionHandoffOptions): Promise<HandoffResult | undefined> {
		const entries = this.sessionManager.getBranch();
		const messageCount = entries.filter(e => e.type === "message").length;

		if (messageCount < 2) {
			throw new Error("Nothing to hand off (no messages yet)");
		}

		this.#skipPostTurnMaintenanceAssistantTimestamp = undefined;

		this.#handoffAbortController = new AbortController();
		const handoffAbortController = this.#handoffAbortController;
		const handoffSignal = handoffAbortController.signal;
		const sourceSignal = options?.signal;
		const onSourceAbort = () => {
			if (!handoffSignal.aborted) {
				handoffAbortController.abort();
			}
		};
		if (sourceSignal) {
			sourceSignal.addEventListener("abort", onSourceAbort, { once: true });
			if (sourceSignal.aborted) {
				onSourceAbort();
			}
		}

		try {
			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}

			const model = this.model;
			if (!model) {
				throw new Error("No model selected for handoff");
			}
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}

			const handoffRequestMessages: Message[] = [
				...this.#convertToLlmForSideRequest(this.agent.state.messages),
				{
					role: "user",
					content: [
						{ type: "text", text: renderHandoffPrompt(this.#obfuscateTextForProvider(customInstructions)) },
					],
					attribution: "agent",
					timestamp: Date.now(),
				},
			];
			const handoffContext: Context = {
				systemPrompt: this.#obfuscateTextArrayForProvider(this.#baseSystemPrompt) ?? [...this.#baseSystemPrompt],
				messages: handoffRequestMessages,
				tools: obfuscateProviderTools(
					this.#obfuscator,
					this.#pruneToolDescriptions ? stripToolDescriptions(this.agent.state.tools) : this.agent.state.tools,
				),
			};
			const rawHandoffText = await generateHandoffFromContext(handoffContext, model, {
				// Mirror the live loop's cache routing: reuse the agent's provider
				// prompt-cache key so the oneshot reads the cache the live turn
				// populated, while a unique side lineage keeps append-only provider
				// state from mixing with the main turn.
				streamOptions: this.prepareSimpleStreamOptions(
					{
						apiKey: this.#modelRegistry.resolver(model, this.sessionId),
						sessionId: `${this.sessionId}:side:${Snowflake.next()}`,
						promptCacheKey: this.agent.promptCacheKey ?? this.sessionId,
						initiatorOverride: "agent",
						metadata: this.agent.metadataForProvider(model.provider),
						signal: handoffSignal,
					},
					model.provider,
				),
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
				// Honor the user's /model thinking selection on the handoff
				// path. Clamped per-model inside generateHandoffFromContext via
				// resolveCompactionEffort so unsupported-effort models don't
				// trip requireSupportedEffort.
				thinkingLevel: this.thinkingLevel,
			});
			const handoffText = this.#deobfuscateFromProvider(rawHandoffText);

			if (handoffSignal.aborted) {
				throw new Error("Handoff cancelled");
			}
			if (!handoffText) {
				return undefined;
			}

			// Start a new session
			const previousSessionFile = this.sessionFile;
			await this.#resetTurnDiscoveredTools();
			await this.sessionManager.flush();
			this.#cancelOwnAsyncJobs();
			await this.sessionManager.newSession(previousSessionFile ? { parentSession: previousSessionFile } : undefined);
			await this.#restoreMCPSelectionsForSessionContext(this.buildDisplaySessionContext(), {
				fallbackSelectedMCPToolNames: this.#getConfiguredDefaultSelectedMCPToolNames(),
			});
			const restoredMCPToolNames = this.getSelectedMCPToolNames();
			if (restoredMCPToolNames.length > 0) {
				this.sessionManager.appendMCPToolSelection(restoredMCPToolNames);
			}
			// agent.reset() clears the core steering/follow-up queues. Preserve any queued
			// steers/follow-ups (RPC/SDK steer()/followUp() issued during the handoff, or a
			// pre-loader TUI steer) so they survive into the post-handoff session instead of
			// being silently dropped. Capture is synchronous immediately before reset and
			// restore is synchronous immediately after — no await gap — so a steer arriving
			// later (during ensureOnDisk/Bun.write below) appends to the restored queue
			// rather than being clobbered.
			const preservedSteering = this.agent.peekSteeringQueue().slice();
			const preservedFollowUp = this.agent.peekFollowUpQueue().slice();
			this.agent.reset();
			this.agent.replaceQueues(preservedSteering, preservedFollowUp);
			this.#freshProviderSessionId = undefined;
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();
			this.#rekeyScreenpipeForCurrentSessionId();
			this.#resetHindsightConversationTrackingIfHindsight();
			this.#resetMnemopiConversationTrackingIfMnemopi();
			this.#promotedMemoryPrompt = undefined;
			this.#pendingNextTurnMessages = [];
			this.#scheduledHiddenNextTurnGeneration = undefined;
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;

			// Inject the handoff document as a custom message
			const handoffContent = createHandoffContext(handoffText);
			this.sessionManager.appendCustomMessageEntry("handoff", handoffContent, true, undefined, "agent");
			await this.sessionManager.ensureOnDisk();
			let savedPath: string | undefined;
			if (options?.autoTriggered && this.settings.get("compaction.handoffSaveToDisk")) {
				const artifactsDir = this.sessionManager.getArtifactsDir();
				if (artifactsDir) {
					const handoffFilePath = path.join(artifactsDir, createHandoffFileName());
					try {
						await Bun.write(handoffFilePath, `${handoffText}\n`);
						savedPath = handoffFilePath;
					} catch (error) {
						logger.warn("Failed to save handoff document to disk", {
							path: handoffFilePath,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} else {
					logger.debug("Skipping handoff document save because session is not persisted");
				}
			}

			// Rebuild agent messages from session
			this.#cacheAttribution.noteHistoryRewrite("compaction");
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			this.#advisorRuntime?.reset();
			this.#syncTodoPhasesFromBranch();

			return { document: handoffText, savedPath };
		} catch (error) {
			if (handoffSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
				throw new Error("Handoff cancelled");
			}
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", onSourceAbort);
			this.#handoffAbortController = undefined;
		}
	}

	#estimatePrePromptContextTokens(messages: AgentMessage[], contextWindow: number): number {
		const breakdown = this.getContextBreakdown({ contextWindow, pendingMessages: messages });
		const providerAnchoredTokens =
			breakdown?.usedTokens ??
			computeNonMessageTokens(this) + messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		// Floor by the stored conversation: a before_provider_request compressor can
		// deflate the provider-billed usage far below what the session actually
		// carries, which would suppress compaction indefinitely. The floor counts
		// only reliably-countable text (opaque reasoning payloads excluded — their
		// local byte size diverges from provider billing) and no non-message tokens,
		// so it can only raise a genuinely deflated estimate.
		const storedConversationEstimate = [...this.messages, ...messages].reduce(
			(sum, msg) => sum + estimateTokens(msg, { excludeEncryptedReasoning: true }),
			0,
		);
		return compactionContextTokens(providerAnchoredTokens, storedConversationEstimate);
	}

	async #runPrePromptCompactionIfNeeded(messages: AgentMessage[]): Promise<void> {
		const model = this.model;
		if (!model) return;
		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.settings.getGroup("compaction");
		const contextTokens = this.#estimatePrePromptContextTokens(messages, contextWindow);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) return;

		// Auto-promote first: switching to a larger-context model avoids compacting
		// the history at all. The post-turn threshold path already promotes before
		// compacting; without this, the pre-prompt path would pre-empt promotion and
		// compact or summarize a session that should have just been promoted.
		if (await this.#promoteContextModel()) {
			logger.debug("Pre-prompt context promotion avoided compaction", {
				contextTokens,
				contextWindow,
				model: `${model.provider}/${model.id}`,
			});
			return;
		}

		logger.debug("Pre-prompt context maintenance triggered by pending prompt size", {
			contextTokens,
			contextWindow,
			model: `${model.provider}/${model.id}`,
		});
		await this.#runAutoCompaction("threshold", false, false, false, {
			autoContinue: false,
			triggerContextTokens: contextTokens,
		});
	}

	/**
	 * Check if context maintenance or promotion is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Four cases (in order):
	 * 1. Input overflow + promotion: promote to larger model, retry without maintenance.
	 * 2. Input overflow + no promotion target: run context maintenance, auto-retry on same model.
	 * 3. Output incomplete (stopReason === "length", e.g. `response.incomplete`): the
	 *    model burned its output budget without producing an actionable deliverable
	 *    (reasoning-only or truncated). Drop the dead turn, try promotion, otherwise
	 *    run compaction/handoff and retry.
	 * 4. Threshold: context over threshold, run context maintenance (no auto-retry).
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @param allowDefer If true, threshold-driven handoff strategy may schedule itself as a
	 *   deferred post-prompt task instead of running inline. Callers running inside the
	 *   `agent_end` handler set this to true so `session.prompt()` resolves cleanly; callers
	 *   on the pre-prompt path (where the next agent turn is about to start) set it to false
	 *   to avoid racing the deferred handoff against the new turn.
	 * @param autoContinue Whether maintenance may schedule the agent-authored continuation prompt.
	 * @returns whether compaction/recovery scheduled a handoff, retry, auto-continue, or
	 *   queued-message drain that already owns the next turn. Callers MUST skip
	 *   `session_stop` and other agent continuations when `continuationScheduled`
	 *   is true.
	 */
	async #checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		allowDefer = true,
		autoContinue = true,
	): Promise<CompactionCheckResult> {
		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return COMPACTION_CHECK_NONE;
		const contextWindow = this.model?.contextWindow ?? 0;
		const generation = this.#promptGeneration;
		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		// This handles the case where an error was kept after compaction (in the "kept" region).
		// The error shouldn't trigger another compaction since we already compacted.
		// Example: opus fails -> switch to codex -> compact -> switch back to opus -> opus error
		// is still in context but shouldn't trigger compaction again.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const errorIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp < new Date(compactionEntry.timestamp).getTime();
		if (sameModel && !errorIsFromBeforeCompaction && isContextOverflow(assistantMessage, contextWindow)) {
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.replaceMessages(messages.slice(0, -1));
			}

			// Try context promotion first - switch to a larger model and retry without compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				// Retry on the promoted (larger) model without compacting
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			// No promotion target available fall through to compaction
			const compactionSettings = this.settings.getGroup("compaction");
			if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
				return await this.#runAutoCompaction("overflow", true, false, allowDefer, { autoContinue });
			}
			return COMPACTION_CHECK_NONE;
		}

		// Case 3: Output-side incomplete — `response.incomplete` from OpenAI Responses
		// (and Codex) maps to stopReason === "length". The model burned its
		// `max_output_tokens` budget on reasoning/text and emitted no actionable
		// deliverable. Same recovery class as overflow: promotion if available,
		// otherwise compaction/handoff. Unlike overflow, the *input* is fine, so we
		// allow the handoff strategy to actually run.
		if (sameModel && !errorIsFromBeforeCompaction && assistantMessage.stopReason === "length") {
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.replaceMessages(messages.slice(0, -1));
			}

			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (promoted) {
				logger.debug("Context promotion triggered by response.incomplete (length stop)", {
					from: `${assistantMessage.provider}/${assistantMessage.model}`,
				});
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				return COMPACTION_CHECK_CONTINUATION;
			}

			const incompleteCompactionSettings = this.settings.getGroup("compaction");
			if (incompleteCompactionSettings.enabled && incompleteCompactionSettings.strategy !== "off") {
				logger.debug("Compaction triggered by response.incomplete (length stop, no promotion target)", {
					model: `${assistantMessage.provider}/${assistantMessage.model}`,
					strategy: incompleteCompactionSettings.strategy,
				});
				return await this.#runAutoCompaction("incomplete", true, false, allowDefer, {
					autoContinue,
					triggerContextTokens: calculateContextTokens(assistantMessage.usage),
				});
			}
			// Neither promotion nor compaction is available — surface the dead-end so
			// the user understands why the turn yielded with nothing.
			logger.warn("response.incomplete with no recovery path (promotion + compaction both unavailable)", {
				model: `${assistantMessage.provider}/${assistantMessage.model}`,
			});
			return COMPACTION_CHECK_NONE;
		}

		// Stale-result pass runs every turn, before any threshold gating: it is
		// cheap (bails when no candidate) and independent of the compaction
		// setting.
		const supersedeResult = await this.#pruneStaleToolResults();

		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return COMPACTION_CHECK_NONE;

		// Case 4: Threshold - turn succeeded but context is getting large
		// Skip if this was an error (non-overflow errors don't have usage data)
		if (assistantMessage.stopReason === "error") return COMPACTION_CHECK_NONE;
		const pruneResult = await this.#pruneToolOutputs();
		// The threshold GATE stays anchored to the provider-billed context tokens
		// (#3174): the supersede/prune passes above return token *estimates*, and
		// subtracting them from the billed number let tool-result-heavy sessions
		// (goal mode especially) sit above the real threshold indefinitely while
		// this check silently no-op'd every turn.
		const contextTokens = calculateContextTokens(assistantMessage.usage);
		// The shake trigger estimate DOES keep the prune savings: the pruned
		// results are already gone from the next request, so shake's post-pass
		// fallback correction must not re-count them as residual pressure.
		let estimatedContextTokens = contextTokens;
		if (supersedeResult) {
			estimatedContextTokens = Math.max(0, estimatedContextTokens - supersedeResult.tokensSaved);
		}
		if (pruneResult) {
			estimatedContextTokens = Math.max(0, estimatedContextTokens - pruneResult.tokensSaved);
		}
		if (shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			// Try promotion first — if a larger model is available, switch instead of compacting
			const promoted = await this.#tryContextPromotion(assistantMessage);
			if (!promoted) {
				return await this.#runAutoCompaction("threshold", false, false, allowDefer, {
					autoContinue,
					triggerContextTokens: estimatedContextTokens,
				});
			}
		}
		return COMPACTION_CHECK_NONE;
	}
	/** True while an enabled goal is actively running (not exiting/completed). */
	#isGoalModeActive(): boolean {
		const state = this.#goalModeState;
		if (!state?.enabled) return false;
		return state.mode === "active" && state.goal.status === "active";
	}

	/** Cheap pre-check mirroring #checkCompaction's threshold gate (billed tokens). */
	#isOverCompactionThreshold(assistantMessage: AssistantMessage): boolean {
		const compactionSettings = this.settings.getGroup("compaction");
		if (!compactionSettings.enabled || compactionSettings.strategy === "off") return false;
		const contextWindow = this.model?.contextWindow ?? 0;
		return shouldCompact(calculateContextTokens(assistantMessage.usage), contextWindow, compactionSettings);
	}

	#assistantEndedWithSuccessfulYield(assistantMessage: AssistantMessage): boolean {
		const toolCallId = this.#lastSuccessfulYieldToolCallId;
		if (!toolCallId) return false;
		const lastToolCall = assistantMessage.content
			.slice()
			.reverse()
			.find((content): content is ToolCall => content.type === "toolCall");
		return lastToolCall?.name === "yield" && lastToolCall.id === toolCallId;
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.#isEmptyAssistantStop(assistantMessage)) {
			this.#emptyStopRetryCount = 0;
			return false;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned empty stop after retry cap", {
				attempts: this.#emptyStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			if (this.#retryAttempt > 0) {
				await this.#emitSessionEvent({
					type: "auto_retry_end",
					success: false,
					attempt: this.#retryAttempt,
					finalError: "Assistant returned empty stop after retry cap",
				});
				this.#retryAttempt = 0;
			}
			this.#resolveRetry();
			// Tool-use orphans corrupt Anthropic message history (tool_result without
			// matching tool_use). Always remove them even when the retry cap is hit.
			if (assistantMessage.stopReason === "toolUse") {
				this.#removeEmptyStopFromActiveContext(assistantMessage);
			}
			return false;
		}
		this.#removeEmptyStopFromActiveContext(assistantMessage);
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#isEmptyAssistantStop(assistantMessage: AssistantMessage): boolean {
		switch (assistantMessage.stopReason) {
			case "stop":
				// Reasoning/thinking-only turns are not actionable: they do not
				// answer the user and do not give the agent loop a tool call to run.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			case "toolUse":
				// An orphaned toolUse stop (no tool_use block) corrupts Anthropic history:
				// a later tool_result has nothing to anchor to. Thinking alone cannot anchor
				// a tool_result, so it does not rescue a toolUse stop here.
				for (const content of assistantMessage.content) {
					if (content.type === "toolCall") return false;
					if (content.type === "text" && hasNonWhitespace(content.text)) return false;
				}
				return true;
			default:
				return false;
		}
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(emptyStopRetryTemplate, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}
	async #handleUnexpectedAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		if (!this.settings.get("features.unexpectedStopDetection")) {
			return false;
		}
		if (this.#isGoalModeActive() && this.#isOverCompactionThreshold(assistantMessage)) {
			// Active-goal turn already over the compaction threshold: threshold
			// maintenance owns the continuation. A retry reminder here would start
			// the next goal turn on an over-threshold context and strand the
			// compaction pass behind it — defer to the agent_end #checkCompaction.
			logger.debug("agent_end maintenance routing", {
				route: "active-goal-over-threshold-checkCompaction",
				successfulYield: false,
			});
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const text = assistantMessage.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("\n");
		if (!/\S/.test(text)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), UNEXPECTED_STOP_TIMEOUT_MS);
		let classification: boolean | undefined;
		try {
			classification = await classifyUnexpectedStop(text, {
				settings: this.settings,
				registry: this.#modelRegistry,
				sessionId: this.sessionId,
				metadataResolver: (provider: string) => this.agent.metadataForProvider(provider),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}

		if (classification !== true) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(unexpectedStopRetryTemplate, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	/** Counts consecutive Gemini thought-summary headers across the streaming reasoning channel. */
	#geminiHeaderRunDetector = new GeminiHeaderRunDetector();
	/** Set when the header guard aborted the stream; consumed by the agent_end handler. */
	#pendingGeminiToolCallReminder: { headerCount: number } | undefined;

	/**
	 * Gemini header-runaway guard (`model.loopGuard.toolCallReminder`): Gemini
	 * occasionally narrates a long chain of genuinely-distinct planning titles
	 * without ever calling a tool, so the pi-ai similarity loop guard never
	 * fires. Count reasoning-summary headers on the live stream and, at the
	 * threshold, abort the turn — the agent_end handler then discards the
	 * stalled reasoning-only turn and re-drives it with a hidden tool-call
	 * reminder (see #handleGeminiToolCallReminderInterrupt).
	 */
	#watchGeminiHeaderRunaway(assistantMessageEvent: AssistantMessageEvent): void {
		switch (assistantMessageEvent.type) {
			case "start":
			case "text_start":
			case "toolcall_start":
			case "thinking_start":
				// Leaving the reasoning channel (or starting a fresh block/turn)
				// resets the run — only an uninterrupted header chain counts.
				this.#geminiHeaderRunDetector.reset();
				return;
			case "thinking_delta":
				break;
			default:
				return;
		}
		if (this.#pendingGeminiToolCallReminder) return;
		if (!this.settings.get("model.loopGuard.enabled") || !this.settings.get("model.loopGuard.toolCallReminder")) {
			return;
		}
		const model = this.model;
		if (!model || !isGeminiThinkingModel(model)) return;
		if (!this.#geminiHeaderRunDetector.push(assistantMessageEvent.delta)) return;
		const headerCount = this.#geminiHeaderRunDetector.count;
		this.#pendingGeminiToolCallReminder = { headerCount };
		this.emitNotice(
			"warning",
			`Interrupted a reasoning runaway (${headerCount} consecutive planning headers with no tool call); reminding the model to act.`,
			"loop-guard",
		);
		this.agent.abort();
	}

	/**
	 * Completes the header-runaway interrupt after the guard's abort settles:
	 * drop the stalled reasoning-only turn from active context and session
	 * history (replaying it would feed the next turn more loop fuel), inject a
	 * hidden tool-call reminder (custom → developer on the wire), and re-drive
	 * the turn. Returns true when the interrupt was handled.
	 */
	async #handleGeminiToolCallReminderInterrupt(assistantMessage: AssistantMessage): Promise<boolean> {
		const pending = this.#pendingGeminiToolCallReminder;
		if (!pending) return false;
		this.#pendingGeminiToolCallReminder = undefined;
		if (assistantMessage.stopReason !== "aborted" || this.#abortInProgress || this.#isDisposed) return false;
		this.#removeEmptyStopFromActiveContext(assistantMessage);
		this.agent.appendMessage({
			role: "custom",
			customType: "gemini-tool-call-reminder",
			content: [{ type: "text", text: this.#geminiToolCallReminder(pending.headerCount) }],
			display: false,
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	#geminiToolCallReminder(headerCount: number): string {
		return [
			"<system-reminder>",
			`Your last turn was interrupted after ${headerCount} consecutive planning headers with no tool call. The stalled reasoning was discarded.`,
			"Stop planning. Take the next concrete step now by issuing a tool call, or reply with your final answer.",
			"</system-reminder>",
		].join("\n");
	}

	#removeEmptyStopFromActiveContext(assistantMessage: AssistantMessage): void {
		const messages = this.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			this.agent.replaceMessages(messages.slice(0, -1));
		}

		const emptyStopEntry = this.sessionManager
			.getBranch()
			.slice()
			.reverse()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
			);
		if (!emptyStopEntry) {
			return;
		}
		if (emptyStopEntry.parentId === null) {
			this.sessionManager.resetLeaf();
		} else {
			this.sessionManager.branch(emptyStopEntry.parentId);
		}
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason)
		);
	}

	#enforceRewindBeforeYield(): boolean {
		if (!this.#checkpointState || this.#pendingRewindReport) {
			return false;
		}
		const reminder = [
			"<system-warning>",
			"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
			"</system-warning>",
		].join("\n");
		this.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	async #applyRewind(report: string): Promise<void> {
		const checkpointState = this.#checkpointState;
		if (!checkpointState) {
			return;
		}
		try {
			this.sessionManager.branchWithSummary(checkpointState.checkpointEntryId, report, {
				startedAt: checkpointState.startedAt,
			});
		} catch (error) {
			logger.warn("Rewind branch checkpoint missing, falling back to root", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.sessionManager.branchWithSummary(null, report, { startedAt: checkpointState.startedAt });
		}
		const details = { startedAt: checkpointState.startedAt, rewoundAt: new Date().toISOString() };
		this.sessionManager.appendCustomMessageEntry("rewind-report", report, false, details, "agent");
		const sessionContext = this.buildDisplaySessionContext();
		this.agent.replaceMessages(sessionContext.messages);
		this.#advisorRuntime?.reset();
		this.#checkpointState = undefined;
		this.#pendingRewindReport = undefined;
	}

	/**
	 * Apply a pending checkpoint rewind at the turn boundary, inside the live
	 * run. Runs from the agent's `onTurnEnd` hook because the loop keeps its own
	 * message array: `agent.replaceMessages` alone cannot reach it, so the
	 * active history rebuilt through the branch_summary and rewind report must
	 * be spliced into `loopMessages` before the post-rewind model call.
	 */
	async #maybeApplyRewindMidRun(
		loopMessages: AgentMessage[],
		signal: AbortSignal | undefined,
		context: AgentTurnEndContext | undefined,
	): Promise<void> {
		if (!context || signal?.aborted) return;
		const message = context.message;
		if (message.role !== "assistant") return;
		const assistant = message as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return;
		if (!this.#checkpointState) return;
		const hasRewindResult = context.toolResults.some(
			result => result.toolName === "rewind" && result.isError !== true,
		);
		if (!hasRewindResult && this.#pendingRewindReport === undefined) return;
		if (!(await this.#waitForTurnPersistence(assistant, context.toolResults))) {
			logger.warn("Rewind skipped: turn persistence did not settle");
			return;
		}
		if (signal?.aborted) return;
		const report = this.#pendingRewindReport;
		if (report === undefined) return;
		await this.#applyRewind(report);
		loopMessages.splice(0, loopMessages.length, ...this.agent.state.messages);
	}
	async #enforcePlanModeToolDecision(): Promise<void> {
		if (!this.#planModeState?.enabled) {
			return;
		}
		const assistantMessage = this.#findLastAssistantMessage();
		if (!assistantMessage) {
			return;
		}
		if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
			return;
		}

		const calledRequiredTool = assistantMessage.content.some(
			content => content.type === "toolCall" && (content.name === "ask" || content.name === "resolve"),
		);
		if (calledRequiredTool) {
			return;
		}
		const hasRequiredTools = this.#toolRegistry.has("ask") && this.#toolRegistry.has("resolve");
		if (!hasRequiredTools) {
			logger.warn("Plan mode enforcement skipped because ask/resolve tools are unavailable", {
				activeToolNames: this.agent.state.tools.map(tool => tool.name),
			});
			return;
		}

		const reminder = prompt.render(planModeToolDecisionReminderPrompt, {
			askToolName: "ask",
		});

		await this.prompt(reminder, {
			synthetic: true,
			expandPromptTemplates: false,
			toolChoice: "required",
		});
	}

	/**
	 * Render context shared by the eager todo/task preludes. `toolRefs` resolves each
	 * tool's wire name (matching `buildSystemPrompt`'s `toolRefs`) so the reminder names
	 * the tool the model actually sees when an extension renames it; `taskBatch` gates
	 * batch-call guidance that would steer toward a failing call shape when `task.batch`
	 * is off (the flat single-spawn schema rejects `tasks`/`context`).
	 */
	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#toolRegistry.get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName("task"), todo: wireName("todo") },
			taskBatch: this.settings.get("task.batch"),
		};
	}

	#createEagerTodoPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.settings.get("todo.eager");
		const todosEnabled = this.settings.get("todo.enabled");
		if (mode === "default" || !todosEnabled) {
			return undefined;
		}

		if (this.#planModeState?.enabled) {
			return undefined;
		}
		if (this.getTodoPhases().length > 0) {
			return undefined;
		}

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		// When `promptText` is undefined (post-compaction re-injection) there is no fresh
		// user message to gate on, so skip the first-message and prompt-suffix checks.
		if (promptText !== undefined) {
			const hasPriorUserMessage = this.agent.state.messages.some(m => m.role === "user");
			if (hasPriorUserMessage) {
				return undefined;
			}

			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
				return undefined;
			}
		}

		// Must check the active tool set, not just the registry: tool discovery
		// (tools.discoveryMode === "all") can register `todo` while hiding it from
		// the exposed tools. Forcing a named tool_choice for an inactive tool makes
		// the provider reject the request (HTTP 400).
		if (!this.getActiveToolNames().includes("todo")) {
			logger.warn("Eager todo enforcement skipped because todo is not active", {
				activeToolNames: this.getActiveToolNames(),
			});
			return undefined;
		}

		const message: AgentMessage = {
			role: "custom",
			customType: "eager-todo-prelude",
			content: prompt.render(eagerTodoPrompt, { ...this.#buildEagerPreludeContext(), forced: mode === "always" }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		// `preferred` suggests a todo list (reminder only); `always` also forces the
		// `todo` tool on the first turn — the previous boolean-on behavior. Post-compaction
		// re-injection (`promptText === undefined`) is always reminder-only: forcing a tool
		// onto the auto-resumed turn would override the agent's in-flight action.
		if (promptText === undefined || mode === "preferred") {
			return { message };
		}
		const todoToolChoice = buildNamedToolChoice("todo", this.model);
		if (!todoToolChoice) {
			// `always` on a model that can't be forced degrades to reminder-only (no
			// tool_choice). For `todo.eager: true` users migrated to `always`, such
			// models now receive the first-turn reminder where they previously got
			// nothing (see the CHANGELOG entry); `always ⊇ preferred` is preserved.
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: this.model?.api, modelId: this.model?.id },
			);
			return { message };
		}
		return { message, toolChoice: todoToolChoice };
	}

	#createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		if (this.settings.get("task.eager") !== "always" && !this.isUltraMode()) return undefined;
		// Main agent only: subagents keep `task` active (the parent only filters `todo`),
		// so a salient delegate-reminder there would amplify nested fan-out. Gate on the
		// resolved agent kind, not the id, so a top-level session with a custom `agentId`
		// still gets the reminder.
		if (this.#agentKind === "sub") return undefined;
		if (this.#planModeState?.enabled) return undefined;
		// First-message-only gates are skipped post-compaction (`promptText === undefined`),
		// where there is no fresh user message to suppress the reminder for.
		if (promptText !== undefined) {
			if (this.agent.state.messages.some(m => m.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.getActiveToolNames().includes("task")) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(eagerTaskPrompt, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Build the eager task/todo reminders to re-inject on the auto-continuation turn that
	 * follows a compaction. The first-message preludes are the oldest messages, so
	 * compaction summarizes them away and the agent silently loses the delegate-via-tasks
	 * and phased-todo guidance mid-work; this re-asserts them, reminder-only (the todo
	 * builder drops its forced tool_choice when `promptText` is undefined). Each builder
	 * still applies its own mode / agent-kind / plan-mode / tool-active / surviving-todo
	 * gates, so an empty array means nothing currently warrants a nudge.
	 */
	#buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const compiledContract = this.#activeCompiledTaskContract;
		const retainedContractNotice = this.agent.state.messages.some(
			message =>
				message.role === "custom" &&
				message.customType === "task-contract-notice" &&
				message.content === compiledContract?.executorBlock.text,
		);
		if (compiledContract && !retainedContractNotice) {
			nudges.push({
				role: "custom",
				customType: "task-contract-notice",
				content: compiledContract.executorBlock.text,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			});
		}
		const todo = this.#createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.#createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}
	/**
	 * Check whether the root agent stopped without satisfying the active task contract.
	 * Injects a recoverable reminder and schedules continuation when criteria are unmet.
	 */
	async #checkRootCompletionGate(): Promise<boolean> {
		if (this.#agentKind !== "main") return false;
		const contract = this.#activeTaskContract;
		if (!contract) return false;
		// A queued streaming follow-up may activate a compiled root contract before its
		// hidden executor notice is actually delivered. Do not let an unrelated wake turn
		// enforce that deferred contract; enforcement starts once the notice enters context.
		const compiledContract = this.#activeCompiledTaskContract;
		if (
			compiledContract &&
			!this.agent.state.messages.some(
				message =>
					message.role === "custom" &&
					message.customType === "task-contract-notice" &&
					message.content === compiledContract.executorBlock.text,
			)
		) {
			return false;
		}

		if (this.#completionGateAwaitingProgress) {
			logger.debug("Completion gate: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#completionGateReminderCount,
			});
			return false;
		}

		const remindersMax = 2;
		if (this.#completionGateReminderCount >= remindersMax) {
			logger.debug("Completion gate: max reminders reached", { count: this.#completionGateReminderCount });
			return false;
		}

		const gateInput = buildCompletionGateInputFromTranscript(contract, this.messages, this.#taskContractActivatedAt);
		const evaluation = this.evaluateRootCompletionGate(gateInput);
		if (evaluation.outcome === "pass") {
			this.#completionGateReminderCount = 0;
			this.#completionGateAwaitingProgress = false;
			return false;
		}

		const reminderBody =
			evaluation.outcome === "blocked"
				? (evaluation.reminder ??
					"The current route violates the active task contract (non-solution or unresolved blocker). Do not claim success — revise the approach or report blocked with evidence.")
				: (evaluation.reminder ??
					"Completion criteria are not yet satisfied. Address the missing items before finishing.");

		this.#completionGateReminderCount++;
		const reminder =
			`<system-reminder>\n` +
			`Active task contract not satisfied:\n${reminderBody}\n\n` +
			`Verify with concrete checks (tests, commands, reads) — narrative alone is insufficient.\n` +
			`(Completion gate reminder ${this.#completionGateReminderCount}/${remindersMax})\n` +
			`</system-reminder>`;

		logger.debug("Completion gate: sending reminder", {
			outcome: evaluation.outcome,
			attempt: this.#completionGateReminderCount,
		});

		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.#completionGateAwaitingProgress = true;
		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 */
	async #checkTodoCompletion(): Promise<boolean> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
		const lastServedLabel = this.#toolChoiceQueue.consumeLastServedLabel();
		if (lastServedLabel === "user-force") {
			return false;
		}

		// Suppress within a self-continuation chain: if the agent's last turn was driven by a
		// prior reminder (and the agent took no tool-level action since), do not re-ping.
		// The agent has already acknowledged; further escalation just wastes context and
		// pressures the agent into busy-work or destructive ops (issue #2590).
		if (this.#todoReminderAwaitingProgress) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#todoReminderCount,
			});
			return false;
		}

		const remindersEnabled = this.settings.get("todo.reminders");
		const todosEnabled = this.settings.get("todo.enabled");
		if (!remindersEnabled || !todosEnabled) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			return false;
		}

		const remindersMax = this.settings.get("todo.reminders.max");
		if (this.#todoReminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#todoReminderCount });
			return false;
		}

		const phases = this.getTodoPhases();
		if (phases.length === 0) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			return false;
		}

		const incompleteByPhase = phases
			.map(phase => ({
				name: phase.name,
				tasks: phase.tasks
					.filter(
						(task): task is TodoItem & { status: "pending" | "in_progress" } =>
							task.status === "pending" || task.status === "in_progress",
					)
					.map(task => ({ content: task.content, status: task.status })),
			}))
			.filter(phase => phase.tasks.length > 0);
		const incomplete = incompleteByPhase.flatMap(phase => phase.tasks);
		if (incomplete.length === 0) {
			this.#todoReminderCount = 0;
			this.#todoReminderAwaitingProgress = false;
			return false;
		}

		// Build reminder message
		this.#todoReminderCount++;
		const todoList = incompleteByPhase
			.map(phase => `- ${phase.name}\n${phase.tasks.map(task => `  - ${task.content}`).join("\n")}`)
			.join("\n");
		const reminder =
			`<system-reminder>\n` +
			`You stopped with ${incomplete.length} incomplete todo item(s):\n${todoList}\n\n` +
			`Please continue working on these tasks or mark them complete if finished.\n` +
			`(Reminder ${this.#todoReminderCount}/${remindersMax})\n` +
			`</system-reminder>`;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#todoReminderCount,
		});

		// Emit event for UI to render notification
		await this.#emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete,
			attempt: this.#todoReminderCount,
			maxAttempts: remindersMax,
		});

		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		this.#todoReminderAwaitingProgress = true;
		// Inject reminder and persist it so the JSONL transcript matches model context.
		this.agent.appendMessage(reminderMessage);
		this.sessionManager.appendMessage(reminderMessage);
		this.#scheduleAgentContinue({ generation: this.#promptGeneration });
		return true;
	}

	/**
	 * Attempt context promotion to a larger model.
	 * Returns true if promotion succeeded (caller should retry without compacting).
	 */
	async #tryContextPromotion(assistantMessage: AssistantMessage): Promise<boolean> {
		const currentModel = this.model;
		if (!currentModel) return false;
		// The overflow/length error may have come from a model the user already
		// switched away from; only promote when the failing turn was this model.
		if (assistantMessage.provider !== currentModel.provider || assistantMessage.model !== currentModel.id)
			return false;
		return this.#promoteContextModel();
	}

	/**
	 * Switch to a larger-context sibling when context promotion is enabled and a
	 * target with a strictly larger window (and a usable key) exists. Returns true
	 * when the model was switched, so the caller can retry without compacting.
	 * Message-independent core shared by the post-turn overflow path
	 * ({@link #tryContextPromotion}) and the pre-prompt threshold path
	 * ({@link #runPrePromptCompactionIfNeeded}).
	 */
	async #promoteContextModel(): Promise<boolean> {
		const promotionSettings = this.settings.getGroup("contextPromotion");
		if (!promotionSettings.enabled) return false;
		const currentModel = this.model;
		if (!currentModel) return false;
		const contextWindow = currentModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const targetModel = await this.#resolveContextPromotionTarget(currentModel, contextWindow);
		if (!targetModel) return false;

		try {
			await this.setModelTemporary(targetModel, undefined, { ephemeral: true });
			logger.debug("Context promotion switched model on overflow", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
			});
			return true;
		} catch (error) {
			logger.warn("Context promotion failed", {
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${targetModel.provider}/${targetModel.id}`,
				error: String(error),
			});
			return false;
		}
	}

	async #resolveContextPromotionTarget(currentModel: Model, contextWindow: number): Promise<Model | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const candidate = this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
		if (!candidate) return undefined;
		if (modelsAreEqual(candidate, currentModel)) return undefined;
		if (candidate.contextWindow == null || candidate.contextWindow <= contextWindow) return undefined;
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) return undefined;
		return candidate;
	}

	/**
	 * Fusion cost mode: at a compaction boundary the provider/KV cache has already
	 * been invalidated by the history rewrite, so switching the main model here is
	 * marginal-cost: the messages-segment miss is already paid, and only the
	 * tools/system segment re-prefills for the new model.
	 *
	 * Static mode (`fusion.dynamicRouting` off): when `fusion.compactModel` is
	 * configured, ramp the main model down to that cheaper tier once per session.
	 *
	 * Dynamic mode (`fusion.dynamicRouting` on): at EVERY compaction a lightweight
	 * classifier reads the compaction summary and picks the tier for the next
	 * stretch — `cheap` (compactModel) for settled mechanical work, `frontier`
	 * (the original model) when the work needs strong reasoning. Automated routing
	 * latches off permanently the moment the user manually switches models.
	 *
	 * Always opt-in (empty selector = disabled), ephemeral (never written to
	 * settings), and a no-op when the target is unavailable, unauthed, or already
	 * active. Mirrors {@link #promoteContextModel}.
	 */
	async #applyFusionCompactionSwitch(summary?: string): Promise<void> {
		// Whole body guarded: this runs inside the compaction commit path, so an
		// unexpected throw from model resolution/auth lookup must never mark a
		// committed compaction as failed or stall auto-continue.
		try {
			if (this.settings.get("fusion.enabled") !== true) return;
			if (this.settings.get("fusion.mode") === "off") return;
			const currentModel = this.model;
			if (!currentModel) return;
			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) return;
			const resolveSelector = (sel: string): Model | undefined =>
				resolveModelRoleValue(sel, availableModels, {
					settings: this.settings,
					matchPreferences: getModelMatchPreferences(this.settings),
					modelRegistry: this.#modelRegistry,
				}).model;

			const dynamicRouting = this.settings.get("fusion.dynamicRouting") === true;
			// Tiered pool (tier 1 = most powerful … 5 = least intelligent), managed
			// via /fusion pool (legacy alias: /fusion-pool). Only meaningful with
			// dynamic routing and 2+ tiers.
			const pool = dynamicRouting ? parseFusionPoolEntries(this.settings.get("fusion.modelPool") ?? []) : [];
			const poolMode = pool.length >= 2;

			const selector = this.settings.get("fusion.compactModel")?.trim();
			const sidekickStrongSelector = this.settings.get("fusion.sidekickStrongModel")?.trim() ?? "";
			if (
				!shouldRunFusionCompactionSwitch({
					hasCompactSelector: !!selector,
					poolMode,
					dynamicRouting,
					hasSidekickStrongSelector: !!sidekickStrongSelector,
					pool,
				})
			) {
				return;
			}
			const cheapModel = selector ? resolveSelector(selector) : undefined;

			if (!dynamicRouting) {
				// Static: switch at most once per session so a later compaction never
				// clobbers a model the user manually chose after the first downgrade.
				if (!cheapModel) return;
				if (this.#fusionCompactionSwitched) return;
				if (modelsAreEqual(cheapModel, currentModel)) return;
				if (!this.#modelRegistry.hasConfiguredAuth(cheapModel)) return;
				// Capture the frontier baseline and auto-switch marker so the
				// failure-streak escalation (and its manual-override detection)
				// also works in static mode.
				this.#fusionBaseModel ??= currentModel;
				await this.setModelTemporary(cheapModel, undefined, { ephemeral: true });
				this.#fusionLastAutoModel = this.model ?? cheapModel;
				this.#fusionCompactionSwitched = true;
				logger.debug("Fusion compaction switch", {
					from: `${currentModel.provider}/${currentModel.id}`,
					to: `${cheapModel.provider}/${cheapModel.id}`,
				});
				return;
			}

			// Dynamic routing: respect a manual model choice forever after.
			if (this.#fusionRoutingDisabled) return;
			if (this.#fusionLastAutoModel && !modelsAreEqual(this.#fusionLastAutoModel, currentModel)) {
				this.#fusionRoutingDisabled = true;
				logger.debug("Fusion dynamic routing disabled after manual model switch");
				return;
			}
			const baseModel = this.#fusionBaseModel ?? currentModel;

			const route = await classifyFusionRoute(
				summary ?? "",
				this.#modelRegistry,
				this.settings,
				this.sessionId,
				poolMode ? pool : undefined,
			);
			// Binary mode falls back to the static one-shot ramp-down when the
			// classifier is unavailable; pool mode is classifier-driven and does not.
			const effectiveRoute = resolveEffectiveFusionRoute(route, {
				alreadySwitched: this.#fusionCompactionSwitched,
				pool,
			});
			if (effectiveRoute === undefined) return;

			// Decoupled sidekick tier routing (Devin-Fusion refinement): the same
			// verdict also re-tiers the warm sidekick, independently of whether the
			// main model switches below.
			await this.#applyFusionSidekickRoute(effectiveRoute, pool, resolveSelector);
			let target: Model | undefined;
			if (typeof effectiveRoute === "number") {
				const tierSelector = pool.find(t => t.tier === effectiveRoute)?.selector;
				target = tierSelector ? resolveSelector(tierSelector) : undefined;
			} else {
				target = effectiveRoute === "cheap" ? cheapModel : baseModel;
			}
			if (!target) return;
			if (modelsAreEqual(target, currentModel)) return;
			if (!this.#modelRegistry.hasConfiguredAuth(target)) return;
			// Capture the frontier baseline before the first downgrade so `frontier`
			// routes can restore it on a later compaction.
			this.#fusionBaseModel = baseModel;
			await this.setModelTemporary(target, undefined, { ephemeral: true });
			this.#fusionLastAutoModel = this.model ?? target;
			this.#fusionCompactionSwitched = true;
			logger.debug("Fusion dynamic route", {
				route: route ?? `${effectiveRoute} (static fallback)`,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${target.provider}/${target.id}`,
			});
		} catch (error) {
			logger.warn("Fusion compaction switch failed", { error: String(error) });
		}
	}

	/**
	 * Fusion dynamic routing: re-tier the warm sidekick from the same compaction
	 * verdict that routes the main model — hard stretches upgrade it to
	 * `fusion.sidekickStrongModel`, settled stretches return it to the base
	 * `fusion.sidekickModel`. Decoupled from the main switch: either can change
	 * without the other. Best-effort — the sidekick may be parked or absent, and
	 * its (small) context re-prefills on its next warm turn.
	 */
	async #applyFusionSidekickRoute(
		route: FusionRoute,
		pool: readonly FusionPoolTier[],
		resolveSelector: (sel: string) => Model | undefined,
	): Promise<void> {
		try {
			const strongSelector = this.settings.get("fusion.sidekickStrongModel")?.trim();
			if (!strongSelector) return;
			const sidekick = this.#fusionSidekickId
				? AgentRegistry.global().get(this.#fusionSidekickId)?.session
				: undefined;
			if (!sidekick) return;
			const tier = resolveSidekickRoute(route, pool);
			const selector = tier === "strong" ? strongSelector : this.settings.get("fusion.sidekickModel") || "pi/smol";
			const target = resolveSelector(selector);
			if (!target) return;
			const current = sidekick.model;
			if (current && modelsAreEqual(target, current)) return;
			if (!this.#modelRegistry.hasConfiguredAuth(target)) return;
			await sidekick.setModelTemporary(target, undefined, { ephemeral: true });
			logger.debug("Fusion sidekick route", { tier, to: `${target.provider}/${target.id}` });
		} catch (error) {
			logger.warn("Fusion sidekick route failed", { error: String(error) });
		}
	}

	/**
	 * Fusion cost mode: between compaction boundaries, a streak of consecutive
	 * failed tool calls on a downgraded main model is the cheapest reliable
	 * "this stretch turned hard" signal — no extra model request, verification-
	 * grade evidence. Force an early tier-up back to the frontier baseline
	 * instead of waiting for the next compaction. The mid-stretch switch
	 * deliberately pays one full-price prefill; that is the cost of escalating
	 * quality early. Guard structure mirrors {@link #applyFusionCompactionSwitch}.
	 */
	async #maybeEscalateFusionOnFailureStreak(): Promise<void> {
		try {
			const threshold = this.settings.get("fusion.escalateFailureStreak");
			if (typeof threshold !== "number" || threshold <= 0) return;
			if (this.#fusionToolFailureStreak < threshold) return;
			if (this.settings.get("fusion.enabled") !== true) return;
			if (this.settings.get("fusion.mode") === "off") return;
			if (this.#fusionRoutingDisabled) return;
			const baseModel = this.#fusionBaseModel;
			if (!baseModel) return; // never downgraded — nothing to escalate to
			const currentModel = this.model;
			if (!currentModel || modelsAreEqual(baseModel, currentModel)) return;
			// Respect a manual model choice, exactly like the compaction path.
			if (this.#fusionLastAutoModel && !modelsAreEqual(this.#fusionLastAutoModel, currentModel)) {
				this.#fusionRoutingDisabled = true;
				logger.debug("Fusion dynamic routing disabled after manual model switch");
				return;
			}
			if (!this.#modelRegistry.hasConfiguredAuth(baseModel)) return;
			this.#fusionToolFailureStreak = 0;
			await this.setModelTemporary(baseModel, undefined, { ephemeral: true });
			this.#fusionLastAutoModel = this.model ?? baseModel;
			logger.debug("Fusion failure-streak escalation", {
				threshold,
				from: `${currentModel.provider}/${currentModel.id}`,
				to: `${baseModel.provider}/${baseModel.id}`,
			});
		} catch (error) {
			logger.warn("Fusion failure-streak escalation failed", { error: String(error) });
		}
	}

	#setModelWithProviderSessionReset(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
		}
		this.agent.setModel(model);

		// Re-evaluate append-only context mode — provider or setting may have changed
		this.#syncAppendOnlyContext(model);
	}

	#closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	#resetCurrentResponsesProviderSession(reason: string): void {
		const currentModel = this.model;
		if (currentModel?.api !== "openai-responses" && currentModel?.api !== "openai-codex-responses") {
			return;
		}

		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
		this.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Reset Responses provider session after stale replay error", {
			provider: currentModel.provider,
			model: currentModel.id,
			api: currentModel.api,
			reason,
		});
	}

	/**
	 * Re-evaluate append-only context mode, creating or destroying the
	 * manager as needed. Called on model switch AND setting change.
	 */
	#syncAppendOnlyContext(model: Model | null | undefined): void {
		const setting = this.settings.get("provider.appendOnlyContext") ?? "auto";
		const enable = shouldEnableAppendOnlyContext(setting, model);
		const providerId = model?.provider;
		const prev = this.#lastAppendOnlyResolution;
		if (prev && prev.enable === enable && prev.providerId === providerId) return;
		this.#lastAppendOnlyResolution = { enable, providerId };

		if (enable && !this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(new AppendOnlyContextManager());
		} else if (enable && this.agent.appendOnlyContext) {
			// Already active — invalidate prefix + log so the next turn
			// rebuilds for the current model's normalization.
			this.agent.appendOnlyContext.invalidateForModelChange();
		} else if (!enable && this.agent.appendOnlyContext) {
			this.agent.setAppendOnlyContext(undefined);
		}
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		const providerKeys = new Set<string>();
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			providerKeys.add("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${currentModel.provider}`);
		}
		if (nextModel.api === "openai-responses") {
			providerKeys.add(`openai-responses:${nextModel.provider}`);
		}
		if (currentModel.api === "openai-completions") {
			const sameBackend =
				nextModel.api === "openai-completions" &&
				nextModel.provider === currentModel.provider &&
				nextModel.baseUrl === currentModel.baseUrl;
			if (!sameBackend) {
				// Completions keys embed the base URL resolved at request time, which can
				// diverge from the model's configured baseUrl — evict by provider prefix so
				// resolved-URL entries and sibling models on the same backend all go.
				const prefix = `openai-completions:${currentModel.provider}:`;
				for (const providerKey of this.#providerSessionState.keys()) {
					if (providerKey.startsWith(prefix)) {
						providerKeys.add(providerKey);
					}
				}
			}
		}

		for (const providerKey of providerKeys) {
			const state = this.#providerSessionState.get(providerKey);
			if (!state) continue;

			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state during model switch", {
					providerKey,
					error: String(error),
				});
			}

			this.#providerSessionState.delete(providerKey);
		}
	}

	#normalizeProviderReplayValue(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(item => this.#normalizeProviderReplayValue(item));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entryValue]) => [key, this.#normalizeProviderReplayValue(entryValue)]),
			);
		}
		return value;
	}

	#normalizeSessionMessageForProviderReplay(message: AgentMessage): unknown {
		switch (message.role) {
			case "user":
			case "developer":
				return {
					role: message.role,
					content: this.#normalizeProviderReplayValue(message.content),
					providerPayload: message.providerPayload,
				};
			case "assistant": {
				const isResponsesFamilyMessage =
					message.api === "openai-responses" || message.api === "openai-codex-responses";
				return {
					role: message.role,
					content:
						isResponsesFamilyMessage && Array.isArray(message.content)
							? message.content.flatMap(block => {
									if (block.type === "thinking") {
										return [];
									}
									if (block.type === "toolCall") {
										return [
											{
												type: block.type,
												id: block.id,
												name: block.name,
												arguments: block.arguments,
											},
										];
									}
									if (block.type === "text") {
										return [{ type: block.type, text: block.text, textSignature: block.textSignature }];
									}
									return [this.#normalizeProviderReplayValue(block)];
								})
							: this.#normalizeProviderReplayValue(message.content),
					api: message.api,
					provider: message.provider,
					model: message.model,
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
					providerPayload: isResponsesFamilyMessage ? undefined : message.providerPayload,
				};
			}
			case "toolResult":
				return {
					role: message.role,
					toolName: message.toolName,
					toolCallId: message.toolCallId,
					isError: message.isError,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "bashExecution":
				return {
					role: message.role,
					command: message.command,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "pythonExecution":
				return {
					role: message.role,
					code: message.code,
					output: message.output,
					exitCode: message.exitCode,
					cancelled: message.cancelled,
					meta: message.meta
						? {
								truncation: this.#normalizeProviderReplayValue(message.meta.truncation),
								limits: this.#normalizeProviderReplayValue(message.meta.limits),
								diagnostics: message.meta.diagnostics
									? this.#normalizeProviderReplayValue({
											summary: message.meta.diagnostics.summary,
											messages: message.meta.diagnostics.messages,
										})
									: undefined,
							}
						: undefined,
					excludeFromContext: message.excludeFromContext,
				};
			case "custom":
			case "hookMessage":
				return {
					role: message.role,
					customType: message.customType,
					content: this.#normalizeProviderReplayValue(message.content),
				};
			case "branchSummary":
				return { role: message.role, summary: message.summary };
			case "compactionSummary":
				return {
					role: message.role,
					summary: message.summary,
					providerPayload: message.providerPayload,
				};
			case "fileMention":
				return {
					role: message.role,
					files: message.files.map(file => ({
						path: file.path,
						content: file.content,
						image: file.image,
					})),
				};
			default:
				return this.#normalizeProviderReplayValue(message);
		}
	}

	#didSessionMessagesChange(previousMessages: AgentMessage[], nextMessages: AgentMessage[]): boolean {
		if (previousMessages.length !== nextMessages.length) return true;
		return previousMessages.some(
			(message, i) =>
				!Bun.deepEquals(
					this.#normalizeSessionMessageForProviderReplay(message),
					this.#normalizeSessionMessageForProviderReplay(nextMessages[i]),
				),
		);
	}

	#getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#formatRoleModelValue(
		role: string,
		model: Model,
		selectorOverride?: string,
		thinkingLevelOverride?: ThinkingLevel,
	): string {
		const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
		if (thinkingLevelOverride !== undefined) {
			return formatModelSelectorValue(modelKey, thinkingLevelOverride);
		}
		const existingRoleValue = this.settings.getModelRole(role);
		if (!existingRoleValue) return modelKey;

		const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, this.settings, {
			isLiteralModelId: (provider, id) => this.#modelRegistry.find(provider, id) !== undefined,
		});
		return formatModelSelectorValue(modelKey, thinkingLevel);
	}
	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		const configuredTarget = currentModel.contextPromotionTarget?.trim();
		if (!configuredTarget) return undefined;

		const parsed = parseModelString(configuredTarget, {
			allowMaxAlias: true,
			isLiteralModelId: (provider, id) =>
				availableModels.some(model => model.provider === provider && model.id === id),
		});
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === configuredTarget);
	}

	#resolveRoleModelFull(
		role: string,
		availableModels: Model[],
		currentModel: Model | undefined,
	): ResolvedModelRoleValue {
		const roleModelStr =
			role === "default"
				? (this.settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.settings.getModelRole(role);

		if (!roleModelStr) {
			return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
		}

		return resolveModelRoleValue(roleModelStr, availableModels, {
			settings: this.settings,
			matchPreferences: getModelMatchPreferences(this.settings),
			modelRegistry: this.#modelRegistry,
		});
	}

	#getCompactionModelCandidates(availableModels: Model[]): Model[] {
		return this.#resolveCompactionModelCandidates(this.model, availableModels);
	}

	#resolveCompactionModelCandidates(preferredModel: Model | null | undefined, availableModels: Model[]): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.#getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push(model);
		};

		addCandidate(this.#resolveConfiguredCompactionModel(preferredModel ?? undefined, availableModels));
		addCandidate(preferredModel ?? undefined);
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModelFull(role, availableModels, preferredModel ?? undefined).model);
		}

		const sortedByContext = [...availableModels].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		for (const model of sortedByContext) {
			if (!seen.has(this.#getModelKey(model))) {
				addCandidate(model);
				break;
			}
		}

		return candidates;
	}

	/** Resolve the model's `compactionModel` selector (model id or provider/id) against the registry. */
	#resolveConfiguredCompactionModel(currentModel: Model | undefined, availableModels: Model[]): Model | undefined {
		const configuredTarget = currentModel?.compactionModel?.trim();
		if (!configuredTarget || !currentModel) return undefined;

		const parsed = parseModelString(configuredTarget, {
			allowMaxAlias: true,
			isLiteralModelId: (provider, id) =>
				availableModels.some(model => model.provider === provider && model.id === id),
		});
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === configuredTarget);
	}

	#isCompactionAuthFailure(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		// Real provider 401/403 — surfaced as `.status` by the compaction layer
		// (see `createSummarizationError` in packages/agent/src/compaction/compaction.ts).
		// Without this branch, an expired/revoked Anthropic key would bypass the
		// authenticated-fallback path and dump the raw HTTP body into the UI.
		const status = (error as Error & { status?: number }).status;
		if (status === 401 || status === 403) return true;
		// pi-native gateway synthetic for "no credential configured" (issue #986).
		// Carries no HTTP status, so the legacy message regex stays.
		return /auth_unavailable|no auth available/i.test(error.message);
	}

	#buildCompactionAuthError(): Error {
		const currentModel = this.model;
		if (!currentModel) {
			return new Error(
				"Compaction requires a model with usable credentials, but no authenticated compaction model is available.",
			);
		}
		return new Error(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}. ` +
				`Configure ${currentModel.provider} credentials or assign an authenticated fallback role such as modelRoles.smol.`,
		);
	}

	async #compactWithFallbackModel(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		options?: SummaryOptions,
		remoteOnly = false,
	): Promise<CompactionResult> {
		const allCandidates = this.#getCompactionModelCandidates(this.#modelRegistry.getAvailable());
		const candidates = remoteOnly
			? allCandidates.filter(candidate => shouldUseOpenAiRemoteCompaction(candidate))
			: allCandidates;
		const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);

		for (const candidate of candidates) {
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;

			try {
				return await compact(
					this.#obfuscatePreparationForProvider(preparation),
					candidate,
					this.#modelRegistry.resolver(candidate, this.sessionId),
					this.#obfuscateTextForProvider(customInstructions),
					signal,
					{
						...options,
						metadata: this.agent.metadataForProvider(candidate.provider),
						convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
						telemetry,
						// Honor the user's /model thinking selection (incl. `off`) on
						// the manual `/compact` path. Clamped per-model inside compact()
						// via resolveCompactionEffort so unsupported-effort models
						// (xai-oauth/grok-build) don't trip requireSupportedEffort.
						thinkingLevel: this.thinkingLevel,
					},
				);
			} catch (error) {
				if (!this.#isCompactionAuthFailure(error)) {
					throw error;
				}
			}
		}

		throw this.#buildCompactionAuthError();
	}

	async #prepareCompactionFromHooks(
		preparation: CompactionPreparation,
		hookCompaction: CompactionResult | undefined,
	): Promise<
		| {
				kind: "fromHook";
				summary: string;
				shortSummary: string | undefined;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: unknown;
				preserveData: Record<string, unknown> | undefined;
		  }
		| {
				kind: "needsLlm";
				hookContext: string[] | undefined;
				hookPrompt: string | undefined;
				preserveData: Record<string, unknown> | undefined;
		  }
	> {
		let hookContext: string[] | undefined;
		let hookPrompt: string | undefined;
		let preserveData: Record<string, unknown> | undefined;

		if (!hookCompaction && this.#extensionRunner?.hasHandlers("session.compacting")) {
			const compactMessages = preparation.messagesToSummarize.concat(preparation.turnPrefixMessages);
			const result = (await this.#extensionRunner.emit({
				type: "session.compacting",
				sessionId: this.sessionId,
				messages: compactMessages,
			})) as { context?: string[]; prompt?: string; preserveData?: Record<string, unknown> } | undefined;

			hookContext = result?.context;
			hookPrompt = result?.prompt;
			preserveData = result?.preserveData;
		}

		const memoryBackendContext = await this.#collectMemoryBackendContext(preparation);
		if (memoryBackendContext) {
			hookContext = hookContext ? [...hookContext, memoryBackendContext] : [memoryBackendContext];
		}

		if (hookCompaction) {
			preserveData ??= hookCompaction.preserveData;
			return {
				kind: "fromHook",
				summary: hookCompaction.summary,
				shortSummary: hookCompaction.shortSummary,
				firstKeptEntryId: hookCompaction.firstKeptEntryId,
				tokensBefore: hookCompaction.tokensBefore,
				details: hookCompaction.details,
				preserveData,
			};
		}

		return { kind: "needsLlm", hookContext, hookPrompt, preserveData };
	}

	/**
	 * Internal: Run auto-compaction with events.
	 *
	 * @param allowDefer If true (default), threshold-driven handoff strategy is allowed to
	 *   schedule itself as a deferred post-prompt task and return a deferred-handoff result
	 *   immediately. The caller MUST treat that as "compaction will happen async — do not
	 *   also schedule `agent.continue()` for this turn", otherwise the deferred handoff
	 *   races a fresh streaming turn (the symptom: "Auto-handoff" loader + assistant
	 *   message still streaming). Callers on a path that is about to start a new agent
	 *   turn (e.g. the pre-prompt check in `#promptWithMessage`) pass `false` to force
	 *   inline execution so the handoff completes before the new turn begins.
	 * @returns whether auto-compaction scheduled a follow-up turn.
	 */
	async #runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		deferred = false,
		allowDefer = true,
		options: { autoContinue?: boolean; forceInPlace?: boolean; triggerContextTokens?: number } = {},
	): Promise<CompactionCheckResult> {
		const compactionSettings = this.settings.getGroup("compaction");
		if (compactionSettings.strategy === "off") return COMPACTION_CHECK_NONE;
		if (reason !== "idle" && !compactionSettings.enabled) return COMPACTION_CHECK_NONE;
		const generation = this.#promptGeneration;
		const shouldAutoContinue = options.autoContinue !== false && compactionSettings.autoContinue !== false;
		// Shake runs inline (cheap, no remote LLM). On overflow recovery, if shake
		// reclaims nothing we fall through to the summary-compaction body below so
		// the oversized input still gets resolved. Mid-turn passes (forceInPlace)
		// skip shake: the live loop context is rebuilt from the branch rewrite, so
		// only a summary compaction actually shrinks the next request.
		if (compactionSettings.strategy === "shake" && !options.forceInPlace) {
			const outcome = await this.#runAutoShake(
				reason,
				willRetry,
				generation,
				shouldAutoContinue,
				options.triggerContextTokens,
			);
			if (outcome !== "fallback") return outcome;
		}
		// "overflow" and "incomplete" force inline execution because they are recovery
		// paths the caller wants resolved before scheduling the next turn. "idle" is
		// triggered by the idle loop and does its own scheduling.
		if (
			!deferred &&
			allowDefer &&
			!options.forceInPlace &&
			reason !== "overflow" &&
			reason !== "incomplete" &&
			reason !== "idle" &&
			compactionSettings.strategy === "handoff"
		) {
			this.#schedulePostPromptTask(
				async signal => {
					await Promise.resolve();
					if (signal.aborted) return;
					await this.#runAutoCompaction(reason, willRetry, true);
				},
				{ generation },
			);
			return COMPACTION_CHECK_DEFERRED_HANDOFF;
		}

		// forceInPlace (mid-turn compaction) always summarizes in place: a mid-run
		// handoff would reset the session out from under the live agent loop.
		const handoffAllowed =
			compactionSettings.strategy === "handoff" && reason !== "overflow" && !options.forceInPlace;
		let action: "context-full" | "handoff" = handoffAllowed ? "handoff" : "context-full";
		// Abort any older auto-compaction before installing this run's controller.
		this.#autoCompactionAbortController?.abort();
		const autoCompactionAbortController = new AbortController();
		this.#autoCompactionAbortController = autoCompactionAbortController;
		const autoCompactionSignal = autoCompactionAbortController.signal;

		try {
			// Emit start AFTER the controller is installed so isCompacting is already true
			// for any listener — and for input routed during this emit's event-loop yield:
			// a message typed as the compaction loader appears must land in the compaction
			// queue, not the core steering queue (which handoff's agent.reset() would wipe).
			await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
			if (handoffAllowed) {
				const handoffFocus = AUTO_HANDOFF_THRESHOLD_FOCUS;
				const handoffResult = await this.handoff(handoffFocus, {
					autoTriggered: true,
					signal: autoCompactionSignal,
				});
				if (!handoffResult) {
					const aborted = autoCompactionSignal.aborted;
					if (aborted) {
						await this.#emitSessionEvent({
							type: "auto_compaction_end",
							action,
							result: undefined,
							aborted: true,
							willRetry: false,
						});
						return COMPACTION_CHECK_NONE;
					}
					logger.warn("Auto-handoff returned no document; falling back to context-full maintenance", {
						reason,
					});
					action = "context-full";
				}
				if (handoffResult) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: false,
						willRetry: false,
					});
					const continuationScheduled = !autoCompactionSignal.aborted && reason !== "idle" && shouldAutoContinue;
					if (continuationScheduled) {
						this.#scheduleAutoContinuePrompt(generation);
					}
					return continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE;
				}
			}

			if (!this.model) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return COMPACTION_CHECK_NONE;
			}

			const availableModels = this.#modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				return COMPACTION_CHECK_NONE;
			}

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, compactionSettings);
			if (!preparation) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: true,
				});
				if (!willRetry && this.agent.hasQueuedMessages()) {
					this.#scheduleAgentContinue({
						delayMs: 100,
						generation,
						shouldContinue: () => this.agent.hasQueuedMessages(),
					});
					return COMPACTION_CHECK_CONTINUATION;
				}
				return COMPACTION_CHECK_NONE;
			}

			let hookCompaction: CompactionResult | undefined;
			let fromExtension = false;
			let preserveData: Record<string, unknown> | undefined;

			if (this.#extensionRunner?.hasHandlers("session_before_compact")) {
				const hookResult = (await this.#extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					signal: autoCompactionSignal,
				})) as SessionBeforeCompactResult | undefined;

				if (hookResult?.cancel) {
					await this.#emitSessionEvent({
						type: "auto_compaction_end",
						action,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return COMPACTION_CHECK_NONE;
				}

				if (hookResult?.compaction) {
					hookCompaction = hookResult.compaction;
					fromExtension = true;
				}
			}

			const compactionPrep = await this.#prepareCompactionFromHooks(preparation, hookCompaction);

			let summary: string;
			let shortSummary: string | undefined;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let details: unknown;

			if (compactionPrep.kind === "fromHook") {
				summary = compactionPrep.summary;
				shortSummary = compactionPrep.shortSummary;
				firstKeptEntryId = compactionPrep.firstKeptEntryId;
				tokensBefore = compactionPrep.tokensBefore;
				details = compactionPrep.details;
				preserveData = compactionPrep.preserveData;
			} else {
				const candidates = this.#getCompactionModelCandidates(availableModels);
				const retrySettings = this.settings.getGroup("retry");
				const telemetry = resolveTelemetry(this.agent.telemetry, this.sessionId);
				let compactResult: CompactionResult | undefined;
				let lastError: unknown;

				for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
					const candidate = candidates[candidateIndex];
					const hasMoreCandidates = candidateIndex < candidates.length - 1;
					const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
					if (!apiKey) continue;

					let attempt = 0;
					while (true) {
						try {
							compactResult = await compact(
								this.#obfuscatePreparationForProvider(preparation),
								candidate,
								this.#modelRegistry.resolver(candidate, this.sessionId),
								undefined,
								autoCompactionSignal,
								{
									promptOverride: this.#obfuscateTextForProvider(compactionPrep.hookPrompt),
									extraContext: this.#obfuscateTextArrayForProvider(compactionPrep.hookContext),
									remoteInstructions: this.#obfuscateTextForProvider(this.#baseSystemPrompt.join("\n\n")),
									metadata: this.agent.metadataForProvider(candidate.provider),
									initiatorOverride: "agent",
									convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
									telemetry,
									// Honor the user's /model thinking selection on the
									// auto-compaction path — the most-fired compaction
									// site. Clamped per-model inside compact() via
									// resolveCompactionEffort.
									thinkingLevel: this.thinkingLevel,
								},
							);
							break;
						} catch (error) {
							if (autoCompactionSignal.aborted) {
								throw error;
							}

							const message = error instanceof Error ? error.message : String(error);
							if (this.#isCompactionAuthFailure(error)) {
								lastError = this.#buildCompactionAuthError();
								break;
							}
							if (this.#isCompactionSummarizationTimeoutMessage(message)) {
								logger.warn(
									hasMoreCandidates
										? "Auto-compaction summarization timed out, trying next model"
										: "Auto-compaction summarization timed out, not retrying same model",
									{
										error: message,
										model: `${candidate.provider}/${candidate.id}`,
									},
								);
								lastError = error;
								break;
							}

							const retryAfterMs = this.#parseRetryAfterMsFromError(message);
							const shouldRetry =
								retrySettings.enabled &&
								attempt < retrySettings.maxRetries &&
								(retryAfterMs !== undefined ||
									this.#isTransientErrorMessage(message) ||
									isUsageLimitError(message));
							if (!shouldRetry) {
								lastError = error;
								break;
							}

							const baseDelayMs = retrySettings.baseDelayMs * 2 ** attempt;
							const delayMs = retryAfterMs !== undefined ? Math.max(baseDelayMs, retryAfterMs) : baseDelayMs;

							// If retry delay is too long (>30s), try next candidate instead of waiting
							const maxAcceptableDelayMs = 30_000;
							if (delayMs > maxAcceptableDelayMs && hasMoreCandidates) {
								logger.warn("Auto-compaction retry delay too long, trying next model", {
									delayMs,
									retryAfterMs,
									error: message,
									model: `${candidate.provider}/${candidate.id}`,
								});
								lastError = error;
								break; // Exit retry loop, continue to next candidate
							}

							attempt++;
							logger.warn("Auto-compaction failed, retrying", {
								attempt,
								maxRetries: retrySettings.maxRetries,
								delayMs,
								retryAfterMs,
								error: message,
								model: `${candidate.provider}/${candidate.id}`,
							});
							await scheduler.wait(delayMs, { signal: autoCompactionSignal });
						}
					}

					if (compactResult) {
						break;
					}
				}

				if (!compactResult) {
					if (lastError) {
						throw lastError;
					}
					throw new Error("Compaction failed: no available model");
				}

				summary = compactResult.summary;
				shortSummary = compactResult.shortSummary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				details = compactResult.details;
				preserveData = { ...(compactionPrep.preserveData ?? {}), ...(compactResult.preserveData ?? {}) };
			}

			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}

			const tracedCompaction = await this.#attachOffloadTraceToCompaction({
				summary,
				shortSummary,
				preserveData,
				preparation,
			});
			summary = tracedCompaction.summary;
			preserveData = this.#stripRetiredSnapcompactPreserveData(tracedCompaction.preserveData);

			this.sessionManager.appendCompaction(
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				preserveData,
			);
			this.#retainCompactionSummaryToMemory(summary, shortSummary, false);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.buildDisplaySessionContext();
			this.agent.replaceMessages(sessionContext.messages);
			// Compaction discarded the conversation history that carried the approved
			// plan reference. Clear the sent-flag so #buildPlanReferenceMessage re-reads
			// the plan from disk and re-injects it on the next turn (issue #1246).
			this.#planReferenceSent = false;
			this.#advisorRuntime?.reset();
			this.#syncTodoPhasesFromBranch();
			this.#closeCodexProviderSessionsForHistoryRewrite();

			// Get the saved compaction entry for the hook
			const savedCompactionEntry = newEntries.find(e => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this.#extensionRunner && savedCompactionEntry) {
				await this.#extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
				});
			}

			const result: CompactionResult = {
				summary,
				shortSummary,
				firstKeptEntryId,
				tokensBefore,
				details,
				preserveData,
			};
			// Fusion cost mode: ramp the main model down to the configured cheaper
			// tier now that the history rewrite has already invalidated the cache.
			await this.#applyFusionCompactionSwitch(summary);
			await this.#emitSessionEvent({ type: "auto_compaction_end", action, result, aborted: false, willRetry });

			// Progress guard: a "successful" pass whose residual context still has no
			// headroom must not schedule the continuation/retry that re-enters
			// #checkCompaction over the same oversized tail — that is the thrash loop.
			// Only post-turn passes are guarded; mid-turn (forceInPlace), pre-prompt
			// (autoContinue: false), and idle passes never own the next turn.
			const guardHeadroom = options.autoContinue !== false && reason !== "idle" && !options.forceInPlace;
			const noHeadroom = guardHeadroom && this.#compactionLeftNoHeadroom(willRetry);

			let continuationScheduled = false;
			if (!willRetry && reason !== "idle" && shouldAutoContinue && !noHeadroom) {
				this.#scheduleAutoContinuePrompt(generation);
				continuationScheduled = true;
			}

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					// Drop the prior turn before retry when it carries no actionable deliverable:
					// - "error": failure was kept in history but must not re-enter the next turn's prompt.
					// - reason === "incomplete" && stopReason === "length": truncated output (typically
					//   reasoning-only) — re-running it produces the same dead-end.
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) {
						this.agent.replaceMessages(messages.slice(0, -1));
					}
				}

				if (!noHeadroom) {
					this.#scheduleAgentContinue({ delayMs: 100, generation });
					continuationScheduled = true;
				}
			} else if (this.agent.hasQueuedMessages()) {
				// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
				// Kick the loop so queued messages are actually delivered.
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
				});
				continuationScheduled = true;
			}
			if (noHeadroom) {
				this.emitNotice(
					"warning",
					willRetry
						? "Compaction freed too little context to make progress: the recovered prompt still does not fit the context window. Pausing instead of retrying — reduce context (e.g. /clear or /handoff) before continuing."
						: "Compaction freed too little context to make progress: residual context is still above the recovery threshold. Pausing auto-continue — reduce context (e.g. /clear or /handoff) before continuing.",
					"compaction",
				);
				return continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_PAUSED;
			}
			return continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE;
		} catch (error) {
			if (autoCompactionSignal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: reason === "incomplete"
							? `Incomplete response recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
			});
		} finally {
			if (this.#autoCompactionAbortController === autoCompactionAbortController) {
				this.#autoCompactionAbortController = undefined;
			}
		}
		return COMPACTION_CHECK_NONE;
	}

	/**
	 * Post-compaction headroom check for the context-full tail.
	 *
	 * For a retry recovery (overflow/incomplete) the rebuilt prompt only needs to
	 * fit the usable window — the reserve is clamped so a model window smaller
	 * than the configured absolute reserve keeps a positive budget. For a
	 * threshold pass the residual must land at or below the
	 * `COMPACTION_RECOVERY_BAND × threshold` hysteresis band, mirroring the
	 * post-shake check, so the next turn cannot immediately re-trip compaction.
	 */
	#compactionLeftNoHeadroom(willRetry: boolean): boolean {
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const residualTokens = this.getContextUsage({ contextWindow })?.tokens;
		if (residualTokens === undefined) return false;
		const compactionSettings = this.settings.getGroup("compaction");
		if (willRetry) {
			const reserveTokens = Math.min(
				effectiveReserveTokens(contextWindow, compactionSettings),
				Math.floor(contextWindow / 2),
			);
			return residualTokens > contextWindow - reserveTokens;
		}
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
		return residualTokens > recoveryBand;
	}

	/**
	 * Run a shake-strategy auto-maintenance pass. Emits the
	 * `auto_compaction_start`/`auto_compaction_end` pair with a shake `action`,
	 * runs {@link shake} inline against the protect-window config, and schedules
	 * continuation exactly like the context-full tail.
	 *
	 * Returns `"fallback"` only for an overflow recovery where shake reclaimed
	 * nothing (or threw) — the caller then runs the summary-compaction body so
	 * the oversized input still gets resolved. Returns `"handled"` otherwise.
	 */
	async #runAutoShake(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		generation: number,
		autoContinue: boolean,
		triggerContextTokens?: number,
	): Promise<CompactionCheckResult | "fallback"> {
		const action = "shake";
		this.#autoCompactionAbortController?.abort();
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		const signal = controller.signal;
		try {
			await this.#emitSessionEvent({ type: "auto_compaction_start", reason, action });
			const result = await this.shake("elide", { config: DEFAULT_SHAKE_CONFIG, signal });
			if (signal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const reclaimed = result.toolResultsDropped + result.blocksDropped > 0;
			// Detect the dead-loop reported in issues #2119/#2275: the threshold check
			// fires, shake runs, but residual context is still above the configured
			// threshold. The next agent_end would re-trigger shake, which has nothing
			// new to drop on the second pass, so the loop spins until the user kills it.
			// Same hazard for "incomplete" (the retry would re-hit the length cap) and
			// for the existing "overflow + nothing reclaimed" case. In every recovery
			// reason we hand off to the summarization-driven context-full path so the
			// situation actually resolves; "idle" is exempt because its 60s+ timer
			// re-checks usage before re-firing and cannot dead-loop on its own.
			//
			// #2275: the post-shake check MUST be anchored on the same metric that
			// triggered compaction. The local estimator (`#estimatePendingPromptTokens`)
			// undercounts thinking-signature payloads, so on thinking-heavy sessions it
			// reads well below the provider-reported usage that fired the threshold.
			// When that estimate slips under the threshold, the fallback never fires
			// and the auto-continue prompt re-injects every turn. Prefer the trigger's
			// own `contextTokens` (provider-anchored) when the caller supplies it, and
			// add hysteresis (80% recovery band) so we don't oscillate at the boundary
			// while shake keeps reclaiming a trickle of the previous turn's output.
			const contextWindow = this.model?.contextWindow ?? 0;
			const compactionSettings = this.settings.getGroup("compaction");
			let stillOverThreshold = false;
			if (contextWindow > 0) {
				if (typeof triggerContextTokens === "number" && Number.isFinite(triggerContextTokens)) {
					const correctedTokens = Math.max(0, triggerContextTokens - result.tokensFreed);
					const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
					const recoveryBand = Math.floor(thresholdTokens * COMPACTION_RECOVERY_BAND);
					stillOverThreshold = correctedTokens > recoveryBand;
				} else {
					const postShakeTokens = this.getContextUsage({ contextWindow })?.tokens ?? 0;
					stillOverThreshold = shouldCompact(postShakeTokens, contextWindow, compactionSettings);
				}
			}
			const shouldFallBack = reason !== "idle" && ((reason === "overflow" && !reclaimed) || stillOverThreshold);
			if (shouldFallBack) {
				const errorMessage = reclaimed
					? `Auto-shake reclaimed ~${result.tokensFreed} tokens but context is still above the threshold; falling back to context-full compaction.`
					: "Auto-shake found nothing eligible to drop; falling back to context-full compaction.";
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: false,
					willRetry: false,
					skipped: !reclaimed,
					errorMessage,
				});
				return "fallback";
			}
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry,
				skipped: !reclaimed,
			});

			let continuationScheduled = false;
			if (!willRetry && reason !== "idle" && autoContinue) {
				this.#scheduleAutoContinuePrompt(generation);
				continuationScheduled = true;
			}
			if (willRetry) {
				// The shake rebuild replays every entry, so a trailing error/length
				// assistant from the failed turn re-enters agent state — drop it before
				// retrying, same as the context-full tail.
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant") {
					const lastAssistant = lastMsg as AssistantMessage;
					const shouldDrop =
						lastAssistant.stopReason === "error" ||
						(reason === "incomplete" && lastAssistant.stopReason === "length");
					if (shouldDrop) this.agent.replaceMessages(messages.slice(0, -1));
				}
				this.#scheduleAgentContinue({ delayMs: 100, generation });
				continuationScheduled = true;
			} else if (this.agent.hasQueuedMessages()) {
				this.#scheduleAgentContinue({
					delayMs: 100,
					generation,
					shouldContinue: () => this.agent.hasQueuedMessages(),
				});
				continuationScheduled = true;
			}
			return continuationScheduled ? COMPACTION_CHECK_CONTINUATION : COMPACTION_CHECK_NONE;
		} catch (error) {
			if (signal.aborted) {
				await this.#emitSessionEvent({
					type: "auto_compaction_end",
					action,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return COMPACTION_CHECK_NONE;
			}
			const message = error instanceof Error ? error.message : "shake failed";
			await this.#emitSessionEvent({
				type: "auto_compaction_end",
				action,
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage: `Auto-shake failed: ${message}`,
			});
			// Overflow still needs recovery even if shake threw.
			return reason === "overflow" ? "fallback" : COMPACTION_CHECK_NONE;
		} finally {
			if (this.#autoCompactionAbortController === controller) {
				this.#autoCompactionAbortController = undefined;
			}
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settings.set("compaction.enabled", enabled);
		if (enabled && this.settings.get("compaction.strategy") === "off") {
			this.settings.set("compaction.strategy", "context-full");
		}
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settings.get("compaction.enabled") && this.settings.get("compaction.strategy") !== "off";
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Retry an empty, reason-less provider abort: a turn that ended `aborted`
	 * with no content and the generic sentinel (bare `abort()`), but only while
	 * the session is neither aborting nor tearing down. A user/lifecycle abort
	 * (`#abortInProgress`), a dispose-driven abort (`#isDisposed`), or a
	 * session-induced streaming-edit guard abort (`#streamingEditAbortTriggered` —
	 * auto-generated-file guard or failed-patch preview) is deliberate and MUST
	 * settle the turn instead: routing it through retry would orphan
	 * `#retryPromise` on a continuation the guard skips (hanging the in-flight
	 * `prompt()`) or silently undo the guard's intended abort.
	 */
	#isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		return (
			message.stopReason === "aborted" &&
			message.content.length === 0 &&
			message.errorMessage === GENERIC_ABORT_SENTINEL &&
			!this.#abortInProgress &&
			!this.#isDisposed &&
			!this.#streamingEditAbortTriggered
		);
	}

	/**
	 * Check if an error is retryable (transient errors or usage limits).
	 * Context overflow is NOT retryable (handled by compaction instead).
	 * Usage-limit errors are retryable because the retry handler performs credential switching.
	 */
	#isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		if (this.#isClassifierRefusal(message)) return true;
		if (this.#isProviderErrorFinishReasonBeforeToolUse(message)) return true;
		if (this.#isMalformedFunctionCallError(message)) return true;
		if (this.#hasReplayUnsafeToolOutput(message)) return false;
		if (message.errorMessage.includes(THINKING_LOOP_ERROR_MARKER)) return true;
		// Thinking-loop detection also arrives as a classified errorId with no
		// transient wording in the message — retry on the flag itself.
		if (AIError.is(message.errorId, AIError.Flag.ThinkingLoop)) return true;
		if (this.#isStaleOpenAIResponsesReplayError(message)) return true;

		const err = message.errorMessage;
		return this.#isTransientErrorMessage(err) || isUsageLimitError(err);
	}
	/**
	 * Retried turns remove the failed assistant message from active context.
	 * Text/thinking-only partials are safe to discard and replay. Retained
	 * tool calls are not: a completed tool call may already have emitted its
	 * tool result after this assistant message, so replaying can duplicate work.
	 */
	#hasReplayUnsafeToolOutput(message: AssistantMessage): boolean {
		return message.content.some(block => block.type === "toolCall");
	}

	#isStaleOpenAIResponsesReplayError(message: AssistantMessage): boolean {
		const currentApi = this.model?.api;
		if (
			message.api !== "openai-responses" &&
			message.api !== "openai-codex-responses" &&
			currentApi !== "openai-responses" &&
			currentApi !== "openai-codex-responses"
		) {
			return false;
		}

		const errorMessage = message.errorMessage;
		if (!errorMessage) return false;

		return (
			/\bItem with id ['"][^'"]+['"] not found\.?/i.test(errorMessage) ||
			(/previous[ _]?response/i.test(errorMessage) &&
				/not[ _]?found|invalid|expired|stale|zero[ _-]?data[ _-]?retention/i.test(errorMessage))
		);
	}

	#isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#isProviderErrorFinishReasonBeforeToolUse(message: AssistantMessage): boolean {
		if (!message.errorMessage) return false;
		if (message.content.some(block => block.type === "toolCall")) return false;
		return /\bProvider (?:returned error finish_reason|finish_reason:\s*error)\b/i.test(message.errorMessage);
	}

	#isMalformedFunctionCallError(message: AssistantMessage): boolean {
		if (!message.errorMessage) return false;
		return /\bmalformed.?function.?call\b/i.test(message.errorMessage);
	}

	#isTransientErrorMessage(errorMessage: string): boolean {
		return (
			this.#isTransientEnvelopeErrorMessage(errorMessage) || this.#isTransientTransportErrorMessage(errorMessage)
		);
	}

	#isTransientEnvelopeErrorMessage(errorMessage: string): boolean {
		// Match Anthropic stream-envelope failures that indicate a broken stream before any content starts.
		return /anthropic stream envelope error:/i.test(errorMessage) && /before message_start/i.test(errorMessage);
	}

	#isCompactionSummarizationTimeoutMessage(errorMessage: string): boolean {
		return /\b(?:operation\s+)?timed?\s*out\b|\btimeout\b|\bstream stall\b/i.test(errorMessage);
	}

	#isTransientTransportErrorMessage(errorMessage: string): boolean {
		// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504,
		// service unavailable, provider-suggested retry, network/connection/socket errors, fetch failed,
		// gateway upstream failures, terminated, retry delay exceeded, Bun HTTP/2 stream resets
		// (RST_STREAM / REFUSED_STREAM / ENHANCE_YOUR_CALM, surfaced verbatim from
		// src/http/h2_client/dispatch.zig)
		return (
			isUnexpectedSocketCloseMessage(errorMessage) ||
			/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|retry your request|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|upstream.?request.?failed|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay|stream stall|no error details in response|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)|malformed.?function.?call/i.test(
				errorMessage,
			)
		);
	}

	#getRetryFallbackChains(): RetryFallbackChains {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (!configuredChains || typeof configuredChains !== "object") return {};
		return configuredChains as RetryFallbackChains;
	}

	#validateRetryFallbackChains(): void {
		const configuredChains = this.settings.get("retry.fallbackChains");
		if (configuredChains === undefined) return;
		if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
			const msg = "retry.fallbackChains must be a mapping of role names to selector arrays.";
			logger.warn(msg);
			this.configWarnings.push(msg);
			return;
		}

		for (const [role, chain] of Object.entries(configuredChains)) {
			if (!Array.isArray(chain)) {
				const msg = `Fallback chain for role '${role}' must be an array of selector strings.`;
				logger.warn(msg);
				this.configWarnings.push(msg);
				continue;
			}
			for (const selectorStr of chain) {
				if (typeof selectorStr !== "string") {
					const msg = `Fallback chain for role '${role}' contains a non-string selector.`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const parsed = parseRetryFallbackSelector(selectorStr, this.#modelRegistry);
				if (!parsed) {
					const msg = `Invalid fallback selector format in role '${role}': ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
					continue;
				}
				const exists = this.#modelRegistry.find(parsed.provider, parsed.id);
				if (!exists) {
					const msg = `Fallback chain for role '${role}' references unknown model: ${selectorStr}`;
					logger.warn(msg);
					this.configWarnings.push(msg);
				}
			}
		}
	}

	#getRetryFallbackRevertPolicy(): RetryFallbackRevertPolicy {
		return this.settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
	}

	#getRetryFallbackPrimarySelector(role: string): RetryFallbackSelector | undefined {
		const configuredSelector = this.settings.getModelRole(role);
		return configuredSelector ? parseRetryFallbackSelector(configuredSelector, this.#modelRegistry) : undefined;
	}

	#clearActiveRetryFallback(): void {
		this.#activeRetryFallback = undefined;
	}

	#isRetryFallbackSelectorSuppressed(selector: RetryFallbackSelector): boolean {
		return this.#modelRegistry.isSelectorSuppressed(selector.raw);
	}

	#noteRetryFallbackCooldown(currentSelector: string, retryAfterMs: number | undefined, errorMessage: string): void {
		let cooldownMs = retryAfterMs;
		if (!cooldownMs || cooldownMs <= 0) {
			const reason = parseRateLimitReason(errorMessage);
			cooldownMs = reason === "UNKNOWN" ? 5 * 60 * 1000 : calculateRateLimitBackoffMs(reason);
		}
		this.#modelRegistry.suppressSelector(currentSelector, Date.now() + cooldownMs);
	}

	#resolveRetryFallbackRole(currentSelector: string): string | undefined {
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#modelRegistry);
		if (!parsedCurrent) return undefined;
		const currentBaseSelector = formatRetryFallbackBaseSelector(parsedCurrent);
		const currentPlainSelector = this.model
			? formatModelSelectorValue(formatModelString(this.model), parsedCurrent.thinkingLevel)
			: undefined;
		const currentPlainBaseSelector =
			currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;

		for (const role of this.#retryFallbackCandidateRoles()) {
			const primarySelector = this.#getRetryFallbackPrimarySelector(role);
			if (primarySelector?.raw === currentSelector) return role;
		}
		for (const role of this.#retryFallbackCandidateRoles()) {
			const primarySelector = this.#getRetryFallbackPrimarySelector(role);
			if (!primarySelector) continue;
			if (currentPlainSelector && primarySelector.raw === currentPlainSelector) return role;
			const primaryBaseSelector = formatRetryFallbackBaseSelector(primarySelector);
			if (primaryBaseSelector === currentBaseSelector) return role;
			if (currentPlainBaseSelector && primaryBaseSelector === currentPlainBaseSelector) return role;
		}
		return undefined;
	}

	/**
	 * Roles a failing selector may resolve to for fallback purposes. Roles with
	 * an explicit chain keep priority (original behavior); configured model roles
	 * without one come after — they inherit the `default` chain in
	 * {@link #getRetryFallbackEffectiveChain}, so a configured `task` role with
	 * no task-specific chain still falls back through the default chain.
	 */
	#retryFallbackCandidateRoles(): string[] {
		const roles = Object.keys(this.#getRetryFallbackChains());
		const seen = new Set(roles);
		for (const role of Object.keys(this.settings.getModelRoles())) {
			if (!seen.has(role)) {
				seen.add(role);
				roles.push(role);
			}
		}
		return roles;
	}

	#getRetryFallbackEffectiveChain(role: string): RetryFallbackSelector[] {
		const primarySelector = this.#getRetryFallbackPrimarySelector(role);
		if (!primarySelector) return [];
		const chain = [primarySelector];
		const seen = new Set<string>([primarySelector.raw]);
		const configuredChains = this.#getRetryFallbackChains();
		// A role without its own chain inherits the default chain.
		for (const selector of configuredChains[role] ?? configuredChains.default ?? []) {
			const parsed = parseRetryFallbackSelector(selector, this.#modelRegistry);
			if (!parsed || seen.has(parsed.raw)) continue;
			seen.add(parsed.raw);
			chain.push(parsed);
		}
		return chain;
	}

	#findRetryFallbackCandidates(role: string, currentSelector: string): RetryFallbackSelector[] {
		const chain = this.#getRetryFallbackEffectiveChain(role);
		if (chain.length <= 1) return [];
		const parsedCurrent = parseRetryFallbackSelector(currentSelector, this.#modelRegistry);
		const currentBaseSelector = parsedCurrent ? formatRetryFallbackBaseSelector(parsedCurrent) : undefined;
		const currentPlainSelector =
			this.model && parsedCurrent
				? formatModelSelectorValue(formatModelString(this.model), parsedCurrent.thinkingLevel)
				: undefined;
		const currentPlainBaseSelector =
			parsedCurrent && currentPlainSelector && currentPlainSelector !== currentSelector
				? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(currentPlainSelector) ?? parsedCurrent)
				: undefined;
		const exactIndex = chain.findIndex(
			selector => selector.raw === currentSelector || selector.raw === currentPlainSelector,
		);
		if (exactIndex >= 0) return chain.slice(exactIndex + 1);
		const baseIndex = currentBaseSelector
			? chain.findIndex(selector => {
					const selectorBase = formatRetryFallbackBaseSelector(selector);
					return selectorBase === currentBaseSelector || selectorBase === currentPlainBaseSelector;
				})
			: -1;
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
		return chain.slice(1);
	}

	async #applyRetryFallbackCandidate(
		role: string,
		selector: RetryFallbackSelector,
		currentSelector: string,
		options?: { pinFallback?: boolean },
	): Promise<void> {
		const resolved = resolveModelOverride([selector.raw], this.#modelRegistry, this.settings);
		const candidate = resolved.model ?? this.#modelRegistry.find(selector.provider, selector.id);
		if (!candidate) {
			throw new Error(`Retry fallback model not found: ${selector.raw}`);
		}
		const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
		if (!apiKey) {
			throw new Error(`No API key for retry fallback ${selector.raw}`);
		}

		// Capture the configured selector (auto-aware) so a fallback chain preserves
		// `auto` instead of collapsing it to the level it resolved to this turn.
		const currentThinkingLevel = this.configuredThinkingLevel();
		const nextThinkingLevel = selector.thinkingLevel ?? currentThinkingLevel;
		const candidateSelector = formatModelStringWithRouting(candidate);
		this.#setModelWithProviderSessionReset(candidate);
		this.sessionManager.appendModelChange(candidateSelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.settings.getStorage()?.recordModelUsage(candidateSelector);
		this.setThinkingLevel(nextThinkingLevel);
		if (!this.#activeRetryFallback) {
			this.#activeRetryFallback = {
				role,
				originalSelector: currentSelector,
				originalThinkingLevel: currentThinkingLevel,
				lastAppliedFallbackThinkingLevel: nextThinkingLevel,
				pinned: options?.pinFallback === true,
			};
		} else {
			this.#activeRetryFallback.lastAppliedFallbackThinkingLevel = nextThinkingLevel;
			this.#activeRetryFallback.pinned = this.#activeRetryFallback.pinned || options?.pinFallback === true;
		}
		await this.#emitSessionEvent({
			type: "retry_fallback_applied",
			from: currentSelector,
			to: selector.raw,
			role,
		});
	}

	async #tryRetryModelFallback(currentSelector: string, options?: { pinFallback?: boolean }): Promise<boolean> {
		const role = this.#activeRetryFallback?.role ?? this.#resolveRetryFallbackRole(currentSelector);
		if (!role) return false;

		for (const selector of this.#findRetryFallbackCandidates(role, currentSelector)) {
			if (this.#isRetryFallbackSelectorSuppressed(selector)) continue;
			const resolved = resolveModelOverride([selector.raw], this.#modelRegistry, this.settings);
			const candidate = resolved.model ?? this.#modelRegistry.find(selector.provider, selector.id);
			if (!candidate) continue;
			const apiKey = await this.#modelRegistry.getApiKey(candidate, this.sessionId);
			if (!apiKey) continue;
			await this.#applyRetryFallbackCandidate(role, selector, currentSelector, options);
			return true;
		}

		return false;
	}

	async #maybeRestoreRetryFallbackPrimary(): Promise<void> {
		if (!this.#activeRetryFallback) return;
		if (this.#activeRetryFallback.pinned) return;
		if (this.#getRetryFallbackRevertPolicy() !== "cooldown-expiry") return;

		const {
			originalSelector: originalSelectorRaw,
			originalThinkingLevel,
			lastAppliedFallbackThinkingLevel,
		} = this.#activeRetryFallback;
		const originalSelector = parseRetryFallbackSelector(originalSelectorRaw, this.#modelRegistry);
		if (!originalSelector) {
			this.#clearActiveRetryFallback();
			return;
		}

		const currentModel = this.model;
		if (!currentModel) return;
		const currentSelector = formatRetryFallbackSelector(currentModel, this.thinkingLevel);
		if (currentSelector === originalSelector.raw) {
			if (!this.#isRetryFallbackSelectorSuppressed(originalSelector)) {
				this.#clearActiveRetryFallback();
			}
			return;
		}
		if (this.#isRetryFallbackSelectorSuppressed(originalSelector)) return;

		const resolvedPrimary = resolveModelOverride([originalSelector.raw], this.#modelRegistry, this.settings);
		const primaryModel =
			resolvedPrimary.model ?? this.#modelRegistry.find(originalSelector.provider, originalSelector.id);
		if (!primaryModel) return;
		const apiKey = await this.#modelRegistry.getApiKey(primaryModel, this.sessionId);
		if (!apiKey) return;

		const currentThinkingLevel = this.configuredThinkingLevel();
		const thinkingToApply =
			currentThinkingLevel === lastAppliedFallbackThinkingLevel ? originalThinkingLevel : currentThinkingLevel;
		const primarySelector = formatModelStringWithRouting(primaryModel);
		this.#setModelWithProviderSessionReset(primaryModel);
		this.sessionManager.appendModelChange(primarySelector, EPHEMERAL_MODEL_CHANGE_ROLE);
		this.settings.getStorage()?.recordModelUsage(primarySelector);
		this.setThinkingLevel(thinkingToApply);
		this.#clearActiveRetryFallback();
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		const now = Date.now();
		const retryAfterMsMatch = /retry-after-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (retryAfterMsMatch) {
			return Math.max(0, Number(retryAfterMsMatch[1]));
		}

		const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(errorMessage);
		if (retryAfterMatch) {
			const value = retryAfterMatch[1];
			const seconds = Number(value);
			if (!Number.isNaN(seconds)) {
				return Math.max(0, seconds * 1000);
			}
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) {
				return Math.max(0, dateMs - now);
			}
		}

		const retryHintMs = extractRetryHint(undefined, errorMessage);
		if (retryHintMs !== undefined) {
			return retryHintMs;
		}

		const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMsMatch) {
			const resetMs = Number(resetMsMatch[1]);
			if (!Number.isNaN(resetMs)) {
				if (resetMs > 1_000_000_000_000) {
					return Math.max(0, resetMs - now);
				}
				return Math.max(0, resetMs);
			}
		}

		const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(errorMessage);
		if (resetMatch) {
			const resetSeconds = Number(resetMatch[1]);
			if (!Number.isNaN(resetSeconds)) {
				if (resetSeconds > 1_000_000_000) {
					return Math.max(0, resetSeconds * 1000 - now);
				}
				return Math.max(0, resetSeconds * 1000);
			}
		}

		// Smart Fallback if no exact headers found
		return undefined;
	}

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
	async #handleRetryableError(
		message: AssistantMessage,
		options?: { allowModelFallback?: boolean },
	): Promise<boolean> {
		const retrySettings = this.settings.getGroup("retry");
		if (!retrySettings.enabled) return false;
		const classifierRefusal = this.#isClassifierRefusal(message);

		const generation = this.#promptGeneration;
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		if (this.#retryAttempt > retrySettings.maxRetries) {
			// Max retries exceeded, emit final failure and reset
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this.#retryAttempt = 0;
			this.#resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		const errorMessage = message.errorMessage || "Unknown error";
		const staleOpenAIResponsesReplayError = this.#isStaleOpenAIResponsesReplayError(message);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, this.#retryAttempt);
		let switchedCredential = false;
		let switchedModel = false;
		// Set when a usage-limit error pinned the wait to credential
		// availability — suppresses the generic retry-after bump below.
		let usageLimitWaitMs: number | undefined;

		if (staleOpenAIResponsesReplayError) {
			this.#resetCurrentResponsesProviderSession("stale replay error");
		}

		if (this.model && !staleOpenAIResponsesReplayError && isUsageLimitError(errorMessage)) {
			const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			const outcome = await this.#modelRegistry.authStorage.markUsageLimitReached(
				this.model.provider,
				this.sessionId,
				{
					retryAfterMs,
					baseUrl: this.model.baseUrl,
					modelId: this.model.id,
				},
			);
			if (outcome.switched) {
				switchedCredential = true;
				delayMs = 0;
			} else if (await this.#maybeAutoRedeemCodexReset()) {
				// A live usage-limit 429 on the active Codex account, with a banked
				// reset and the opt-in setting on: spend the reset and retry
				// immediately instead of waiting out the window. Runs after the
				// free sibling-switch above and before model fallback below.
				switchedCredential = true;
				delayMs = 0;
			} else {
				// No sibling credential is usable right now. Wait for whichever
				// comes first: the provider's retry-after window for the current
				// account, or the earliest moment a temporarily blocked sibling
				// frees up (e.g. a 60s post-401 block or a 5-min usage-probe
				// block) — the next attempt's getApiKey re-ranks and picks it up.
				// Without this, one short-lived sibling block escalates a
				// recoverable situation into the provider's multi-hour wait and
				// trips the fail-fast cap below.
				usageLimitWaitMs = retryAfterMs;
				if (outcome.retryAtMs !== undefined) {
					const siblingWaitMs = Math.max(0, outcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;
					if (siblingWaitMs < usageLimitWaitMs) {
						usageLimitWaitMs = siblingWaitMs;
					}
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const allowModelFallback = options?.allowModelFallback !== false;
		const currentSelector = this.model ? formatRetryFallbackSelector(this.model, this.thinkingLevel) : undefined;
		if (!staleOpenAIResponsesReplayError && !switchedCredential && currentSelector) {
			if (allowModelFallback && retrySettings.modelFallback) {
				if (!classifierRefusal) {
					this.#noteRetryFallbackCooldown(currentSelector, parsedRetryAfterMs, errorMessage);
				}
				switchedModel = await this.#tryRetryModelFallback(currentSelector, { pinFallback: classifierRefusal });
			}
			if (switchedModel) {
				delayMs = 0;
			} else if (usageLimitWaitMs === undefined && parsedRetryAfterMs && parsedRetryAfterMs > delayMs) {
				delayMs = parsedRetryAfterMs;
			}
		}
		if (classifierRefusal && !switchedModel) {
			this.#retryAttempt = 0;
			this.#resolveRetry();
			return false;
		}

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		const maxDelayMs = retrySettings.maxDelayMs;
		if (maxDelayMs > 0 && delayMs > maxDelayMs && !switchedCredential && !switchedModel) {
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: `Provider requested ${delayMs}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
			});
			this.#resolveRetry();
			return false;
		}

		await this.#emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: retrySettings.maxRetries,
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.replaceMessages(messages.slice(0, -1));
		}

		// Wait with exponential backoff (abortable).
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			await scheduler.wait(delayMs, { signal: retryAbortController.signal });
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			this.#retryAbortController = undefined;
			await this.#emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this.#resolveRetry();
			return false;
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// Retry via continue() outside the agent_end event callback chain.
		this.#scheduleAgentContinue({ delayMs: 1, generation });

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.#resolveRetry();
	}

	async #promptAgentWithIdleRetry(messages: AgentMessage[], options?: { toolChoice?: ToolChoice }): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			try {
				await this.agent.prompt(messages, options);
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settings.get("retry.enabled") ?? true;
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settings.set("retry.enabled", enabled);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from agent state and re-attempts with a fresh retry budget.
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.isStreaming || this.isCompacting || this.isRetrying) return false;

		const messages = this.agent.state.messages;
		const lastMsg = messages[messages.length - 1];
		if (lastMsg?.role !== "assistant") return false;

		const assistantMsg = lastMsg as AssistantMessage;
		if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") return false;

		// Remove the failed/aborted assistant message (same as auto-retry does before re-attempting)
		this.agent.replaceMessages(messages.slice(0, -1));

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#scheduleAgentContinue({ delayMs: 1 });

		return true;
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	async #saveBashOriginalArtifact(originalText: string): Promise<string | undefined> {
		try {
			return await this.sessionManager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.useUserShell If true, allow caller to request configured user-shell routing
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean },
	): Promise<BashResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();

		if (this.#extensionRunner?.hasHandlers("user_bash")) {
			const hookResult = await this.#extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd,
			});
			if (hookResult?.result) {
				this.recordBashResult(command, hookResult.result, options);
				return hookResult.result;
			}
		}

		const abortController = new AbortController();
		this.#bashAbortControllers.add(abortController);

		try {
			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: this.sessionId,
				timeout: clampTimeout("bash") * 1000,
				onMinimizedSave: originalText => this.#saveBashOriginalArtifact(originalText),
				useUserShell: options?.useUserShell,
			});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this.#bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this.#pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of this.#bashAbortControllers) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this.#bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this.#pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	#flushPendingBashMessages(): void {
		if (this.#pendingBashMessages.length === 0) return;

		for (const bashMessage of this.#pendingBashMessages) {
			// Add to agent state
			this.agent.appendMessage(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this.#pendingBashMessages = [];
	}

	// =========================================================================
	// User-Initiated Python Execution
	// =========================================================================

	/**
	 * Execute Python code in the shared kernel.
	 * Uses the same kernel session as eval's Python backend, allowing collaborative editing.
	 * @param code The Python code to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, execution won't be sent to LLM ($$ prefix)
	 */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.sessionManager.getCwd();
		this.assertEvalExecutionAllowed();

		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			if (this.#extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await this.#extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertEvalExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}

			// Use the same session ID as eval's Python backend for kernel sharing.
			const sessionId =
				this.getEvalSessionId() ??
				defaultEvalSessionId({
					cwd,
					getSessionFile: () => this.sessionManager.getSessionFile() ?? null,
				});
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.#evalKernelOwnerId,
				kernelMode: this.settings.get("python.kernelMode"),
				interpreter: this.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackEvalExecution(execution, abortController);
	}

	assertEvalExecutionAllowed(): void {
		if (this.#evalExecutionDisposing) {
			throw new Error("Python execution is unavailable while session disposal is in progress");
		}
	}

	/**
	 * Track Python work started outside AgentSession.executePython so dispose can await and abort it too.
	 */
	trackEvalExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#evalAbortControllers.add(abortController);
		this.#activeEvalExecutions.add(execution);
		void execution.then(
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
			() => {
				this.#evalAbortControllers.delete(abortController);
				this.#activeEvalExecutions.delete(execution);
			},
		);
		return execution;
	}

	/**
	 * Record a Python execution result in session history.
	 */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const pythonMessage: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this.#pendingPythonMessages.push(pythonMessage);
		} else {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}
	}

	/**
	 * Cancel running Python execution.
	 */
	abortEval(): void {
		for (const abortController of this.#evalAbortControllers) {
			abortController.abort();
		}
	}

	async #waitForEvalExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeEvalExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeEvalExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeEvalExecutions.size > 0) {
				return false;
			}
		}
		return true;
	}

	async #prepareEvalExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForEvalExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abortEval();
			if (!(await this.#waitForEvalExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}

	/** Whether a Python execution is currently running */
	get isEvalRunning(): boolean {
		return this.#evalAbortControllers.size > 0;
	}

	/** Whether there are pending Python messages waiting to be flushed */
	get hasPendingPythonMessages(): boolean {
		return this.#pendingPythonMessages.length > 0;
	}

	/**
	 * Flush pending Python messages to agent state and session.
	 */
	#flushPendingPythonMessages(): void {
		if (this.#pendingPythonMessages.length === 0) return;

		for (const pythonMessage of this.#pendingPythonMessages) {
			this.agent.appendMessage(pythonMessage);
			this.sessionManager.appendMessage(pythonMessage);
		}

		this.#pendingPythonMessages = [];
	}

	// =========================================================================
	// IRC Delivery
	// =========================================================================

	#allowsIrcWake(fromId: string): boolean {
		return authorizeIrcDelivery(this.#collaborationPolicy, {
			fromId: this.#agentId ?? "",
			toId: fromId,
			requiresWake: true,
		}).allow;
	}

	/**
	 * Deliver an IRC message into this session (recipient side; called by the
	 * IrcBus). Emits the `irc_message` session event for UI cards and injects
	 * the rendered message into the model's context as an `irc:incoming`
	 * custom message:
	 *
	 * - mid-turn → queued on the aside channel and folded in at the next step
	 *   boundary (non-interrupting, like async-result deliveries) → "injected";
	 * - idle → starts a real turn with the message so the recipient wakes
	 *   → "woken".
	 *
	 * Never blocks on the recipient's turn: the wake turn is fire-and-forget.
	 *
	 * When the sender expects a reply (`send await:true`) and this session is
	 * mid-turn with async execution disabled, the next step boundary may be
	 * gated on the sender's own batch finishing (blocking task spawns), so a
	 * real reply turn can never happen in time. In that case an ephemeral
	 * side-channel auto-reply is generated from the current context (the old
	 * `respondAsBackground` path) and sent back over the bus on this agent's
	 * behalf.
	 */
	async deliverIrcMessage(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#isDisposed) {
			throw new Error("Recipient session is disposed.");
		}
		const autoReply =
			(opts?.expectsReply ?? false) &&
			this.isStreaming &&
			!this.settings.get("async.enabled") &&
			this.#allowsIrcBusyModelReply(msg);
		if (!this.isStreaming && !this.#allowsIrcWake(msg.from)) {
			throw new Error("IRC wake denied by recipient collaboration policy.");
		}
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#emitSessionEvent({ type: "irc_message", message: record });
		if (this.isStreaming) {
			this.#pendingIrcAsides.push(record);
			if (autoReply) void this.#runIrcAutoReply(msg);
			return "injected";
		}
		// Idle: wake a real turn so the recipient responds (shared with the stranded-aside resume).
		this.#wakeForIrc([record]);
		return "woken";
	}

	/**
	 * Generate and deliver an ephemeral auto-reply to `msg` on this agent's
	 * behalf: a no-tools side-channel turn over the current history (same
	 * pipeline as `/btw`), recorded into this session as an `irc:autoreply`
	 * aside so the model knows what was said for it, and sent back to the
	 * sender as a regular bus message (`replyTo: msg.id`) so their parked
	 * `wait`/`await:true` resolves. Failures only log — the sender then hits
	 * its normal wait timeout.
	 */
	#allowsIrcBusyModelReply(msg: IrcMessage): boolean {
		const policy = this.#collaborationPolicy;
		if (policy && !policy.allowBusyModelReply) return false;
		return authorizeIrcDelivery(policy, {
			fromId: msg.to,
			toId: msg.from,
			busyModelReply: true,
		}).allow;
	}

	async #runIrcAutoReply(msg: IrcMessage): Promise<void> {
		if (!this.#allowsIrcBusyModelReply(msg)) return;
		try {
			const { replyText } = await this.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#isDisposed) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#emitSessionEvent({ type: "irc_message", message: record });
			// Asides drain at the next step boundary; anything left over is
			// flushed at the start of the next prompt (#flushPendingIrcAsides).
			this.#pendingIrcAsides.push(record);
			// `from` must be the id the sender addressed (msg.to) so their
			// from-filtered waiter matches.
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}

	/**
	 * Emit an IRC relay observation event on this session for UI rendering only.
	 * Does not persist the record to history. Called by the IrcBus to surface
	 * agent↔agent traffic on the main session.
	 */
	emitIrcRelayObservation(record: CustomMessage): void {
		void this.#emitSessionEvent({ type: "irc_message", message: record });
	}

	/**
	 * Run a single ephemeral side-channel turn against this session's current
	 * model + system prompt + history.  The native tool catalog rides along so
	 * the static prefix stays byte-identical to the main turn (prompt cache),
	 * but tools never execute here: a hidden developer reminder disarms them
	 * and any stray tool calls are discarded from the reply.  The side request
	 * does not block on, or interfere with, any in-flight main turn.  The
	 * session's history and persisted state are NOT modified by this call.
	 *
	 * Used by `BtwController` (`/btw`) and `OmfgController` (`/omfg`) to share
	 * the snapshot + stream pipeline.  The snapshot includes any in-flight
	 * streaming assistant text so the model sees the half-finished response
	 * rather than missing context.
	 */
	async runEphemeralTurn(args: {
		promptText: string;
		onTextDelta?: (delta: string) => void;
		signal?: AbortSignal;
		dedupeReply?: boolean;
	}): Promise<{ replyText: string; assistantMessage: AssistantMessage }> {
		const model = this.model;
		if (!model) {
			throw new Error("No active model on session");
		}
		const cacheSessionId = this.sessionId;
		const snapshot = this.#buildEphemeralSnapshot(args.promptText);
		const llmMessages = await this.convertMessagesToLlm(snapshot, args.signal);
		const context: Context = {
			systemPrompt: this.systemPrompt,
			messages: llmMessages,
			// Forward the native tool catalog untouched: stripping it (or forcing
			// toolChoice="none") rewrites the static prefix and busts the provider
			// prompt cache shared with the main turn. The snapshot's developer
			// reminder tells the model tools are unavailable, and any tool calls
			// that slip through are discarded from the reply below.
			tools: this.agent.state.tools,
		};
		const options = this.prepareSimpleStreamOptions(
			{
				apiKey: this.#modelRegistry.resolver(model, cacheSessionId),
				// Side-channel turns must not share OpenAI/Codex append-only
				// conversation state with the main agent turn: IRC and /btw can run
				// while the main turn is mid-tool-call. Keep the prompt-cache key
				// stable, but give provider routing a unique request lineage.
				sessionId: `${cacheSessionId}:side:${Snowflake.next()}`,
				promptCacheKey: cacheSessionId,
				preferWebsockets: false,
				reasoning: toReasoningEffort(this.thinkingLevel),
				disableReasoning: shouldDisableReasoning(this.thinkingLevel),
				hideThinkingSummary: this.agent.hideThinkingSummary,
				serviceTier: this.serviceTier,
				signal: args.signal,
			},
			model.provider,
		);

		let providerReplyText = "";
		let emittedReplyText = "";
		let assistantMessage: AssistantMessage | undefined;
		const stream = streamSimple(model, obfuscateProviderContext(this.#obfuscator, context), options);
		for await (const event of stream) {
			if (event.type === "text_delta") {
				providerReplyText += event.delta;
				if (args.onTextDelta) {
					const readyText = this.#deobfuscatedProviderTextReadyForDelta(providerReplyText);
					if (readyText.length > emittedReplyText.length) {
						const delta = readyText.slice(emittedReplyText.length);
						emittedReplyText = readyText;
						args.onTextDelta(delta);
					}
				}
				continue;
			}
			if (event.type === "done") {
				const finalMessage = this.#obfuscator?.hasSecrets()
					? { ...event.message, content: deobfuscateAssistantContent(this.#obfuscator, event.message.content) }
					: event.message;
				assistantMessage = finalMessage.content.some(block => block.type === "toolCall")
					? { ...finalMessage, content: finalMessage.content.filter(block => block.type !== "toolCall") }
					: finalMessage;
				break;
			}
			if (event.type === "error") {
				throw new Error(event.error.errorMessage || "Ephemeral turn failed");
			}
		}

		if (!assistantMessage) {
			throw new Error("Ephemeral turn ended without a final message");
		}
		const replyText = this.#deobfuscateFromProvider(providerReplyText);
		if (args.onTextDelta && replyText.length > emittedReplyText.length) {
			args.onTextDelta(replyText.slice(emittedReplyText.length));
		}
		return {
			replyText: args.dedupeReply === false ? replyText.trim() : dedupeEphemeralReply(replyText.trim()),
			assistantMessage,
		};
	}

	/**
	 * Build a message snapshot for an ephemeral side-channel turn.  Includes
	 * the in-flight streaming assistant message (if any) so the model sees
	 * the partial response in context, then appends a hidden developer
	 * reminder (the tool catalog rides along for cache parity but must not be
	 * used) and the prompt as a virtual user message.
	 */
	#buildEphemeralSnapshot(promptText: string): AgentMessage[] {
		const messages = [...this.messages];
		const streaming = this.agent.state.streamMessage;
		if (streaming && streaming.role === "assistant") {
			const preservedBlocks: AssistantMessage["content"] = [];
			// Preserve thinking blocks: DeepSeek-class encoders replay them as
			// `reasoning_content` and reject the request (HTTP 400) when the field
			// goes missing on a turn that previously emitted thinking.
			for (const c of streaming.content) {
				if (c.type === "thinking") preservedBlocks.push(c);
			}
			const streamingText = streaming.content
				.filter((c): c is TextContent => c.type === "text")
				.map(c => c.text)
				.join("");
			if (streamingText) {
				preservedBlocks.push({ type: "text", text: streamingText });
			}
			if (preservedBlocks.length > 0) {
				const normalized: AssistantMessage = {
					...streaming,
					content: preservedBlocks,
				};
				const lastMessage = messages.at(-1);
				if (lastMessage?.role === "assistant") {
					messages[messages.length - 1] = normalized;
				} else {
					messages.push(normalized);
				}
			}
		}
		if (this.agent.state.tools.length > 0) {
			messages.push({
				role: "developer",
				content: [{ type: "text", text: sideChannelNoToolsPrompt }],
				attribution: "agent",
				timestamp: Date.now(),
			});
		}
		messages.push({
			role: "user",
			content: [{ type: "text", text: promptText }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		return messages;
	}

	/**
	 * Persist any IRC asides that missed their step-boundary injection (the
	 * message landed after the turn's last aside drain). Called at the start
	 * of the next prompt so the model still sees them.
	 */
	#flushPendingIrcAsides(): void {
		if (this.#pendingIrcAsides.length === 0) return;
		const records = this.#pendingIrcAsides;
		this.#pendingIrcAsides = [];
		for (const record of records) {
			// emitExternalEvent on message_end appends to agent state and dispatches
			// to all session listeners, which in turn handle TUI rendering and
			// sessionManager persistence via #handleAgentEvent.
			this.agent.emitExternalEvent({ type: "message_start", message: record });
			this.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Reload the current session from disk.
	 *
	 * Intended for extension commands and headless modes to re-read the current session
	 * file and re-emit session_switch hooks.
	 */
	async reload(): Promise<void> {
		const sessionFile = this.sessionFile;
		if (!sessionFile) return;
		await this.switchSession(sessionFile);
	}

	/**
	 * Switch to a different session file.
	 * Aborts current operation, loads messages, restores model/thinking.
	 * Listeners are preserved and will continue receiving events.
	 * @returns true if switch completed, false if cancelled by hook
	 */
	async switchSession(sessionPath: string): Promise<boolean> {
		const previousSessionFile = this.sessionManager.getSessionFile();
		const switchingToDifferentSession = previousSessionFile
			? path.resolve(previousSessionFile) !== path.resolve(sessionPath)
			: true;
		// Emit session_before_switch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_switch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_switch",
				reason: "resume",
				targetSessionFile: sessionPath,
			})) as SessionBeforeSwitchResult | undefined;

			if (result?.cancel) {
				return false;
			}
		}

		const bgInstance = this.sessionManager.getBackgroundInstance();
		const detachedAsBackground = Boolean(bgInstance && this.isStreaming && previousSessionFile);
		let rollbackDetach: (() => void) | undefined;
		if (bgInstance && detachedAsBackground && previousSessionFile) {
			rollbackDetach = this.#detachAsBackgroundAgent(bgInstance.name, previousSessionFile);
		} else {
			this.#disconnectFromAgent();
			await this.abort({ goalReason: "internal" });
		}

		// Flush pending writes before switching so restore snapshots reflect committed state.
		await this.sessionManager.flush();
		try {
			await this.#resetTurnDiscoveredTools();
		} catch (error) {
			if (rollbackDetach) rollbackDetach();
			else this.#reconnectToAgent();
			throw error;
		}
		await this.#sessionSwitchReconciler?.before?.();
		const previousSessionState = this.sessionManager.captureState();
		const previousSessionContext = this.buildDisplaySessionContext();
		// switchSession replaces these arrays wholesale during load/rollback, so retaining
		// the existing message objects is sufficient and avoids structured-clone failures for
		// extension/custom metadata that is valid to persist but not cloneable.
		const previousAgentMessages = [...this.agent.state.messages];
		const previousSteeringMessages = [...this.agent.peekSteeringQueue()];
		const previousFollowUpMessages = [...this.agent.peekFollowUpQueue()];
		const previousPendingNextTurnMessages = [...this.#pendingNextTurnMessages];
		const previousScheduledHiddenNextTurnGeneration = this.#scheduledHiddenNextTurnGeneration;
		const previousModel = this.model;
		const previousThinkingLevel = this.#thinkingLevel;
		const previousAutoThinking = this.#autoThinking;
		const previousAutoResolvedLevel = this.#autoResolvedLevel;
		const previousServiceTier = this.agent.serviceTier;
		const previousSelectedMCPToolNames = new Set(this.#selectedMCPToolNames);
		const previousTools = [...this.agent.state.tools];
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const previousPromotedMemoryPrompt = this.#promotedMemoryPrompt;
		const previousSystemPrompt = this.agent.state.systemPrompt;
		const previousFreshProviderSessionId = this.#freshProviderSessionId;
		const previousFallbackSelectedMCPToolNames = previousSessionFile
			? this.#getSessionDefaultSelectedMCPToolNames(previousSessionFile)
			: undefined;

		this.agent.clearAllQueues();
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		try {
			await this.sessionManager.setSessionFile(sessionPath);
			if (switchingToDifferentSession) {
				this.#freshProviderSessionId = undefined;
			}
			this.#syncAgentSessionId();
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();
			// Screenpipe is deliberately NOT bound to the target here. Unlike the
			// memory rekeys above — idempotent session-id swaps with no capture side
			// effect — the bridge actively captures, and this switch can still roll
			// back below. Binding now would let the target bridge's poll attribute
			// journal rows/manifests to a session the switch never commits, which
			// cannot be retracted. The previous session's bridge keeps running (any
			// mid-switch capture correctly stays under the still-current session);
			// the target is bound only once the switch commits, just before the
			// success return, and the catch path re-binds to the restored session.

			const sessionContext = this.buildDisplaySessionContext();
			const didReloadConversationChange =
				!switchingToDifferentSession &&
				this.#didSessionMessagesChange(previousSessionContext.messages, sessionContext.messages);
			const fallbackSelectedMCPToolNames = this.#getSessionDefaultSelectedMCPToolNames(sessionPath);
			await this.#restoreMCPSelectionsForSessionContext(sessionContext, { fallbackSelectedMCPToolNames });

			// Emit session_switch event to hooks
			if (this.#extensionRunner) {
				await this.#extensionRunner.emit({
					type: "session_switch",
					reason: "resume",
					previousSessionFile,
				});
			}

			this.agent.replaceMessages(sessionContext.messages);
			this.setActiveTaskContract(undefined);
			this.#activateCompiledTaskContract(undefined);
			this.#resetAdvisorSessionState();
			this.#syncTodoPhasesFromBranch();
			if (switchingToDifferentSession) {
				this.#closeAllProviderSessions("session switch");
			} else if (didReloadConversationChange) {
				this.#closeAllProviderSessions("session reload");
			}

			// Restore model if saved
			const targetModelStrings = getRestorableSessionModels(
				sessionContext.models,
				this.sessionManager.getLastModelChangeRole(),
			);
			if (targetModelStrings.length > 0) {
				const availableModels = this.#modelRegistry.getAvailable();
				let match: Model | undefined;
				for (const targetModelStr of targetModelStrings) {
					const slashIdx = targetModelStr.indexOf("/");
					if (slashIdx <= 0) continue;
					const provider = targetModelStr.slice(0, slashIdx);
					const modelId = targetModelStr.slice(slashIdx + 1);
					match = availableModels.find(m => m.provider === provider && m.id === modelId);
					if (match) break;
				}
				if (match) {
					const currentModel = this.model;
					const shouldResetProviderState =
						switchingToDifferentSession ||
						(currentModel !== undefined &&
							(currentModel.provider !== match.provider ||
								currentModel.id !== match.id ||
								currentModel.api !== match.api));
					if (shouldResetProviderState) {
						this.#setModelWithProviderSessionReset(match);
					} else {
						this.agent.setModel(match);
					}
				}
			}

			const hasThinkingEntry = this.sessionManager.getBranch().some(entry => entry.type === "thinking_level_change");
			const hasServiceTierEntry = this.sessionManager
				.getBranch()
				.some(entry => entry.type === "service_tier_change");
			const defaultThinkingLevel = parseConfiguredThinkingLevel(this.settings.get("defaultThinkingLevel"));
			const configuredServiceTier = this.settings.get("serviceTier");
			// Session log entries carry the resolved concrete level plus the configured
			// selector when it differs (e.g. `auto`). Restore from the selector so an
			// auto session resumes pending — the next user turn reclassifies — while a
			// manual concrete pin stays pinned even when the global default is auto.
			const restoredThinkingLevel: ConfiguredThinkingLevel | undefined =
				hasThinkingEntry || (defaultThinkingLevel === AUTO_THINKING && sessionContext.thinkingLevel !== "off")
					? (parseConfiguredThinkingLevel(sessionContext.configuredThinkingLevel) ??
						(sessionContext.thinkingLevel as ThinkingLevel | undefined))
					: defaultThinkingLevel;
			if (restoredThinkingLevel === AUTO_THINKING) {
				this.#autoThinking = true;
				this.#autoResolvedLevel = undefined;
				this.#thinkingLevel = resolveProvisionalAutoLevel(this.model);
			} else {
				this.#autoThinking = false;
				this.#autoResolvedLevel = undefined;
				this.#thinkingLevel = resolveThinkingLevelForModel(this.model, restoredThinkingLevel);
			}
			this.#applyThinkingLevelToAgent(this.#thinkingLevel);
			this.agent.serviceTier = hasServiceTierEntry
				? sessionContext.serviceTier
				: configuredServiceTier === "none"
					? undefined
					: configuredServiceTier;

			if (switchingToDifferentSession) {
				await this.#resetFusionState();
				this.#resetHindsightConversationTrackingIfHindsight();
				this.#resetMnemopiConversationTrackingIfMnemopi();
				this.#promotedMemoryPrompt = undefined;
			}
			this.#reconnectToAgent();
			try {
				await this.#sessionSwitchReconciler?.after?.();
			} catch (error) {
				logger.warn("Failed to reconcile session mode after switch", {
					targetSessionFile: sessionPath,
					error: String(error),
				});
			}
			// The switch has committed — now (and only now) bind screenpipe capture to
			// the target session, so no journal rows are ever attributed to a switch
			// that rolled back above.
			this.#rekeyScreenpipeForCurrentSessionId();
			return true;
		} catch (error) {
			this.sessionManager.restoreState(previousSessionState);
			this.#freshProviderSessionId = previousFreshProviderSessionId;
			this.#syncAgentSessionId(previousSessionState.sessionId);
			this.#rekeyHindsightMemoryForCurrentSessionId();
			this.#rekeyMnemopiMemoryForCurrentSessionId();
			// Re-bind to the restored session. This is a no-op in the normal rollback
			// case (the target was never bound above), but keeps binding deterministic
			// if any future step binds the target before a later throw.
			this.#rekeyScreenpipeForCurrentSessionId();
			let restoreMcpError: unknown;
			try {
				await this.#restoreMCPSelectionsForSessionContext(previousSessionContext, {
					fallbackSelectedMCPToolNames: previousFallbackSelectedMCPToolNames,
				});
			} catch (mcpError) {
				restoreMcpError = mcpError;
				logger.warn("Failed to restore MCP selections after switch error", {
					previousSessionFile,
					targetSessionFile: sessionPath,
					error: String(mcpError),
				});
				this.#selectedMCPToolNames = new Set(previousSelectedMCPToolNames);
				this.agent.setTools(
					this.#activeToolCeiling
						? previousTools.filter(tool => this.#activeToolCeiling?.has(tool.name.toLowerCase()))
						: previousTools,
				);
				this.#baseSystemPrompt = previousBaseSystemPrompt;
				this.agent.setSystemPrompt(previousSystemPrompt);
			}
			this.#baseSystemPrompt = previousBaseSystemPrompt;
			this.#promotedMemoryPrompt = previousPromotedMemoryPrompt;
			this.agent.setSystemPrompt(previousSystemPrompt);
			this.agent.replaceMessages(previousAgentMessages);
			this.agent.replaceQueues(previousSteeringMessages, previousFollowUpMessages);
			this.#pendingNextTurnMessages = previousPendingNextTurnMessages;
			this.#scheduledHiddenNextTurnGeneration = previousScheduledHiddenNextTurnGeneration;
			if (previousModel) {
				this.agent.setModel(previousModel);
			}
			this.#thinkingLevel = previousThinkingLevel;
			this.#autoThinking = previousAutoThinking;
			this.#autoResolvedLevel = previousAutoResolvedLevel;
			this.#applyThinkingLevelToAgent(previousThinkingLevel);
			this.agent.serviceTier = previousServiceTier;
			this.#syncTodoPhasesFromBranch();
			this.#advisorRuntime?.reset();
			this.#reconnectToAgent();
			if (restoreMcpError) {
				throw restoreMcpError;
			}
			throw error;
		}
	}

	/**
	 * Create a branch from a specific entry.
	 * Emits before_branch/branch session events to hooks.
	 *
	 * @param entryId ID of the entry to branch from
	 * @returns Object with:
	 *   - selectedText: The text of the selected user message (for editor pre-fill)
	 *   - cancelled: True if a hook cancelled the branch
	 */
	async branch(entryId: string): Promise<{
		selectedText: string;
		cancelled: boolean;
	}> {
		const previousSessionFile = this.sessionFile;
		const selectedEntry = this.sessionManager.getEntry(entryId);

		if (selectedEntry?.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for branching");
		}

		const selectedText = this.#extractUserMessageText(selectedEntry.message.content);

		let skipConversationRestore = false;

		// Emit session_before_branch event (can be cancelled)
		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { selectedText, cancelled: true };
			}
			skipConversationRestore = result?.skipConversationRestore ?? false;
		}
		await this.#resetTurnDiscoveredTools();

		// Clear pending messages (bound to old session state)
		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;

		// Flush pending writes before branching
		await this.sessionManager.flush();
		this.#cancelOwnAsyncJobs();

		if (!selectedEntry.parentId) {
			await this.sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			this.sessionManager.createBranchedSession(selectedEntry.parentId);
		}
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#rekeyScreenpipeForCurrentSessionId();
		this.#resetHindsightConversationTrackingIfHindsight();
		this.#resetMnemopiConversationTrackingIfMnemopi();
		this.#promotedMemoryPrompt = undefined;

		// Reload messages from entries (works for both file and in-memory mode)
		const sessionContext = this.buildDisplaySessionContext();

		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		// Emit session_branch event to hooks (after branch completes)
		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		this.setActiveTaskContract(undefined);
		this.#activateCompiledTaskContract(undefined);
		if (!skipConversationRestore) {
			this.agent.replaceMessages(sessionContext.messages);
			this.#resetAdvisorSessionState();
			this.#closeCodexProviderSessionsForHistoryRewrite();
		}

		return { selectedText, cancelled: false };
	}

	/**
	 * Strip provider-replay side channels from a promoted /btw assistant message.
	 * `providerPayload`, redacted thinking, and thinking signatures belong to the
	 * ephemeral side request's provider session; replaying them from the branched
	 * history would hand another provider turn an opaque state it never issued.
	 */
	#sanitizeBtwAssistantMessage(assistantMessage: AssistantMessage): AssistantMessage {
		const content: AssistantMessage["content"] = [];
		for (const part of assistantMessage.content) {
			if (part.type === "thinking") {
				content.push({ type: "thinking", thinking: part.thinking });
				continue;
			}
			if (part.type === "redactedThinking") continue;
			content.push(part);
		}
		return { ...assistantMessage, content, providerPayload: undefined };
	}

	async branchFromBtw(
		question: string,
		assistantMessage: AssistantMessage,
	): Promise<{ cancelled: boolean; sessionFile: string | undefined }> {
		const previousSessionFile = this.sessionFile;
		if (!this.sessionManager.getSessionFile()) {
			throw new Error("Cannot branch /btw: session is not persisted");
		}

		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Cannot branch /btw: current session has no leaf");
		}

		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}

		if (this.#extensionRunner?.hasHandlers("session_before_branch")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_branch",
				entryId: leafId,
			})) as SessionBeforeBranchResult | undefined;

			if (result?.cancel) {
				return { cancelled: true, sessionFile: previousSessionFile };
			}
		}

		await this.#cancelPostPromptTasks();
		if (
			this.isBashRunning ||
			this.isEvalRunning ||
			this.isCompacting ||
			this.isGeneratingHandoff ||
			this.isRetrying
		) {
			throw new Error("Cannot branch /btw while session maintenance or user work is still running");
		}
		await this.#resetTurnDiscoveredTools();

		this.#pendingNextTurnMessages = [];
		this.#scheduledHiddenNextTurnGeneration = undefined;
		this.agent.replaceQueues([], []);
		if (this.isStreaming) {
			await this.abort({ goalReason: "internal", reason: "branching /btw" });
			this.agent.replaceQueues([], []);
		}
		await this.sessionManager.flush();
		this.#cancelOwnAsyncJobs();

		this.sessionManager.createBranchedSession(leafId);
		this.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		});
		this.sessionManager.appendMessage(this.#sanitizeBtwAssistantMessage(assistantMessage));
		this.#syncTodoPhasesFromBranch();
		this.#freshProviderSessionId = undefined;
		this.#syncAgentSessionId();
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
		this.#rekeyScreenpipeForCurrentSessionId();
		this.#resetHindsightConversationTrackingIfHindsight();
		this.#resetMnemopiConversationTrackingIfMnemopi();
		this.#promotedMemoryPrompt = undefined;

		const sessionContext = this.buildDisplaySessionContext();
		await this.#restoreMCPSelectionsForSessionContext(sessionContext);

		if (this.#extensionRunner) {
			await this.#extensionRunner.emit({
				type: "session_branch",
				previousSessionFile,
			});
		}

		this.agent.replaceMessages(sessionContext.messages);
		this.setActiveTaskContract(undefined);
		this.#activateCompiledTaskContract(undefined);
		this.#resetAdvisorSessionState();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		return { cancelled: false, sessionFile: this.sessionFile };
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike branch() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string } = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
		/** Raw session context built during navigation — pass to renderInitialMessages to skip a second O(N) walk. */
		sessionContext?: SessionContext;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
		};

		// Set up abort controller for summarization
		this.#branchSummaryAbortController = new AbortController();
		let hookSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (this.#extensionRunner?.hasHandlers("session_before_tree")) {
			const result = (await this.#extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: this.#branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				hookSummary = result.summary;
				fromExtension = true;
			}
		}
		await this.#resetTurnDiscoveredTools();

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !hookSummary) {
			const model = this.model!;
			const apiKey = await this.#modelRegistry.getApiKey(model, this.sessionId);
			if (!apiKey) {
				throw new Error(`No API key for ${model.provider}`);
			}
			const branchSummarySettings = this.settings.getGroup("branchSummary");
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey: this.#modelRegistry.resolver(model, this.sessionId),
				signal: this.#branchSummaryAbortController.signal,
				customInstructions: this.#obfuscateTextForProvider(options.customInstructions),
				reserveTokens: branchSummarySettings.reserveTokens,
				metadata: this.agent.metadataForProvider(model.provider),
				convertToLlm: messages => this.#convertToLlmForSideRequest(messages),
				telemetry: resolveTelemetry(this.agent.telemetry, this.sessionId),
			});
			this.#branchSummaryAbortController = undefined;
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (hookSummary) {
			summaryText = hookSummary.summary;
			summaryDetails = hookSummary.details;
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = this.#extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			this.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			this.sessionManager.branch(newLeafId);
		}

		// Update agent state — build display context to populate agent messages.
		const stateContext = this.sessionManager.buildSessionContext();
		const displayContext = deobfuscateSessionContext(stateContext, this.#obfuscator);
		await this.#restoreMCPSelectionsForSessionContext(displayContext);
		this.agent.replaceMessages(displayContext.messages);
		this.setActiveTaskContract(undefined);
		this.#activateCompiledTaskContract(undefined);
		this.#resetAdvisorSessionState();
		this.#syncTodoPhasesFromBranch();
		this.#closeCodexProviderSessionsForHistoryRewrite();

		this.#branchSummaryAbortController = undefined;

		// Emit session_tree event; only handlers can mutate session entries, so skip
		// the emit and the context rebuild when no handlers are registered (mirrors
		// the session_before_tree guard above).
		if (this.#extensionRunner?.hasHandlers("session_tree")) {
			await this.#extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});
			const rawContext = this.sessionManager.buildSessionContext();
			return { editorText, cancelled: false, summaryEntry, sessionContext: rawContext };
		}
		return { editorText, cancelled: false, summaryEntry, sessionContext: stateContext };
	}

	/**
	 * Get all user messages from session for branch selector.
	 */
	getUserMessagesForBranching(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this.#extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	#extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter(m => m.role === "user").length;
		const assistantMessages = state.messages.filter(m => m.role === "assistant").length;
		const toolResults = state.messages.filter(m => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		let totalPremiumRequests = 0;
		const getTaskToolUsage = (details: unknown): Usage | undefined => {
			if (!details || typeof details !== "object") return undefined;
			const record = details as Record<string, unknown>;
			const usage = record.usage;
			if (!usage || typeof usage !== "object") return undefined;
			return usage as Usage;
		};

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
				totalCost += assistantMsg.usage.cost.total;
			}

			if (message.role === "toolResult" && message.toolName === "task") {
				const usage = getTaskToolUsage(message.details);
				if (usage) {
					totalInput += usage.input;
					totalOutput += usage.output;
					totalCacheRead += usage.cacheRead;
					totalCacheWrite += usage.cacheWrite;
					totalPremiumRequests += usage.premiumRequests ?? 0;
					totalCost += usage.cost.total;
				}
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			premiumRequests: totalPremiumRequests,
		};
	}

	/**
	 * Get current context usage statistics.
	 * Uses the last assistant message's usage data when available,
	 * otherwise estimates tokens for all messages.
	 */
	getContextBreakdown(options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	}): ContextUsageBreakdown | undefined {
		const model = this.model;
		const contextWindow = options?.contextWindow ?? model?.contextWindow ?? 0;
		if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;

		const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = computeNonMessageBreakdown(this);
		const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
		const currentNonMessageTokens = computeNonMessageTokens(this);

		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;

		let usedTokens = 0;
		let anchored = false;

		const pendingMessages = options?.pendingMessages ?? [];

		const pending = this.#pendingContextSnapshot;

		// Always locate the latest real assistant-usage anchor after the last
		// compaction. Its provider-reported promptTokens is ground truth for
		// everything up to that point; only the tail after it is estimated.
		let anchorEntry: SessionMessageEntry | undefined;
		for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
			const entry = branchEntries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const assistant = entry.message;
				if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
					anchorEntry = entry;
					break;
				}
			}
		}

		const resolvedActiveMessages = this.messages;
		let resolvedAnchorIndex = -1;
		let anchorAssistant: AssistantMessage | undefined;
		if (anchorEntry) {
			const a = anchorEntry.message as AssistantMessage;
			anchorAssistant = a;
			resolvedAnchorIndex = resolvedActiveMessages.indexOf(a);
			if (resolvedAnchorIndex === -1) {
				resolvedAnchorIndex = resolvedActiveMessages.findIndex(
					msg => msg.role === "assistant" && msg.timestamp === a.timestamp,
				);
			}
		}

		// A real anchor supersedes the in-flight estimate only once a step of the
		// CURRENT turn has produced provider usage — i.e. it resolves at or after
		// the pending cutoff. While the turn's first response is still pending (or
		// the newest real anchor predates this turn) the pending snapshot is the
		// only thing accounting for the just-submitted prompt, so it wins. This
		// keeps a long tool turn from stacking an estimate of the entire tail on
		// top of a stale turn-start prompt.
		const useAnchor =
			anchorAssistant !== undefined &&
			resolvedAnchorIndex !== -1 &&
			(!pending || resolvedAnchorIndex >= pending.cutoffCount);

		if (useAnchor && anchorAssistant) {
			const promptTokens =
				anchorAssistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(anchorAssistant.usage);
			const nonMessageTokens = anchorAssistant.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this);
			anchored = true;
			let tailTokens = 0;
			for (let i = resolvedAnchorIndex + 1; i < resolvedActiveMessages.length; i++) {
				tailTokens += estimateTokens(resolvedActiveMessages[i]);
			}
			usedTokens =
				promptTokens +
				Math.max(0, currentNonMessageTokens - nonMessageTokens) +
				tailTokens +
				pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		} else if (pending) {
			anchored = true;
			let tailTokens = 0;
			if (resolvedActiveMessages.length > pending.cutoffCount) {
				for (let i = pending.cutoffCount; i < resolvedActiveMessages.length; i++) {
					tailTokens += estimateTokens(resolvedActiveMessages[i]);
				}
			}
			usedTokens =
				pending.promptTokens +
				Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) +
				tailTokens +
				pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		}

		if (!anchored && !pending && branchEntries.length === 0) {
			// Fallback: look for the latest assistant message with usage/snapshot in this.messages (for branchless/fake sessions in tests)
			for (let i = resolvedActiveMessages.length - 1; i >= 0; i--) {
				const msg = resolvedActiveMessages[i];
				if (msg.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage) {
					const promptTokens = msg.contextSnapshot?.promptTokens ?? calculatePromptTokens(msg.usage);
					const nonMessageTokens = msg.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(this);

					let tailTokens = 0;
					for (let j = i + 1; j < resolvedActiveMessages.length; j++) {
						tailTokens += estimateTokens(resolvedActiveMessages[j]);
					}

					usedTokens =
						promptTokens +
						Math.max(0, currentNonMessageTokens - nonMessageTokens) +
						tailTokens +
						pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
					anchored = true;
					break;
				}
			}
		}
		if (!anchored) {
			let messagesTokens = 0;
			for (const msg of resolvedActiveMessages) {
				messagesTokens += estimateTokens(msg);
			}
			usedTokens =
				currentNonMessageTokens +
				messagesTokens +
				pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
		}

		const messagesTokens = Math.max(0, usedTokens - categoryNonMessageTokens);

		return {
			contextWindow,
			anchored,
			usedTokens,
			systemPromptTokens,
			systemToolsTokens: toolsTokens,
			systemContextTokens,
			skillsTokens,
			messagesTokens,
		};
	}

	/**
	 * Aggregate prompt-cache statistics for this session: lifetime hit rate and
	 * cache-break counts attributed by cause (system-prompt change, tool-list
	 * change, history rewrite, model change, provider-side).
	 */
	getCacheStats(): CacheStats {
		return this.#cacheAttribution.stats();
	}

	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined {
		const breakdown = this.getContextBreakdown(options);
		if (!breakdown) return undefined;
		return {
			tokens: breakdown.usedTokens,
			contextWindow: breakdown.contextWindow,
			percent: breakdown.contextWindow > 0 ? (breakdown.usedTokens / breakdown.contextWindow) * 100 : 0,
		};
	}

	/**
	 * Monotonic counter that changes whenever the in-flight pending context
	 * snapshot is set or cleared. Status-line context memoization keys on this so
	 * a value computed mid-turn cannot persist after the turn ends/aborts.
	 */
	get contextUsageRevision(): number {
		return this.#contextUsageRevision;
	}

	#setPendingContextSnapshot(
		snapshot: { promptTokens: number; nonMessageTokens: number; cutoffCount: number } | undefined,
	): void {
		this.#pendingContextSnapshot = snapshot;
		this.#contextUsageRevision++;
	}

	#ingestProviderUsageHeaders(response: ProviderResponseMetadata, model?: Model): void {
		if (model?.provider !== "anthropic") return;
		this.#modelRegistry.authStorage.ingestUsageHeaders("anthropic", response.headers, {
			sessionId: this.agent.sessionId,
			baseUrl: this.#modelRegistry.getProviderBaseUrl?.("anthropic"),
		});
	}

	async fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null> {
		const authStorage = this.#modelRegistry.authStorage;
		if (!authStorage.fetchUsageReports) return null;
		return authStorage.fetchUsageReports({
			baseUrlResolver: provider => {
				if (provider === "google-antigravity") {
					const mode = this.settings.get("providers.antigravityEndpoint");
					if (mode === "sandbox") {
						return "https://daily-cloudcode-pa.sandbox.googleapis.com";
					} else if (mode === "production") {
						return "https://daily-cloudcode-pa.googleapis.com";
					}
				}
				return this.#modelRegistry.getProviderBaseUrl?.(provider);
			},
			signal,
		});
	}

	/**
	 * Redeem one saved Codex rate-limit reset for a specific account, injecting
	 * the provider base URL like {@link AgentSession.fetchUsageReports}. Powers
	 * the `/usage reset` command and auto-redeem. Never throws for business
	 * outcomes — inspect the returned `code`.
	 */
	async redeemResetCredit(target: ResetCreditTarget, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return this.#modelRegistry.authStorage.redeemResetCredit({
			target,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}

	/**
	 * List saved Codex rate-limit resets per stored account, fetched live from
	 * the dedicated credits endpoint (bypasses the usage cache). Powers the
	 * `/usage reset` account selector.
	 */
	async listResetCredits(signal?: AbortSignal): Promise<ResetCreditAccountStatus[]> {
		return this.#modelRegistry.authStorage.listResetCredits({
			sessionId: this.sessionId,
			baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
			signal,
		});
	}
	async #confirmCodexAutoRedeem(decision: CodexAutoRedeemRedeemDecision): Promise<boolean> {
		const runner = this.#extensionRunner;
		if (!runner?.hasUI()) {
			this.emitNotice(
				"warning",
				"Codex saved reset is eligible, but auto-redeem is unset and no prompt UI is available. Run `/usage reset` or set codexResets.autoRedeem.",
				"codex-auto-reset",
			);
			return false;
		}

		const who = decision.target.email ?? decision.target.accountId ?? "the active account";
		const resetLabel = decision.availableCount === 1 ? "reset" : "resets";
		try {
			const choice = await runner
				.getUIContext()
				.select(
					`Do you wanna redeem your reset?\n${who} is blocked by the weekly Codex limit for about ${formatDuration(decision.remainingMs)}. Spend 1 of ${decision.availableCount} saved ${resetLabel}?`,
					[
						{
							label: "Yes",
							description: "Redeem now and remember yes for future eligible Codex weekly blocks.",
						},
						{
							label: "No",
							description: "Do not auto-redeem saved Codex resets.",
						},
					],
				);
			if (choice === "Yes") {
				this.settings.set("codexResets.autoRedeem", "yes");
				return true;
			}
			if (choice === "No") {
				this.settings.set("codexResets.autoRedeem", "no");
			}
		} catch (error) {
			logger.warn("codex-auto-reset prompt failed", { error: String(error) });
		}
		return false;
	}

	/**
	 * Auto-redeem hook for {@link AgentSession.#handleRetryableError}'s
	 * usage-limit branch. Returns `true` only when a saved Codex reset was
	 * actually spent (so the caller retries immediately). The "unset" mode is
	 * reactive but asks before spending; "yes" skips that prompt, and "no" avoids
	 * the eligibility IO entirely. The decision remains heavily gated — see
	 * `./codex-auto-reset` and the design in `local://autoreset-spec.md`.
	 * Per-account in-flight dedup lets concurrent sessions adopt one redeem
	 * instead of double-spending.
	 */
	async #maybeAutoRedeemCodexReset(coordinator = defaultCodexAutoRedeemCoordinator): Promise<boolean> {
		const cfg = this.settings.getGroup("codexResets");
		const model = this.model;
		// Cheap exits before any IO.
		if (!shouldEvaluateCodexAutoRedeem(cfg.autoRedeem) || !model || model.provider !== "openai-codex") return false;
		const authStorage = this.#modelRegistry.authStorage;
		// Capture identity BEFORE awaits: markUsageLimitReached leaves the
		// usage-limit session credential sticky, so this names the blocked account.
		const identity = authStorage.getOAuthAccountIdentity("openai-codex", this.sessionId);
		const accountKey = (identity?.accountId ?? identity?.email)?.trim().toLowerCase();
		if (!accountKey) return false;
		const existing = coordinator.inFlightByAccount.get(accountKey);
		if (existing) return existing;

		const run = (async (): Promise<boolean> => {
			const reports = await this.fetchUsageReports();
			const decision = evaluateCodexAutoRedeem({
				nowMs: Date.now(),
				provider: model.provider,
				modelId: model.id,
				settings: {
					autoRedeem: true,
					minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
					keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
				},
				identity,
				reports,
				attemptedBlockKeys: coordinator.attemptedBlockKeys,
				lastAttemptAtByAccount: coordinator.lastAttemptAtByAccount,
			});
			if (!decision.redeem) {
				logger.debug("codex-auto-reset: skipped", { reason: decision.reason });
				return false;
			}
			if (shouldPromptCodexAutoRedeem(cfg.autoRedeem) && !(await this.#confirmCodexAutoRedeem(decision))) {
				return false;
			}
			// Commit the attempt BEFORE acting so this block can never re-enter.
			coordinator.attemptedBlockKeys.add(decision.blockKey);
			coordinator.lastAttemptAtByAccount.set(decision.accountKey, Date.now());
			const who = decision.target.email ?? decision.target.accountId ?? "the active account";
			const outcome = await authStorage.redeemResetCredit({
				target: decision.target,
				baseUrlResolver: provider => this.#modelRegistry.getProviderBaseUrl?.(provider),
				// Not tied to the retry abort controller: aborting a consume
				// mid-flight leaves credit state unknown.
				signal: AbortSignal.timeout(15_000),
			});
			switch (outcome.code) {
				case "reset": {
					const left = Math.max(0, decision.availableCount - 1);
					this.emitNotice(
						"info",
						`Auto-redeemed a saved Codex rate-limit reset for ${who} (${left} left); retrying now.`,
						"codex-auto-reset",
					);
					void this.fetchUsageReports();
					return true;
				}
				case "already_redeemed":
					this.emitNotice(
						"warning",
						"A saved Codex reset was already redeemed elsewhere; waiting for the window.",
						"codex-auto-reset",
					);
					return false;
				case "no_credit":
					logger.debug("codex-auto-reset: no_credit (snapshot/live mismatch)", { account: accountKey });
					return false;
				case "nothing_to_reset":
					this.emitNotice(
						"warning",
						"Codex reset reported nothing to reset; auto-redeem suppressed for this window.",
						"codex-auto-reset",
					);
					return false;
				default:
					this.emitNotice("warning", `Codex auto-redeem failed (${outcome.code}).`, "codex-auto-reset");
					return false;
			}
		})().finally(() => coordinator.inFlightByAccount.delete(accountKey));
		coordinator.inFlightByAccount.set(accountKey, run);
		return run;
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = getCurrentThemeName();
		const { exportSessionToHtml } = await import("../export/html");
		return exportSessionToHtml(this.sessionManager, this.state, { outputPath, themeName });
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.#getLastCopyCandidateAssistantMessage();
		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	hasCopyCandidateAssistantMessage(): boolean {
		return this.#getLastCopyCandidateAssistantMessage() !== undefined;
	}

	#getLastCopyCandidateAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "assistant") continue;

			const assistantMessage = message as AssistantMessage;
			// Skip aborted messages with no content
			if (assistantMessage.stopReason === "aborted" && assistantMessage.content.length === 0) continue;

			return assistantMessage;
		}

		return undefined;
	}
	/**
	 * Get text content of the most recent visible handoff message.
	 * Fresh handoff sessions store the handoff context as a custom message, not
	 * an assistant message, so callers that copy the "last" message can use this
	 * as a fallback before the new session has an assistant response.
	 */
	getLastVisibleHandoffText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i];
			if (message.role !== "custom") continue;

			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;

			if (typeof customMessage.content === "string") {
				return customMessage.content.trim() || undefined;
			}

			let text = "";
			for (const content of customMessage.content) {
				if (content.type === "text") {
					text += content.text;
				}
			}
			return text.trim() || undefined;
		}

		return undefined;
	}

	/**
	 * Format the entire session as plain text for clipboard export: system
	 * prompt, model/thinking config, tool inventory, and the full transcript
	 * rendered with markdown role headings (`## User`, `## Assistant`,
	 * `### Tool Call`/`### Tool Result`).
	 */
	formatSessionAsText(): string {
		return formatSessionDumpText({
			messages: this.messages,
			systemPrompt: this.agent.state.systemPrompt,
			model: this.agent.state.model,
			thinkingLevel: this.#thinkingLevel,
			tools: this.agent.state.tools,
			inlineToolDescriptors: this.#pruneToolDescriptions,
		});
	}

	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set AND a model resolved for the `advisor` role AND
	 * the advisor applies to this agent kind — i.e. the actual runtime exists,
	 * not merely the setting. Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisorAgent !== undefined;
	}

	/** Exposes the live advisor for provider-parity and runtime contract tests. */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisorAgent;
	}

	/**
	 * Set the active completion-gate snapshot. Assignment-child and compiled-root
	 * contracts both adapt through this seam; compiled contracts remain ephemeral.
	 */
	setActiveTaskContract(snapshot: ActiveTaskContractSnapshot | undefined): void {
		this.#activeTaskContract = snapshot;
		this.#taskContractActivatedAt = snapshot ? Date.now() : undefined;
		this.#completionGateReminderCount = 0;
		this.#completionGateAwaitingProgress = false;
		this.#syncAdvisorSystemPrompt();
	}

	getActiveTaskContract(): ActiveTaskContractSnapshot | undefined {
		return this.#activeTaskContract;
	}

	getOrchestrationTelemetry(): OrchestrationTelemetrySink {
		return this.#orchestrationTelemetry;
	}

	getApproachRegistry(): ApproachRegistry {
		return this.#approachRegistry;
	}

	evaluateRootCompletionGate(input: CompletionGateInput): CompletionGateEvaluation {
		const evaluation = evaluateCompletionGate(input);
		this.#orchestrationTelemetry.emit({
			kind: "completion_gate",
			timestamp: Date.now(),
			sessionId: this.sessionId ?? undefined,
			completionGateOutcome: evaluation.outcome,
		});
		return evaluation;
	}

	#syncAdvisorSystemPrompt(): void {
		if (!this.#advisorAgent) return;
		const systemPrompt = composeAdvisorSystemPrompt({
			basePrompt: advisorSystemPrompt,
			watchdogPrompt: this.#advisorWatchdogPrompt,
			activeTaskContract: this.#activeTaskContract,
			compiledTaskContractBlock: this.#activeCompiledTaskContract?.advisorBlock.text,
		});
		this.#advisorAgent.setSystemPrompt(systemPrompt);
	}

	isMoaActive(): boolean {
		return this.#moaLaneLabels.length > 0;
	}

	getMoaLaneLabels(): readonly string[] {
		return this.#moaLaneLabels;
	}

	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const advisor = this.#advisorAgent;
		if (!advisor) {
			return {
				configured,
				active: false,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
				messages: { user: 0, assistant: 0, total: 0 },
			};
		}
		const model = advisor.state.model;
		const messages = advisor.state.messages;
		const contextTokens = this.#estimateAdvisorContextTokens(messages);
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let cost = 0;
		let user = 0;
		let assistant = 0;
		for (const message of messages) {
			if (message.role === "user") user++;
			if (message.role === "assistant") {
				assistant++;
				const assistantMsg = message as AssistantMessage;
				input += assistantMsg.usage.input;
				output += assistantMsg.usage.output;
				cacheRead += assistantMsg.usage.cacheRead;
				cacheWrite += assistantMsg.usage.cacheWrite;
				cost += assistantMsg.usage.cost.total;
			}
		}
		return {
			configured,
			active: true,
			model,
			contextWindow: model.contextWindow ?? 0,
			contextTokens,
			tokens: {
				input,
				output,
				cacheRead,
				cacheWrite,
				total: input + output + cacheRead + cacheWrite,
			},
			cost,
			messages: { user, assistant, total: messages.length },
		};
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		const stats = this.getAdvisorStats();
		if (!stats.active) {
			return stats.configured
				? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
				: "Advisor is disabled.";
		}
		const model = stats.model!;
		const contextLine =
			stats.contextWindow > 0
				? `Context: ${stats.contextTokens.toLocaleString()} / ${stats.contextWindow.toLocaleString()} tokens (${Math.round((stats.contextTokens / stats.contextWindow) * 100)}%)`
				: `Context: ${stats.contextTokens.toLocaleString()} tokens`;
		const spendParts = [
			`${stats.tokens.input.toLocaleString()} input`,
			`${stats.tokens.output.toLocaleString()} output`,
		];
		if (stats.tokens.cacheRead > 0) spendParts.push(`${stats.tokens.cacheRead.toLocaleString()} cache read`);
		if (stats.tokens.cacheWrite > 0) spendParts.push(`${stats.tokens.cacheWrite.toLocaleString()} cache write`);
		const spendLine = `Spend: ${spendParts.join(", ")}, $${stats.cost.toFixed(4)}`;
		return `Advisor is enabled (${model.provider}/${model.id}). ${contextLine}. ${spendLine}.`;
	}

	/**
	 * Estimate the advisor's current context tokens. When the advisor has a
	 * recent non-aborted assistant message with usage, use that prompt's token
	 * count and add a trailing estimate for messages after it. Otherwise estimate
	 * every message.
	 */
	#estimateAdvisorContextTokens(messages: AgentMessage[]): number {
		let lastUsageIndex: number | null = null;
		let lastUsage: AssistantMessage["usage"] | undefined;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
					lastUsage = assistantMsg.usage;
					lastUsageIndex = i;
					break;
				}
			}
		}
		if (!lastUsage || lastUsageIndex === null) {
			let estimated = 0;
			for (const message of messages) {
				estimated += estimateTokens(message);
			}
			return estimated;
		}
		let trailingTokens = 0;
		for (let i = lastUsageIndex + 1; i < messages.length; i++) {
			trailingTokens += estimateTokens(messages[i]);
		}
		return calculatePromptTokens(lastUsage) + trailingTokens;
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		const advisor = this.#advisorAgent;
		if (!advisor) return null;
		if (options?.compact) {
			return formatSessionHistoryMarkdown(advisor.state.messages);
		}
		return formatSessionDumpText({
			messages: advisor.state.messages,
			systemPrompt: advisor.state.systemPrompt,
			model: advisor.state.model,
			thinkingLevel: advisor.state.thinkingLevel,
			tools: advisor.state.tools,
		});
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.#extensionRunner?.hasHandlers(eventType) ?? false;
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner | undefined {
		return this.#extensionRunner;
	}
}
