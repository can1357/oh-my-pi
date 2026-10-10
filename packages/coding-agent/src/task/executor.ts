/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent, AgentIdentity, AgentMessage, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { AgentBusyError, EventLoopKeepalive, recordHandoff, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ServiceTierByFamily, Usage } from "@oh-my-pi/pi-ai";
import { isRecord, logger, popLoopPhase, prompt, pushLoopPhase, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobError, AsyncJobManager, type AsyncJobRunResult } from "../async";
import type { Rule } from "../capability/rule";
import type { EffectiveExtensionRoots } from "../capability/types";
import { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	previewLine,
	replaceTabs,
	shortenToolArgumentPaths,
	TRUNCATE_LENGTHS,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { type EditMode, getEditInputPaths } from "@oh-my-pi/pi-tui/tools/edit";
import {
	formatModelStringWithRouting,
	resolveAgentAdvisorRolePattern,
	resolveAgentAdvisorSelection,
	resolveAgentPrewalkPattern,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import {
	buildServiceTierByFamily,
	isServiceTierForFamily,
	resolveAgentServiceTierOverride,
	resolveSubagentServiceTier,
	type ServiceTierInheritSettingValue,
} from "../config/service-tier";
import type { CompactionThresholdPair } from "../config/compaction-threshold";
import { type OAuthAccountPools, validateAgentAccountPools } from "../config/account-pools";
import { type OverlayLayers, Settings } from "../config/settings";

import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { PreparedExtension } from "../extensibility/extensions/types";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import { IrcBus } from "../irc/bus";
import type { MCPManager } from "../mcp/manager";
import type { MnemopiSessionState } from "../mnemopi/state";
import { initializeExtensions } from "../modes/runtime-init";
import subagentAsyncPendingTemplate from "../prompts/system/subagent-async-pending.md" with { type: "text" };
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import seanceAssignmentTemplate from "../prompts/system/seance-assignment.md" with { type: "text" };
import submitReminderTemplate from "../prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { AgentLifecycleManager, type AgentReviver } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster, isCurrentSessionRosterRef } from "../registry/persisted-agents";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
} from "../sdk";
import {
	type AgentSession,
	type AgentSessionEvent,
	type Prewalk,
	PromptDroppedError,
	type PromptOptions,
} from "../session/agent-session";
import { type ArtifactManager, writeArtifact } from "../session/artifacts";
import { ASYNC_RESULT_MESSAGE_TYPE } from "../session/async-job-delivery";
import type { AuthStorage } from "../session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { hasConversationalHistory, SessionManager } from "../session/session-manager";
import { truncateTail } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
	type ConfiguredThinkingLevel,
	prewalkWouldBeNoop,
	resolveTaskEffortLevel,
	type TaskEffort,
} from "@oh-my-pi/pi-tui/thinking";
import type { ContextFileEntry, ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { isIrcEnabled } from "../irc/messaging";
import { LIST_STATUS_ORDER } from "@oh-my-pi/pi-tui/tools/irc";
import { DEFAULT_PEER_ROSTER_LIMIT } from "@oh-my-pi/pi-tui/tools/irc";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import { buildOutputValidator, summarizeValidationFailure } from "../tools/output-schema-validator";
import { ToolAbortError } from "../tools/tool-errors";
import { resetYieldTurnState } from "../tools/yield";
import { type EventBus, emitSubagentFrame } from "../utils/event-bus";
import { trackLateCleanup } from "../utils/late-cleanup";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { isCompletionProbeEnabled, startCompletionProbe } from "./completion-probe";
import { attributeSubagentError } from "./error-attribution";
import { generateTaskLabel } from "./label";
import { resolveAgentPrewalkDefault } from "./prewalk";
import { isReadOnlyAgent } from "./read-only-policy";
import { formatTaskResultSummary } from "./result-summary";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import { seanceIsolationOptions } from "./seance-policy";
import type { WorkPoolYieldItem } from "./workpool-yield";
import {
	type AgentDefinition,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "./types";
import {
	type AgentProgress,
	type SingleResult,
	type StructuredSubagentOutput,
	type StructuredSubagentSchemaMode,
	type StructuredSubagentSchemaSource,
	type TaskToolDetails,
	type YieldItem,
} from "@oh-my-pi/pi-tui/tools/task";
import { yieldSectionShapes } from "./yield-assembly";
import { assembleYieldResult } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import {
	cfgTaskPrewalk,
	cfgTaskAgentPrewalk,
	cfgTaskMaxEffort,
	cfgTaskSoftRequestBudgetNotice,
	cfgTaskSoftRequestBudget,
	cfgTaskAgentIdleTtlMs,
	cfgTaskMaxRuntimeMs,
	cfgTaskMaxRecursionDepth,
	cfgTaskAgentAdvisor,
	cfgTaskAgentAccountPools,
} from "./settings";
import {
	cfgTierSubagent,
	cfgTierGoogle,
	cfgTierAnthropic,
	cfgTierOpenai,
	cfgRetryFallbackChains,
	cfgDefaultThinkingLevel,
} from "../session/settings";
import { cfgDisabledProviders } from "../config/model-settings";
import { getRetryFallbackRole, installRetryFallbackRole } from "../session/retry-fallback-chains";
import {
	cfgCompactionModelThresholdsEnabled,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
} from "../session/context-settings";

export type { YieldItem } from "@oh-my-pi/pi-tui/tools/task";

const TASK_ABORT_CLEANUP_GRACE_MS = 10_000;

/**
 * Soft per-agent request budgets (assistant requests per run). Crossing the
 * budget injects a wrap-up steering notice (`task.softRequestBudgetNotice`,
 * on by default). At 1.5x the budget the free-running turn is stopped and the
 * agent is driven to one forced final `yield` so partial findings come back
 * as a real report; only if it still refuses to yield within
 * {@link BUDGET_STOP_GRACE_REQUESTS} more requests is the run hard-aborted.
 * Entries are ceilings, not fixed values: the `default` key applies to agents
 * without an explicit entry, and the `task.softRequestBudget` setting can only
 * lower an agent's budget, never raise it above its bundled entry (0 disables
 * the guard entirely).
 */
export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

/**
 * Resolves the effective soft request budget for an agent. The configured
 * `task.softRequestBudget` and the agent's bundled entry are both upper
 * bounds, so the tighter one wins; a configured budget of 0 disables the
 * guard regardless of the bundled entry.
 */
export function resolveSoftRequestBudget(agentName: string, configuredBudget: number): number {
	const normalized = Math.max(0, Math.trunc(configuredBudget));
	if (normalized === 0) return 0;
	return Math.min(normalized, SOFT_REQUEST_BUDGET[agentName] ?? normalized);
}

/** Extra requests allowed after a budget stop for the forced yield to land before the run is hard-aborted. */
export const BUDGET_STOP_GRACE_REQUESTS = 5;

/** Steering notice injected when a subagent crosses its soft request budget. */
export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and yield your final report. At ${Math.ceil(budget * 1.5)} requests the run is force-stopped and you will be asked to yield whatever you have.`;
}

/** Flatten whitespace and clip salvage text for the cancelled-child summary line. */
function formatSalvageSnippet(text: string, maxLength = 500): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

/** Agent event types to forward for progress tracking. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

/** Session-scoped role owning subagent `id`'s retry fallback chain; cold revival reinstalls it under this name. */
export function subagentRetryFallbackRole(id: string): string {
	return `subagent:${id}`;
}

interface SubagentRetryFallbackCandidate {
	model: Model<Api>;
	selector: string;
}

function resolveSubagentRetryFallbackCandidates(
	modelPatterns: string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): SubagentRetryFallbackCandidate[] {
	const candidates: SubagentRetryFallbackCandidate[] = [];
	const seen = new Set<string>();
	const disabledProviders = new Set(cfgDisabledProviders.get(settings));
	for (const pattern of modelPatterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) continue;
		if (disabledProviders.has(resolved.model.provider)) continue;
		const selector = resolved.explicitThinkingLevel
			? formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel)
			: formatModelStringWithRouting(resolved.model);
		if (seen.has(selector)) continue;
		seen.add(selector);
		candidates.push({ model: resolved.model, selector });
	}
	return candidates;
}

/**
 * Chain a single-model subagent inherits when its own model patterns supply no
 * fallbacks of their own. The child is pinned to a `subagent:<id>` role whose
 * chain shadows every configured role chain (see
 * {@link installSubagentRetryFallbackChain}), so a role-alias request (`@smol`,
 * the bundled `task` agent's `@task`) MUST inherit that role's chain —
 * otherwise the pin silently re-routes the child onto the `default` role's
 * chain. Explicit model selectors keep inheriting `default`: they carry no role
 * identity, and a role that happens to be assigned the same model must not
 * capture the child's fallback routing.
 *
 * Spawn paths preserve the pre-expansion alias as `modelRole` because their
 * model patterns are already expanded. Direct callers may still supply an
 * unexpanded alias through `modelOverride` or `agent.model`; retain that
 * existing path by deriving the role only when no preserved role was supplied.
 */
function resolveSubagentInheritedRetryFallbackChain(
	settings: Settings,
	modelRegistry: ModelRegistry,
	role: string | undefined,
): string[] | undefined {
	const configuredChains = cfgRetryFallbackChains.get(settings);
	// An explicitly emptied role chain means "no fallbacks", not "inherit
	// default" — mirrors expandDefaultRetryFallbackChains.
	const fallbackChain = (role !== undefined ? configuredChains?.[role] : undefined) ?? configuredChains?.default;
	if (
		!Array.isArray(fallbackChain) ||
		fallbackChain.length === 0 ||
		!fallbackChain.every(entry => typeof entry === "string")
	) {
		return undefined;
	}
	const disabledProviders = new Set(cfgDisabledProviders.get(settings));
	return fallbackChain.filter(entry => {
		const resolved = resolveModelOverride([entry], modelRegistry, settings);
		return !resolved.model || !disabledProviders.has(resolved.model.provider);
	});
}

function installSubagentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: SubagentRetryFallbackCandidate[];
	inheritedFallbackChain: string[] | undefined;
	model: Model<Api> | undefined;
	authFallbackUsed: boolean;
}): string | undefined {
	const { settings, id, candidates, inheritedFallbackChain, model, authFallbackUsed } = args;
	if (!model || authFallbackUsed || candidates.length === 0) return undefined;

	const selectedIndex = candidates.findIndex(
		candidate => candidate.model.provider === model.provider && candidate.model.id === model.id,
	);
	if (selectedIndex < 0) return undefined;
	const fallbackSelectors = candidates.slice(selectedIndex + 1).map(candidate => candidate.selector);
	// A single configured model may reuse its role's (or the default) configured chain, but never an implicit parent fallback.
	const fallbackChain = fallbackSelectors.length > 0 ? fallbackSelectors : inheritedFallbackChain;
	if (
		!Array.isArray(fallbackChain) ||
		fallbackChain.length === 0 ||
		!fallbackChain.every(entry => typeof entry === "string")
	) {
		return undefined;
	}

	const role = subagentRetryFallbackRole(id);
	installRetryFallbackRole(settings, role, { primary: candidates[selectedIndex].selector, chain: fallbackChain });
	return role;
}

export interface IrcPeerRosterRow {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	activity?: string;
}

export interface IrcPeerRosterData {
	/** Live (running+idle) peer rows, bounded at DEFAULT_PEER_ROSTER_LIMIT. */
	peers: IrcPeerRosterRow[];
	/** Current-root parked refs, counted but never named. */
	parkedCount: number;
	/** Live rows dropped by the bound; the prompt reports them truthfully. */
	omittedCount: number;
}

export function collectIrcPeerRoster(
	registry: AgentRegistry,
	selfId: string,
	rootSessionFile?: string,
): IrcPeerRosterData {
	// Running before idle, then newest activity
	// first — so the cap keeps the newest relevant siblings, not an
	// insertion-order prefix.
	const live = registry
		.listVisibleTo(selfId)
		.sort(
			(a, b) =>
				(LIST_STATUS_ORDER[a.status] ?? 9) - (LIST_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
		);
	const limit = DEFAULT_PEER_ROSTER_LIMIT;
	const omittedCount = Math.max(0, live.length - limit);
	const peers = (omittedCount > 0 ? live.slice(0, limit) : live).map(peer => ({
		id: peer.id,
		displayName: peer.displayName,
		kind: peer.kind,
		status: peer.status,
		activity: peer.activity,
	}));
	let parkedCount = 0;
	for (const ref of registry.list()) {
		if (
			ref.id !== selfId &&
			ref.kind !== "advisor" &&
			ref.status === "parked" &&
			isCurrentSessionRosterRef(ref, rootSessionFile)
		) {
			parkedCount++;
		}
	}
	return { peers, parkedCount, omittedCount };
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	/** Additional workspace directories to seed on the subagent session (multi-root). */
	additionalDirectories?: string[];
	/** Exact provider credential resolver inherited from the parent session. */
	getApiKey?: CreateAgentSessionOptions["getApiKey"];
	/** Parent session whose stored credential affinities seed the child session. */
	credentialSourceSessionId?: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	/** Resolved source JSONL path; present only for restricted seance forks. */
	sourceSession?: string;
	/** Source session id rendered in the seance's system prompt. */
	sourceSessionLabel?: string;
	/** Shared background from the task call (`task.batch`), rendered into the subagent's system prompt. */
	context?: string;
	/**
	 * The session's active overall plan, handed off so subagents spawned during
	 * plan execution share the same plan context as the main agent. Omitted when
	 * the session did not start with a plan (or while plan mode is still active).
	 */
	planReference?: { path: string; content: string };
	/** Pre-set UI label (e.g. eval bridge label). When absent, a tiny-model label is generated from the assignment. */
	description?: string;
	index: number;
	id: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * Rides the subagent lifecycle/progress payloads so HUD-style surfaces can
	 * skip spawns the transcript already renders inline. See
	 * {@link SubagentLifecyclePayload.detached}.
	 */
	detached?: boolean;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Extension routing note for the chosen model; surfaced as `resolvedModelRoute`. */
	modelRoute?: string;
	/**
	 * Active model selector of the parent session, used as an auth-aware fallback
	 * if the resolved subagent model has no working credentials. See #985.
	 */
	parentActiveModelPattern?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Caller-requested coarse effort (`lo`/`med`/`hi`); maps onto the resolved model's supported thinking range and wins over {@link thinkingLevel}. */
	effort?: TaskEffort;
	/** Caller's description of how open-ended the work is; rides the initial prompt into the child's `auto` thinking classifier. */
	solutionSpace?: string;
	/** Schema used to validate the final structured completion. */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Origin of the selected schema, preserved in {@link SingleResult.structuredOutput}. */
	outputSchemaSource?: StructuredSubagentSchemaSource;
	/**
	 * Caller supplied a schema that supersedes the agent's native output prompt.
	 * Eval `agent(..., schema=...)` sets this so built-in agents ignore stale yield labels.
	 */
	outputSchemaOverridesAgent?: boolean;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/**
	 * Override the `task.maxRuntimeMs` wall-clock cap for this run. When provided
	 * it wins over the settings value; `0` disables the per-subagent wall-clock
	 * limit entirely. Used by the eval `agent()` bridge, whose parent cell
	 * watchdog is already suspended for the call's duration.
	 */
	maxRuntimeMs?: number;
	/** Include IRC only when the invocation policy permits collaboration. */
	enableIrc?: boolean;
	enableLsp?: boolean;
	/**
	 * Enable MCP capabilities for this child. `false` suppresses both inherited
	 * MCP proxy tools and session MCP discovery; it never consults the
	 * process-global MCP manager. Defaults to `true`.
	 */
	enableMCP?: boolean;
	/** Kernel-defined tools explicitly exposed by the parent eval session. */
	customTools?: CustomTool[];
	/** Workpool items accepted by the child yield tool during this turn. */
	workPoolYieldItems?: WorkPoolYieldItem[];
	/**
	 * Limit the child to its explicit host tool names and the required yield
	 * tool, suppressing discovered and always-included capabilities.
	 */
	restrictToolNames?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	/**
	 * Epochs (ms, `Date.now()`) bracketing the concurrency-semaphore wait:
	 * `invokedAt` is stamped at the spawn boundary before `acquire()`,
	 * `acquiredAt` immediately after. {@link runSubprocess} reports true queue
	 * wait (`acquiredAt - invokedAt`) and pre-run setup (`startTime - acquiredAt`)
	 * separately in the launch-timing debug log. Undefined for callers that
	 * bypass the semaphore path.
	 */
	invokedAt?: number;
	acquiredAt?: number;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	workspaceTree?: WorkspaceTree;
	/** Parent-discovered rules, forwarded to skip rule discovery in the subagent. */
	rules?: Rule[];
	/**
	 * Parent session's live extension-root policy. Forwarded separately from
	 * `preloadedExtensionPaths`, which only controls extension module loading.
	 */
	extensionRoots?: () => EffectiveExtensionRoots;
	/**
	 * Parent's discovered extension source paths. Forwarded to skip the
	 * extension FS scan in the subagent; the subagent then re-binds each
	 * extension against its own `ExtensionAPI` (cwd, eventBus, runtime).
	 */
	preloadedExtensionPaths?: string[];
	/** Parent-imported extension factories rebound to the child runtime. */
	preloadedPreparedExtensions?: readonly PreparedExtension[];
	/**
	 * Parent's discovered custom-tool source paths. Forwarded to skip the
	 * `.omp/tools/` FS scan in the subagent; the subagent then re-binds each
	 * tool against its own `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];
	mcpManager?: MCPManager;
	/** User-authorized model agents available to this child and its descendants. */
	inheritedSessionAgents?: CreateAgentSessionOptions["inheritedSessionAgents"];
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/**
	 * Parent session's live per-family service tiers, the source of truth for a
	 * subagent whose `tier.subagent` is `"inherit"`. `null` = the parent
	 * explicitly has no tier (e.g. `/fast off`); omitted = no live session, so
	 * inherit falls back to the subagent's configured `tier.*` settings.
	 */
	parentServiceTier?: ServiceTierByFamily | null;
	/**
	 * Exact-name `task.agentServiceTierOverrides` entry that task/eval dispatch
	 * resolved for this agent, applied after model resolution. Spawns that keep
	 * `tier.subagent` (Vibe workers) omit it.
	 */
	serviceTierOverride?: ServiceTierInheritSettingValue;
	/** Exact-name `task.agentCompactionThresholdOverrides` pair selected by dispatch. */
	compactionThresholdOverride?: CompactionThresholdPair;
	/** Exact-name `task.agentAccountPools` entry selected by dispatch; see `CreateAgentSessionOptions.oauthAccountPools`. */
	oauthAccountPools?: OAuthAccountPools;
	/** Override local:// protocol options so subagent shares parent's local:// root */
	localProtocolOptions?: LocalProtocolOptions;
	/**
	 * Parent session's ArtifactManager. Subagent adopts it so artifact IDs are
	 * unique across the whole agent tree and all artifacts land in the parent's
	 * artifacts directory (no per-subagent subdir).
	 */
	parentArtifactManager?: ArtifactManager;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
	/**
	 * Parent agent's OpenTelemetry configuration. When defined, the subagent's
	 * loop is started with the same tracer/hooks but its own agent identity
	 * stamped, so its `invoke_agent` / `chat` / `execute_tool` spans appear as
	 * a sub-tree under the parent's active `execute_tool task` span. A
	 * `handoff` span is emitted on dispatch to mark the parent → subagent
	 * transition explicitly.
	 */
	parentTelemetry?: AgentTelemetryConfig;
	/** Skills to autoload via sendCustomMessage before the first prompt */
	autoloadSkills?: Skill[];
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent.
	 * Forwarded verbatim to the SDK; the executor never derives it (the spawner
	 * passes its own `getAgentId()`).
	 */
	parentAgentId?: string;
	/**
	 * Keep the finished subagent addressable in the registry for IRC/revival.
	 * Defaults to true. Eval bridge agents are programmatic one-shot helpers and
	 * set this false so disposal unregisters them instead of leaving idle peers.
	 */
	keepAlive?: boolean;
	/** Internal ownership handoff for cleanup that outlives the visible Task result. */
	onCleanupDeferred?: (completion: Promise<void>) => void;
	/** Releases resources retained for a kept-alive agent when its lifecycle ends. */
	onRelease?: () => Promise<void>;
	/** Internal cleanup grace override for deterministic lifecycle tests. */
	cleanupGraceMs?: number;
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function previewOffendingData(value: unknown, maxLength = 500): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		serialized = String(value);
	}
	return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validator, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validator && !validator.validate(candidate).success) return null;
	return { data: candidate };
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	outputSchema: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	lastAssistantText?: string;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
	structuredOutput?: StructuredSubagentOutput;
}
export const SUBAGENT_WARNING_SCHEMA_OVERRIDDEN =
	"SYSTEM WARNING: Subagent exhausted schema-retry budget; result was accepted despite failing the output schema.";
