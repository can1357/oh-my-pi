/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentIdentity, AgentTelemetryConfig, ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { recordHandoff, resolveTelemetry } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Api, Model, ServiceTier, Usage } from "@pk-nerdsaver-ai/pi-ai";
import { logger, popLoopPhase, prompt, pushLoopPhase, untilAborted } from "@pk-nerdsaver-ai/pi-utils";
import type { Rule } from "../capability/rule";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { resolveSubagentServiceTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import { callTool } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { AgentExecutionProfile } from "../orchestration/agent-execution-profile";
import {
	type CollaborationPolicy,
	resolveCollaborationPolicy,
	serializeCollaborationPolicy,
} from "../orchestration/collaboration-policy";
import assignmentContractPromptTemplate from "../prompts/system/assignment-contract.md" with { type: "text" };
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import submitReminderTemplate from "../prompts/system/subagent-yield-reminder.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "../sdk";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import type { AuthStorage } from "../session/auth-storage";
import type { ClientBridge } from "../session/client-bridge";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";
import type { ContextFileEntry, ForkContextSnapshot } from "../tools";
import { isIrcEnabled } from "../tools/irc";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import {
	buildOutputValidator,
	type OutputValidator,
	summarizeValidationFailure,
} from "../tools/output-schema-validator";
import { type ReportFindingDetails, toReviewFinding } from "../tools/review";
import { ToolAbortError } from "../tools/tool-errors";
import { filterAutoToolNames, type ResolvedToolProfile, resolveToolProfile } from "../tools/tool-profiles";
import type { EventBus } from "../utils/event-bus";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { WorkspaceTree } from "../workspace-tree";
import { type AssignmentContract, type AssignmentResult, parseAssignmentResult } from "./assignment-contract";
import {
	type AssignmentVerificationResult,
	type AssignmentVerifierRunners,
	verifyAssignment,
} from "./assignment-verifier";
import { Semaphore } from "./parallel";
import {
	type AssignmentFailureClass,
	classifyRecoveryFailure,
	nextRecoveryAttempt,
	type RecoveryAttempt,
	type RecoveryCapsule,
	type RecoveryFailureFacts,
} from "./recovery-policy";
import type { SpawnPlan, SpawnRouteCandidate } from "./spawn-plan";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	oneLineLabel,
	type ReviewFinding,
	resolveSubagentDisplayName,
	type SingleResult,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type TaskToolDetails,
} from "./types";

const MCP_CALL_TIMEOUT_MS = 60_000;

/**
 * Soft per-agent request budgets (assistant requests per run). When a subagent
 * crosses its budget it receives ONE steering notice asking it to wrap up; at
 * 1.5x the budget the run is aborted gracefully so partial output is salvaged.
 * The `default` key applies to agents without an explicit entry and can be
 * overridden via the `task.softRequestBudget` setting (0 disables the guard).
 */
export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	explore: 40,
	quick_task: 40,
	default: 90,
};

/** Steering notice injected once when a subagent crosses its soft request budget. */
export function buildBudgetNotice(requests: number): string {
	return `[budget notice] You have used ${requests} requests in this run. Wrap up now: finish the current step and yield your final report.`;
}

/**
 * Build the `checkAbort` / `awaitAbortable` pair used by both the setup-phase
 * and the prompt-loop call sites. `onAbort` runs exactly once per `checkAbort`
 * invocation that observes an aborted signal — BEFORE the helper throws
 * `ToolAbortError` — so callers can update local bookkeeping (e.g. resolve
 * the monitor-specific abort reason into a local `abortReasonText`) at the
 * same point they always did. Callers that prefer to defer classification to
 * their own `finally` block should pass a no-op `onAbort`; the helper still
 * throws so control flow is identical.
 */
export function createAbortHelpers(
	signal: AbortSignal,
	onAbort: () => void,
): {
	checkAbort: () => void;
	awaitAbortable: <T>(promise: Promise<T>) => Promise<T>;
} {
	const checkAbort = (): void => {
		if (signal.aborted) {
			onAbort();
			throw new ToolAbortError();
		}
	};
	const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
		checkAbort();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbortEvent = (): void => {
			try {
				checkAbort();
			} catch (err) {
				reject(err);
			}
		};
		signal.addEventListener("abort", onAbortEvent, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			signal.removeEventListener("abort", onAbortEvent);
		}
	};
	return { checkAbort, awaitAbortable };
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

/**
 * Per-provider ceilings for concurrently RUNNING subagent sessions, keyed by
 * resolved provider id. Most providers tolerate parallel task spawns fine, but
 * ollama-cloud enforces a hard account-level concurrency cap, so spawns that
 * resolve to it must queue at the spawn boundary instead of bursting into
 * rate-limit backoff (issue #3464).
 */
const PROVIDER_SPAWN_CONCURRENCY_SETTINGS = {
	"ollama-cloud": "providers.ollama-cloud.maxConcurrency",
} as const;

const providerSpawnSemaphores = new Map<string, Semaphore>();

/**
 * Resolve the spawn semaphore for a provider with a configured concurrency
 * ceiling. The shared instance is resized in place (never replaced) on later
 * setting changes so in-flight holders stay counted and a runtime limit change
 * can never push concurrency past the cap.
 */
function getProviderSpawnSemaphore(provider: string, settings: Settings): Semaphore | undefined {
	const settingPath =
		PROVIDER_SPAWN_CONCURRENCY_SETTINGS[provider as keyof typeof PROVIDER_SPAWN_CONCURRENCY_SETTINGS];
	if (!settingPath) return undefined;
	const maxConcurrency = settings.get(settingPath);
	const existing = providerSpawnSemaphores.get(provider);
	if (existing) {
		existing.resize(maxConcurrency);
		return existing;
	}
	const semaphore = new Semaphore(maxConcurrency);
	providerSpawnSemaphores.set(provider, semaphore);
	return semaphore;
}

const SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX = "subagent:";

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
	for (const pattern of modelPatterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) continue;
		const selector = resolved.explicitThinkingLevel
			? formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel)
			: formatModelStringWithRouting(resolved.model);
		if (seen.has(selector)) continue;
		seen.add(selector);
		candidates.push({ model: resolved.model, selector });
	}
	return candidates;
}

function installSubagentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: SubagentRetryFallbackCandidate[];
	model: Model<Api> | undefined;
	authFallbackUsed: boolean;
	/** Which mechanism supplied the fallback model, when `authFallbackUsed` is true. */
	fallbackKind?: "priority-list" | "parent";
}): string | undefined {
	const { settings, id, candidates, model, authFallbackUsed, fallbackKind } = args;
	// A parent-model fallback is not one of `candidates` (it comes from the
	// PARENT session's active model pattern, outside the task's own priority
	// list), so a retry chain built from `candidates` would be meaningless —
	// skip early. A priority-list fallback (candidate 2, 3, …) IS one of
	// `candidates`; still install a chain from whatever ordered candidates
	// remain after the one actually selected.
	if (!model || (authFallbackUsed && fallbackKind !== "priority-list") || candidates.length <= 1) return undefined;

	const selectedIndex = candidates.findIndex(
		candidate => candidate.model.provider === model.provider && candidate.model.id === model.id,
	);
	if (selectedIndex < 0) return undefined;
	const fallbackSelectors = candidates.slice(selectedIndex + 1).map(candidate => candidate.selector);
	if (fallbackSelectors.length === 0) return undefined;

	const role = `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`;
	const modelRoles: Record<string, string> = {};
	const existingRoles = settings.getModelRoles();
	for (const existingRole in existingRoles) {
		const selector = existingRoles[existingRole];
		if (selector) {
			modelRoles[existingRole] = selector;
		}
	}
	modelRoles[role] = candidates[selectedIndex].selector;
	settings.override("modelRoles", modelRoles);
	const fallbackChains: Record<string, string[]> = {
		[role]: fallbackSelectors,
	};
	const existingFallbackChains = settings.get("retry.fallbackChains");
	for (const existingRole in existingFallbackChains) {
		if (existingRole !== role) {
			fallbackChains[existingRole] = existingFallbackChains[existingRole];
		}
	}
	settings.override("retry.fallbackChains", fallbackChains);
	return role;
}