export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Subagent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";

/** Build a schema_violation outcome — surfaced as a non-zero exit so callers treat it as a failure. */
function buildSchemaViolationOutcome(
	failure: { message: string; missingRequired: string[] },
	data: unknown,
): { rawOutput: string; stderr: string; exitCode: number } {
	const missing = failure.missingRequired;
	const headline =
		missing.length > 0
			? `schema_violation: missing required fields: ${missing.join(", ")}`
			: `schema_violation: ${failure.message}`;
	const payload = {
		error: "schema_violation",
		message: failure.message,
		missingRequired: missing,
		data: previewOffendingData(data),
	};
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify(payload, null, 2);
	} catch {
		rawOutput = `{"error":"schema_violation","message":${JSON.stringify(headline)}}`;
	}
	return { rawOutput, stderr: headline, exitCode: 1 };
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { yieldItems, doneAborted, signalAborted, outputSchema, lastAssistantText } = args;
	const mode = args.outputSchemaMode ?? "permissive";
	const source = args.outputSchemaSource ?? (outputSchema === undefined ? "none" : "session");
	const includeStructuredOutput = source !== "none";
	let structuredOutput: StructuredSubagentOutput | undefined;
	let abortedViaYield = false;
	const hasYield = Array.isArray(yieldItems) && yieldItems.length > 0;
	const hadFailureBeforeYield = exitCode !== 0 && stderr.trim().length > 0;

	if (hasYield) {
		const lastYield = yieldItems[yieldItems.length - 1];
		if (lastYield?.status === "aborted") {
			abortedViaYield = true;
			exitCode = 0;
			stderr = lastYield.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastYield.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastYield.error || "Unknown error"}"}`;
			}
		} else {
			const assembled = assembleYieldResult(yieldItems, lastAssistantText, yieldSectionShapes(outputSchema));
			if (!assembled || assembled.missingData) {
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
				if (includeStructuredOutput) {
					structuredOutput = { source, mode, status: "invalid", error: SUBAGENT_WARNING_NULL_YIELD };
				}
				// Strict mode promises a schema violation fails the run, not a
				// warning-decorated success (exitCode 0); build the same
				// non-zero-exit outcome the validated-data path uses below so
				// async job delivery marks the job failed instead of completed.
				if (mode === "strict" && includeStructuredOutput) {
					const { validator } = buildOutputValidator(outputSchema);
					const outcome = buildSchemaViolationOutcome(
						{ message: SUBAGENT_WARNING_NULL_YIELD, missingRequired: [...(validator?.requiredFields ?? [])] },
						undefined,
					);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				}
			} else {
				const { validator, error: schemaError, normalized } = buildOutputValidator(outputSchema);
				const submittedData = assembled.rawText ? assembled.data : parseStringifiedJson(assembled.data ?? null);
				const completeData =
					mode === "strict" ? (validator?.normalize(submittedData) ?? submittedData) : submittedData;
				const validation = validator?.validate(completeData);
				const failure =
					validation && !validation.success
						? summarizeValidationFailure(validation, completeData, validator?.requiredFields ?? [])
						: assembled.schemaOverridden
							? { message: SUBAGENT_WARNING_SCHEMA_OVERRIDDEN, missingRequired: [] }
							: schemaError
								? { message: `invalid output schema: ${schemaError}`, missingRequired: [] }
								: undefined;
				if (includeStructuredOutput) {
					structuredOutput =
						schemaError || normalized === undefined
							? {
									source,
									mode,
									status: "unavailable",
									data: completeData,
									error: schemaError ? `invalid output schema: ${schemaError}` : undefined,
								}
							: failure
								? { source, mode, status: "invalid", data: completeData, error: failure.message }
								: { source, mode, status: "valid", data: completeData };
				}
				const mustReject =
					failure !== undefined && (mode === "strict" || (!assembled.schemaOverridden && !schemaError));
				if (mustReject && failure) {
					const outcome = buildSchemaViolationOutcome(failure, completeData);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				} else {
					try {
						rawOutput =
							assembled.rawText && typeof completeData === "string"
								? completeData
								: (JSON.stringify(completeData, null, 2) ?? "null");
					} catch (err) {
						const errorMessage = err instanceof Error ? err.message : String(err);
						rawOutput = `{"error":"Failed to serialize yield data: ${errorMessage}"}`;
					}
					if (!hadFailureBeforeYield) {
						exitCode = 0;
						stderr = assembled.schemaOverridden
							? SUBAGENT_WARNING_SCHEMA_OVERRIDDEN
							: (structuredOutput?.error ?? "");
					} else if (!stderr) {
						stderr = "Subagent failed after yielding a result.";
					}
				}
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted;
		const { normalized: normalizedSchema, error: schemaError } = normalizeSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const { validator } = buildOutputValidator(outputSchema);
			const completeData = parseStringifiedJson(fallback.data ?? null);
			const result = validator?.validate(completeData) ?? { success: true as const };
			if (!result.success) {
				const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
				if (includeStructuredOutput) {
					structuredOutput = { source, mode, status: "invalid", data: completeData, error: summary.message };
				}
				const outcome = buildSchemaViolationOutcome(summary, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
			} else {
				if (includeStructuredOutput) {
					structuredOutput = {
						source,
						mode,
						status: "valid",
						data: completeData,
					};
				}
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (exitCode === 0) {
			const hasRawOutput = rawOutput.trim().length > 0;
			rawOutput = rawOutput ? `${SUBAGENT_WARNING_MISSING_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_MISSING_YIELD;
			if (hasOutputSchema || !hasRawOutput) {
				exitCode = 1;
				stderr = SUBAGENT_WARNING_MISSING_YIELD;
			}
		}
	}

	return { rawOutput, exitCode, stderr, abortedViaYield, hasYield, structuredOutput };
}

function formatToolArgsPreview(value: string, key: string): { value: string; key: string } {
	const safe = shortenToolArgumentPaths(replaceTabs(sanitizeText(value)), key);
	return { value: previewLine(safe, TRUNCATE_LENGTHS.CONTENT), key };
}

/**
 * Extract bounded display arguments after path and terminal sanitation. The key names which argument
 * was chosen so the renderer can shorten home paths in path-valued arguments without rewriting a
 * literal search pattern.
 */
function extractToolArgsPreview(
	args: Record<string, unknown>,
	toolName: string,
	editMode?: EditMode,
): { value: string; key: string } | undefined {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];
	const isEdit = toolName === "edit" || toolName === "apply_patch";
	if (isEdit && typeof args.input === "string") {
		const paths = getEditInputPaths(args.input, editMode);
		if (paths.length > 0) return formatToolArgsPreview(paths.join(", "), "path");
	}
	const compoundEdits = args.edits;
	if (isEdit && Array.isArray(compoundEdits)) {
		const paths = new Set<string>();
		if (typeof args.path === "string" && args.path) paths.add(args.path);
		for (const edit of compoundEdits) {
			if (!isRecord(edit)) continue;
			if (typeof edit.path === "string" && edit.path) paths.add(edit.path);
			if (typeof edit.rename === "string" && edit.rename) paths.add(edit.rename);
		}
		if (paths.size > 0) return formatToolArgsPreview([...paths].join(", "), "path");
	}
	for (const key of previewKeys) {
		if (typeof args[key] === "string" && args[key]) {
			return formatToolArgsPreview(args[key] as string, key);
		}
	}
	return undefined;
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Tokens for progress display: input + output + cacheWrite per turn.
 *
 * Deliberately excludes cacheRead. With prompt caching, cacheRead in each turn
 * equals the full cached context (potentially hundreds of KB), so summing it
 * across all turns produces a cumulative total that is N×context_size — far
 * larger than the context window and misleading as a "work done" metric.
 * cacheWrite is kept because each byte is written once, not repeated per turn.
 * The cost segment handles billing; dedicated cache_read/cache_write segments
 * handle cache-specific monitoring.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	const computed = input + output + cacheWrite;
	if (computed > 0) return computed;
	// Fallback for providers that only surface a pre-summed total without individual
	// field breakdown. This total includes cacheRead, but returning it is still better
	// than silently showing 0 for those providers.
	return firstNumberField(record, ["totalTokens", "total_tokens"]) ?? 0;
}

/**
 * Create proxy tools that reuse the parent's MCP connections.
 *
 * Each proxy delegates to the current source `MCPTool`/`DeferredMCPTool` rather
 * than rebuilding a raw `tools/call` request, so the Task/subagent path shares
 * the source tool's authoritative outbound boundary: harness-intent (`i`)
 * stripping, optional-placeholder pruning, local-URL resolution, reconnect
 * retry, abort handling, and result/provider metadata. The source tool is
 * re-resolved on every call by raw MCP server/tool metadata (not the normalized
 * display name), so a reconnect that swaps the instance in `getTools()` is
 * always honored. The source transport owns the configured MCP deadline,
 * including timeout=0; a second Task deadline would silently cap longer calls.
 * The proxy only races caller cancellation around source execution.
 */
export function createMCPProxyTools(mcpManager: MCPManager): CustomTool[] {
	return mcpManager.getTools().map(tool => {
		const serverName = tool.mcpServerName ?? "";
		const mcpToolName = tool.mcpToolName ?? "";
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters,
			strict: tool.strict,
			mcpServerName: serverName,
			mcpToolName,
			execute: async (toolCallId, params, onUpdate, ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				// Re-resolve by raw MCP metadata so a reconnect that replaced the
				// source instance is picked up; the display name alone is not enough.
				const source = mcpManager
					.getTools()
					.find(t => t.mcpServerName === serverName && t.mcpToolName === mcpToolName);
				if (!source?.execute) {
					return {
						content: [{ type: "text" as const, text: `MCP error: tool ${mcpToolName} no longer available` }],
						details: { serverName, mcpToolName, isError: true },
					};
				}
				try {
					return await untilAborted(signal, source.execute(toolCallId, params, onUpdate, ctx, signal));
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
					}
					if (signal?.aborted) {
						throw new ToolAbortError();
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `MCP error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
						details: { serverName, mcpToolName, isError: true },
					};
				}
			},
		};
	});
}

/** Session surface {@link followMCPTools} drives: the child's MCP rebind plus its teardown hook. */
export type MCPToolFollowerSession = Pick<AgentSession, "refreshMCPTools" | "addDisposer">;

/** Subscription created by {@link followMCPTools}; bind it to the session the proxies went into. */
export interface MCPToolFollower {
	/** Attach the created session; replays any change seen since subscribing, then follows later ones. */
	bind(session: MCPToolFollowerSession): void;
	/** Drop the subscription when the session was never created. */
	dispose(): void;
}

/**
 * Keep a child session's MCP proxy tools in step with the parent's shared
 * manager. A child gets a spawn-time {@link createMCPProxyTools} snapshot and
 * never owns the manager's single-slot tool callback, so without this a
 * `/mcp reload` — or a server added, removed, or reconnected later — only
 * reaches the owning session and every live subagent keeps its stale set.
 *
 * Subscribe BEFORE building the child's proxies: a change landing while the
 * session is still being created is recorded and replayed on {@link
 * MCPToolFollower.bind}, so no window exists where an update is lost. Bursts
 * (a reload re-placing every server) coalesce into one rebind per tick.
 *
 * `reservedNames` are the child's explicitly supplied tool names (e.g.
 * kernel-defined `mcp__…` tools): `createAgentSession` drops same-named proxies
 * so those tools win, and every rebind must keep dropping them, or the first
 * reload would replace the child's own tool with the MCP capability.
 */
export function followMCPTools(mcpManager: MCPManager, reservedNames?: ReadonlySet<string>): MCPToolFollower {
	let session: MCPToolFollowerSession | undefined;
	let pending = false;
	let scheduled = false;
	const flush = (): void => {
		scheduled = false;
		if (!session || !pending) return;
		pending = false;
		const proxies = createMCPProxyTools(mcpManager);
		const tools = reservedNames?.size ? proxies.filter(tool => !reservedNames.has(tool.name)) : proxies;
		session.refreshMCPTools(tools).catch(error => {
			logger.warn("Subagent MCP tool refresh failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};
	const schedule = (): void => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(flush);
	};
	const unsubscribe = mcpManager.addToolsChangedListener(() => {
		pending = true;
		if (session) schedule();
	});
	return {
		bind(next) {
			session = next;
			next.addDisposer(unsubscribe);
			if (pending) schedule();
		},
		dispose: unsubscribe,
	};
}

/**
 * Per-family tiers a subagent inherits: the parent's live tiers when a live session supplied
 * them, else its configured `tier.*`. Live entries a family can't realize (a resumed session
 * file may carry `{anthropic: "flex"}`) are dropped — the subagent overlay rejects them.
 */
function inheritedSubagentServiceTiers(
	baseSettings: Settings,
	inheritedServiceTier?: ServiceTierByFamily | null,
): ServiceTierByFamily {
	if (inheritedServiceTier === undefined) {
		return buildServiceTierByFamily(
			cfgTierOpenai.get(baseSettings),
			cfgTierAnthropic.get(baseSettings),
			cfgTierGoogle.get(baseSettings),
		);
	}
	const tiers: ServiceTierByFamily = {};
	for (const family of ["openai", "anthropic", "google"] as const) {
		const tier = inheritedServiceTier?.[family];
		if (isServiceTierForFamily(family, tier)) tiers[family] = tier;
	}
	return tiers;
}

/**
 * Compaction thresholds of the root (non-subagent) settings a subagent chain
 * started from. Per-agent `task.agentCompactionThresholdOverrides` entries
 * replace `compaction.threshold*` and switch off `compaction.modelThresholds`
 * only for the agent they name; every other descendant resolves against these
 * root values, not an ancestor's override.
 */
const kRootCompactionThresholds = Symbol("task.rootCompactionThresholds");

interface RootCompactionThresholds extends CompactionThresholdPair {
	modelThresholdsEnabled: boolean;
}

/** Settings from {@link createSubagentSettings}, tagged with its chain's root compaction thresholds. */
interface SubagentChainSettings extends Settings {
	[kRootCompactionThresholds]?: RootCompactionThresholds;
}

/**
 * Settings overrides applying an exact-name compaction threshold entry to one
 * subagent. The agent entry outranks `compaction.modelThresholds`, including
 * entries added while the agent runs, so model entries are switched off for it.
 */
export function compactionThresholdSettings(
	threshold: CompactionThresholdPair | undefined,
): Readonly<Record<string, unknown>> | undefined {
	return threshold === undefined
		? undefined
		: {
				"compaction.thresholdPercent": threshold.thresholdPercent,
				"compaction.thresholdTokens": threshold.thresholdTokens,
				"compaction.modelThresholdsEnabled": false,
			};
}

export function createSubagentSettings(
	baseSettings: SubagentChainSettings,
	overrides?: Readonly<Record<string, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	// Resolve the subagent's per-family tiers from `tier.subagent` ("inherit" =
	// match the parent's live tiers when a live session supplied them, else the
	// subagent's own configured tier.* settings). The result is stamped onto the
	// overlay so createAgentSession's tier.* reads pick it up.
	const inheritedTiers = inheritedSubagentServiceTiers(baseSettings, inheritedServiceTier);
	const subagentTiers = resolveSubagentServiceTier(cfgTierSubagent.get(baseSettings), inheritedTiers);
	// A parent subagent's own per-agent threshold must not leak to its children: descendants
	// of a subagent pin the root's thresholds. A root parent's children read them through live.
	const inheritedRootThresholds = baseSettings[kRootCompactionThresholds];
	const rootThresholds = inheritedRootThresholds ?? {
		thresholdPercent: cfgCompactionThresholdPercent.get(baseSettings),
		thresholdTokens: cfgCompactionThresholdTokens.get(baseSettings),
		modelThresholdsEnabled: cfgCompactionModelThresholdsEnabled.get(baseSettings),
	};
	// Every other setting reads through to the parent live; writes on the overlay stay local.
	const subagentSettings: SubagentChainSettings = baseSettings.overlay({
		...(inheritedRootThresholds && {
			"compaction.thresholdPercent": inheritedRootThresholds.thresholdPercent,
			"compaction.thresholdTokens": inheritedRootThresholds.thresholdTokens,
			"compaction.modelThresholdsEnabled": inheritedRootThresholds.modelThresholdsEnabled,
		}),
		// A subagent's thinking level is chosen at spawn (agent definition, `effort`, or this
		// snapshot of the parent default); a later parent default edit must not re-steer it.
		defaultThinkingLevel: cfgDefaultThinkingLevel.get(baseSettings),
		"tier.openai": subagentTiers.openai ?? "none",
		"tier.anthropic": subagentTiers.anthropic ?? "none",
		"tier.google": subagentTiers.google ?? "none",
		// Async jobs and bash/eval auto-backgrounding are inherited from the parent:
		// background jobs are owner-routed to the subagent's own session, and
		// the run driver's quiescence barrier + teardown reap guarantee no
		// owner job outlives the run, so worktree capture/cleanup stays
		// race-free (previously both were force-disabled here).

		// Subagents run headless — there is no UI to confirm prompts against, so
		// the parent task approval is the authorization boundary. Use yolo mode
		// to preserve unattended subagent execution. User `tools.approval` policies still apply.
		"tools.approvalMode": "yolo",
		// Subagents run unadvised by default; runSubprocess opts a spawn back in
		// per agent (frontmatter `advisor` / `task.agentAdvisor`) via overrides.
		"advisor.enabled": false,
		// A subagent assignment is one turn: its tool loop ends only when the run
		// yields, so post-turn `checkCompaction` (driven from `agent_end`) fires
		// after the run is over and `maintainContextMidRun` is the only proactive
		// compaction the child ever reaches. `compaction.midTurnEnabled` encodes an
		// interactive preference — keep compaction boundaries on real user turns —
		// that has no counterpart here, so inheriting `false` left hours-long
		// worker runs sailing past the configured threshold until the provider
		// rejected the context (#13211). A per-spawn override still wins.
		"compaction.midTurnEnabled": true,
		...overrides,
	});
	subagentSettings[kRootCompactionThresholds] = rootThresholds;
	return subagentSettings;
}

export type AbortReason = "signal" | "shutdown" | "terminate" | "timeout" | "budget";

const MAX_YIELD_TOOL_ERRORS = 6;

/** Inputs for the run monitor driving one subagent assignment. */
interface RunMonitorArgs {
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	/** Parent model registry for tiny-model label generation; absent → skip labeling. */
	modelRegistry?: ModelRegistry;
	/** Parent settings for tiny-model label generation. */
	settings?: Settings;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Extension routing note for the chosen model. */
	modelRoute?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	/** Soft assistant-request budget; 0 disables the guard. */
	softRequestBudget: number;
	/** Whether crossing the soft budget injects a wrap-up steering notice. */
	softRequestBudgetNotice: boolean;
	/** Wall-clock cap in ms; 0 disables the timer. */
	maxRuntimeMs: number;
	/** Whether to periodically ask the agent for a completion estimate; see {@link isCompletionProbeEnabled}. */
	completionProbe: boolean;
	/** Fires each time a terminal `yield` is recorded for this run. */
	onYieldAccepted?: () => void;
}

/**
 * The run-monitoring core of {@link runSubprocess}: progress tracking, event
 * processing, abort/budget machinery, usage accumulation, and output capture
 * for one assignment run.
 */
interface SubagentRunMonitor {
	readonly progress: AgentProgress;
	/** Fires when the run was asked to stop (caller signal, timeout, budget, terminate). */
	readonly abortSignal: AbortSignal;
	readonly accumulatedUsage: Usage;
	hasUsage(): boolean;
	yieldCalled(): boolean;
	/**
	 * Latch or clear the reminder ladder's forced final `yield`. While set, the
	 * next accepted `yield` is terminal even when it carries incremental
	 * section labels, so a model pinned to `yield` by `toolChoice` cannot
	 * satisfy the pin forever without ending the run.
	 */
	markFinalYieldForced(forced: boolean): void;
	/** Epoch ms when the run's terminal `yield` was recorded; undefined while none is latched. */
	yieldAcceptedAt(): number | undefined;
	runtimeLimitExceeded(): boolean;
	/** True once the soft-budget stop fired: the free-running turn was aborted and the run is being driven to a forced final yield. */
	budgetStopRequested(): boolean;
	/** Resolves when the budget-stop session abort has settled (immediately when no stop fired). */
	waitForBudgetStop(): Promise<void>;
	/**
	 * True when a recorded yield was invalidated by a later async-result
	 * injection and no fresh yield has landed since: the yield payload
	 * predates background job outcomes the model was shown.
	 */
	yieldInvalidatedByAsync(): boolean;
	/**
	 * True once a terminal yield with pending owner async work stopped the
	 * free-running turn (recoverable, like a budget stop) instead of
	 * terminating the run. Cleared when {@link waitForYieldTurnStop} settles.
	 */
	yieldTurnStopRequested(): boolean;
	/** Resolves when the yield turn-stop session abort has settled (immediately when none fired). */
	waitForYieldTurnStop(): Promise<void>;
	/** The abort kind for this run, when an abort was requested. */
	abortKind(): AbortReason | undefined;
	terminalError(): string | undefined;
	/** True when the abort carries a precise external reason (signal / wall-clock / budget). */
	hasExplicitAbortReason(): boolean;
	/** Whether the (attempted) abort counts as a cancelled run rather than an internal failure. */
	isAbortedRun(): boolean;
	requestAbort(reason: AbortReason): void;
	failWithError(message: string): void;
	abortActiveSession(): Promise<void>;
	waitForActiveSessionAbort(): Promise<void>;
	resolveSignalAbortReason(): string;
	resolveAbortReasonText(): string;
	setActiveSession(session: AgentSession | null): void;
	/** Return and clear the active session reference. */
	takeActiveSession(): AgentSession | null;
	/** Subscribe the monitor to a session's events. Returns the unsubscribe function. */
	attach(session: AgentSession): () => void;
	/** Best-effort capture of the last assistant text for cancelled-run salvage. */
	captureSalvage(session: AgentSession): void;
	lastAssistantSalvageText(): string | undefined;
	/**
	 * Text of the last assistant turn that read as a report — prose, with no
	 * further work started. Source for `yield`'s data-less finalize.
	 */
	lastReportTurnText(): string | undefined;
	/** Final raw output: end-of-run assistant text when available, else accumulated chunks. */
	rawOutput(): string;
	scheduleProgress(flush?: boolean): void;
	/** Stop processing events and clear listeners/timers. Call once the run settled. */
	finish(): void;
}

/**
 * True when `message` is the session-injected async-result follow-up
 * ({@link ASYNC_RESULT_MESSAGE_TYPE}): the transcript-ordered signal that a
 * background job outcome landed after whatever the model said before it.
 */
function isAsyncResultInjection(message: AgentMessage | undefined): boolean {
	return message?.role === "custom" && message.customType === ASYNC_RESULT_MESSAGE_TYPE;
}

function createSubagentRunMonitor(args: RunMonitorArgs): SubagentRunMonitor {
	const {
		index,
		id,
		agent,
		task,
		assignment,
		signal,
		onProgress,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
		completionProbe,
	} = args;
	const startTime = Date.now();

	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: args.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride: args.modelOverride,
		modelRole: args.modelRole,
		resolvedModelRoute: args.modelRoute,
	};

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let recentOutputDirty = false;
	let resolved = false;
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let runtimeLimitExceeded = false;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let completionProbeStarted = false;
	let yieldCalled = false;
	let yieldCallPending = false;
	/**
	 * A `yield` awaiting validation suppresses the soft-budget check for its
	 * own turn (#5006). The check is deferred, not dropped: every turn that
	 * carries a yield latches {@link yieldCallPending}, so dropping it lets a
	 * run of yield-only turns bypass the budget entirely.
	 */
	let budgetCheckDeferred = false;
	/** True while the reminder ladder's forced final `yield` is outstanding. */
	let finalYieldForced = false;
	let yieldInvalidatedByAsync = false;
	/** Epoch ms the current terminal yield was recorded; cleared when it is invalidated. */
	let yieldAcceptedAt: number | undefined;
	let yieldTurnStopRequested = false;
	let yieldTurnStopPromise: Promise<void> | null = null;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		reasoningTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;
	let budgetSteerSent = false;
	let budgetLimitExceeded = false;
	let budgetStopRequested = false;
	let budgetStopAbortPromise: Promise<void> | undefined;
	let terminalError: string | undefined;
	let consecutiveYieldToolErrors = 0;
	let lastAssistantSalvageText: string | undefined;
	// Text of the most recent assistant turn that READ AS A REPORT: it carried
	// prose and started no further work (no tool call, or only the terminal
	// `yield`). This — not merely the last assistant message — is what a
	// data-less `yield` finalize harvests. Both the idle reminder and the
	// budget wrap-up tell a finished subagent to finalize "from last assistant
	// turn", and models routinely comply one turn later, so the finalize turn
	// itself is usually text-less. Turns that started more work are excluded on
	// purpose: mid-run narration must never surface as a final result.
	let lastReportTurnText: string | undefined;
	let activeSessionAbortPromise: Promise<void> | undefined;

	const abortActiveSession = (): Promise<void> => {
		const session = activeSession;
		if (!session) return Promise.resolve();
		activeSessionAbortPromise ??= session.abort().catch(error => {
			logger.debug("Subagent session abort cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return activeSessionAbortPromise;
	};

	const waitForActiveSessionAbort = async (): Promise<void> => {
		if (activeSessionAbortPromise) await activeSessionAbortPromise;
	};

	const requestAbort = (reason: AbortReason) => {
		if (abortSent) {
			// Shutdown is a superseding external abort: a process teardown that
			// races a self-inflicted budget hard-abort must still follow the
			// shutdown release path (dispose + unregister) instead of the
			// budget-resumable path, which would leave the subagent adopted and
			// alive past AgentLifecycleManager.dispose(). Genuine kills
			// (signal/timeout/terminate) already dispose terminally, and shutdown
			// is never downgraded back to signal.
			if (reason === "shutdown" && abortReason === "budget") {
				abortReason = "shutdown";
			} else if (
				reason === "signal" &&
				abortReason !== "signal" &&
				abortReason !== "timeout" &&
				abortReason !== "shutdown"
			) {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		// Limit flags must stay below the abortSent/resolved guards, next to the
		// abortReason they mirror. The wall-clock timer can fire during teardown —
		// after a budget hard-abort or a committed yield has already settled the
		// run — and resolveAbortReasonText/finalizeRunResult read these flags
		// (not abortReason), so a post-commitment timeout must not set them or it
		// rewrites the real outcome (budget kill mislabeled, completed yield tagged
		// aborted).
		if (reason === "timeout") {
			runtimeLimitExceeded = true;
		}
		if (reason === "budget") {
			budgetLimitExceeded = true;
		}
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		void abortActiveSession();
	};

	// Soft-budget stop: cancel the free-running turn WITHOUT aborting the
	// monitor, so driveSessionToYield can still drive one forced final yield.
	// Deliberately not routed through abortActiveSession(): that memoizes its
	// promise, and a later hard abort (grace exhausted) must be able to abort
	// the session again.
	const requestBudgetStop = () => {
		if (budgetStopRequested || abortSent || resolved) return;
		budgetStopRequested = true;
		const session = activeSession;
		budgetStopAbortPromise = session
			? session.abort().catch(error => {
					logger.debug("Subagent budget-stop abort failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
			: Promise.resolve();
	};

	const failWithError = (message: string) => {
		terminalError ??= message;
		requestAbort("terminate");
	};
	// Yield turn-stop: a terminal yield recorded while owner async work is
	// still pending is a scheduling pause, not run completion. Stop the
	// free-running turn exactly like a budget stop (session abort, monitor
	// signal untouched) so driveSessionToYield's quiescence barrier can settle
	// the jobs, fold their results in, and demand a fresh yield. Terminating
	// here instead would abort the run signal and make the barrier
	// unreachable, completing the run with a payload that predates the job
	// outcomes.
	const requestYieldTurnStop = () => {
		if (yieldTurnStopRequested || abortSent || resolved) return;
		yieldTurnStopRequested = true;
		const session = activeSession;
		yieldTurnStopPromise = session
			? session.abort().catch(error => {
					logger.debug("Subagent yield turn-stop abort failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
			: Promise.resolve();
	};

	/** Owner async work that can still re-wake the run (quiescence barrier predicate). */
	const sessionHasPendingAsyncWork = (): boolean => activeSession?.hasPendingAsyncWork?.() ?? false;

	// Handle abort signal
	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				if (!resolved) requestAbort(signal.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON ? "shutdown" : "signal");
			},
			{ once: true, signal: listenerSignal },
		);
	}

	// Wall-clock hard limit. Defense-in-depth for the case where a provider stream
	// hang escapes the inference-layer watchdog (see openai-completions
	// `isOpenAICompletionsProgressChunk`). Disabled by default; set
	// `task.maxRuntimeMs > 0` to cap each subagent's lifetime.
	let runtimeTimeoutId: NodeJS.Timeout | undefined;
	if (maxRuntimeMs > 0) {
		runtimeTimeoutId = setTimeout(() => {
			if (!resolved) {
				logger.warn("Subagent runtime limit exceeded; aborting", {
					id,
					agent: agent.name,
					maxRuntimeMs,
				});
				requestAbort("timeout");
			}
		}, maxRuntimeMs);
	}

	const resolveSignalAbortReason = (): string => {
		if (signal?.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON) return "Async job manager shutdown";
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const resolveAbortReasonText = (): string => {
		if (runtimeLimitExceeded) {
			return `Subagent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
		}
		if (budgetLimitExceeded) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget}) — agent did not yield when force-stopped`;
		}
		if (budgetStopRequested) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget})`;
		}
		return resolveSignalAbortReason();
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	// Recompute progress.recentOutput from the capped tail. Deferred: text_delta
	// appends only extend the tail and mark it dirty; the (up to 8KB) split/filter
	// runs synchronously here, immediately before the ONLY places the progress
	// object is snapshotted ({...progress} for onProgress and the eventBus
	// progress channel, both inside emitProgressNow — including the
	// scheduleProgress(flush) finalize/error/cancel paths). Observers therefore
	// always see exact state; no staleness beyond the existing 150ms coalescing.
	const refreshRecentOutput = () => {
		if (!recentOutputDirty) return;
		recentOutputDirty = false;
		const tail =
			recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES
				? recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES)
				: recentOutputTail;
		const filtered = tail.split("\n").filter(line => line.trim());
		progress.recentOutput = filtered.slice(-8).reverse();
	};

	const emitProgressNow = () => {
		refreshRecentOutput();
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		const activityGist =
			progress.lastIntent ?? (progress.currentTool ? `running ${progress.currentTool}` : undefined);
		if (activityGist) AgentRegistry.global().setActivity(id, activityGist);
		const progressPayload = {
			index,
			agent: agent.name,
			agentSource: agent.source,
			task,
			parentToolCallId: args.parentToolCallId,
			detached: args.detached,
			assignment,
			progress: { ...progress },
			sessionFile: args.sessionFile,
		};
		emitSubagentFrame(args.eventBus, args.subagentEventBus, TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	// The task wire schema carries no description: when the caller didn't pre-set
	// a UI label (e.g. the eval bridge's `label`), compress the assignment into a
	// tiny-model one-sentence label off the spawn's critical path. Best-effort —
	// a late label still lands via the finalize-time reads of `progress.description`;
	// failures just leave the label unset.
	const labelSource = assignment?.trim();
	if (!args.description && args.modelRegistry && args.settings && labelSource) {
		generateTaskLabel(labelSource, args.modelRegistry, args.settings, id, abortSignal)
			.then(label => {
				if (!label || abortSignal.aborted || progress.description) return;
				progress.description = label;
				if (!resolved) scheduleProgress();
			})
			.catch(err => {
				logger.debug("Subagent label generation failed", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	const getMessageContent = (message: unknown): unknown => {
		if (!isRecord(message) || !("content" in message)) {
			return undefined;
		}
		return message.content;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (!isRecord(message) || !("usage" in message)) {
			return undefined;
		}
		return message.usage;
	};

	// Hysteresis: let the tail grow to 2x the cap before trimming, so the
	// 8KB slice copy runs once per ~8KB of output instead of on every token
	// once the cap is reached. refreshRecentOutput() re-applies the exact cap.
	const trimRecentOutputTail = () => {
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES * 2) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		trimRecentOutputTail();
		// O(chunk) hot path: this runs on every text_delta token (hundreds/
		// thousands per second while streaming). Line reconstruction is deferred
		// to refreshRecentOutput() at the emit boundary.
		recentOutputDirty = true;
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			trimRecentOutputTail();
		}
		recentOutputDirty = true;
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		recentOutputDirty = false;
		progress.recentOutput = [];
	};

	const emitSubagentEvent = (event: AgentSessionEvent) => {
		const payload = { id, event };
		emitSubagentFrame(args.eventBus, args.subagentEventBus, TASK_SUBAGENT_EVENT_CHANNEL, payload);
	};

	const recordExtractedToolData = (toolName: string, data: unknown): void => {
		progress.extractedToolData = progress.extractedToolData || {};
		const existing = progress.extractedToolData[toolName] || [];
		existing.push(data);
		progress.extractedToolData[toolName] = existing;
		if (toolName === "yield") {
			const item = isRecord(data) ? data : undefined;
			const incremental = Array.isArray(item?.type) && item.type.length > 0;
			// A forced final yield ends the run. Once the reminder ladder has
			// pinned `toolChoice` to `yield`, an incremental section satisfies
			// the pin without terminating the run, so re-prompting loops
			// forever: take the section as the final report it was asked for.
			yieldCalled = !incremental || finalYieldForced || item?.complete === true || item?.status === "aborted";
			yieldCallPending = false;
			if (yieldCalled) {
				yieldInvalidatedByAsync = false;
				yieldAcceptedAt = Date.now();
				// Submitted: the remaining work is finalization (or waiting on owned
				// async jobs), so stop showing the last stale self-estimate.
				if (completionProbe) progress.completionPercent = 99;
				args.onYieldAccepted?.();
			}
		}
	};

	/**
	 * Tool calls in flight, by call id. Sibling calls run concurrently, so one call ending must not
	 * blank or relabel another that is still running: the live row shows the newest started call, and
	 * when that call ends it falls back to the oldest one still running.
	 */
	const activeTools = new Map<
		string,
		{ tool: string; args?: string; argsKey?: string; intent?: string; startMs: number }
	>();
	let visibleToolCallId: string | undefined;

	/**
	 * Soft request budget: steer at the budget, stop the free-running turn at
	 * 1.5x, and hard-abort {@link BUDGET_STOP_GRACE_REQUESTS} requests later if
	 * the forced final yield never lands.
	 */
	const evaluateSoftRequestBudget = () => {
		if (softRequestBudget <= 0 || abortSent) return;
		const stopThreshold = softRequestBudget * 1.5;
		if (budgetStopRequested) {
			// Grace window after the stop: the forced yield needs a request or
			// two; a child that keeps burning requests instead of yielding is
			// hard-aborted.
			if (progress.requests >= stopThreshold + BUDGET_STOP_GRACE_REQUESTS) {
				requestAbort("budget");
			}
			return;
		}
		if (progress.requests >= stopThreshold) {
			requestBudgetStop();
			return;
		}
		if (!softRequestBudgetNotice || budgetSteerSent || progress.requests < softRequestBudget) return;
		budgetSteerSent = true;
		const steerSession = activeSession;
		if (!steerSession) return;
		// Build the notice now (the count at crossing time), but send behind an
		// async boundary: a synchronously-throwing send must never take down
		// event processing (which escalates to terminate).
		const notice = buildBudgetNotice(progress.requests, softRequestBudget);
		void Promise.resolve()
			.then(() => steerSession.sendUserMessage(notice, { deliverAs: "steer", attribution: "agent" }))
			.catch(err => {
				logger.warn("Subagent budget steer failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;
		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") {
					resetRecentOutput();
				}
				// An async-result follow-up injected after a recorded yield
				// supersedes that yield: its payload predates the job outcome the
				// model is now being shown. Un-latch so the quiescence barrier's
				// reminder ladder demands a fresh yield. Guarded on the run signal:
				// once the run is completing, late injections must not destabilize
				// the settled classification.
				if (yieldCalled && !abortSignal.aborted && isAsyncResultInjection(event.message)) {
					yieldCalled = false;
					yieldInvalidatedByAsync = true;
					yieldAcceptedAt = undefined;
				}
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				let startArgs: Record<string, unknown> = {};
				if ("toolArgs" in event && isRecord(event.toolArgs)) {
					startArgs = event.toolArgs;
				} else if (isRecord(event.args)) {
					startArgs = event.args;
				}
				const editMode =
					event.toolName === "apply_patch"
						? "apply_patch"
						: ((activeSession?.getToolByName(event.toolName) as { mode?: EditMode } | undefined)?.mode ??
							undefined);
				const preview = extractToolArgsPreview(startArgs, event.toolName, editMode);
				progress.currentToolArgs = preview?.value;
				progress.currentToolArgsKey = preview?.key;
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim() || undefined;
				// Per call: intent-optional tools (e.g. MCP) start without one, and
				// `lastIntent` would otherwise label them with the previous call's.
				progress.currentToolIntent = intent;
				activeTools.set(event.toolCallId, {
					tool: event.toolName,
					args: preview?.value,
					argsKey: preview?.key,
					intent,
					startMs: now,
				});
				visibleToolCallId = event.toolCallId;
				// A fast tool may finish before the coalesced update fires.
				// Publish both lifecycle edges rather than dropping its start.
				flushProgress = true;
				if (intent) {
					progress.lastIntent = intent;
				}
				if (event.toolName === "yield" && !yieldCalled) {
					yieldCallPending = true;
				}
				// Reset any prior in-flight task snapshot so we don't show stale
				// nested progress when the agent enters a fresh `task` call.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}
				break;
			}

			case "tool_execution_end": {
				const finished = activeTools.get(event.toolCallId);
				activeTools.delete(event.toolCallId);
				if (finished) {
					progress.recentTools.unshift({
						tool: finished.tool,
						args: finished.args ?? "",
						argsKey: finished.argsKey,
						intent: finished.intent,
						isError: event.isError,
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				if (visibleToolCallId === event.toolCallId) {
					const remaining = activeTools.entries().next().value;
					visibleToolCallId = remaining?.[0];
					const visible = remaining?.[1];
					progress.currentTool = visible?.tool;
					progress.currentToolArgs = visible?.args;
					progress.currentToolArgsKey = visible?.argsKey;
					progress.currentToolIntent = visible?.intent;
					progress.currentToolStartMs = visible?.startMs;
				}
				// The finalized TaskToolDetails will be captured below into
				// `extractedToolData.task`; drop the in-flight snapshot so the
				// renderer doesn't double-count it against the final entry.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventRecord: unknown = event;
				const eventArgs = isRecord(eventRecord) && isRecord(eventRecord.args) ? eventRecord.args : {};
				if (handler) {
					// Extract data using handler
					if (handler.extractData) {
						const data = handler.extractData({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						});
						if (data !== undefined) {
							recordExtractedToolData(event.toolName, data);
						}
					}

					if (event.toolName === "yield") {
						yieldCallPending = false;
						if (budgetCheckDeferred) {
							budgetCheckDeferred = false;
							// The yield validated without ending the run: the turn
							// that submitted it still counts against the budget.
							if (!yieldCalled) evaluateSoftRequestBudget();
						}
					}

					// Check if the handler wants to terminate the session. A forced
					// final yield terminates too: it was accepted as terminal above,
					// and leaving the turn running would let the pinned model answer
					// with another incremental section instead of finishing.
					const wantsTerminate =
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						}) === true;
					const forcedFinalYield = event.toolName === "yield" && finalYieldForced && yieldCalled;
					if (wantsTerminate || forcedFinalYield) {
						if (event.toolName === "yield" && sessionHasPendingAsyncWork()) {
							// Terminal yield with owner jobs still pending: park the
							// run behind the quiescence barrier instead of completing
							// it (see requestYieldTurnStop).
							requestYieldTurnStop();
						} else {
							requestAbort("terminate");
						}
					}
				}
				if (event.toolName === "yield") {
					if (event.isError && !abortSent) {
						consecutiveYieldToolErrors++;
						let yieldErrorText = "";
						const resultContent = event.result?.content;
						if (Array.isArray(resultContent)) {
							const textParts: string[] = [];
							for (const block of resultContent) {
								if (
									block &&
									typeof block === "object" &&
									"type" in block &&
									block.type === "text" &&
									"text" in block &&
									typeof block.text === "string"
								) {
									textParts.push(block.text);
								}
							}
							yieldErrorText = textParts.join("\n").trim();
						}
						if (consecutiveYieldToolErrors >= MAX_YIELD_TOOL_ERRORS) {
							const suffix = yieldErrorText ? ` Last yield error: ${yieldErrorText}` : "";
							failWithError(
								`Subagent submitted invalid yield results ${consecutiveYieldToolErrors} times; stopping to avoid an infinite submit loop.${suffix}`,
							);
						}
					} else if (!event.isError) {
						consecutiveYieldToolErrors = 0;
					}
				}
				flushProgress = true;
				break;
			}

			case "tool_execution_update": {
				// Surface nested-subagent progress mid-flight. The child task
				// tool emits incremental `onUpdate` calls carrying its current
				// `TaskToolDetails` (results + progress); we stash the latest
				// snapshot so the parent UI can render the in-flight subtree
				// without waiting for the call to finish.
				if (event.toolName === "task") {
					const partial = (event as { partialResult?: { details?: unknown } }).partialResult;
					const details = partial && typeof partial === "object" ? partial.details : undefined;
					if (details && typeof details === "object" && "results" in (details as TaskToolDetails)) {
						progress.inflightTaskDetails = details as TaskToolDetails;
						flushProgress = true;
					}
				}
				break;
			}

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					progress.requests += 1;
					const eventContent = isRecord(event) && "content" in event ? event.content : undefined;
					const messageContent = getMessageContent(event.message) || eventContent;
					if (messageContent && Array.isArray(messageContent)) {
						const turnText: string[] = [];
						let startedMoreWork = false;
						for (const block of messageContent) {
							if (!isRecord(block)) continue;
							if (block.type === "text" && typeof block.text === "string") {
								outputChunks.push(block.text);
								if (block.text) turnText.push(block.text);
								continue;
							}
							if (block.type !== "toolCall" || typeof block.name !== "string") continue;
							if (block.name === "yield") {
								if (!yieldCalled) {
									yieldCallPending = true;
									flushProgress = true;
								}
								continue;
							}
							startedMoreWork = true;
						}
						// Only the report turn immediately preceding the finalize is
						// harvestable. A turn that started more work invalidates any
						// earlier candidate: the model took the reminder's "resume
						// work" path, so that prose predates the work and is no longer
						// a description of the finished assignment. Skipping the
						// update alone would leave it harvestable and hand the parent
						// stale narration as the completed result.
						const text = turnText.join("\n");
						if (startedMoreWork) lastReportTurnText = undefined;
						else if (text.trim()) lastReportTurnText = text;
					}
					// A yield awaiting validation suppresses the budget check for
					// its own turn (#5006). Defer it rather than drop it: every
					// yield turn latches the pending flag, so dropping the check
					// lets a run of yield-only turns never account for a request.
					if (yieldCallPending) budgetCheckDeferred = true;
					else evaluateSoftRequestBudget();
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const eventUsage = isRecord(event) && "usage" in event ? event.usage : undefined;
				const messageUsage = getMessageUsage(event.message) || eventUsage;
				if (isRecord(messageUsage)) {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const costRecord = isRecord(messageUsage.cost) ? messageUsage.cost : undefined;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(messageUsage, "input") ?? 0;
						accumulatedUsage.output += getNumberField(messageUsage, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(messageUsage, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(messageUsage, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(messageUsage, "totalTokens") ?? 0;
						accumulatedUsage.reasoningTokens =
							(accumulatedUsage.reasoningTokens ?? 0) + (getNumberField(messageUsage, "reasoningTokens") ?? 0);
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
							progress.cost = accumulatedUsage.cost.total;
						}
					}
					// Accumulate tokens for progress display
					progress.tokens += getUsageTokens(messageUsage);
					// Track latest per-turn context size so the UI can show
					// "current context", not just cumulative billing volume.
					if (role === "assistant") {
						const perTurnTotal = getNumberField(messageUsage, "totalTokens");
						if (perTurnTotal !== undefined && perTurnTotal > 0) {
							progress.contextTokens = perTurnTotal;
						}
					}
				}
				break;
			}

			case "agent_end":
				// Extract final content from assistant messages only (not user prompts)
				if (event.messages && Array.isArray(event.messages)) {
					for (const msg of event.messages) {
						if ((msg as { role?: string })?.role !== "assistant") continue;
						const messageContent = getMessageContent(msg);
						if (messageContent && Array.isArray(messageContent)) {
							for (const block of messageContent) {
								if (block.type === "text" && block.text) {
									finalOutputChunks.push(block.text);
								}
							}
						}
					}
				}
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const publishAdvisorState = (session: AgentSession | null): void => {
		// A runtime can attach after startup when model discovery finishes.
		// Retain this run's advised state through teardown for settled badges.
		if (!progress.advisor && session?.isAdvisorActive() === true) {
			progress.advisor = true;
			scheduleProgress(true);
		}
	};

	const attach = (session: AgentSession): (() => void) => {
		// The session owns attribution: it knows which model produced its output
		// and withholds an armed-but-unproven fallback. Re-deriving that here from
		// the event stream got it wrong twice over — the stream also carries
		// advisor turns running on a different model, and a routing switch was
		// read as evidence the target had served.
		const publishServingModel = (): void => {
			const serving = session.servingModel;
			if (!serving) return;
			const isFallback = serving.isFallback;
			// A model swap moves the window the usage gauge divides by. Without
			// this the Agent Hub kept the startup model's window while labelling
			// the row with the fallback that replaced it. Models with no declared
			// window keep the last known one rather than blanking the gauge.
			const contextWindow =
				serving.contextWindow && serving.contextWindow > 0 ? serving.contextWindow : progress.contextWindow;
			if (
				serving.selector === progress.resolvedModel &&
				serving.modelIdentity === progress.resolvedModelIdentity &&
				serving.thinkingLevel === progress.resolvedThinkingLevel &&
				(progress.resolvedModelIsFallback ?? false) === isFallback &&
				contextWindow === progress.contextWindow
			) {
				return;
			}
			progress.resolvedModel = serving.selector;
			progress.resolvedModelIdentity = serving.modelIdentity;
			progress.resolvedThinkingLevel = serving.thinkingLevel;
			progress.resolvedModelIsFallback = isFallback;
			progress.contextWindow = contextWindow;
			scheduleProgress(true);
		};
		return session.subscribe(event => {
			emitSubagentEvent(event);
			publishAdvisorState(session);
			publishServingModel();
			if (event.type === "auto_retry_start") {
				progress.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					startedAtMs: Date.now(),
				};
				progress.retryFailure = undefined;
				scheduleProgress(true);
				return;
			}
			if (event.type === "auto_retry_end") {
				const attempt = progress.retryState?.attempt ?? event.attempt;
				progress.retryState = undefined;
				if (!event.success) {
					progress.retryFailure = {
						attempt,
						errorMessage: event.finalError ?? "Auto-retry failed",
					};
				}
				scheduleProgress(true);
				return;
			}
			if (isAgentEvent(event)) {
				// Breadcrumb the synchronous subagent event handling so the loop
				// watchdog can attribute any block to this in-process subagent.
				pushLoopPhase(`subagent:${id}`);
				try {
					processEvent(event);
				} catch (err) {
					logger.error("Subagent event processing failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					requestAbort("terminate");
				} finally {
					popLoopPhase();
				}
			}
		});
	};

	const captureSalvage = (session: AgentSession): void => {
		// Best-effort salvage: capture the last assistant text so
		// cancelled/aborted children can surface "last activity" instead of
		// "(no output)".
		try {
			const lastContent = session.getLastAssistantMessage()?.content;
			if (Array.isArray(lastContent)) {
				const text = lastContent
					.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
					.filter(Boolean)
					.join("\n");
				if (text.trim()) {
					lastAssistantSalvageText = text;
				}
			}
		} catch {
			// Salvage is best-effort; partial sessions may not implement it
		}
	};

	return {
		progress,
		abortSignal,
		accumulatedUsage,
		hasUsage: () => hasUsage,
		yieldCalled: () => yieldCalled,
		markFinalYieldForced: (forced: boolean) => {
			finalYieldForced = forced;
		},
		yieldAcceptedAt: () => yieldAcceptedAt,
		runtimeLimitExceeded: () => runtimeLimitExceeded,
		terminalError: () => terminalError,
		hasExplicitAbortReason: () =>
			abortReason === "signal" ||
			abortReason === "shutdown" ||
			runtimeLimitExceeded ||
			budgetLimitExceeded ||
			budgetStopRequested,
		budgetStopRequested: () => budgetStopRequested,
		waitForBudgetStop: () => budgetStopAbortPromise ?? Promise.resolve(),
		yieldInvalidatedByAsync: () => yieldInvalidatedByAsync,
		yieldTurnStopRequested: () => yieldTurnStopRequested,
		waitForYieldTurnStop: async () => {
			const pending = yieldTurnStopPromise;
			if (!pending) {
				yieldTurnStopRequested = false;
				return;
			}
			try {
				await pending;
			} finally {
				// Clear only after the abort settled so the idempotence gate in
				// requestYieldTurnStop stays closed while it is in flight.
				if (yieldTurnStopPromise === pending) {
					yieldTurnStopPromise = null;
					yieldTurnStopRequested = false;
				}
			}
		},
		// A soft stop that never escalated still identifies as a budget abort so
		// the lifecycle can park the agent as resumable instead of killing it.
		abortKind: () => abortReason ?? (budgetStopRequested ? "budget" : undefined),
		isAbortedRun: () =>
			abortReason === "signal" ||
			abortReason === "shutdown" ||
			runtimeLimitExceeded ||
			budgetLimitExceeded ||
			abortReason === undefined,
		requestAbort,
		failWithError,
		abortActiveSession,
		waitForActiveSessionAbort,
		resolveSignalAbortReason,
		resolveAbortReasonText,
		setActiveSession: session => {
			activeSession = session;
			publishAdvisorState(session);
			if (session && completionProbe && !completionProbeStarted) {
				completionProbeStarted = true;
				startCompletionProbe({
					session: () => activeSession,
					signal: AbortSignal.any([listenerSignal, abortSignal]),
					onEstimate: (percent, cost) => {
						if (resolved) return;
						// A probe in flight when the yield landed must not pull the bar back from 99%.
						if (!yieldCalled) progress.completionPercent = percent;
						progress.cost += cost;
						scheduleProgress(true);
					},
				});
			}
		},
		takeActiveSession: () => {
			const session = activeSession;
			activeSession = null;
			return session;
		},
		attach,
		captureSalvage,
		lastAssistantSalvageText: () => lastAssistantSalvageText,
		lastReportTurnText: () => lastReportTurnText,
		rawOutput: () => (finalOutputChunks.length > 0 ? finalOutputChunks.join("") : outputChunks.join("")),
		scheduleProgress,
		finish: () => {
			resolved = true;
			listenerController.abort();
			if (runtimeTimeoutId !== undefined) {
				clearTimeout(runtimeTimeoutId);
				runtimeTimeoutId = undefined;
			}
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
		},
	};
}

interface DriveOutcome {
	exitCode: number;
	error?: string;
	aborted: boolean;
	abortReasonText?: string;
}

const MAX_YIELD_RETRIES = 3;
const MAX_PROMPT_DISPATCH_ATTEMPTS = 4;
const PROMPT_DISPATCH_IDLE_TIMEOUT_MS = 5_000;

class PromptDispatchError extends Error {}

/**
 * Drive one assignment through a live session: send the prompt, wait for idle,
 * remind the agent to `yield` (up to {@link MAX_YIELD_RETRIES} times), then
 * classify the terminal assistant state. A soft-budget stop short-circuits the
 * reminder ladder into a single forced final yield so partial findings still
 * come back as a real report.
 */
async function driveSessionToYield(
	session: AgentSession,
	monitor: SubagentRunMonitor,
	task: string,
	options: {
		/** Open-endedness description forwarded to the session's `auto` thinking classifier. */
		solutionSpace?: string;
		/**
		 * Invoked when the initial prompt loses a prompt race (AgentBusyError) before
		 * retrying. Lets the caller restore a safe contract and detach its monitor
		 * while backing off. Absent, the busy error keeps the old path.
		 */
		onPromptBusy?: () => Promise<void>;
	} = {},
): Promise<DriveOutcome> {
	const { solutionSpace, onPromptBusy } = options;
	using _keepalive = new EventLoopKeepalive();
	const abortSignal = monitor.abortSignal;
	let exitCode = 0;
	let error: string | undefined;
	let aborted = false;
	let abortReasonText: string | undefined;
	const checkAbort = () => {
		if (abortSignal.aborted) {
			aborted = monitor.isAbortedRun();
			if (aborted) {
				abortReasonText ??= monitor.resolveAbortReasonText();
			}
			exitCode = 1;
			throw new ToolAbortError();
		}
	};
	const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
		checkAbort();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbort = () => {
			try {
				checkAbort();
			} catch (err) {
				reject(err);
			}
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	};
	/**
	 * Send a headless prompt, retrying pre-provider drops (`PromptDroppedError`).
	 * Local slash commands are disabled so an assignment always reaches the
	 * model. `forceFinalYield` arms the monitor's forced-final latch only while
	 * an attempt dispatches, so another turn's incremental `yield` during drop
	 * recovery stays incremental.
	 */
	const dispatchPrompt = async (
		text: string,
		promptOptions: PromptOptions,
		label: string,
		{ forceFinalYield = false }: { forceFinalYield?: boolean } = {},
	): Promise<void> => {
		for (let attempt = 1; attempt <= MAX_PROMPT_DISPATCH_ATTEMPTS; attempt++) {
			if (forceFinalYield) monitor.markFinalYieldForced(true);
			try {
				await awaitAbortable(session.prompt(text, { ...promptOptions, runCommands: false, throwOnDrop: true }));
				return;
			} catch (err) {
				if (!(err instanceof PromptDroppedError)) throw err;
			}
			if (forceFinalYield) monitor.markFinalYieldForced(false);
			if (attempt === MAX_PROMPT_DISPATCH_ATTEMPTS) {
				throw new PromptDispatchError(`${label} dropped before provider dispatch after ${attempt} attempts`);
			}
			const deadline = AbortSignal.timeout(PROMPT_DISPATCH_IDLE_TIMEOUT_MS);
			try {
				await untilAborted(AbortSignal.any([abortSignal, deadline]), () => session.waitForIdle());
			} catch (err) {
				checkAbort();
				if (deadline.aborted) {
					throw new PromptDispatchError(`${label} dropped before provider dispatch; session did not become idle`);
				}
				throw err;
			}
			await untilAborted(abortSignal, () => Bun.sleep(250 * 2 ** (attempt - 1)));
		}
	};

	try {
		try {
			// An IRC wake may own the session when this turn dispatches. Its prompt
			// wins the race and this prompt throws AgentBusyError; back off through
			// the caller hook and retry. Bounded so a wedged worker still resolves
			// instead of hanging the batch.
			let promptAttempts = 0;
			for (;;) {
				try {
					await dispatchPrompt(task, { attribution: "agent", solutionSpace }, "initial prompt");
					break;
				} catch (error) {
					promptAttempts++;
					if (!(error instanceof AgentBusyError) || promptAttempts >= 3 || !onPromptBusy) throw error;
					await onPromptBusy();
				}
			}
			await awaitAbortable(session.waitForIdle());
		} catch (err) {
			// A budget stop or a yield turn-stop (terminal yield parked behind
			// the async quiescence barrier) cancels the free-running turn by
			// aborting the session, which can surface here as a rejected
			// prompt. Swallow it and drive the barrier/forced final yield
			// below; real caller/timeout aborts (monitor signal) and genuine
			// failures keep the old path.
			const recoverableStop = monitor.budgetStopRequested() || monitor.yieldTurnStopRequested();
			if (!recoverableStop || abortSignal.aborted || err instanceof PromptDispatchError) throw err;
		}

		const reminderToolChoice = buildNamedToolChoice("yield", session.model);

		const runYieldLadder = async (): Promise<void> => {
			let retryCount = 0;
			let retriesForced = false;
			while (!monitor.yieldCalled() && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
				// A budget stop collapses the reminder ladder to a single forced
				// final yield: wait for the stop's session abort to settle, then
				// prompt once with the wrap-up reminder + named tool choice.
				const budgetStop = monitor.budgetStopRequested();
				if (budgetStop) {
					retryCount = MAX_YIELD_RETRIES - 1;
					await monitor.waitForBudgetStop();
					if (monitor.yieldCalled() || abortSignal.aborted) break;
				}
				// Skip reminders when the model returned a terminal error (e.g.
				// rate-limit cap hit, auth failure). Re-prompting would just
				// hit the same wall, multiplying the failure noise without
				// any chance of producing a yield.
				const lastBeforeReminder = session.getLastAssistantMessage();
				if (lastBeforeReminder?.stopReason === "error") break;
				// A turn waiting on owner work is a scheduling pause. The outer
				// barrier settles that work before a reminder counts against it.
				if (!budgetStop && session.hasPendingAsyncWork()) break;
				try {
					retryCount++;
					const reminder = prompt.render(submitReminderTemplate, {
						retryCount,
						maxRetries: MAX_YIELD_RETRIES,
						budgetStop,
					});

					const isFinalRetry = retryCount >= MAX_YIELD_RETRIES;
					// Last chance: the next accepted yield ends the run, incremental
					// or not, so the pinned model cannot answer the pin forever.
					// Armed for this prompt's turn only — the quiescence barrier's
					// later notice turn may legitimately submit more sections.
					retriesForced = isFinalRetry;
					await dispatchPrompt(
						reminder,
						{
							attribution: "agent",
							synthetic: true,
							...(isFinalRetry && reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
						},
						"yield reminder",
						{ forceFinalYield: isFinalRetry },
					);
					await awaitAbortable(session.waitForIdle());
				} catch (err) {
					if (err instanceof PromptDispatchError) throw err;
					if (abortSignal.aborted || err instanceof ToolAbortError) {
						// Benign control-flow exit — user cancel (^C) or compaction aborting
						// pending operations both surface here as ToolAbortError. The outer
						// catch and finally already mark the run aborted; logging at ERROR
						// would spam operator dashboards with non-failures.
						logger.debug("Subagent prompt aborted");
					} else {
						logger.error("Subagent prompt failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				} finally {
					if (retriesForced) {
						retriesForced = false;
						monitor.markFinalYieldForced(false);
					}
				}
			}
		};

		// Yield ladder + quiescence barrier (structured concurrency), one
		// loop: a turn without a yield first settles pending owner work, then
		// spends reminders only after there is nothing left to wait for.
		// A yield also waits for quiescence; each delivered result supersedes
		// the previous yield and demands a fresh one.
		//
		// A final yield with owner background jobs still running or
		// undelivered is a scheduling pause, not run completion — the monitor
		// parks such a yield with a recoverable turn-stop instead of
		// terminating the run. Jobs are settled and their results folded into
		// the run as async-result follow-up turns; each delivered result
		// supersedes the yield it postdates, so the reminder ladder re-runs
		// to demand a fresh yield that accounts for it. Only a yield with no
		// pending owner work left is terminal — the isolation runner captures
		// and destroys the worktree right after this run resolves, so no
		// owner job that could still re-wake the session may outlive it.
		// Suppressed (acknowledged / wait-watched) jobs never re-wake the run
		// and are reaped at teardown.
		//
		// Before blocking on running jobs after a yield, tell the model ONCE
		// what it is waiting on so it can stand by or cancel the job. A turn
		// without a yield settles its pending jobs without an extra notice.
		// Runs that exhaust the ladder with no pending work, or hit a terminal
		// model error, skip the barrier; teardown reaps their jobs.
		let asyncPendingNoticeSent = false;
		while (!abortSignal.aborted) {
			if (!monitor.yieldCalled()) {
				await runYieldLadder();
				if (
					!monitor.yieldCalled() &&
					(monitor.budgetStopRequested() ||
						session.getLastAssistantMessage()?.stopReason === "error" ||
						!session.hasPendingAsyncWork())
				)
					break;
			}
			// Let the parked yield's turn-stop session abort settle before
			// prompting again (mirrors waitForBudgetStop).
			await awaitAbortable(monitor.waitForYieldTurnStop());
			if (!session.hasPendingAsyncWork()) {
				if (monitor.yieldCalled()) break;
				continue;
			}
			if (!monitor.yieldCalled()) {
				await awaitAbortable(session.settleAsyncWork());
				continue;
			}
			if (!asyncPendingNoticeSent) {
				asyncPendingNoticeSent = true;
				const running = session.getAsyncJobSnapshot()?.running ?? [];
				if (running.length > 0) {
					const jobs = running.map(job => `${job.id}${job.label ? ` (${job.label})` : ""}`).join(", ");
					const notice = prompt.render(subagentAsyncPendingTemplate, {
						count: running.length,
						multiple: running.length > 1,
						jobs,
					});
					try {
						await dispatchPrompt(notice, { attribution: "agent", synthetic: true }, "async-pending notice");
						await awaitAbortable(session.waitForIdle());
					} catch (err) {
						if (abortSignal.aborted || err instanceof ToolAbortError || err instanceof PromptDispatchError)
							throw err;
						// Other notice-turn failures leave the pending jobs to settle passively.
						logger.warn("Subagent async-pending notice failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
					// Re-evaluate: the notice turn may have cancelled, watched, or
					// absorbed the jobs — or already re-yielded.
					continue;
				}
			}
			await awaitAbortable(session.settleAsyncWork());
			// Results delivered during the settle invalidated the recorded
			// yield: the next iteration's ladder demands a fresh one.
		}

		if (!monitor.yieldCalled()) {
			await awaitAbortable(session.waitForIdle());
		}

		const lastAssistant = session.getLastAssistantMessage();
		if (lastAssistant) {
			if (lastAssistant.stopReason === "aborted") {
				if (!monitor.yieldCalled() || monitor.runtimeLimitExceeded()) {
					aborted = monitor.isAbortedRun();
					if (aborted) {
						// A real caller signal or the wall-clock timer carries a precise
						// reason (signal.reason / "runtime limit exceeded"). An internal
						// turn abort does NOT — prefer the assistant message's own
						// errorMessage ("Request was aborted" or a specific stream error)
						// over the misleading "Cancelled by caller".
						abortReasonText ??= monitor.hasExplicitAbortReason()
							? monitor.resolveAbortReasonText()
							: lastAssistant.errorMessage?.trim() || monitor.resolveAbortReasonText();
					}
					exitCode = 1;
				}
			} else if (lastAssistant.stopReason === "error") {
				exitCode = 1;
				error ??= attributeSubagentError(lastAssistant.errorMessage, lastAssistant);
			}
		}

		// A budget-stopped run that still produced no yield is a budget abort:
		// surface the precise reason instead of a generic missing-yield failure.
		if (!monitor.yieldCalled() && monitor.budgetStopRequested() && !aborted) {
			aborted = true;
			abortReasonText ??= monitor.resolveAbortReasonText();
			exitCode = 1;
		}

		// A recorded yield that async-result deliveries superseded and the
		// model never refreshed is stale: fail the run instead of letting the
		// parent act on a payload that predates the background job outcomes
		// the model was shown. The stale payload still ships through
		// finalizeSubprocessOutput's failed-after-yield path (exit 1 + stderr,
		// output preserved as salvage).
		if (monitor.yieldInvalidatedByAsync() && !abortSignal.aborted) {
			exitCode = 1;
			error ??=
				"Background job results arrived after the subagent's last yield; it did not submit a refreshed yield covering them.";
		}
	} catch (err) {
		if (abortSignal.aborted && monitor.yieldCalled() && !monitor.runtimeLimitExceeded()) {
			exitCode = 0;
		} else {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		}
	} finally {
		error ??= monitor.terminalError();
		if (abortSignal.aborted && (!monitor.yieldCalled() || monitor.runtimeLimitExceeded())) {
			aborted = monitor.isAbortedRun();
			if (aborted) {
				abortReasonText ??= monitor.resolveAbortReasonText();
			}
			if (exitCode === 0) exitCode = 1;
		}
	}

	return { exitCode, error, aborted, abortReasonText };
}

interface FinalizeRunArgs {
	monitor: SubagentRunMonitor;
	done: { exitCode: number; error?: string; aborted?: boolean; abortReason?: string; durationMs: number };
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	signal?: AbortSignal;
	artifactsDir?: string;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	/**
	 * This finalize is a revival/wake or explicit follow-up turn, not the initial
	 * run. Such turns only (re)write `<id>.md` when they produce a real `yield`
	 * result, so a conversational peer-message wake (which never yields) cannot clobber the
	 * completed run's artifact with a missing-yield warning body (issue #9518).
	 */
	followUpTurn?: boolean;
	sessionFile?: string;
	startTime: number;
}

/**
 * Turn a settled run into a {@link SingleResult}: resolve the yield payload via
 * {@link finalizeSubprocessOutput}, salvage cancelled-run output, write the
 * `<id>.md` output artifact, flush final progress, and emit the lifecycle end
 * event.
 */
async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
	const { monitor, done, index, id, agent, task, assignment, signal, modelOverride, modelRole } = args;
	const progress = monitor.progress;
	let exitCode = done.exitCode;
	let stderr = done.error ?? "";

	// Use final output if available, otherwise accumulated output
	let rawOutput = monitor.rawOutput();
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;
	// Breadcrumb the synchronous yield-payload shaping (O(rawOutput)) so a block
	// here is attributed to this subagent rather than logged as "unknown".
	pushLoopPhase(`subagent:${id}`);
	let finalized: FinalizeSubprocessOutputResult;
	try {
		finalized = finalizeSubprocessOutput({
			rawOutput,
			exitCode,
			stderr,
			doneAborted: Boolean(done.aborted),
			signalAborted: Boolean(signal?.aborted),
			yieldItems,
			outputSchema: args.outputSchema,
			outputSchemaMode: args.outputSchemaMode,
			outputSchemaSource: args.outputSchemaSource,
			lastAssistantText: monitor.lastReportTurnText(),
		});
	} finally {
		popLoopPhase();
	}
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	// Salvage for cancelled/aborted children that produced no completed output:
	// surface the last assistant text + stats instead of "(no output)" so the
	// parent doesn't redo work the child already finished.
	const salvageText = monitor.lastAssistantSalvageText();
	if (
		(done.aborted || signal?.aborted || monitor.runtimeLimitExceeded()) &&
		!rawOutput.trim() &&
		salvageText !== undefined
	) {
		rawOutput = `[cancelled after ${progress.requests} req, ${progress.tokens} tok — last activity: "${formatSalvageSnippet(salvageText)}"]`;
	}
	const lastYield = yieldItems?.[yieldItems.length - 1];
	const yieldAbortReason = lastYield?.status === "aborted" ? lastYield.error || "Subagent aborted task" : undefined;
	const { abortedViaYield, hasYield } = finalized;
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time).
	// Compute output metadata for agent:// URL integration.
	//
	// A revival/follow-up turn only (re)writes <id>.md when it produced a real
	// yield result. A subagent revived to answer a peer message never yields, so
	// writing here would overwrite the completed run's authoritative artifact with
	// a missing-yield warning body (issue #9518). The initial run is unaffected
	// (followUpTurn is unset), preserving the documented missing-yield artifact.
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (args.artifactsDir && (!args.followUpTurn || hasYield)) {
		const candidatePath = path.join(args.artifactsDir, `${id}.md`);
		try {
			await writeArtifact(candidatePath, rawOutput);
			outputPath = candidatePath;
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch (error) {
			logger.warn("Failed to persist subagent output artifact", {
				agentId: id,
				path: candidatePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const structured = finalized.structuredOutput;
		const sidecarPath = path.join(args.artifactsDir, `${id}.json`);
		if (outputPath && structured && Object.hasOwn(structured, "data")) {
			try {
				const serialized = JSON.stringify(structured.data, null, 2);
				// `structured.data === undefined` (an own "data" key holding
				// `undefined`) makes JSON.stringify return `undefined` too —
				// neither a write nor a removal, which would leave a stale
				// sidecar from an earlier turn answering agent://<id>/<field>
				// with superseded data (PR #10625 review).
				if (serialized !== undefined) await writeArtifact(sidecarPath, `${serialized}\n`);
				else await fs.rm(sidecarPath, { force: true });
			} catch (error) {
				logger.warn("Failed to persist subagent structured output sidecar", {
					agentId: id,
					path: sidecarPath,
					error: error instanceof Error ? error.message : String(error),
				});
				// A stale sidecar from an earlier turn must not outlive this
				// turn's <id>.md just because the replacement write failed —
				// agent://<id>/<field> would keep answering with superseded data.
				try {
					await fs.rm(sidecarPath, { force: true });
				} catch (rmError) {
					logger.warn("Failed to drop stale subagent structured output sidecar", {
						agentId: id,
						path: sidecarPath,
						error: rmError instanceof Error ? rmError.message : String(rmError),
					});
				}
			}
		} else if (outputPath) {
			// This turn republished <id>.md; a stale sidecar from an earlier
			// turn would keep answering agent://<id>/<field> with the
			// superseded payload, so it must not outlive its <id>.md.
			try {
				await fs.rm(sidecarPath, { force: true });
			} catch (error) {
				logger.warn("Failed to drop stale subagent structured output sidecar", {
					agentId: id,
					path: sidecarPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	// Update final progress. A wall-clock timeout always wins: if the runtime
	// limit fired we report aborted/failed regardless of whether a yield landed
	// while we were tearing the session down. The yield data is still surfaced
	// to the caller via `progress.extractedToolData`, but the exit status must
	// reflect the timeout so on-call doesn't mistake a stuck run for success.
	const runtimeLimitExceeded = monitor.runtimeLimitExceeded();
	if (runtimeLimitExceeded && exitCode === 0) {
		exitCode = 1;
	}
	const wasAborted =
		runtimeLimitExceeded || Boolean(done.aborted) || abortedViaYield || (!hasYield && Boolean(signal?.aborted));
	const finalAbortReason = wasAborted
		? runtimeLimitExceeded
			? monitor.resolveAbortReasonText()
			: done.aborted
				? (done.abortReason ?? monitor.resolveAbortReasonText())
				: abortedViaYield
					? yieldAbortReason
					: signal?.aborted
						? monitor.resolveSignalAbortReason()
						: monitor.resolveAbortReasonText()
		: undefined;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	monitor.scheduleProgress(true);

	// Emit lifecycle end event after finalization so yield status is reflected
	const settledPayload = {
		id,
		agent: agent.name,
		parentToolCallId: args.parentToolCallId,
		detached: args.detached,
		agentSource: agent.source,
		description: progress.description,
		status: progress.status as "completed" | "failed" | "aborted",
		sessionFile: args.sessionFile,
		index,
	};
	emitSubagentFrame(args.eventBus, args.subagentEventBus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, settledPayload);

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: progress.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		...(finalized.structuredOutput ? { structuredOutput: finalized.structuredOutput } : {}),
		durationMs: Date.now() - args.startTime,
		tokens: progress.tokens,
		requests: progress.requests,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		modelOverride,
		modelRole,
		resolvedModel: progress.resolvedModel,
		resolvedModelIdentity: progress.resolvedModelIdentity,
		resolvedThinkingLevel: progress.resolvedThinkingLevel,
		resolvedModelIsFallback: progress.resolvedModelIsFallback,
		resolvedModelRoute: progress.resolvedModelRoute,
		advisor: progress.advisor,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		usage: monitor.hasUsage() ? monitor.accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		retryFailure: progress.retryFailure,
		outputMeta,
	};
}

/** Inputs for {@link attachIrcWakeTurnMonitor}. */
export interface IrcWakeTurnMonitorOptions {
	/** Registry id of the kept-alive subagent whose autonomous IRC wake turns are monitored. */
	id: string;
	index?: number;
	agent: AgentDefinition;
	description?: string;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	parentToolCallId?: string;
	/** Fallback session file when the registry ref carries none. */
	sessionFile?: string;
	maxRuntimeMs?: number;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	artifactsDir?: string;
}

/** Sender + message id of one `irc:incoming` record that woke a turn. */
interface WakeSource {
	from: string;
	messageId?: string;
}

function wakeSources(records: AgentMessage[], selfId: string): WakeSource[] {
	const sources: WakeSource[] = [];
	for (const record of records) {
		if (record.role !== "custom") continue;
		const details = record.details && typeof record.details === "object" ? record.details : undefined;
		const from = details ? Reflect.get(details, "from") : undefined;
		if (typeof from !== "string" || from === selfId || sources.some(source => source.from === from)) continue;
		// Automated wake-turn relays are answers, not wake sources: relaying one
		// back would ping-pong two idle peers forever.
		if (details && Reflect.get(details, "wakeRelay") === true) continue;
		const messageId = details ? Reflect.get(details, "id") : undefined;
		sources.push({ from, messageId: typeof messageId === "string" ? messageId : undefined });
	}
	return sources;
}

/**
 * Hand a woken subagent's turn output to whoever woke it, when the subagent
 * did not answer them itself. A re-`yield` delivers the `<task-result>`
 * envelope (the artifact was just rewritten, so it carries the `agent://`
 * pointer); a plain turn delivers its final assistant text. Without this, a
 * recipients without a dedicated messaging tool can still answer a sender;
 * otherwise their re-yield silently
 * updates the artifact nobody is told to re-read.
 */
async function relayWakeTurnOutput(args: {
	id: string;
	records: AgentMessage[];
	turnStartTime: number;
	yielded: boolean;
	result: SingleResult | undefined;
	turnText: string;
	/** Short, attributed peer-visible error text (no stack) when the turn died on an error. */
	error: string | undefined;
	/** Whether the turn was aborted (runtime limit, cancellation, hard abort). */
	aborted: boolean;
	/** Reason text for an aborted turn, from {@link SubagentRunMonitor.resolveAbortReasonText}. */
	abortReason: string | undefined;
	/** A {@link finalizeRunResult} throw, so the waiter is notified instead of stranded. */
	finalizeError: unknown;
	/** Waker already receiving this turn's outcome as an async job delivery. */
	jobOwnerId: string | undefined;
}): Promise<void> {
	const bus = IrcBus.global();
	const sources = wakeSources(args.records, args.id);
	if (sources.length === 0) return;
	const failed = wakeTurnFailed(args);
	for (const source of sources) {
		if (source.from === args.jobOwnerId) continue;
		const alreadyMessaged = bus.sentSince(args.id, source.from, args.turnStartTime);
		// A completed turn's answer would duplicate what the agent already sent
		// this waker, so dedup stays. A failed/cancelled turn is a distinct
		// lifecycle fact: `sentSince` cannot tell "already answered you" from
		// "pinged you 'on it'", and suppressing the failure notice on a mere ping
		// strands the waker exactly as before — one message later. So the failure
		// lane always notifies, flavoured to acknowledge the earlier message.
		if (alreadyMessaged && !failed) continue;
		const body = buildWakeRelayBody({ ...args, alreadyMessaged });
		if (!body) continue;
		const receipt = await bus.send({
			from: args.id,
			to: source.from,
			body,
			replyTo: source.messageId,
			wakeRelay: true,
		});
		if (receipt.outcome === "failed") {
			logger.warn("IRC wake-turn relay failed", { from: args.id, to: source.from, error: receipt.error });
		}
	}
}

/** Whether a wake turn died on an error, a cancellation, or a finalization throw instead of completing. */
function wakeTurnFailed(outcome: { error: string | undefined; aborted: boolean; finalizeError: unknown }): boolean {
	return outcome.error !== undefined || outcome.aborted || outcome.finalizeError !== undefined;
}

/**
 * Body for a wake-turn relay, distinguishing the terminal outcomes a waiter
 * would otherwise see as the same generic "stopped without replying" note:
 * a real answer (yield summary or turn text), a provider failure carrying the
 * attributed `[provider/model] <error>`, a cancellation with its reason, a
 * finalization throw, or a turn that ran and produced nothing. A turn that
 * yielded an artifact before failing is reported via that artifact's summary
 * rather than contradicted with a "no output" claim; a partial-answer waker
 * (`alreadyMessaged`) is told the earlier message was not the answer. Every
 * non-answer notice carries a `history://<id>` pointer so the peer can inspect
 * the transcript. Exported for a focused contract test of the yielded-failure
 * branch, which the observer seam cannot drive.
 */
export function buildWakeRelayBody(args: {
	id: string;
	yielded: boolean;
	result: SingleResult | undefined;
	turnText: string;
	error: string | undefined;
	aborted: boolean;
	abortReason: string | undefined;
	finalizeError: unknown;
	alreadyMessaged: boolean;
}): string {
	const transcript = `See history://${args.id} for details.`;
	// Computed once, above the completed/failed split: a turn that yielded an
	// artifact before failing must be reported, never contradicted.
	const summary =
		args.yielded && args.result?.outputPath
			? formatTaskResultSummary(args.result, { totalDurationMs: args.result.durationMs })
			: undefined;

	const headline = args.error
		? `Wake turn failed: ${args.error}.`
		: args.aborted
			? `Wake turn was cancelled${args.abortReason?.trim() ? `: ${args.abortReason.trim()}` : ""}.`
			: undefined;
	if (headline) {
		if (summary) {
			return `${headline} A result was recorded before the turn ended:\n\n${summary}\n\n${transcript}`;
		}
		const context = args.alreadyMessaged
			? "You received a message earlier in this turn, but that was not the answer and nothing further was sent."
			: "No answer was produced.";
		return `${headline} ${context} ${transcript}`;
	}

	// Completed lane. `alreadyMessaged` completed turns were filtered upstream
	// (their answer would duplicate what the agent already sent).
	const answer = summary ?? args.turnText.trim();
	if (answer) return answer;
	if (args.finalizeError) {
		const message = args.finalizeError instanceof Error ? args.finalizeError.message : String(args.finalizeError);
		return `Wake turn failed to finalize: ${message}. No answer was produced. ${transcript}`;
	}
	return `Wake turn produced no output. ${transcript}`;
}

/** Extracts display text from an IRC/aside record's content, shared by the custom-role and
 *  user-role branches below (both fields share the same string | text-part-array shape). */
function extractIrcRecordText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

/**
 * Bracket a kept-alive subagent's undriven turns — autonomous IRC wakes and
 * user prompts from focused-session steering — with a task run monitor so
 * RPC/collab subscribers see the same `subagent_lifecycle` /
 * `subagent_progress` frames a first run emits, and an accepted yield rewrites
 * the artifact like a first run's. Shared by the live executor reviver and the
 * persisted cold-revive path so a resumed process's parked subagents are not
 * blind spots. The observer runs after the session has flushed its post-prompt
 * settle (see {@link AgentSession.setIrcWakeTurnObserver}).
 *
 * The turn's output reaches the parent as an async job when the parent's
 * message woke the turn or the turn yielded, and the other waking peers via
 * {@link relayWakeTurnOutput}; the relay is registered as a pending reply on
 * the session up front so a `send await:true` waiter holds its "stopped
 * without replying" verdict until the relay has been delivered.
 */
export function attachIrcWakeTurnMonitor(session: AgentSession, options: IrcWakeTurnMonitorOptions): void {
	const { id, agent } = options;
	const index = options.index ?? 0;
	const maxRuntimeMs = options.maxRuntimeMs ?? 0;
	session.setIrcWakeTurnObserver(records => {
		// Autonomous IRC wake turns reuse the session's YieldTool just like
		// runSubagentFollowUpTurn; clear the prior run's incremental-section flag
		// and retry counters so this wake turn's guards see only its own state.
		resetYieldTurnState(session.getToolByName("yield"));
		const ircTask =
			records
				.map(record => {
					if (record.role === "custom") {
						const body =
							record.details && typeof record.details === "object"
								? Reflect.get(record.details, "message")
								: undefined;
						if (typeof body === "string") return body;
						return extractIrcRecordText(record.content);
					}
					// User prompts: typed text, or the synthetic `.`/`c` continue directive.
					if (record.role === "user" || record.role === "developer") return extractIrcRecordText(record.content);
					return "";
				})
				.filter(Boolean)
				.join("\n\n") || "IRC follow-up";
		const turnStartTime = Date.now();
		const relay = Promise.withResolvers<void>();
		session.trackIrcReply(relay.promise);
		const sessionFile = AgentRegistry.global().get(id)?.sessionFile ?? options.sessionFile ?? undefined;
		// The parent receives this turn's outcome through an owner-routed job: the
		// ordinary async-result delivery, and what its `wait` blocks on. A turn
		// woken by the parent's own message is work the parent started, so the job
		// spans the whole turn. Otherwise only a yield is a completion the parent
		// must receive like the first run's, so the job registers the moment the
		// yield is accepted, before the ref goes idle.
		const ownerId = AgentRegistry.global().get(id)?.parentId;
		// Cancelling the job cancels the turn it stands for.
		const jobCancel = new AbortController();
		let wakeJob: { ownerId: string; outcome: PromiseWithResolvers<AsyncJobRunResult> } | undefined;
		const registerWakeJob = (): void => {
			if (wakeJob) return;
			const manager = session.asyncJobManager;
			if (!ownerId || !manager) return;
			const outcome = Promise.withResolvers<AsyncJobRunResult>();
			try {
				manager.register(
					"task",
					id,
					({ signal }) => {
						signal.addEventListener("abort", () => jobCancel.abort(signal.reason), { once: true });
						return untilAborted(signal, outcome.promise);
					},
					{ id, agentId: id, ownerId },
				);
				wakeJob = { ownerId, outcome };
			} catch (error) {
				logger.warn("IRC wake-turn job registration failed", {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		const turnMonitor = createSubagentRunMonitor({
			index,
			id,
			agent,
			task: ircTask,
			description: options.description,
			modelOverride: options.modelOverride,
			modelRole: options.modelRole,
			eventBus: options.eventBus,
			subagentEventBus: options.subagentEventBus,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			sessionFile,
			softRequestBudget: 0,
			softRequestBudgetNotice: false,
			maxRuntimeMs,
			// Autonomous wake turns answer a peer message; too short to probe.
			completionProbe: false,
			signal: jobCancel.signal,
			onYieldAccepted: registerWakeJob,
		});

		const startedPayload = {
			id,
			agent: agent.name,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			agentSource: agent.source,
			description: options.description,
			status: "started",
			sessionFile,
			index,
		} as const;
		emitSubagentFrame(options.eventBus, options.subagentEventBus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, startedPayload);

		turnMonitor.setActiveSession(session);
		const unsubscribeTurn = turnMonitor.attach(session);
		if (wakeSources(records, id).some(source => source.from === ownerId)) registerWakeJob();
		return async turnError => {
			unsubscribeTurn();
			const activeSession = turnMonitor.takeActiveSession();
			if (activeSession) turnMonitor.captureSalvage(activeSession);
			const lastAssistant = session.getLastAssistantMessage();
			const yielded = turnMonitor.yieldCalled();
			const runtimeLimitExceeded = turnMonitor.runtimeLimitExceeded();
			const aborted = runtimeLimitExceeded || (lastAssistant?.stopReason === "aborted" && !yielded);
			// Two error lanes. `error` carries full diagnostics (a thrown turn
			// error's stack) for `done.error`, logs, and lifecycle. `errorForPeer`
			// carries only the short, attributed message: a stack trace injected
			// into another agent's model context is noise, not signal.
			const providerError =
				lastAssistant?.stopReason === "error"
					? attributeSubagentError(lastAssistant.errorMessage, lastAssistant)
					: undefined;
			const thrown = providerError === undefined && turnError !== undefined && !yielded ? turnError : undefined;
			const error =
				providerError ??
				(thrown instanceof Error
					? thrown.stack || thrown.message
					: thrown === undefined
						? undefined
						: String(thrown));
			const errorForPeer =
				providerError ??
				(thrown instanceof Error ? thrown.message : thrown === undefined ? undefined : String(thrown));
			turnMonitor.finish();
			if (yielded) {
				// Acceptance boundary for an autonomous wake turn (#11079): the
				// turn's terminal yield is settled, so terminalize the ref here
				// even when the run-state mirror never delivers `idle`.
				AgentRegistry.global().markResultAccepted(id, session, turnMonitor.yieldAcceptedAt());
			}
			// Read before finalization: a schema-bearing agent that answered in
			// prose gets a missing-yield warning prepended to `result.output`.
			const turnText = turnMonitor.rawOutput() || (turnMonitor.lastAssistantSalvageText() ?? "");
			const abortReason = aborted ? turnMonitor.resolveAbortReasonText() : undefined;
			let result: SingleResult | undefined;
			let finalizeError: unknown;
			try {
				result = await finalizeRunResult({
					monitor: turnMonitor,
					done: {
						exitCode: aborted || error ? 1 : 0,
						error,
						aborted,
						abortReason,
						durationMs: Date.now() - turnStartTime,
					},
					index,
					id,
					agent,
					task: ircTask,
					modelOverride: options.modelOverride,
					modelRole: options.modelRole,
					outputSchema: options.outputSchema,
					outputSchemaMode: options.outputSchemaMode,
					outputSchemaSource: options.outputSchemaSource,
					artifactsDir: options.artifactsDir,
					eventBus: options.eventBus,
					subagentEventBus: options.subagentEventBus,
					parentToolCallId: options.parentToolCallId,
					detached: true,
					followUpTurn: true,
					sessionFile,
					startTime: turnStartTime,
				});
			} catch (caught) {
				finalizeError = caught;
				logger.warn("IRC subagent turn finalization failed", {
					id,
					error: caught instanceof Error ? caught.message : String(caught),
				});
			} finally {
				// Once registered, the wake job carries this turn's outcome to the
				// parent whatever it is: the yield result, the failure that
				// superseded it, or, for a turn that never yielded, the answer a
				// relay would have carried.
				if (wakeJob && yielded && result) {
					const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
					const structured = result.structuredOutput;
					if (result.aborted || result.exitCode !== 0 || result.error !== undefined) {
						wakeJob.outcome.reject(new AsyncJobError(text, structured));
					} else {
						wakeJob.outcome.resolve(structured ? { text, structured } : { text });
					}
				} else if (wakeJob && yielded) {
					const message = finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
					wakeJob.outcome.reject(new Error(`Wake turn of ${id} failed to finalize: ${message}`));
				} else if (wakeJob) {
					const outcome = { error: errorForPeer, aborted, finalizeError };
					const text = buildWakeRelayBody({
						...outcome,
						id,
						yielded,
						result,
						turnText,
						abortReason,
						alreadyMessaged: IrcBus.global().sentSince(id, wakeJob.ownerId, turnStartTime),
					});
					if (wakeTurnFailed(outcome)) wakeJob.outcome.reject(new Error(text));
					else wakeJob.outcome.resolve({ text });
				}
				// Unconditional: a failed, cancelled, empty, or even un-finalized
				// wake turn must still tell whoever woke it, or a `send await:true`
				// waiter mistakes a dead peer for a healthy-but-silent one.
				try {
					await relayWakeTurnOutput({
						id,
						records,
						turnStartTime,
						yielded,
						result,
						turnText,
						error: errorForPeer,
						aborted,
						abortReason,
						finalizeError,
						jobOwnerId: wakeJob?.ownerId,
					});
				} catch (relayError) {
					logger.warn("IRC wake-turn relay threw", {
						id,
						error: relayError instanceof Error ? relayError.message : String(relayError),
					});
				} finally {
					relay.resolve();
				}
			}
		};
	});
}

/**
 * Settle a subagent's registry lifecycle after a run: terminal teardown for
 * hard aborts, unregister for one-shot helpers, and idle + lifecycle adoption
 * for kept-alive agents. A soft-budget abort on a kept-alive, revivable agent
 * is treated as a self-inflicted stop rather than a kill — the agent stays
 * interrogable and resumable (IRC wake / revival).
 */
export async function finalizeSubagentLifecycle(args: {
	id: string;
	session: AgentSession;
	aborted: boolean;
	/** Which watchdog (if any) requested the abort; decides revivability. */
	abortKind?: AbortReason;
	keepAlive: boolean;
	isolated: boolean;
	agentIdleTtlMs: number;
	reviveSession: AgentReviver | null;
	cleanupDeadlineAt?: number;
	onCleanupDeferred?: (completion: Promise<void>) => void;
	onRelease?: () => Promise<void>;
}): Promise<void> {
	const registry = AgentRegistry.global();
	const ref = registry.get(args.id);
	const ownsRef = Boolean(ref && ref.session === args.session);
	const cleanupDeadlineAt = args.cleanupDeadlineAt ?? Date.now() + 5000;
	const disposeSession = async (): Promise<void> => {
		// On a graceful finish (e.g. a `yield`) the advisor's review of the final
		// turn was enqueued at turn end but may still be draining. Give it a
		// chance to land in the transcript before the runtime is torn down —
		// mirroring print mode's headless drain — bounded by the shared cleanup
		// deadline. Hard aborts skip this to keep kill teardown fast.
		if (!args.aborted) {
			args.session.prepareForHeadlessAdvisorDrain();
			await args.session.waitForAdvisorCatchup(Math.max(0, cleanupDeadlineAt - Date.now()));
		}
		const disposal = args.session.dispose();
		const remainingMs = Math.max(0, cleanupDeadlineAt - Date.now());
		try {
			await untilAborted(AbortSignal.timeout(remainingMs), () => disposal);
		} catch (error) {
			if (Date.now() >= cleanupDeadlineAt) {
				args.onCleanupDeferred?.(disposal);
				return;
			}
			logger.warn("Subagent session cleanup failed", {
				id: args.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const releaseOwnedResources = async (): Promise<void> => {
		try {
			await args.onRelease?.();
		} catch (error) {
			logger.warn("Subagent lifecycle resource cleanup failed", { id: args.id, error: String(error) });
		}
	};

	// A budget abort leaves a consistent session with its transcript on disk.
	// Manager shutdown also preserves the transcript, but disposes and unregisters
	// the process-local session. Caller signals, wall-clock timeouts, and internal
	// terminations are genuine kills and stay terminal.
	const resumableAbort = args.abortKind === "budget" && args.keepAlive && args.reviveSession !== null;
	if (args.aborted && !resumableAbort) {
		if (ref && ownsRef) {
			if (args.abortKind === "shutdown") {
				try {
					await AgentLifecycleManager.global().release(args.id, ref);
				} catch (error) {
					logger.warn("runSubagent: failed to release session during manager shutdown", {
						id: args.id,
						error: String(error),
					});
					await disposeSession();
					registry.unregister(args.id, ref);
				}
			} else {
				// Route hard kills through the lifecycle owner so the terminal
				// decision is durable and a restart cannot rediscover the transcript
				// as a revivable parked agent.
				try {
					await AgentLifecycleManager.global().release(args.id, ref, { tombstone: true });
				} catch (error) {
					logger.warn("runSubagent: failed to persist kill tombstone", { id: args.id, error: String(error) });
					registry.setStatus(args.id, "aborted", ref);
					registry.detachSession(args.id, ref);
					await disposeSession();
				}
			}
		} else {
			await disposeSession();
		}
		await releaseOwnedResources();
		return;
	}

	if (!args.keepAlive) {
		// One-shot helper: dispose and unregister. No IRC, no revival.
		await disposeSession();
		if (ref && ownsRef) registry.unregister(args.id, ref);
		await releaseOwnedResources();
		return;
	}

	// Keep-alive: finished and failed subagents both stay interrogable.
	// The lifecycle manager owns idle-TTL parking + revival from here on.
	if (!ref || !ownsRef || !registry.setStatus(args.id, "idle", ref)) {
		await disposeSession();
		await releaseOwnedResources();
		return;
	}
	AgentLifecycleManager.global().adopt(
		args.id,
		{
			idleTtlMs: args.agentIdleTtlMs,
			revive: args.reviveSession ?? undefined,
			onRelease: args.onRelease,
		},
		ref,
	);
}

/** Options for {@link runSubagentFollowUpTurn}. */
export interface FollowUpTurnOptions {
	/** Registry id of the (live or parked) subagent to continue. */
	id: string;
	/** Agent definition the session was originally spawned with (drives progress labels + finalize). */
	agent: AgentDefinition;
	/** The follow-up message; sent as the turn's user prompt. */
	message: string;
	index?: number;
	description?: string;
	/** Explicit pre-expansion model role alias retained from the original run. */
	modelRole?: string;
	/** Structured-output state retained from the original invocation. */
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	parentToolCallId?: string;
	/**
	 * When set, a turn that produces a `yield` result (re)writes `<artifactsDir>/<id>.md`
	 * so `agent://<id>` tracks the latest completion. A yield-less turn (e.g. a peer-message
	 * wake answering a message) leaves the existing artifact intact (issue #9518).
	 */
	artifactsDir?: string;
	/** Wall-clock cap in ms for this turn; 0 disables. */
	maxRuntimeMs?: number;
	/** Periodically ask for a completion estimate during this turn; see {@link isCompletionProbeEnabled}. */
	completionProbe?: boolean;
	/** Workpool items accepted by the child yield tool during this turn. */
	workPoolYieldItems?: WorkPoolYieldItem[];
}

/**
 * Continue a previously spawned (keep-alive) subagent with one more monitored
 * turn: revive it if parked, send `message` as a real prompt, drive it to
 * `yield`, and finalize a {@link SingleResult} exactly like a first run.
 *
 * The session's full conversation history is retained (live session, or JSONL
 * replay through the lifecycle reviver), so the turn sees all prior context.
 * Unlike {@link runSubprocess}, the session is NOT torn down afterwards — it
 * stays adopted by the {@link AgentLifecycleManager} (idle → TTL park →
 * revive), and an aborted turn only aborts the in-flight turn.
 */
export async function runSubagentFollowUpTurn(options: FollowUpTurnOptions): Promise<SingleResult> {
	const { id, agent, message, signal } = options;
	const index = options.index ?? 0;
	const startTime = Date.now();
	let session = await AgentLifecycleManager.global().ensureLive(id);
	// Acquire turn ownership before mutating the shared yield contract: installing
	// pooled items under a running ordinary wake would reject its in-flight tool
	// calls. The check-to-install section below has no await, so once idle is
	// observed no wake dispatch can interleave before the synchronous mutation.
	// Bounded: a worker that never settles fails its batch instead of installing
	// under the active turn or hanging the pool.
	let ownershipWaits = 0;
	const acquireOwnership = async (): Promise<void> => {
		while (session.isStreaming && ownershipWaits < 3) {
			ownershipWaits++;
			if (signal) {
				await untilAborted(signal, () => session.waitForIdle());
			} else {
				await session.waitForIdle();
			}
		}
		if (session.isStreaming) {
			throw new Error(
				`Subagent ${id} stayed busy through 3 ownership waits; refusing to install the pooled yield contract under an active turn`,
			);
		}
	};
	await acquireOwnership();
	// Revalidate until the worker survives an install round-trip unchanged: the
	// waits/rebuild above can outlast the idle TTL, letting park() detach this
	// instance mid-install. Each observed replacement means another full park
	// cycle, so reinstall on the fresh session (a revival restores only the last persisted contract) and check
	// again; genuine churn fails fast instead of driving a stale instance, and
	// a released worker throws instead of driving a corpse. A replacement may
	// already be streaming a wake, so ownership is reacquired every round.
	for (let acquireAttempts = 0; ; acquireAttempts++) {
		await session.setWorkPoolYieldItems(options.workPoolYieldItems ?? []);
		const live = await AgentLifecycleManager.global().ensureLive(id);
		if (live === session) break;
		if (acquireAttempts >= 2) {
			throw new Error(
				`Subagent ${id} was replaced during every install attempt; refusing to drive a stale worker session`,
			);
		}
		session = live;
		await acquireOwnership();
	}
	// A kept-alive session reuses its YieldTool across turns; clear the prior
	// run's incremental-section flag and retry counters so this turn's guards
	// evaluate against its own state, not stale accumulators.
	resetYieldTurnState(session.getToolByName("yield"));
	const ref = AgentRegistry.global().get(id);
	const sessionFile = ref?.sessionFile ?? undefined;

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task: message,
		description: options.description,
		modelRole: options.modelRole,
		signal,
		onProgress: options.onProgress,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: options.maxRuntimeMs ?? 0,
		completionProbe: options.completionProbe ?? false,
	});

	const startedPayload = {
		id,
		agent: agent.name,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		agentSource: agent.source,
		description: options.description,
		status: "started",
		sessionFile,
		index,
	} as const;
	emitSubagentFrame(options.eventBus, options.subagentEventBus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, startedPayload);

	monitor.setActiveSession(session);
	// The batch monitor attaches per attempt; the hook below detaches before each
	// backoff and reattaches for the retry, so the teardown always releases the
	// current attempt — including when the drive rejects and no winning attempt
	// was ever assigned.
	let outcome: DriveOutcome;
	// An IRC wake may own the session when this turn dispatches. drive retries the
	// initial prompt through this hook: detach first so the wake turn's `yield`
	// neither marks this batch yielded nor leaks into its result, restore the
	// ordinary contract so the wake cannot consume pooled items, wait it out,
	// then reinstall and reattach for the retry.
	let attemptUnsubscribe = monitor.attach(session);
	try {
		outcome = await driveSessionToYield(session, monitor, message, {
			onPromptBusy: async () => {
				attemptUnsubscribe();
				logger.debug("Subagent follow-up lost the prompt race to an IRC wake; backing off", { id });
				await session.setWorkPoolYieldItems([]);
				if (signal) {
					await untilAborted(signal, () => session.waitForIdle());
				} else {
					await session.waitForIdle();
				}
				resetYieldTurnState(session.getToolByName("yield"));
				await session.setWorkPoolYieldItems(options.workPoolYieldItems ?? []);
				attemptUnsubscribe = monitor.attach(session);
			},
		});
		if (monitor.yieldCalled()) {
			// A follow-up turn's accepted yield is the run's final result too:
			// terminalize the ref here, not just on the initial run (#11079).
			AgentRegistry.global().markResultAccepted(id, session, monitor.yieldAcceptedAt());
		}
	} finally {
		try {
			await untilAborted(AbortSignal.timeout(5000), () => monitor.waitForActiveSessionAbort());
		} catch {
			// Ignore abort cleanup timeouts; the session stays adopted either way.
		}
		attemptUnsubscribe();
		const active = monitor.takeActiveSession();
		if (active) monitor.captureSalvage(active);
		monitor.finish();
	}

	return finalizeRunResult({
		monitor,
		done: { ...outcome, abortReason: outcome.abortReasonText, durationMs: Date.now() - startTime },
		index,
		id,
		agent,
		task: message,
		modelRole: options.modelRole,
		outputSchema: options.outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		followUpTurn: true,
		sessionFile,
		startTime,
	});
}

/** Inputs of a subagent's rendered system prompt, fixed at spawn. */
interface SubagentPromptInputs {
	id: string;
	sourceSession?: string;
	model?: string;
	agentSystemPrompt: string;
	context: string;
	planReference: string;
	planReferencePath: string;
	worktree: string;
	outputSchema: unknown;
	outputSchemaOverridesAgent: boolean;
	ircEnabled: boolean;
	/** Root resolved by the latest roster ensure; peer rows render scoped to it, so a session switch hides stale parked trees. */
	ircRoot: { sessionFile?: string };
}

/**
 * The spawn-time inputs of a subagent session. The live run and the lifecycle reviver both build
 * their {@link createAgentSession} options from it, so the reviver retains this plain capture
 * rather than the spawning run's options, monitor, abort signals, progress sinks or settings.
 */
interface SubagentSessionSpec {
	options: Omit<
		CreateAgentSessionOptions,
		| "settings"
		| "sessionManager"
		| "expectedAgentRef"
		| "systemPrompt"
		| "resolveServiceTierByFamily"
		| "onFirstChatDispatch"
	>;
	/** Explicit source-fork capability; independent of the optional prompt label. */
	seanceFork: boolean;
	prompt: SubagentPromptInputs;
}

/** Launch-only session inputs: a revived session restores these from its transcript or goes without. */
interface SubagentLaunchInputs {
	workPoolYieldItems: readonly WorkPoolYieldItem[];
	resolveServiceTierByFamily?: CreateAgentSessionOptions["resolveServiceTierByFamily"];
	onFirstChatDispatch?: () => void;
}

/** Names of the child's explicitly supplied tools; they win over same-named MCP proxies on every rebind. */
function explicitSubagentToolNames(spec: SubagentSessionSpec): ReadonlySet<string> {
	return new Set((spec.options.customTools ?? []).map(tool => tool.name));
}

function buildSubagentSessionOptions(
	spec: SubagentSessionSpec,
	settings: Settings,
	sessionManager: SessionManager,
	expectedAgentRef: CreateAgentSessionOptions["expectedAgentRef"],
	launch?: SubagentLaunchInputs,
): CreateAgentSessionOptions {
	const inputs = spec.prompt;
	const seance = spec.seanceFork;
	// MCP proxies are minted per build, not captured in the spec: a kept-alive
	// subagent revived after `/mcp reload` must see the manager's current tools.
	const mcpTools = !seance && spec.options.mcpManager ? createMCPProxyTools(spec.options.mcpManager) : [];
	const customTools = seance ? [] : (spec.options.customTools ?? []);
	return {
		...spec.options,
		mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
		customTools: customTools.length > 0 ? customTools : undefined,
		settings,
		sessionManager,
		expectedAgentRef,
		resolveServiceTierByFamily: launch?.resolveServiceTierByFamily,
		onFirstChatDispatch: launch?.onFirstChatDispatch,
		...(seance ? seanceIsolationOptions() : undefined),
		systemPrompt: defaultPrompt => {
			const ircRoster = inputs.ircEnabled
				? collectIrcPeerRoster(AgentRegistry.global(), inputs.id, inputs.ircRoot.sessionFile)
				: undefined;
			const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
				agent: inputs.agentSystemPrompt,
				context: inputs.context,
				planReference: inputs.planReference,
				planReferencePath: inputs.planReferencePath,
				worktree: inputs.worktree,
				outputSchema: inputs.outputSchema,
				outputSchemaOverridesAgent: inputs.outputSchemaOverridesAgent,
				// Read the live item set through the registry instead of capturing the session, which
				// would pin its whole graph past park. A revive builds while the registry session is
				// null, so it renders the cleared set rather than the launch-time pooled instructions.
				workPoolYieldItems:
					AgentRegistry.global().get(inputs.id)?.session?.getWorkPoolYieldItems?.() ??
					launch?.workPoolYieldItems ??
					[],
				ircPeers: ircRoster?.peers ?? [],
				ircParkedCount: ircRoster?.parkedCount ?? 0,
				ircOmittedCount: ircRoster?.omittedCount ?? 0,
				ircSelfId: inputs.ircEnabled ? inputs.id : "",
			});
			// Per-spawn text (context, worktree, IRC roster) goes after the trailing
			// `<project-context>` block so spawns of the same agent share the static
			// prompt prefix as a cache hit.
			const seancePrompt = inputs.sourceSession
				? prompt.render(seanceAssignmentTemplate, {
						sourceSession: inputs.sourceSession,
						model: inputs.model ?? "",
					})
				: undefined;
			return [...defaultPrompt, subagentPrompt, ...(seancePrompt ? [seancePrompt] : [])];
		},
	};
}

/** Re-resolves the IRC roster root a subagent's prompt scopes its peer rows to. */
async function refreshSubagentIrcRoot(
	inputs: SubagentPromptInputs,
	sessionManager: SessionManager,
	sessionFile: string | null,
): Promise<void> {
	if (!inputs.ircEnabled) return;
	const registry = AgentRegistry.global();
	inputs.ircRoot.sessionFile = await ensurePersistedRoster(
		registry,
		sessionManager.getSessionFile() ??
			sessionFile ??
			registry.get(inputs.id)?.sessionFile ??
			registry.get(MAIN_AGENT_ID)?.sessionFile,
	);
}

/** Recipe for a subagent's settings overlay: its parent plus the overlay's own writes. */
interface SubagentSettingsRecipe {
	parent: Settings;
	layers: OverlayLayers;
	rootThresholds: RootCompactionThresholds | undefined;
}

function captureSubagentSettings(parent: Settings, settings: SubagentChainSettings): SubagentSettingsRecipe {
	return { parent, layers: settings.overlayLayers(), rootThresholds: settings[kRootCompactionThresholds] };
}

function restoreSubagentSettings(recipe: SubagentSettingsRecipe): Settings {
	const settings: SubagentChainSettings = recipe.parent.restoreOverlay(recipe.layers);
	settings[kRootCompactionThresholds] = recipe.rootThresholds;
	return settings;
}

/** Everything the lifecycle reviver of a kept-alive subagent needs, captured explicitly. */
interface WarmReviveCapture {
	sessionFile: string;
	spec: SubagentSessionSpec;
	/** Re-captured whenever the live session is disposed, so a revive restores its latest settings writes. */
	settings: SubagentSettingsRecipe;
	parentArtifactManager: ArtifactManager | undefined;
	/** Todos are parent-owned and stripped from subagents, except under prewalk (its todo gate needs them). */
	keepTodo: boolean;
	wake: IrcWakeTurnMonitorOptions;
	/** Exact agent name the live `task.agentAccountPools` entry is looked up by on revive. */
	agentName: string;
}

/** Keeps `capture.settings` current with `session`'s overlay writes until the session is disposed. */
function trackSubagentSettings(session: AgentSession, capture: WarmReviveCapture): void {
	const parent = capture.settings.parent;
	session.addDisposer(() => {
		capture.settings = captureSubagentSettings(parent, session.settings);
	});
}

/**
 * Lifecycle reviver for a parked subagent: park closed the JSONL writer, so reopening takes the
 * single-writer lock cleanly and restores the full message history (createAgentSession →
 * agent.replaceMessages). Isolated runs keep their worktree for the same lifecycle, so they use
 * this path too. Built at module scope and handed nothing but `capture`: JSC keeps an enclosing
 * function's `arguments` reachable from its arrow closures, so any extra parameter would be pinned.
 */
function createWarmSubagentReviver(capture: WarmReviveCapture): AgentReviver {
	return async expectedAgentRef => {
		const { id } = capture.spec.prompt;
		const reopened = await SessionManager.open(capture.sessionFile, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		if (!hasConversationalHistory(reopened.getEntries())) {
			await reopened.close();
			throw new Error(
				`Cannot revive subagent "${id}": session file "${capture.sessionFile}" has no message history ` +
					`(truncated to header/session_init). The agent was not revived.`,
			);
		}
		if (capture.parentArtifactManager) {
			reopened.adoptArtifactManager(capture.parentArtifactManager);
		}
		await refreshSubagentIrcRoot(capture.spec.prompt, reopened, capture.sessionFile);
		const mcpManager = capture.spec.options.mcpManager;
		const mcpFollower = mcpManager ? followMCPTools(mcpManager, explicitSubagentToolNames(capture.spec)) : undefined;
		let revived: AgentSession;
		// Account pools are owner policy: take the live exact-name entry, as
		// dispatch and persisted revival do, never the spawn-time copy.
		const agentAccountPools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(capture.settings.parent));
		try {
			({ session: revived } = await createAgentSession({
				...buildSubagentSessionOptions(
					capture.spec,
					restoreSubagentSettings(capture.settings),
					reopened,
					expectedAgentRef,
				),
				oauthAccountPools: Object.hasOwn(agentAccountPools, capture.agentName)
					? agentAccountPools[capture.agentName]
					: undefined,
			}));
		} catch (error) {
			mcpFollower?.dispose();
			throw error;
		}
		mcpFollower?.bind(revived);
		trackSubagentSettings(revived, capture);
		// Re-run the executor's extension wiring on the rebuilt session. Skipping it leaves the
		// runner pre-init, so a `tool_call` handler touching a runtime action trips the
		// fail-closed gate and blocks every tool (including `yield`) in the revived agent (issue #8824).
		await initializeExtensions(revived, {
			reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
			reportRuntimeError: err => logger.error("Extension error", { path: err.extensionPath, error: err.error }),
			filterActiveTools: toolNames => (capture.keepTodo ? toolNames : toolNames.filter(name => name !== "todo")),
		});
		AgentRegistry.global().syncSessionStatus(id, revived);
		attachIrcWakeTurnMonitor(revived, capture.wake);
		return revived;
	};
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		modelRole,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const cleanupGraceMs = options.cleanupGraceMs ?? TASK_ABORT_CLEANUP_GRACE_MS;
	const startTime = Date.now();
	// Set by the session's onFirstChatDispatch hook the first time the agent
	// loop dispatches a chat request to the provider — the launch-complete boundary.
	let firstChatDispatchAt: number | undefined;

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Cancelled before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
			modelOverride,
			modelRole,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	// Per-agent advisor: the agent definition's `advisor` frontmatter or the
	// `task.agentAdvisor` settings override (agent name → "on"/"off"/model
	// pattern) pairs the spawned session with an advisor. Subagents default to
	// no advisor (createSubagentSettings forces `advisor.enabled` off); an
	// explicit model pattern is expanded against this owner's roles (a nested
	// spawn's owner is its parent subagent) and lands on the child's
	// `modelRoles.advisor`. The expanded pattern is also what the session
	// contract persists, so cold revival under root settings reuses it.
	const advisorSelection = options.sourceSession
		? undefined
		: resolveAgentAdvisorSelection({
				settingsOverride: cfgTaskAgentAdvisor.get(settings)[agent.name],
				agentAdvisor: agent.advisor,
			});
	const advisorRolePattern = advisorSelection?.model
		? resolveAgentAdvisorRolePattern(advisorSelection.model, settings)
		: undefined;
	const subagentSettings = createSubagentSettings(
		settings,
		{
			...compactionThresholdSettings(options.compactionThresholdOverride),
			...(agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
			// Isolated runs must not expose roots outside the worktree.
			...(worktree !== undefined ? { "workspace.additionalDirectories": [] } : undefined),
			...(advisorSelection ? { "advisor.enabled": true } : undefined),
			...(advisorRolePattern
				? { modelRoles: { ...settings.getModelRoles(), advisor: advisorRolePattern } }
				: undefined),
		},
		options.parentServiceTier,
	);
	const maxRecursionDepth = cfgTaskMaxRecursionDepth.get(settings);
	const maxRuntimeMs = Math.max(0, Math.trunc(Number(options.maxRuntimeMs ?? cfgTaskMaxRuntimeMs.get(settings)) || 0));
	// TTL before an adopted idle subagent is parked by the lifecycle manager.
	// <= 0 disables parking (the session stays live until process teardown).
	const agentIdleTtlMs = Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(settings)) || 0);
	const configuredDefaultBudget = Math.max(0, Math.trunc(Number(cfgTaskSoftRequestBudget.get(settings)) || 0));
	const softRequestBudget = resolveSoftRequestBudget(agent.name, configuredDefaultBudget);
	const softRequestBudgetNotice = cfgTaskSoftRequestBudgetNotice.get(settings);
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const restrictToolNames = options.sourceSession !== undefined || options.restrictToolNames === true;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	if (toolNames?.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as ToolSession);
		const expanded = toolNames.filter(name => name !== "exec");
		if (backends.python || backends.js) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}
	// Agents that can start background work (`task`, `bash`) need `wait` to block on it;
	// without it they `sleep`. Runs after `exec` expansion and the max-depth `task` strip.
	// `createTools` still drops it when no wake source (async/IRC/services) is enabled.
	// Restricted sessions own their explicit list and are never widened.
	if (
		toolNames &&
		!restrictToolNames &&
		!toolNames.includes("wait") &&
		(toolNames.includes("task") || toolNames.includes("bash"))
	) {
		toolNames = [...toolNames, "wait"];
	}
	// Inbound steering works without messaging; outbound peer coordination requires write.
	const ircEnabled =
		!restrictToolNames &&
		options.enableIrc !== false &&
		isIrcEnabled(subagentSettings, childDepth) &&
		(toolNames === undefined || toolNames.includes("write"));

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = options.sourceSession ? false : (enableLsp ?? true);
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("eval");

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task,
		assignment,
		description: options.description,
		modelRegistry: options.modelRegistry,
		settings,
		modelOverride,
		modelRole,
		modelRoute: options.modelRoute,
		signal,
		onProgress,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
		completionProbe: isCompletionProbeEnabled(settings, parentDepth),
	});
	const progress = monitor.progress;
	let unsubscribe: (() => void) | null = null;
	let registryAbortUnsubscribe: (() => void) | null = null;
	let reviveSession: AgentReviver | null = null;
	let pendingSessionManager: Promise<SessionManager> | undefined;
	let openedSessionManager: SessionManager | undefined;
	let untrackedSession: AgentSession | undefined;
	let pendingSessionDisposal: Promise<void> | undefined;
	const wakeOptions: IrcWakeTurnMonitorOptions = {
		id,
		index,
		agent,
		description: options.description,
		modelOverride,
		modelRole,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		parentToolCallId: options.parentToolCallId,
		sessionFile: subtaskSessionFile,
		maxRuntimeMs,
		outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		artifactsDir:
			options.sourceSession && subtaskSessionFile
				? subtaskSessionFile.slice(0, -".jsonl".length)
				: options.artifactsDir,
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		const abortSignal = monitor.abortSignal;
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				throw new ToolAbortError();
			}
		};
		const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
			checkAbort();
			const { promise: abortPromise, reject } = Promise.withResolvers<never>();
			const onAbort = () => {
				try {
					checkAbort();
				} catch (err) {
					reject(err);
				}
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([promise, abortPromise]);
			} finally {
				abortSignal.removeEventListener("abort", onAbort);
			}
		};
		// Launch-latency phase marks (performance.now()); read by the debug log
		// emitted before this closure returns. Left undefined when setup throws
		// before reaching the phase, which itself localizes the cost.
		const perfStart = performance.now();
		let resolvedAt: number | undefined;
		let sessionOpenedAt: number | undefined;
		let sessionCreatedAt: number | undefined;
		let readyAt: number | undefined;

		try {
			checkAbort();
			// Pin authStorage to modelRegistry.authStorage — mirrors the createAgentSession invariant.
			const registryFromParent = options.modelRegistry !== undefined;
			const modelRegistry =
				options.modelRegistry ??
				new ModelRegistry(options.authStorage ?? (await awaitAbortable(discoverAuthStorage())));
			const authStorage = modelRegistry.authStorage;
			if (options.authStorage && options.authStorage !== authStorage) {
				throw new Error(
					"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
				);
			}
			checkAbort();
			if (!registryFromParent) {
				modelRegistry.refreshInBackground();
			} else {
				logger.debug("runSubagent: reusing parent modelRegistry; skipping refresh");
			}
			checkAbort();

			const configuredModelPatterns = resolveConfiguredModelPatterns(modelPatterns, settings);
			const inheritedRetryFallbackChain =
				configuredModelPatterns.length === 1
					? resolveSubagentInheritedRetryFallbackChain(
							subagentSettings,
							modelRegistry,
							modelRole ?? resolveExplicitModelRole(modelPatterns, subagentSettings),
						)
					: undefined;
			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed,
				warning: modelResolutionWarning,
			} = await awaitAbortable(
				resolveModelOverrideWithAuthFallback(
					modelPatterns,
					options.parentActiveModelPattern,
					modelRegistry,
					settings,
					id,
				),
			);
			if (modelResolutionWarning) {
				logger.warn("Subagent model resolution warning", {
					warning: modelResolutionWarning,
					requested: modelPatterns,
				});
			}
			if (authFallbackUsed && model) {
				logger.warn("Subagent model has no working credentials; falling back to parent session model", {
					requested: modelPatterns,
					parentModel: options.parentActiveModelPattern,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
				});
			}
			// The exact-name `task.agentServiceTierOverrides` entry dispatch resolved
			// for this agent. The session evaluates it against its final model —
			// including patterns only it can resolve — so a concrete tier lands on
			// exactly that model's family, and persists the result (even empty) so
			// hot and cold revival restore it instead of re-deriving `tier.subagent`.
			const serviceTierOverride = options.serviceTierOverride;
			const resolveServiceTierByFamily =
				serviceTierOverride === undefined
					? undefined
					: (resolvedModel: Model | undefined) =>
							resolveAgentServiceTierOverride(
								serviceTierOverride,
								resolvedModel,
								inheritedSubagentServiceTiers(settings, options.parentServiceTier),
							);
			const retryFallbackRole = installSubagentRetryFallbackChain({
				settings: subagentSettings,
				id,
				candidates: resolveSubagentRetryFallbackCandidates(modelPatterns, modelRegistry, subagentSettings),
				inheritedFallbackChain: inheritedRetryFallbackChain,
				model,
				authFallbackUsed,
			});
			if (retryFallbackRole) {
				logger.debug("Configured subagent runtime model fallback chain", {
					role: retryFallbackRole,
					requested: modelPatterns,
				});
			}
			if (model?.contextWindow && model.contextWindow > 0) {
				progress.contextWindow = model.contextWindow;
			}
			// Caller-requested coarse effort maps onto the resolved model's
			// supported range, then respects the operator-configured ceiling.
			// Undefined (no effort, or no controllable effort surface) falls
			// through to the normal selectors below.
			// The ceiling outlives initial resolution: it rides into the session so
			// retry-fallback recovery can never clamp effort back up past it.
			const spawnEffortCeiling = options.effort !== undefined ? cfgTaskMaxEffort.get(settings) : undefined;
			const effortLevel =
				options.effort !== undefined
					? resolveTaskEffortLevel(model, options.effort, spawnEffortCeiling)
					: undefined;
			if (model) {
				const displayLevel = effortLevel ?? (explicitThinkingLevel ? resolvedThinkingLevel : undefined);
				progress.resolvedModelIdentity = formatModelStringWithRouting(model);
				progress.resolvedThinkingLevel = displayLevel;
				progress.resolvedModel =
					displayLevel !== undefined
						? formatModelSelectorValue(progress.resolvedModelIdentity, displayLevel)
						: progress.resolvedModelIdentity;
			}
			// Precedence: caller `effort` > explicit `:level` suffix on the resolved
			// model pattern > agent-definition default (e.g. task's `auto`) >
			// pattern-derived level.
			const effectiveThinkingLevel =
				effortLevel ?? (explicitThinkingLevel ? resolvedThinkingLevel : (thinkingLevel ?? resolvedThinkingLevel));
			resolvedAt = performance.now();
			const effectiveCwd = worktree ?? cwd;
			if (options.sourceSession && !subtaskSessionFile) {
				throw new Error("The seance fork requires a persisted child session file.");
			}
			const sessionManagerPromise = options.sourceSession
				? SessionManager.forkFrom(options.sourceSession, effectiveCwd, undefined, undefined, {
						sessionFile: subtaskSessionFile!,
						resetInheritedCost: true,
						repairInterruptedTail: true,
						suppressBreadcrumb: true,
						neutralizeInheritedSessionInit: true,
					})
				: sessionFile
					? SessionManager.open(sessionFile, undefined, undefined, {
							initialCwd: effectiveCwd,
							parentSession: options.sessionFile ?? undefined,
							suppressBreadcrumb: true,
						})
					: Promise.resolve(SessionManager.inMemory(effectiveCwd));
			pendingSessionManager = sessionManagerPromise;
			// Setup below can fail before this promise's consumption boundary.
			// Observe rejection immediately while preserving it for the later await.
			sessionManagerPromise.catch(() => {});
			// Per-agent prewalk: the agent definition's `prewalk` frontmatter or the
			// `task.agentPrewalk` settings override hands the subagent off to a
			// fast/cheap target at its first edit/write — the same mechanism as the
			// session-level --prewalk. The bundled generic `task` agent has no
			// frontmatter default; the `task.prewalk` toggle (default off) arms it.
			// Resolution failures skip prewalk instead of failing the spawn.
			let prewalk: Prewalk | undefined;
			const prewalkPattern = options.sourceSession
				? undefined
				: resolveAgentPrewalkPattern({
						settingsOverride: cfgTaskAgentPrewalk.get(settings)[agent.name],
						agentPrewalk: resolveAgentPrewalkDefault(agent, cfgTaskPrewalk.get(settings)),
					});
			if (prewalkPattern) {
				await awaitAbortable(modelRegistry.awaitBackgroundRefresh());
				const resolvedPrewalk = resolveModelOverride([prewalkPattern], modelRegistry, settings);
				const target = resolvedPrewalk.model;
				if (!target || !modelRegistry.hasConfiguredAuth(target)) {
					logger.warn("Subagent prewalk target unavailable; skipping prewalk", {
						agent: agent.name,
						pattern: prewalkPattern,
						warning: resolvedPrewalk.warning,
					});
				} else if (prewalkWouldBeNoop(model, effectiveThinkingLevel, target, resolvedPrewalk.thinkingLevel)) {
					// Same model AND same effective thinking level: switching would only
					// inject the plan/checklist nudges for no gain — skip. An effort-only
					// delta on the same model still arms (it is a real cheapening hand-off).
					logger.debug("Subagent prewalk target matches starting model and thinking level; skipping prewalk", {
						agent: agent.name,
						pattern: prewalkPattern,
					});
				} else {
					prewalk = { target, thinkingLevel: resolvedPrewalk.thinkingLevel };
				}
			}

			const enableMCP = !restrictToolNames && (options.enableMCP ?? true);
			const mcpManager = enableMCP ? options.mcpManager : undefined;

			// Derive subagent-scoped telemetry from the parent's config so the
			// child loop's spans nest under the parent's active execute_tool span
			// (OTEL context propagation handles parent linkage automatically),
			// carry the subagent's own agent identity, and use the subagent's
			// own session id for `gen_ai.conversation.id`.
			const subagentAgentIdentity: AgentIdentity | undefined = options.parentTelemetry
				? {
						id,
						name: agent.name,
						description: agent.description,
					}
				: undefined;
			const subagentTelemetry: AgentTelemetryConfig | undefined =
				options.parentTelemetry && subagentAgentIdentity
					? {
							...options.parentTelemetry,
							agent: subagentAgentIdentity,
							// Clear parent's conversationId; the child loop falls back to
							// its own AgentLoopConfig.sessionId.
							conversationId: undefined,
						}
					: undefined;

			if (options.parentTelemetry && subagentAgentIdentity) {
				const parentTelemetryHandle = resolveTelemetry(
					options.parentTelemetry,
					options.parentTelemetry.conversationId,
				);
				recordHandoff(parentTelemetryHandle, {
					fromAgent: options.parentTelemetry.agent,
					toAgent: subagentAgentIdentity,
				});
			}

			const { normalized: normalizedOutputSchema } = normalizeSchema(outputSchema);
			// Rebuilding an equivalent session from the same JSONL file re-invokes
			// createAgentSession with this spec (same agent id, tools, model, system
			// prompt, artifacts dir) — only the SessionManager and settings differ.
			const sessionSpec: SubagentSessionSpec = {
				options: {
					cwd: worktree ?? cwd,
					additionalDirectories: worktree !== undefined ? undefined : options.additionalDirectories,
					authStorage,
					modelRegistry,
					getApiKey: options.getApiKey,
					credentialSourceSessionId: options.credentialSourceSessionId,
					oauthAccountPools: options.oauthAccountPools,
					inheritedSessionAgents: options.inheritedSessionAgents,
					model,
					modelPattern: model || modelOverride === undefined ? undefined : modelPatterns,
					modelPatternAuthFallback:
						model || modelOverride === undefined ? undefined : options.parentActiveModelPattern,
					modelPatternFallbackRole:
						model || modelOverride === undefined ? undefined : subagentRetryFallbackRole(id),
					modelPatternDefaultFallbackChain:
						model || modelOverride === undefined ? undefined : inheritedRetryFallbackChain,
					thinkingLevel: effectiveThinkingLevel,
					thinkingLevelCeiling: spawnEffortCeiling,
					// Subagents are short-lived; never schedule background warm requests.
					cacheWarming: false,
					toolNames,
					outputSchema,
					outputSchemaMode: options.outputSchemaMode,
					restrictToolNames,
					requireYieldTool: true,
					contextFiles: options.contextFiles,
					skills: options.skills,
					promptTemplates: options.promptTemplates,
					workspaceTree: options.workspaceTree,
					rules: options.rules,
					extensionRoots: options.extensionRoots,
					preloadedExtensionPaths: restrictToolNames ? [] : options.preloadedExtensionPaths,
					preloadedPreparedExtensions: options.preloadedPreparedExtensions,
					preloadedCustomToolPaths: restrictToolNames ? [] : options.preloadedCustomToolPaths,
					hasUI: false,
					prewalk,
					spawns: spawnsEnv,
					taskDepth: childDepth,
					// The whole spawn tree shares the root session's observability bus,
					// so nested lifecycle/progress/event frames reach its surfaces
					// without leaking into another root session's traffic.
					subagentEventBus: options.subagentEventBus,
					parentHindsightSessionState: options.parentHindsightSessionState,
					parentMnemopiSessionState: options.parentMnemopiSessionState,
					parentTaskPrefix: id,
					parentAgentId: options.parentAgentId,
					agentId: id,
					agentDisplayName: agent.name,
					agentName: agent.name,
					enableLsp: lspEnabled,
					enableIrc: restrictToolNames ? false : options.enableIrc,
					skipPythonPreflight,
					enableMCP,
					mcpManager,
					// MCP proxies are minted per build as `mcpTools` in buildSubagentSessionOptions.
					customTools: options.customTools,
					localProtocolOptions: options.localProtocolOptions,
					telemetry: subagentTelemetry,
				},
				seanceFork: options.sourceSession !== undefined,
				prompt: {
					id,
					sourceSession: options.sourceSessionLabel,
					model: progress.resolvedModel,
					agentSystemPrompt: agent.systemPrompt,
					context: options.context?.trim() ?? "",
					planReference: options.planReference?.content ?? "",
					planReferencePath: options.planReference?.path ?? "",
					worktree: worktree ?? "",
					outputSchema: normalizedOutputSchema,
					outputSchemaOverridesAgent: options.outputSchemaOverridesAgent === true,
					ircEnabled,
					ircRoot: {},
				},
			};

			const sessionManager = await awaitAbortable(sessionManagerPromise);
			openedSessionManager = sessionManager;
			if (options.parentArtifactManager && !options.sourceSession) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			}
			sessionOpenedAt = performance.now();
			await refreshSubagentIrcRoot(sessionSpec.prompt, sessionManager, sessionFile);

			const hasExistingModelRole = sessionManager.getLastModelChangeRole() !== undefined;
			// Subscribe before the builder mints proxies so a manager change during
			// session startup is replayed on bind instead of lost.
			const mcpFollower = mcpManager
				? followMCPTools(mcpManager, explicitSubagentToolNames(sessionSpec))
				: undefined;
			let session: AgentSession;
			let sessionPromise: Promise<CreateAgentSessionResult> | undefined;
			try {
				sessionPromise = createAgentSession(
					buildSubagentSessionOptions(sessionSpec, subagentSettings, sessionManager, null, {
						workPoolYieldItems: options.workPoolYieldItems ?? [],
						// A revived session restores the tier history it persisted (including
						// tiers a provider rejected or an extension changed since spawn); only
						// the fresh spawn resolves the per-agent override.
						resolveServiceTierByFamily,
						onFirstChatDispatch: () => {
							firstChatDispatchAt ??= performance.now();
						},
					}),
				);
				({ session } = await awaitAbortable(sessionPromise));
				untrackedSession = session;
			} catch (err) {
				mcpFollower?.dispose();
				// Abort raced session startup. The session may still resolve later
				// holding live LSP/MCP child processes — dispose it when it does so
				// a cancelled subagent cannot leak them.
				pendingSessionDisposal = sessionPromise
					?.then(created => created.session.dispose())
					.then(
						() => {},
						() => {},
					);
				throw err;
			}
			mcpFollower?.bind(session);
			// The SDK records a new session's initial model as the default role.
			// Pin the child's own chain so a parent default sharing that model
			// cannot steal its fallback routing. Resumed history keeps its role.
			if (
				!hasExistingModelRole &&
				retryFallbackRole &&
				model &&
				session.model &&
				formatModelStringWithRouting(session.model) === formatModelStringWithRouting(model)
			) {
				sessionManager.appendModelChange(formatModelStringWithRouting(model), retryFallbackRole);
			}
			sessionCreatedAt = performance.now();

			monitor.setActiveSession(session);
			untrackedSession = undefined;
			// Run-state notifications precede deferrable wire-level `agent_end`,
			// so adopted keep-alive lifecycle cannot get stuck during prompt unwind.
			const registry = AgentRegistry.global();
			registry.syncSessionStatus(id, session);
			const runRef = registry.get(id);
			if (runRef) {
				// Agent Hub kills bypass this run's caller signal: lifecycle.release()
				// detaches the session and publishes an `aborted` tombstone directly.
				// Bridge that exact registry generation back into the monitor so the
				// prompt race and owning async task job settle promptly.
				registryAbortUnsubscribe = registry.onChange(event => {
					if (event.type === "status_changed" && event.ref === runRef && event.ref.status === "aborted") {
						monitor.requestAbort("signal");
					}
				});
				// Close the subscribe-after-read race with a kill that landed while
				// createAgentSession was returning.
				if (runRef.status === "aborted") monitor.requestAbort("signal");
			}
			// Todos are parent-owned bookkeeping and stripped from subagents —
			// except under prewalk, whose plan nudge + todo gate require the
			// subagent to commit its own todo list before the hand-off.
			const isParentOwnedTool = (name: string): boolean => !prewalk && name === "todo";
			if (sessionFile !== null) {
				const reviveCapture: WarmReviveCapture = {
					sessionFile,
					spec: sessionSpec,
					settings: captureSubagentSettings(settings, subagentSettings),
					parentArtifactManager: options.sourceSession ? undefined : options.parentArtifactManager,
					keepTodo: prewalk !== undefined,
					wake: wakeOptions,
					agentName: agent.name,
				};
				trackSubagentSettings(session, reviveCapture);
				reviveSession = createWarmSubagentReviver(reviveCapture);
			}

			// Emit lifecycle start event
			const startedPayload = {
				id,
				agent: agent.name,
				parentToolCallId: options.parentToolCallId,
				detached: options.detached,
				agentSource: agent.source,
				description: options.description,
				status: "started" as const,
				sessionFile: subtaskSessionFile,
				index,
			};
			emitSubagentFrame(options.eventBus, options.subagentEventBus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, startedPayload);

			const subagentToolNames = session.getEnabledToolNames();
			const filteredSubagentTools = subagentToolNames.filter(name => !isParentOwnedTool(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await awaitAbortable(session.setActiveToolsByName(filteredSubagentTools));
			}
			if (options.workPoolYieldItems) {
				await awaitAbortable(session.setWorkPoolYieldItems(options.workPoolYieldItems));
			}
			const enabledSubagentTools = session.getEnabledToolNames();
			// The enabled set includes the synthetic write transport injected for
			// explicit tool lists that omitted write. `session_init.tools` is later
			// replayed as an explicit grant during cold revival, so persist write
			// only when the original agent contract granted it.
			const persistedSubagentTools =
				toolNames !== undefined && !toolNames.includes("write")
					? enabledSubagentTools.filter(name => name !== "write")
					: enabledSubagentTools;

			session.sessionManager.appendSessionInit({
				// Blocks as sent; the session appends a newer session_init whenever a model call's base changes.
				systemPrompt: session.agent.state.systemPrompt,
				task,
				tools: persistedSubagentTools,
				agent: agent.name,
				modelRole: modelRole ?? resolveExplicitModelRole(modelOverride ?? agent.model, subagentSettings),
				resolvedModel: progress.resolvedModel,
				// Deferred model resolution installs this role inside createAgentSession,
				// so read it back from the settings both install paths write.
				retryFallback: getRetryFallbackRole(subagentSettings, subagentRetryFallbackRole(id)),
				readOnly: isReadOnlyAgent(agent),
				spawns: spawnsEnv,
				readSummarize: agent.readSummarize,
				advisor: advisorSelection ? (advisorRolePattern ?? "on") : undefined,
				compactionThreshold: options.compactionThresholdOverride,
				outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				restrictToolNames: restrictToolNames || undefined,
				// Isolated runs are never revivable (worktree merged + cleaned):
				// stamp the contract so cold revival leaves them transcript-only
				// even when the workspace was retained for recovery.
				isolated: worktree !== undefined || undefined,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void monitor.abortActiveSession();
				},
				{ once: true, signal: sessionAbortController.signal },
			);
			// Defensive: if the wall-clock timer (or external signal) fired during
			// the awaited setup above, the listener registration races the dispatch
			// and may not observe the already-fired abort event. Mirror it manually.
			if (abortSignal.aborted) {
				void monitor.abortActiveSession();
			}

			// No closure in this block may capture `session`: JSC gives every closure in a
			// block one shared scope object, so the lifecycle reviver built above would
			// then pin the parked, disposed session for the life of the process.
			const pendingExtensionMessages: Array<Promise<unknown>> = [];
			await awaitAbortable(
				initializeExtensions(session, {
					reportSendError: (action, err) => logger.error("Extension send failed", { action, error: err.message }),
					reportRuntimeError: err =>
						logger.error("Extension error", { path: err.extensionPath, error: err.error }),
					trackExtensionSend: task => {
						pendingExtensionMessages.push(task.catch(() => {}));
					},
					filterActiveTools: toolNames => toolNames.filter(name => !isParentOwnedTool(name)),
				}),
			);
			while (pendingExtensionMessages.length > 0) {
				await awaitAbortable(Promise.all(pendingExtensionMessages.splice(0)));
			}

			unsubscribe = monitor.attach(session);

			checkAbort();
			// Autoload skills via sendCustomMessage (same mechanic as /skill:<name>)
			if (options.autoloadSkills?.length) {
				for (const skill of options.autoloadSkills) {
					const { message } = await buildSkillPromptMessage(skill, { args: "" }, "autoload");
					await session.sendCustomMessage(
						{
							customType: SKILL_PROMPT_MESSAGE_TYPE,
							content: message,
							display: false,
							details: { name: skill.name, path: skill.filePath },
						},
						{ triggerTurn: false },
					);
				}
			}

			readyAt = performance.now();
			const outcome = await driveSessionToYield(session, monitor, task, { solutionSpace: options.solutionSpace });
			// Acceptance boundary (#11079): the run's final result is settled, so
			// stamp the lifecycle and terminalize a ref the run-state mirror left
			// `running` before the (possibly slow) cleanup below.
			if (monitor.yieldCalled()) {
				AgentRegistry.global().markResultAccepted(id, session, monitor.yieldAcceptedAt());
			}
			exitCode = outcome.exitCode;
			error = outcome.error;
			aborted = outcome.aborted;
			abortReasonText = outcome.abortReasonText;
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			const cleanupDeadlineAt = Date.now() + cleanupGraceMs;
			const cleanupChangeStatus =
				worktree === undefined
					? "This task was not isolated, so its changes may remain in the working directory."
					: "No isolated changes were applied.";
			const lateCleanups: Promise<void>[] = [];
			let deferredSessionShutdown: Promise<void> | undefined;
			const deferCleanup = (completion: Promise<void>): void => {
				lateCleanups.push(completion);
				// The run's terminal outcome (a successful `yield`, or a genuine
				// abort) is already settled; `aborted` reflects the authoritative
				// run status after the abort-signal reconciliation below. Late
				// cleanup (advisor drain, session disposal, owner-job reaping)
				// draining past the deadline is orthogonal — it MUST NOT downgrade
				// a non-aborted run to `aborted`, which discarded valid `agent()`
				// results (issue #9670). The deferred work still completes
				// asynchronously via `lateCleanups`/`onCleanupDeferred`.
				if (!aborted) return;
				exitCode = 1;
				abortReasonText = `cleanup exceeded ${cleanupGraceMs} ms`;
				error ??= `Task aborted. Cleanup did not finish within ${cleanupGraceMs} ms. ${cleanupChangeStatus}`;
			};
			if (abortSignal.aborted) {
				aborted = monitor.isAbortedRun();
				if (aborted) {
					abortReasonText ??= monitor.resolveAbortReasonText();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			const activeSessionAbort = monitor.waitForActiveSessionAbort();
			try {
				await untilAborted(
					AbortSignal.timeout(Math.max(0, cleanupDeadlineAt - Date.now())),
					() => activeSessionAbort,
				);
			} catch (cleanupError) {
				if (Date.now() >= cleanupDeadlineAt) {
					deferCleanup(activeSessionAbort);
				} else {
					logger.warn("Subagent abort cleanup failed", {
						id,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				}
			}
			if (registryAbortUnsubscribe) {
				registryAbortUnsubscribe();
				registryAbortUnsubscribe = null;
			}
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			const jobManager = AsyncJobManager.instance();
			if (jobManager) {
				const reap = await jobManager.cancelAndReapOwnerJobs(id, cleanupDeadlineAt);
				if (!reap.settled) {
					deferCleanup(reap.completion);
					logger.warn("Subagent async job cleanup exceeded its deadline", {
						id,
						pendingJobIds: reap.pendingJobIds,
					});
				}
			}
			const session = monitor.takeActiveSession();
			if (session) {
				monitor.captureSalvage(session);
				if (options.keepAlive !== false && (!options.sourceSession || readyAt !== undefined)) {
					attachIrcWakeTurnMonitor(session, wakeOptions);
				}
				await finalizeSubagentLifecycle({
					id,
					session,
					aborted,
					abortKind: monitor.abortKind(),
					keepAlive: options.keepAlive !== false && (!options.sourceSession || readyAt !== undefined),
					isolated: worktree !== undefined,
					agentIdleTtlMs,
					reviveSession,
					cleanupDeadlineAt,
					onRelease: options.onRelease,
					onCleanupDeferred: completion => {
						deferredSessionShutdown = completion;
						deferCleanup(completion);
					},
				});
			}
			if (jobManager) {
				if (deferredSessionShutdown) {
					const finalReap = Promise.allSettled([deferredSessionShutdown]).then(async () => {
						const reap = await jobManager.cancelAndReapOwnerJobs(id, Date.now());
						await reap.completion;
					});
					lateCleanups.push(finalReap);
				} else {
					const reap = await jobManager.cancelAndReapOwnerJobs(id, cleanupDeadlineAt);
					if (!reap.settled) {
						deferCleanup(reap.completion);
						logger.warn("Subagent async job cleanup exceeded its deadline after session shutdown", {
							id,
							pendingJobIds: reap.pendingJobIds,
						});
					}
				}
			}
			if (untrackedSession) {
				const incompleteSession = untrackedSession;
				untrackedSession = undefined;
				const disposal = Promise.resolve().then(() => incompleteSession.dispose());
				pendingSessionDisposal = disposal.then(
					() => {},
					() => {},
				);
				try {
					await untilAborted(AbortSignal.timeout(Math.max(0, cleanupDeadlineAt - Date.now())), () => disposal);
				} catch (cleanupError) {
					if (Date.now() >= cleanupDeadlineAt) {
						deferCleanup(disposal);
					} else {
						logger.warn("Incomplete subagent session disposal failed", {
							id,
							error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
						});
					}
				}
			}
			if (options.sourceSession && readyAt === undefined) {
				const removeFailedFork = (async () => {
					await pendingSessionDisposal;
					if (deferredSessionShutdown) await deferredSessionShutdown;
					let manager = openedSessionManager;
					if (!manager && pendingSessionManager) {
						manager = await pendingSessionManager.catch(() => undefined);
					}
					const ownedSessionFile = manager?.getSessionFile();
					if (manager && ownedSessionFile) await manager.dropSession(ownedSessionFile);
				})().catch(cleanupError => {
					logger.warn("Failed to remove incomplete seance fork", {
						id,
						sessionFile: openedSessionManager?.getSessionFile(),
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				});
				try {
					await untilAborted(
						AbortSignal.timeout(Math.max(0, cleanupDeadlineAt - Date.now())),
						() => removeFailedFork,
					);
				} catch (cleanupError) {
					if (Date.now() >= cleanupDeadlineAt) {
						deferCleanup(removeFailedFork);
					} else {
						logger.warn("Incomplete seance fork cleanup failed", {
							id,
							error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
						});
					}
				}
			}
			if (lateCleanups.length > 0) {
				const completion = Promise.allSettled(lateCleanups).then(() => {});
				trackLateCleanup(completion, { id, resource: "subagent" });
				options.onCleanupDeferred?.(completion);
			}
		}

		// Launch-latency breakdown (subagent invocation → first chat dispatch).
		// Phase deltas are performance.now() spans; the task-tool concurrency
		// brackets use the Date.now epochs captured by the spawn site
		// (invokedAt before acquire, acquiredAt after) so queue wait and
		// pre-run setup are reported apart.
		const span = (from: number | undefined, to: number | undefined): number | undefined =>
			from !== undefined && to !== undefined ? Math.round(to - from) : undefined;
		const queueMs =
			options.invokedAt !== undefined && options.acquiredAt !== undefined
				? Math.round(options.acquiredAt - options.invokedAt)
				: undefined;
		const preRunMs = options.acquiredAt !== undefined ? Math.round(startTime - options.acquiredAt) : undefined;
		const setupToFirstChatMs = span(perfStart, firstChatDispatchAt);
		const invokeToFirstChatMs =
			options.invokedAt !== undefined && setupToFirstChatMs !== undefined
				? Math.round(startTime - options.invokedAt) + setupToFirstChatMs
				: undefined;
		logger.debug("subagent launch timing", {
			id,
			agent: agent.name,
			queueMs,
			preRunMs,
			resolveMs: span(perfStart, resolvedAt),
			sessionOpenMs: span(resolvedAt, sessionOpenedAt),
			createSessionMs: span(sessionOpenedAt, sessionCreatedAt),
			readyMs: span(sessionCreatedAt, readyAt),
			promptToFirstChatMs: span(readyAt, firstChatDispatchAt),
			setupToFirstChatMs,
			invokeToFirstChatMs,
		});
		return {
			exitCode,
			error,
			aborted,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	monitor.finish();

	const result = await finalizeRunResult({
		monitor,
		done,
		index,
		id,
		agent,
		task,
		assignment,
		modelOverride,
		modelRole,
		outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		startTime,
	});
	AgentRegistry.global().setHistory(id, { outputPath: result.outputPath });
	return result;
}