function renderIrcPeerRoster(selfId: string): string {
	const peers = AgentRegistry.global()
		.list()
		.filter(ref => ref.id !== selfId && ref.status !== "aborted" && ref.kind !== "advisor");
	if (peers.length === 0) return "- (no other agents)";
	const lines = peers.map(
		peer =>
			`- \`${peer.id}\` — ${peer.displayName} (${peer.kind}, ${peer.status})${peer.activity ? `: ${peer.activity}` : ""}`,
	);
	if (peers.some(peer => peer.status === "idle" || peer.status === "parked")) {
		lines.push("Idle/parked peers are not gone: messaging them wakes (or revives) them.");
	}
	return lines.join("\n");
}

function withAbortTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

function getReportFindingKey(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title : null;
	const filePath = typeof record.file_path === "string" ? record.file_path : null;
	const lineStart = typeof record.line_start === "number" ? record.line_start : null;
	const lineEnd = typeof record.line_end === "number" ? record.line_end : null;
	const priority = typeof record.priority === "string" ? record.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	/** Shared background from the task call (`task.batch`), rendered into the subagent's system prompt. */
	context?: string;
	/**
	 * The session's active overall plan, handed off so subagents spawned during
	 * plan execution share the same plan context as the main agent. Omitted when
	 * the session did not start with a plan (or while plan mode is still active).
	 */
	planReference?: { path: string; content: string };
	description?: string;
	/** Specialist role/expertise for this spawn; drives the system-prompt preamble, display name, and telemetry identity. */
	role?: string;
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
	/** Internal marker for the persistent Fusion warm sidekick spawn. */
	fusionSidekick?: boolean;
	modelOverride?: string | string[];
	/**
	 * "fork" inherits the parent's exact prefix (system prompt, tools, model)
	 * plus a read-only history snapshot via {@link forkContext} so the child's
	 * first request re-reads the parent's warm provider cache. Default "fresh".
	 */
	contextMode?: "fresh" | "fork";
	/** Parent snapshot backing fork mode; required when contextMode is "fork". */
	forkContext?: ForkContextSnapshot;
	/**
	 * Active model selector of the parent session, used as an auth-aware fallback
	 * if the resolved subagent model has no working credentials. See #985.
	 */
	parentActiveModelPattern?: string;
	thinkingLevel?: ThinkingLevel;
	color?: string;
	outputSchema?: unknown;
	/** Frozen allocation-free plan composed before this child id existed. */
	spawnPlan?: SpawnPlan;
	/** Frozen execution envelope from the spawn plan. */
	executionProfile?: AgentExecutionProfile;
	/** Source-aware tool capability ceiling. */
	toolProfile?: ResolvedToolProfile;
	/** Runtime collaboration authorization for registry/IRC behavior. */
	collaborationPolicy?: CollaborationPolicy;
	/** Parent-authored immutable acceptance contract. */
	assignmentContract?: AssignmentContract;
	/** Failure-only context for a fresh recovery child; never includes transcript text. */
	recoveryCapsule?: RecoveryCapsule;
	/** Parent extension runner that evaluated pre-allocation spawn policy. */
	extensionRunner?: ExtensionRunner;
	/** Parent-owned verification runners; child evidence never supplies commands or paths. */
	assignmentVerifierRunners?: AssignmentVerifierRunners;
	/** Authoritative parent-observed changed paths when available. */
	actualChangedFiles?: readonly string[];
	/** Recovery attempts already allocated for this assignment. */
	recoveryAttempts?: readonly RecoveryAttempt[];
	/** Providers suppressed by prior terminal recovery decisions. */
	recoverySuppressedProviders?: readonly string[];
	/** Allocate a new child identity only after recovery policy returns retry. */
	allocateRecoveryId?: (attempt: RecoveryAttempt) => Promise<string>;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/**
	 * Decision-surface guidance from the orchestration harness, injected into the
	 * subagent system prompt as a compact constraint block. Absent for full harness
	 * agents where no ceiling is applied.
	 */
	harnessGuidance?: string;
	/**
	 * Override the `task.maxRuntimeMs` wall-clock cap for this run. When provided
	 * it wins over the settings value; `0` disables the per-subagent wall-clock
	 * limit entirely. Used by the eval `agent()` bridge, whose parent cell
	 * watchdog is already suspended for the call's duration.
	 */
	maxRuntimeMs?: number;
	/**
	 * Keep the finished subagent session alive (registry-interrogable, parked
	 * on the idle-TTL lifecycle) after a non-aborted, non-isolated run.
	 * Defaults to true; the eval `agent()` bridge passes `false` so its
	 * short-lived programmatic helpers are disposed immediately.
	 */
	keepAlive?: boolean;
	/**
	 * The parent session's live effective service tier, consumed when
	 * `serviceTierSubagent` is `"inherit"`: `null` means the parent explicitly
	 * has no tier (e.g. `/fast off`), `undefined` means no live session is
	 * available so inherit falls back to the parent's configured `serviceTier`
	 * setting. See {@link resolveSubagentServiceTier}.
	 */
	parentServiceTier?: ServiceTier | null;
	enableLsp?: boolean;
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
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	workspaceTree?: WorkspaceTree;
	/** Parent-discovered rules, forwarded to skip rule discovery in the subagent. */
	rules?: Rule[];
	/**
	 * Parent's discovered extension source paths. Forwarded to skip the
	 * extension FS scan in the subagent; the subagent then re-binds each
	 * extension against its own `ExtensionAPI` (cwd, eventBus, runtime).
	 */
	preloadedExtensionPaths?: string[];
	/**
	 * Parent's discovered custom-tool source paths. Forwarded to skip the
	 * `.ompk/tools/` FS scan in the subagent; the subagent then re-binds each
	 * tool against its own `CustomToolAPI` (cwd, exec, pushPendingAction, UI).
	 */
	preloadedCustomToolPaths?: ToolPathWithSource[];
	/** Parent client bridge inherited by live and revived child sessions. */
	clientBridge?: ClientBridge;
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
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
	/** Parent agent's eval executor session id. Subagents reuse it so eval state is shared. */
	parentEvalSessionId?: string;
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

/**
 * Resolve the final yielded payload, optionally splicing collected
 * `report_finding` entries into a top-level `findings` array.
 *
 * Injection is suppressed when an active validator would reject the augmented
 * payload (e.g. a caller-supplied schema with `additionalProperties: false`
 * that does not declare `findings`). That keeps the in-tool yield validator
 * (which only sees the raw, pre-injection data) in lockstep with this
 * post-mortem validator — honoring the "accepted in-tool ⇒ accepted
 * post-mortem" guarantee documented in `output-schema-validator.ts`. The
 * dropped findings are still preserved verbatim in the agent's progress
 * stream and JSONL artifact, so no information is lost when injection is
 * suppressed.
 */
function normalizeCompleteData(
	data: unknown,
	reportFindings: ReviewFinding[] | undefined,
	validator: OutputValidator | undefined,
): unknown {
	const normalized = parseStringifiedJson(data ?? null);
	if (
		!Array.isArray(reportFindings) ||
		reportFindings.length === 0 ||
		!normalized ||
		typeof normalized !== "object" ||
		Array.isArray(normalized)
	) {
		return normalized;
	}
	const record = normalized as Record<string, unknown>;
	if ("findings" in record) return normalized;
	const injected = { ...record, findings: reportFindings };
	if (validator && !validator.validate(injected).success) return normalized;
	return injected;
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

export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	/**
	 * Set by the in-tool yield validator when it exhausted its retry budget
	 * (MAX_SCHEMA_RETRIES) and accepted a schema-invalid payload anyway.
	 * `finalizeSubprocessOutput` honors this by serializing the payload and
	 * surfacing a stderr warning, instead of re-emitting `schema_violation`
	 * — which would silently swap the subagent's "accepted" view for a
	 * different, opaque error blob in the parent's view of the result.
	 */
	schemaOverridden?: boolean;
}

interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	reportFindings?: ReviewFinding[];
	outputSchema: unknown;
}

interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
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
	const { yieldItems, reportFindings, doneAborted, signalAborted, outputSchema } = args;
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
			const submitData = lastYield?.data;
			if (submitData === null || submitData === undefined) {
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
			} else {
				const { validator, error: schemaError } = buildOutputValidator(outputSchema);
				const overridden = lastYield?.schemaOverridden === true;
				const completeData = normalizeCompleteData(submitData, reportFindings, validator);
				const result =
					schemaError || overridden
						? { success: true as const }
						: (validator?.validate(completeData) ?? { success: true as const });
				if (!result.success) {
					const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
					const outcome = buildSchemaViolationOutcome(summary, completeData);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				} else {
					try {
						rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
					} catch (err) {
						const errorMessage = err instanceof Error ? err.message : String(err);
						rawOutput = `{"error":"Failed to serialize yield data: ${errorMessage}"}`;
					}
					if (!hadFailureBeforeYield) {
						exitCode = 0;
						stderr = overridden
							? SUBAGENT_WARNING_SCHEMA_OVERRIDDEN
							: schemaError
								? `invalid output schema: ${schemaError}`
								: "";
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
			const completeData = normalizeCompleteData(fallback.data, reportFindings, validator);
			const result = validator?.validate(completeData) ?? { success: true as const };
			if (!result.success) {
				const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
				const outcome = buildSchemaViolationOutcome(summary, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
			} else {
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

	return { rawOutput, exitCode, stderr, abortedViaYield, hasYield };
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
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
 */
export function createMCPProxyTools(mcpManager: MCPManager): CustomTool[] {
	return mcpManager.getTools().map(tool => {
		const mcpTool = tool as { mcpToolName?: string; mcpServerName?: string };
		return {
			name: tool.name,
			label: tool.label ?? tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters,
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				if (signal?.aborted) {
					throw new ToolAbortError();
				}
				const serverName = mcpTool.mcpServerName ?? "";
				const mcpToolName = mcpTool.mcpToolName ?? "";
				try {
					const result = await withAbortTimeout(
						(async () => {
							const connection = await mcpManager.waitForConnection(serverName);
							return callTool(connection, mcpToolName, params as Record<string, unknown>, { signal });
						})(),
						MCP_CALL_TIMEOUT_MS,
						signal,
					);
					return {
						content: (result.content ?? []).map(item =>
							item.type === "text"
								? { type: "text" as const, text: item.text ?? "" }
								: { type: "text" as const, text: JSON.stringify(item) },
						),
						details: { serverName, mcpToolName, isError: result.isError },
					};
				} catch (error) {
					if (error instanceof ToolAbortError) {
						throw error;
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

export function createSubagentSettings(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	return Settings.isolated({
		...snapshot,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,

		// Subagents run headless — there is no UI to confirm prompts against, so
		// the parent task approval is the authorization boundary. Use yolo mode
		// to preserve unattended subagent execution. User `tools.approval` policies still apply.
		"tools.approvalMode": "yolo",
		...overrides,
	});
}

/** Inputs for {@link finalizeSubagentLifecycle}. */
export interface FinalizeSubagentLifecycleOptions {
	id: string;
	session: AgentSession;
	/** The run was hard-aborted (caller signal / wall-clock / budget). */
	aborted: boolean;
	/** Keep the finished session alive on the idle-TTL lifecycle (see {@link ExecutorOptions.keepAlive}). */
	keepAlive: boolean;
	/** The run used an isolated worktree (merged + cleaned; the session is not resumable). */
	isolated: boolean;
	/** TTL before an adopted idle subagent is parked; <= 0 disables parking. */
	agentIdleTtlMs: number;
	/** Cold-revive factory for lifecycle adoption, or null when unavailable. */
	reviveSession: (() => Promise<AgentSession>) | null;
}

/**
 * Registry/lifecycle teardown for a finished subagent run: aborted runs tear
 * down terminally, isolated runs park a detached (non-resumable) ref,
 * keep-alive opt-outs dispose immediately, and everything else stays
 * interrogable under the lifecycle manager's idle-TTL parking.
 */
export async function finalizeSubagentLifecycle(options: FinalizeSubagentLifecycleOptions): Promise<void> {
	const { id, session, aborted, keepAlive, isolated, agentIdleTtlMs, reviveSession } = options;
	const registry = AgentRegistry.global();
	if (aborted) {
		// Hard abort (caller signal / wall-clock / budget): terminal teardown.
		registry.setStatus(id, "aborted");
		try {
			await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
		} catch {
			// Ignore cleanup errors
		}
	} else if (isolated) {
		// Isolated run: the worktree is merged + cleaned after the run, so
		// the session is not resumable. Park the ref WITHOUT adopting — the
		// transcript stays reachable (history://), but ensureLive will throw.
		// Status must flip to "parked" before dispose so the sdk dispose
		// wrapper skips unregister.
		registry.setStatus(id, "parked");
		try {
			await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
		} catch {
			// Ignore cleanup errors
		}
		registry.detachSession(id);
	} else if (!keepAlive) {
		// Keep-alive opt-out (eval `agent()` bridge): the helper is a
		// short-lived programmatic spawn nobody interrogates afterwards,
		// so tear the session down now instead of parking it on the
		// idle-TTL lifecycle. The sdk dispose wrapper usually unregisters the
		// ref (not parked); the explicit unregister below is idempotent and
		// covers sessions without the wrapper.
		registry.setStatus(id, "idle");
		try {
			await untilAborted(AbortSignal.timeout(5000), () => session.dispose());
		} catch {
			// Ignore cleanup errors
		}
		registry.unregister(id);
	} else {
		// Keep-alive: finished and failed subagents both stay interrogable.
		// The lifecycle manager owns idle-TTL parking + revival from here on.
		registry.setStatus(id, "idle");
		AgentLifecycleManager.global().adopt(id, {
			idleTtlMs: agentIdleTtlMs,
			revive: reviveSession ?? undefined,
		});
	}
}

type AbortReason = "signal" | "terminate" | "timeout" | "budget";

/** Inputs for the run monitor driving one subagent assignment. */
interface RunMonitorArgs {
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	modelOverride?: string | string[];
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	/** Soft assistant-request budget; 0 disables the guard. */
	softRequestBudget: number;
	/** Wall-clock cap in ms; 0 disables the timer. */
	maxRuntimeMs: number;
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
	runtimeLimitExceeded(): boolean;
	/** True when the abort carries a precise external reason (signal / wall-clock / budget). */
	hasExplicitAbortReason(): boolean;
	/** Whether the (attempted) abort counts as a cancelled run rather than an internal failure. */
	isAbortedRun(): boolean;
	requestAbort(reason: AbortReason): void;
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
	/** Final raw output: end-of-run assistant text when available, else accumulated chunks. */
	rawOutput(): string;
	scheduleProgress(flush?: boolean): void;
	/** Stop processing events and clear listeners/timers. Call once the run settled. */
	finish(): void;
}

function createSubagentRunMonitor(args: RunMonitorArgs): SubagentRunMonitor {
	const { index, id, agent, task, assignment, signal, onProgress, softRequestBudget, maxRuntimeMs } = args;
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
	};

	const outputChunks: string[] = [];
	const finalOutputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let resolved = false;
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let runtimeLimitExceeded = false;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;
	let yieldCalled = false;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;
	let budgetSteerSent = false;
	let budgetLimitExceeded = false;
	let lastAssistantSalvageText: string | undefined;

	const requestAbort = (reason: AbortReason) => {
		if (reason === "timeout") {
			runtimeLimitExceeded = true;
		}
		if (reason === "budget") {
			budgetLimitExceeded = true;
		}
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal" && abortReason !== "timeout") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		if (activeSession) {
			void activeSession.abort();
		}
	};

	// Handle abort signal
	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				if (!resolved) requestAbort("signal");
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
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget})`;
		}
		return resolveSignalAbortReason();
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	const emitProgressNow = () => {
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		const activityGist =
			progress.lastIntent ?? (progress.currentTool ? `running ${progress.currentTool}` : undefined);
		if (activityGist) AgentRegistry.global().setActivity(id, activityGist);
		if (args.eventBus) {
			args.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				parentToolCallId: args.parentToolCallId,
				detached: args.detached,
				assignment,
				progress: { ...progress },
				sessionFile: args.sessionFile,
			});
		}
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

	const getMessageContent = (message: unknown): unknown => {
		if (message && typeof message === "object" && "content" in message) {
			return (message as { content?: unknown }).content;
		}
		return undefined;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (message && typeof message === "object" && "usage" in message) {
			return (message as { usage?: unknown }).usage;
		}
		return undefined;
	};

	const updateRecentOutputLines = () => {
		const lines = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = lines.slice(-8).reverse();
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		updateRecentOutputLines();
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		updateRecentOutputLines();
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		progress.recentOutput = [];
	};

	const emitSubagentEvent = (event: AgentSessionEvent) => {
		if (!args.eventBus) return;
		args.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id,
			event,
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
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				progress.currentToolArgs = extractToolArgsPreview(
					(event as { toolArgs?: Record<string, unknown> }).toolArgs || event.args || {},
				);
				progress.currentToolStartMs = now;
				const intent = event.intent?.trim();
				if (intent) {
					progress.lastIntent = intent;
				}
				// Reset any prior in-flight task snapshot so we don't show stale
				// nested progress when the agent enters a fresh `task` call.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}
				break;
			}

			case "tool_execution_end": {
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					// Keep only last 5
					if (progress.recentTools.length > 5) {
						progress.recentTools.pop();
					}
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;
				// The finalized TaskToolDetails will be captured below into
				// `extractedToolData.task`; drop the in-flight snapshot so the
				// renderer doesn't double-count it against the final entry.
				if (event.toolName === "task") {
					progress.inflightTaskDetails = undefined;
				}

				// Check for registered subagent tool handler
				const handler = subprocessToolRegistry.getHandler(event.toolName);
				const eventArgs = (event as { args?: Record<string, unknown> }).args ?? {};
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
							progress.extractedToolData = progress.extractedToolData || {};
							const existing = progress.extractedToolData[event.toolName] || [];
							const findingKey = event.toolName === "report_finding" ? getReportFindingKey(data) : null;
							if (findingKey) {
								const existingIndex = existing.findIndex(item => getReportFindingKey(item) === findingKey);
								if (existingIndex >= 0) {
									existing[existingIndex] = data;
								} else {
									existing.push(data);
								}
							} else {
								existing.push(data);
							}
							progress.extractedToolData[event.toolName] = existing;
							if (event.toolName === "yield") {
								yieldCalled = true;
							}
						}
					}

					// Check if handler wants to terminate the session
					if (
						handler.shouldTerminate?.({
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							args: eventArgs,
							result: event.result,
							isError: event.isError,
						})
					) {
						requestAbort("terminate");
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
					if (softRequestBudget > 0 && !abortSent) {
						if (progress.requests >= softRequestBudget * 1.5) {
							requestAbort("budget");
						} else if (!budgetSteerSent && progress.requests >= softRequestBudget) {
							budgetSteerSent = true;
							const steerSession = activeSession;
							if (steerSession) {
								void steerSession
									.sendUserMessage(buildBudgetNotice(progress.requests), { deliverAs: "steer" })
									.catch(err => {
										logger.warn("Subagent budget steer failed", {
											error: err instanceof Error ? err.message : String(err),
										});
									});
							}
						}
					}
				}
				if (role === "assistant") {
					const messageContent =
						getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (block.type === "text" && block.text) {
								outputChunks.push(block.text);
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const messageUsage = getMessageUsage(event.message) || (event as AgentEvent & { usage?: unknown }).usage;
				if (messageUsage && typeof messageUsage === "object") {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const usageRecord = messageUsage as Record<string, unknown>;
						const costRecord = (messageUsage as { cost?: Record<string, unknown> }).cost;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(usageRecord, "input") ?? 0;
						accumulatedUsage.output += getNumberField(usageRecord, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(usageRecord, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(usageRecord, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(usageRecord, "totalTokens") ?? 0;
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
						const perTurnTotal = getNumberField(messageUsage as Record<string, unknown>, "totalTokens");
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

	const attach = (session: AgentSession): (() => void) =>
		session.subscribe(event => {
			emitSubagentEvent(event);
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
			if (event.type === "retry_fallback_applied") {
				progress.resolvedModel = event.to;
				scheduleProgress(true);
				return;
			}
			if (event.type === "retry_fallback_succeeded") {
				progress.resolvedModel = event.model;
				scheduleProgress(true);
				return;
			}
		});

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
		runtimeLimitExceeded: () => runtimeLimitExceeded,
		hasExplicitAbortReason: () => abortReason === "signal" || runtimeLimitExceeded || budgetLimitExceeded,
		isAbortedRun: () =>
			abortReason === "signal" || runtimeLimitExceeded || budgetLimitExceeded || abortReason === undefined,
		requestAbort,
		resolveSignalAbortReason,
		resolveAbortReasonText,
		setActiveSession: session => {
			activeSession = session;
		},
		takeActiveSession: () => {
			const session = activeSession;
			activeSession = null;
			return session;
		},
		attach,
		captureSalvage,
		lastAssistantSalvageText: () => lastAssistantSalvageText,
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

/**
 * Drive one assignment through a live session: send the prompt, wait for idle,
 * remind the agent to `yield` (up to {@link MAX_YIELD_RETRIES} times), then
 * classify the terminal assistant state.
 */
async function driveSessionToYield(
	session: AgentSession,
	monitor: SubagentRunMonitor,
	task: string,
): Promise<DriveOutcome> {
	const abortSignal = monitor.abortSignal;
	let exitCode = 0;
	let error: string | undefined;
	let aborted = false;
	let abortReasonText: string | undefined;
	// driveSessionToYield only ever waits via `awaitAbortable`; the helper's
	// own internal `checkAbort` (called before each race) preserves the prior
	// behavior. Standalone `checkAbort` calls were not present before the
	// consolidation either, so we don't re-bind it here.
	const { awaitAbortable } = createAbortHelpers(abortSignal, () => {
		aborted = monitor.isAbortedRun();
		if (aborted) {
			abortReasonText ??= monitor.resolveAbortReasonText();
		}
		exitCode = 1;
	});

	try {
		await awaitAbortable(session.prompt(task, { attribution: "agent" }));
		await awaitAbortable(session.waitForIdle());

		const reminderToolChoice = buildNamedToolChoice("yield", session.model);

		let retryCount = 0;
		// The budget flag reflects the most recent run and each re-prompt starts a
		// fresh `maxModelRequestsPerRun` counter, so retrying after a budget cut
		// would let the run spend a multiple of the configured cap.
		while (
			!monitor.yieldCalled() &&
			retryCount < MAX_YIELD_RETRIES &&
			!abortSignal.aborted &&
			!session.agent.modelRequestBudgetExceeded
		) {
			// Skip reminders when the model returned a terminal error (e.g.
			// rate-limit cap hit, auth failure). Re-prompting would just
			// hit the same wall, multiplying the failure noise without
			// any chance of producing a yield.
			const lastBeforeReminder = session.getLastAssistantMessage();
			if (lastBeforeReminder?.stopReason === "error") break;
			try {
				retryCount++;
				const reminder = prompt.render(submitReminderTemplate, {
					retryCount,
					maxRetries: MAX_YIELD_RETRIES,
				});

				const isFinalRetry = retryCount >= MAX_YIELD_RETRIES;
				await awaitAbortable(
					session.prompt(reminder, {
						attribution: "agent",
						synthetic: true,
						...(isFinalRetry && reminderToolChoice ? { toolChoice: reminderToolChoice } : {}),
					}),
				);
				await awaitAbortable(session.waitForIdle());
			} catch (err) {
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
			}
		}

		await awaitAbortable(session.waitForIdle());

		if (session.agent.modelRequestBudgetExceeded && !monitor.yieldCalled()) {
			exitCode = 1;
			error ??= "Sidekick model-request budget exhausted (fusion.sidekickRequestBudget)";
		}

		const lastAssistant = session.getLastAssistantMessage();
		if (lastAssistant) {
			if (lastAssistant.stopReason === "aborted") {
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
			} else if (lastAssistant.stopReason === "error") {
				exitCode = 1;
				error ??= lastAssistant.errorMessage || "Subagent failed";
			}
		}
	} catch (err) {
		exitCode = 1;
		if (!abortSignal.aborted) {
			error = err instanceof Error ? err.stack || err.message : String(err);
		}
	} finally {
		if (abortSignal.aborted) {
			aborted = monitor.isAbortedRun();
			if (aborted) {
				abortReasonText ??= monitor.resolveAbortReasonText();
			}
			if (exitCode === 0) exitCode = 1;
		}
	}

	return { exitCode, error, aborted, abortReasonText };
}

interface AssignmentVerificationOutcome {
	readonly assignmentResult?: AssignmentResult;
	readonly verification: AssignmentVerificationResult;
	readonly failureClass?: AssignmentFailureClass;
	readonly isError: boolean;
}

function rejectedAssignmentVerification(
	reasons: readonly string[],
	failureClass: AssignmentFailureClass,
): AssignmentVerificationOutcome {
	return {
		verification: {
			verified: false,
			failureClass,
			reasons: Object.freeze([...reasons]),
			criteria: Object.freeze([]),
		},
		failureClass,
		isError: true,
	};
}

async function verifyAssignmentYield(args: {
	contract: AssignmentContract;
	lastYield: YieldItem | undefined;
	monitor: SubagentRunMonitor;
	runners?: AssignmentVerifierRunners;
	actualChangedFiles?: readonly string[];
}): Promise<AssignmentVerificationOutcome> {
	const { monitor } = args;
	monitor.progress.assignmentVerificationStatus = "submitted";
	monitor.scheduleProgress(true);
	monitor.progress.assignmentVerificationStatus = "verifying";
	monitor.scheduleProgress(true);

	if (args.lastYield?.status !== "success") {
		return rejectedAssignmentVerification(
			["Assignment contract cannot be verified without a successful yield result."],
			"liveness",
		);
	}
	const parsed = parseAssignmentResult(parseStringifiedJson(args.lastYield.data));
	if (!parsed.ok) {
		return rejectedAssignmentVerification(
			parsed.diagnostics.map(diagnostic => `Invalid assignment result: ${diagnostic.message}`),
			"acceptance",
		);
	}

	const verification = await verifyAssignment(args.contract, parsed.result, args.runners, args.actualChangedFiles);
	return {
		assignmentResult: parsed.result,
		verification,
		failureClass: verification.verified ? undefined : verification.failureClass,
		isError: !verification.verified || parsed.result.status === "failed" || parsed.result.status === "blocked",
	};
}

function recoveryFailureFacts(result: SingleResult): RecoveryFailureFacts {
	const abortReason = result.abortReason ?? "";
	const timedOut = result.failureClass === "timeout" || /runtime limit|timed? out|timeout/i.test(abortReason);
	const inferredClass: AssignmentFailureClass =
		result.failureClass ??
		(result.retryFailure
			? "spawn_transport"
			: timedOut
				? "timeout"
				: result.aborted
					? "liveness"
					: result.assignmentVerificationStatus === "verification_failed"
						? "acceptance"
						: "liveness");
	const failedProvider = result.resolvedModel?.split("/", 1)[0];
	const facts: RecoveryFailureFacts = {
		class: inferredClass,
		message: result.error || result.stderr || abortReason || "Terminal child failure",
		validatorReasons:
			result.assignmentVerificationStatus === "verification_failed" && result.stderr ? [result.stderr] : undefined,
		timedOut,
		failedProvider,
	};
	return { ...facts, class: classifyRecoveryFailure(facts) };
}

function failedRecoveryCandidate(options: ExecutorOptions, result: SingleResult): SpawnRouteCandidate | undefined {
	const eligible = options.spawnPlan?.eligible ?? [];
	if (eligible.length === 0) return undefined;
	const resolvedModel = result.resolvedModel;
	if (resolvedModel) {
		const matched = eligible.find(candidate => {
			if (candidate.selector === resolvedModel) return true;
			if (!candidate.provider || !candidate.modelId) return false;
			const identity = `${candidate.provider}/${candidate.modelId}`;
			return resolvedModel === identity || resolvedModel.startsWith(`${identity}:`);
		});
		if (matched) return matched;
	}
	const overrides = Array.isArray(result.modelOverride)
		? result.modelOverride
		: result.modelOverride
			? [result.modelOverride]
			: [];
	return eligible.find(candidate => overrides.includes(candidate.selector)) ?? eligible[0];
}

function seedFailedRecoveryAttempt(options: ExecutorOptions, result: SingleResult): RecoveryAttempt | undefined {
	const candidate = failedRecoveryCandidate(options, result);
	if (!candidate) return undefined;
	const attempt = (options.recoveryAttempts?.length ?? 0) + 1;
	return Object.freeze({
		attempt,
		selector: candidate.selector,
		tier: candidate.tier,
		provider: candidate.provider,
		modelId: candidate.modelId,
		budgets: Object.freeze({
			maxRequests: candidate.maxRequests,
			maxRuntimeMs: candidate.maxRuntimeMs,
		}),
		maxRequests: candidate.maxRequests,
		maxRuntimeMs: candidate.maxRuntimeMs,
		freshChild: true,
	});
}

interface FinalizeRunArgs {
	monitor: SubagentRunMonitor;
	done: { exitCode: number; error?: string; aborted?: boolean; abortReason?: string; durationMs: number };
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	modelOverride?: string | string[];
	outputSchema?: unknown;
	signal?: AbortSignal;
	artifactsDir?: string;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	startTime: number;
	executionProfile?: AgentExecutionProfile;
	toolProfile?: ResolvedToolProfile;
	collaborationPolicy?: CollaborationPolicy;
	assignmentContract?: AssignmentContract;
	assignmentVerifierRunners?: AssignmentVerifierRunners;
	actualChangedFiles?: readonly string[];
	recoveryAttempt?: RecoveryAttempt;
}

/**
 * Turn a settled run into a {@link SingleResult}: resolve the yield payload via
 * {@link finalizeSubprocessOutput}, salvage cancelled-run output, write the
 * `<id>.md` output artifact, flush final progress, and emit the lifecycle end
 * event.
 */
async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
	const { monitor, done, index, id, agent, task, assignment, signal, modelOverride } = args;
	const progress = monitor.progress;
	let exitCode = done.exitCode;
	let stderr = done.error ?? "";

	// Use final output if available, otherwise accumulated output
	let rawOutput = monitor.rawOutput();
	const yieldItems = progress.extractedToolData?.yield as YieldItem[] | undefined;
	const reportFindingDetails = progress.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;
	const reportFindings: ReviewFinding[] | undefined = reportFindingDetails?.map(toReviewFinding);
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
			reportFindings,
			outputSchema: args.outputSchema,
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
	let assignmentVerification: AssignmentVerificationOutcome | undefined;
	if (args.assignmentContract) {
		assignmentVerification = await verifyAssignmentYield({
			contract: args.assignmentContract,
			lastYield,
			monitor,
			runners: args.assignmentVerifierRunners,
			actualChangedFiles: args.actualChangedFiles,
		});
		progress.assignmentVerificationStatus = assignmentVerification.verification.verified
			? "verified"
			: "verification_failed";
		progress.failureClass = assignmentVerification.failureClass;
		progress.isError = assignmentVerification.isError;
		if (assignmentVerification.isError) {
			exitCode = 1;
			const reasons = assignmentVerification.verification.reasons.join("; ");
			stderr = [stderr, reasons ? `assignment verification failed: ${reasons}` : "assignment verification failed"]
				.filter(Boolean)
				.join("\n");
		}
	}
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (args.artifactsDir) {
		outputPath = path.join(args.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
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
	if (runtimeLimitExceeded && args.assignmentContract) {
		progress.assignmentVerificationStatus = "verification_failed";
		progress.failureClass = "timeout";
		progress.isError = true;
	}
	if (args.assignmentContract && exitCode !== 0) {
		progress.assignmentVerificationStatus = "verification_failed";
		progress.failureClass ??= "liveness";
		progress.isError = true;
	}
	const wasAborted =
		runtimeLimitExceeded || abortedViaYield || (!hasYield && (done.aborted || signal?.aborted || false));
	const finalAbortReason = wasAborted
		? runtimeLimitExceeded
			? monitor.resolveAbortReasonText()
			: abortedViaYield
				? yieldAbortReason
				: (done.abortReason ??
					(signal?.aborted ? monitor.resolveSignalAbortReason() : monitor.resolveAbortReasonText()))
		: undefined;
	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	monitor.scheduleProgress(true);

	// Emit lifecycle end event after finalization so yield status is reflected
	if (args.eventBus) {
		args.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: args.parentToolCallId,
			detached: args.detached,
			agentSource: agent.source,
			description: args.description,
			status: progress.status as "completed" | "failed" | "aborted",
			sessionFile: args.sessionFile,
			index,
		});
	}

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: args.description,
		executionProfile: args.executionProfile,
		toolProfile: args.toolProfile,
		collaborationPolicy: args.collaborationPolicy,
		assignmentContract: args.assignmentContract,
		assignmentVerificationStatus: progress.assignmentVerificationStatus,
		contractDigest: args.assignmentContract?.digest,
		contractRevision: args.assignmentContract?.revision,
		failureClass: progress.failureClass,
		recoveryAttempt: args.recoveryAttempt?.attempt,
		recoveryTier: args.recoveryAttempt?.tier,
		recoveryProvider: args.recoveryAttempt?.provider,
		nextRecoveryAction: progress.nextRecoveryAction,
		isError: args.assignmentContract ? progress.isError === true || wasAborted || exitCode !== 0 : undefined,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		durationMs: Date.now() - args.startTime,
		tokens: progress.tokens,
		requests: progress.requests,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		modelOverride,
		resolvedModel: progress.resolvedModel,
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
		fusionSidekick,
		id,
		worktree,
		modelOverride,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
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
	// Stamp the subagent's service tier: a concrete `serviceTierSubagent` wins,
	// `"inherit"` follows the parent's live effective tier (options.parentServiceTier)
	// or, absent a live session, the parent's configured `serviceTier` setting.
	const subagentServiceTier = resolveSubagentServiceTier(
		settings.get("serviceTierSubagent"),
		settings.get("serviceTier"),
		options.parentServiceTier,
	);
	const subagentSettings = createSubagentSettings(settings, {
		serviceTier: subagentServiceTier,
		...(agent.readSummarize === false ? { "read.summarize.enabled": false } : undefined),
	});
	const executionProfile = options.executionProfile ?? options.spawnPlan?.profile;
	const toolPolicyActive =
		options.executionProfile !== undefined ||
		options.spawnPlan !== undefined ||
		options.assignmentContract !== undefined;
	const toolProfile =
		options.toolProfile ??
		(toolPolicyActive
			? resolveToolProfile({ execution: executionProfile, agentTools: agent.tools, requireYield: true })
			: undefined);
	const collaborationPolicy =
		options.collaborationPolicy ??
		(executionProfile
			? resolveCollaborationPolicy({ mode: executionProfile.collaboration, parentId: options.parentAgentId })
			: undefined);
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	// Tailored specialist identity for this spawn. `subagentRole` is the full
	// (trimmed) role text fed to the system-prompt preamble; `subagentDisplayName`
	// is the label-normalized form the registry/roster show, falling back to the
	// agent type name when no role was given.
	const subagentRole = options.role?.trim() || undefined;
	const subagentDisplayName = resolveSubagentDisplayName(options.role, agent.name);
	const maxRuntimeMs = Math.max(
		0,
		Math.trunc(Number(options.maxRuntimeMs ?? settings.get("task.maxRuntimeMs") ?? 0) || 0),
	);
	// TTL before an adopted idle subagent is parked by the lifecycle manager.
	// <= 0 disables parking (the session stays live until process teardown).
	const agentIdleTtlMs = Math.trunc(Number(settings.get("task.agentIdleTtlMs") ?? 420_000) || 0);
	const configuredDefaultBudget = Math.max(
		0,
		Math.trunc(Number(settings.get("task.softRequestBudget") ?? SOFT_REQUEST_BUDGET.default) || 0),
	);
	const agentDefaultBudget =
		configuredDefaultBudget === 0 ? 0 : (SOFT_REQUEST_BUDGET[agent.name] ?? configuredDefaultBudget);
	const plannedRequestBudget = options.spawnPlan?.maxRequests ?? executionProfile?.maxRequests ?? 0;
	const softRequestBudget =
		agentDefaultBudget <= 0
			? plannedRequestBudget
			: plannedRequestBudget <= 0
				? agentDefaultBudget
				: Math.min(agentDefaultBudget, plannedRequestBudget);
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;

	// Add tools if specified
	let toolNames: string[] | undefined;
	if (agent.tools && agent.tools.length > 0) {
		toolNames = agent.tools;
		// Auto-include task tool if spawns defined but task not in tools
		if (agent.spawns !== undefined && !toolNames.includes("task") && !atMaxDepth) {
			toolNames = [...toolNames, "task"];
		}
	}

	if (atMaxDepth && toolNames?.includes("task")) {
		toolNames = toolNames.filter(name => name !== "task");
	}
	// IRC is always available; the COOP prompt section advertises it, so a restricted
	// whitelist must still carry `irc` for the subagent to actually use it.
	if (toolNames && !toolNames.includes("irc")) {
		toolNames = [...toolNames, "irc"];
	}
	if (toolNames?.includes("exec")) {
		const allowEvalPy = settings.get("eval.py") ?? true;
		const allowEvalJs = settings.get("eval.js") ?? true;
		const expanded = toolNames.filter(name => name !== "exec");
		if (allowEvalPy || allowEvalJs) expanded.push("eval");
		expanded.push("bash");
		toolNames = Array.from(new Set(expanded));
	}
	if (toolNames && toolProfile) {
		toolNames = filterAutoToolNames(toolProfile, toolNames);
	}

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;
	const ircEnabled =
		isIrcEnabled(subagentSettings, childDepth) &&
		(!toolProfile || filterAutoToolNames(toolProfile, ["irc"]).length > 0);
	const skipPythonPreflight = Array.isArray(toolNames) && !toolNames.includes("eval");

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task,
		assignment,
		description: options.description,
		modelOverride,
		signal,
		onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		softRequestBudget,
		maxRuntimeMs,
	});
	const progress = monitor.progress;
	progress.executionProfile = executionProfile;
	progress.toolProfile = toolProfile;
	progress.collaborationPolicy = collaborationPolicy;
	progress.assignmentContract = options.assignmentContract;
	progress.recoveryAttempt = options.recoveryAttempts?.at(-1)?.attempt;
	progress.recoveryTier = options.recoveryAttempts?.at(-1)?.tier;
	progress.recoveryProvider = options.recoveryAttempts?.at(-1)?.provider;
	let unsubscribe: (() => void) | null = null;
	let reviveSession: (() => Promise<AgentSession>) | null = null;
	// Adopted (kept-alive) subagents flip registry status from session events on
	// later turns: revive/wake → running, turn drained → idle. The subscription
	// intentionally survives this run; a disposed session emits nothing, so it
	// needs no teardown.
	const installRegistryStatusSync = (target: AgentSession): void => {
		target.subscribe(event => {
			if (event.type === "agent_start") {
				AgentRegistry.global().setStatus(id, "running");
			} else if (event.type === "agent_end") {
				AgentRegistry.global().setStatus(id, "idle");
			}
		});
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
		let releaseProviderSpawnSlot: (() => void) | undefined;
		// runSubagent defers abort classification to the finally block below; the
		// helper still throws so control flow mirrors the prior inline implementation.
		const { checkAbort, awaitAbortable } = createAbortHelpers(abortSignal, () => {});
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
				await awaitAbortable(modelRegistry.refresh());
			} else {
				logger.debug("runSubagent: reusing parent modelRegistry; skipping refresh");
			}
			checkAbort();
			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed,
				fallbackKind,
			} = typeof modelRegistry.getApiKey === "function"
				? await awaitAbortable(
						resolveModelOverrideWithAuthFallback(
							modelPatterns,
							options.parentActiveModelPattern,
							modelRegistry,
							settings,
						),
					)
				: {
						...resolveModelOverride(modelPatterns, modelRegistry, settings),
						authFallbackUsed: false,
						fallbackKind: undefined,
					};
			if (authFallbackUsed && model) {
				if (fallbackKind === "priority-list") {
					logger.warn(
						"Subagent priority-1 model has no working credentials; falling back to next priority model",
						{
							requested: modelPatterns,
							resolvedProvider: model.provider,
							resolvedModel: model.id,
						},
					);
				} else {
					logger.warn("Subagent model has no working credentials; falling back to parent session model", {
						requested: modelPatterns,
						parentModel: options.parentActiveModelPattern,
						resolvedProvider: model.provider,
						resolvedModel: model.id,
					});
				}
			}
			const retryFallbackRole = installSubagentRetryFallbackChain({
				settings: subagentSettings,
				id,
				candidates: resolveSubagentRetryFallbackCandidates(modelPatterns, modelRegistry, settings),
				model,
				authFallbackUsed,
				fallbackKind,
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
			if (model) {
				progress.resolvedModel = explicitThinkingLevel
					? formatModelSelectorValue(formatModelStringWithRouting(model), resolvedThinkingLevel)
					: formatModelStringWithRouting(model);
			}
			const effectiveThinkingLevel = explicitThinkingLevel
				? resolvedThinkingLevel
				: (thinkingLevel ?? resolvedThinkingLevel);
			resolvedAt = performance.now();

			// Providers with a hard account-level concurrency cap (ollama-cloud)
			// bound concurrent subagent RUNS at the spawn boundary: queue here —
			// before the session is even created — until a slot frees up, instead
			// of bursting every parallel spawn into rate-limit backoff (#3464).
			// acquire(abortSignal) also vacates the queue slot if this spawn is
			// cancelled while waiting.
			const providerSpawnSemaphore = model ? getProviderSpawnSemaphore(model.provider, settings) : undefined;
			if (providerSpawnSemaphore) {
				await providerSpawnSemaphore.acquire(abortSignal);
				releaseProviderSpawnSlot = () => providerSpawnSemaphore.release();
			}
			checkAbort();

			const effectiveCwd = worktree ?? cwd;
			const sessionManager = sessionFile
				? await awaitAbortable(
						SessionManager.open(sessionFile, undefined, undefined, {
							initialCwd: effectiveCwd,
							suppressBreadcrumb: true,
						}),
					)
				: SessionManager.inMemory(effectiveCwd);
			if (options.parentArtifactManager) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			}
			sessionOpenedAt = performance.now();

			const mcpProxyTools = options.mcpManager
				? createMCPProxyTools(options.mcpManager).filter(
						tool => !toolProfile || filterAutoToolNames(toolProfile, [tool.name], "mcp").length > 0,
					)
				: [];
			const enableMCP = !options.mcpManager;

			// Derive subagent-scoped telemetry from the parent's config so the
			// child loop's spans nest under the parent's active execute_tool span
			// (OTEL context propagation handles parent linkage automatically),
			// carry the subagent's own agent identity, and use the subagent's
			// own session id for `gen_ai.conversation.id`.
			const subagentAgentIdentity: AgentIdentity | undefined = options.parentTelemetry
				? {
						id,
						name: subagentDisplayName,
						description: subagentRole ? oneLineLabel(subagentRole) : agent.description,
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

			// Fusion cost mode bounds only the persistent warm sidekick's turns
			// (including reused IRC-woken turns) to `fusion.sidekickRequestBudget`
			// model requests; 0 = unlimited. Ordinary subagents remain governed by
			// the generic task budget even when Fusion is enabled.
			const fusionRequestBudget =
				fusionSidekick && settings.get("fusion.enabled") === true && settings.get("fusion.mode") !== "off"
					? settings.get("fusion.sidekickRequestBudget")
					: 0;
			const maxModelRequestsPerRun = fusionRequestBudget > 0 ? fusionRequestBudget : undefined;

			// Captured by the lifecycle reviver: rebuilding an equivalent session from
			// the same JSONL file re-invokes createAgentSession with the exact options
			// of the original run (same agent id, tools, model, system prompt,
			// artifacts dir) — only the SessionManager differs.
			// Fork mode (U11): byte-identical prefix with the parent — same system
			// prompt (no subagent preamble), same tool set (including no yield
			// tool), same model unless explicitly overridden — so the provider
			// re-reads the parent's warm cache. Output falls back to the final
			// assistant text (finalizeSubprocessOutput's schemaless raw-output
			// path); output schemas are unsupported in fork mode.
			const fork = options.contextMode === "fork" && options.forkContext !== undefined ? options.forkContext : null;
			const buildSubagentSessionOptions = (sessionManagerForRun: SessionManager): CreateAgentSessionOptions => ({
				cwd: worktree ?? cwd,
				authStorage,
				modelRegistry,
				settings: subagentSettings,
				model: fork && !options.modelOverride ? (fork.model ?? model) : model,
				thinkingLevel: effectiveThinkingLevel,
				toolNames: fork ? fork.toolNames : toolNames,
				outputSchema: fork ? undefined : outputSchema,
				requireYieldTool: !fork,
				contextFiles: options.contextFiles,
				skills: options.skills,
				promptTemplates: options.promptTemplates,
				workspaceTree: options.workspaceTree,
				rules: options.rules,
				preloadedExtensionPaths: options.preloadedExtensionPaths,
				preloadedCustomToolPaths: options.preloadedCustomToolPaths,
				systemPrompt: defaultPrompt => {
					if (fork) return fork.systemPrompt;
					const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
						agent: agent.systemPrompt,
						role: subagentRole ? oneLineLabel(subagentRole) : "",
						context: options.context?.trim() ?? "",
						planReference: options.planReference?.content ?? "",
						planReferencePath: options.planReference?.path ?? "",
						worktree: worktree ?? "",
						outputSchema: normalizedOutputSchema,
						ircPeers: ircEnabled ? renderIrcPeerRoster(id) : "",
						ircSelfId: ircEnabled ? id : "",
					});
					const contractPrompt = options.assignmentContract
						? `${prompt.render(assignmentContractPromptTemplate, {})}\n\n\`\`\`json\n${JSON.stringify(options.assignmentContract, null, 2)}\n\`\`\``
						: undefined;
					const recoveryPrompt = options.recoveryCapsule
						? `# Recovery Capsule\n\nThis is a fresh child. Use only this compact failure capsule; do not request or reconstruct the failed transcript.\n\n\`\`\`json\n${JSON.stringify(options.recoveryCapsule, null, 2)}\n\`\`\``
						: undefined;
					const harnessGuidancePrompt = options.harnessGuidance
						? `<harness-guidance>\n${options.harnessGuidance}\n</harness-guidance>`
						: undefined;
					const prompts =
						defaultPrompt.length === 0
							? [subagentPrompt]
							: [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
					return [...prompts, harnessGuidancePrompt, contractPrompt, recoveryPrompt].filter(
						(value): value is string => value !== undefined,
					);
				},
				sessionManager: sessionManagerForRun,
				hasUI: false,
				spawns: spawnsEnv,
				taskDepth: childDepth,
				maxModelRequestsPerRun,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
				parentTaskPrefix: id,
				parentAgentId: options.parentAgentId,
				agentId: id,
				agentDisplayName: subagentDisplayName,
				agentColor: options.color,
				enableLsp: lspEnabled,
				skipPythonPreflight,
				enableMCP,
				mcpManager: options.mcpManager,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
				customToolSources:
					mcpProxyTools.length > 0 ? new Map(mcpProxyTools.map(tool => [tool.name, "mcp" as const])) : undefined,
				clientBridge: options.clientBridge,
				localProtocolOptions: options.localProtocolOptions,
				telemetry: subagentTelemetry,
				parentEvalSessionId: options.parentEvalSessionId,
				executionProfile,
				toolProfile,
				collaborationPolicy,
				assignmentContractActive: options.assignmentContract !== undefined,
				onFirstChatDispatch: () => {
					firstChatDispatchAt ??= performance.now();
				},
			});

			const sessionPromise = createAgentSession(buildSubagentSessionOptions(sessionManager)).then(created => {
				// Fork mode: seed the read-only parent-history snapshot so the wire
				// context is parent prefix + this task's user message. Agent-state
				// only (not persisted as branch entries): the fork is ephemeral and
				// its own prompts/results persist normally after the snapshot.
				if (fork) created.session.agent.replaceMessages([...fork.messages]);
				return created;
			});
			let session: AgentSession;
			try {
				({ session } = await awaitAbortable(sessionPromise));
			} catch (err) {
				// Abort raced session startup. The session may still resolve later
				// holding live LSP/MCP child processes — dispose it when it does so
				// a cancelled subagent cannot leak them.
				void sessionPromise.then(created => created.session.dispose()).catch(() => {});
				throw err;
			}
			sessionCreatedAt = performance.now();

			monitor.setActiveSession(session);
			installRegistryStatusSync(session);
			if (sessionFile !== null && worktree === undefined) {
				// Lifecycle reviver: park closed the JSONL writer, so reopening takes
				// the single-writer lock cleanly and restores the full message history
				// (createAgentSession → agent.replaceMessages). Isolated runs are not
				// resumable (worktree is merged + cleaned) and never get a reviver.
				reviveSession = async () => {
					const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
						suppressBreadcrumb: true,
					});
					if (options.parentArtifactManager) {
						reopened.adoptArtifactManager(options.parentArtifactManager);
					}
					const { session: revived } = await createAgentSession(buildSubagentSessionOptions(reopened));
					installRegistryStatusSync(revived);
					return revived;
				};
			}

			// Emit lifecycle start event
			if (options.eventBus) {
				options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					parentToolCallId: options.parentToolCallId,
					detached: options.detached,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: subtaskSessionFile,
					index,
				});
			}

			const subagentToolNames = session.getActiveToolNames();
			const parentOwnedToolNames = new Set(["todo"]);
			const filteredSubagentTools = subagentToolNames.filter(name => !parentOwnedToolNames.has(name));
			if (filteredSubagentTools.length !== subagentToolNames.length) {
				await awaitAbortable(session.setActiveToolsByName(filteredSubagentTools));
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
				task,
				tools: session.getActiveToolNames(),
				spawns: spawnsEnv,
				readSummarize: agent.readSummarize,
				fusionSidekick,
				maxModelRequestsPerRun,
				outputSchema,
				executionProfile,
				collaborationPolicy: collaborationPolicy ? serializeCollaborationPolicy(collaborationPolicy) : undefined,
				toolCeiling: toolProfile?.maximum,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void session.abort();
				},
				{ once: true, signal: sessionAbortController.signal },
			);
			// Defensive: if the wall-clock timer (or external signal) fired during
			// the awaited setup above, the listener registration races the dispatch
			// and may not observe the already-fired abort event. Mirror it manually.
			if (abortSignal.aborted) {
				void session.abort();
			}

			const pendingExtensionMessages: Array<Promise<unknown>> = [];
			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							const sendPromise = session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						sendUserMessage: (content, options) => {
							const sendPromise = session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getActiveTools: () => session.getActiveToolNames(),
						getAllTools: () => session.getAllToolNames(),
						setActiveTools: (toolNames: string[]) =>
							session.setActiveToolsByName(toolNames.filter(name => !parentOwnedToolNames.has(name))),
						getCommands: () => getSessionSlashCommands(session),
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort({ reason: USER_INTERRUPT_LABEL }),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
					},
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", { path: err.extensionPath, error: err.error });
				});
				await awaitAbortable(extensionRunner.emit({ type: "session_start" }));
				while (pendingExtensionMessages.length > 0) {
					await awaitAbortable(Promise.all(pendingExtensionMessages.splice(0)));
				}
			}

			unsubscribe = monitor.attach(session);

			checkAbort();
			// Autoload skills via sendCustomMessage (same mechanic as /skill:<name>)
			if (options.autoloadSkills?.length) {
				for (const skill of options.autoloadSkills) {
					const { message } = await buildSkillPromptMessage(skill, "");
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
			const outcome = await driveSessionToYield(session, monitor, task);
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
			releaseProviderSpawnSlot?.();
			releaseProviderSpawnSlot = undefined;
			if (abortSignal.aborted) {
				aborted = monitor.isAbortedRun();
				if (aborted) {
					abortReasonText ??= monitor.resolveAbortReasonText();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			const session = monitor.takeActiveSession();
			if (session) {
				monitor.captureSalvage(session);
				await finalizeSubagentLifecycle({
					id,
					session,
					aborted,
					keepAlive: options.keepAlive !== false,
					isolated: worktree !== undefined,
					agentIdleTtlMs,
					reviveSession,
				});
			}
		}

		// Launch-latency breakdown (subagent invocation → first chat dispatch).
		// Phase deltas are performance.now() spans; the semaphore brackets use the
		// Date.now epochs captured by the spawn site (invokedAt before acquire,
		// acquiredAt after) so queue wait and pre-run setup are reported apart.
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

	const settled = await finalizeRunResult({
		monitor,
		done,
		index,
		id,
		agent,
		task,
		assignment,
		description: options.description,
		modelOverride,
		outputSchema,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		startTime,
		executionProfile,
		toolProfile,
		collaborationPolicy,
		assignmentContract: options.assignmentContract,
		assignmentVerifierRunners: options.assignmentVerifierRunners,
		actualChangedFiles: options.actualChangedFiles,
		recoveryAttempt: options.recoveryAttempts?.at(-1),
	});

	const terminalFailure = settled.exitCode !== 0 || settled.isError === true || settled.aborted === true;
	if (!terminalFailure || !options.assignmentContract || !options.spawnPlan || signal?.aborted) {
		return settled;
	}

	const failure = recoveryFailureFacts(settled);
	const requestFallbackExhausted = failure.class !== "spawn_transport" || settled.retryFailure !== undefined;
	if (!requestFallbackExhausted) return settled;
	// A terminal auto-retry failure is emitted only after AgentSession scans the
	// ordered runtime fallback chain and finds no usable candidate. Non-transport
	// assignment failures have no pending request-level fallback by definition.
	const previousAttempts = options.recoveryAttempts?.length
		? [...options.recoveryAttempts]
		: [seedFailedRecoveryAttempt(options, settled)].filter(
				(attempt): attempt is RecoveryAttempt => attempt !== undefined,
			);
	const decision = nextRecoveryAttempt({
		workClass: options.spawnPlan.profile.workClass,
		eligible: options.spawnPlan.eligible,
		previousAttempts,
		suppressedProviders: options.recoverySuppressedProviders,
		outcome: {
			terminal: true,
			failedChildId: settled.id,
			failure,
		},
		requestFallbackRemaining: false,
		contract: options.assignmentContract,
		profileSnapshotRefs: [`spawn-plan:${options.spawnPlan.correlationId}`],
		verifiedArtifactRefs:
			settled.assignmentVerificationStatus === "verified" && settled.outputPath ? [settled.outputPath] : undefined,
		verifiedPatchRefs: settled.patchPath ? [settled.patchPath] : undefined,
	});
	settled.failureClass = failure.class;
	settled.nextRecoveryAction = decision.action;
	progress.failureClass = failure.class;
	progress.nextRecoveryAction = decision.action;
	progress.isError = true;
	if (decision.action === "retry") {
		progress.recoveryAttempt = decision.attempt.attempt;
		progress.recoveryTier = decision.attempt.tier;
		progress.recoveryProvider = decision.attempt.provider;
	}
	options.onProgress?.({ ...progress, recentTools: progress.recentTools.slice() });

	if (decision.action === "stop") {
		settled.isError = true;
		return settled;
	}

	let recoveryId: string;
	try {
		recoveryId = options.allocateRecoveryId
			? await options.allocateRecoveryId(decision.attempt)
			: `task-recovery-${randomUUID()}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		settled.stderr = [settled.stderr, `fresh-child recovery allocation failed: ${message}`]
			.filter(Boolean)
			.join("\n");
		settled.error = settled.stderr;
		settled.isError = true;
		return settled;
	}

	const invokedAt = Date.now();
	return runSubprocess({
		...options,
		id: recoveryId,
		modelOverride: [decision.attempt.selector],
		maxRuntimeMs: decision.attempt.maxRuntimeMs,
		recoveryCapsule: decision.capsule,
		recoveryAttempts: [...previousAttempts, decision.attempt],
		recoverySuppressedProviders: decision.suppressedProviders,
		invokedAt,
		acquiredAt: invokedAt,
	});
}
