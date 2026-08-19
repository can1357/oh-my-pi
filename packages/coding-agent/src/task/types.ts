import type { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Usage } from "@pk-nerdsaver-ai/pi-ai";
import { $env } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import type { AgentPrefetch } from "../discovery/helpers";
import type { AgentExecutionProfile, AgentTier, CollaborationMode } from "../orchestration/agent-execution-profile";
import type { CollaborationPolicy } from "../orchestration/collaboration-policy";
import type { ContextPolicy } from "../orchestration/context-policy";
import type { SubagentModelRoutingDecision, SubagentTaskDifficulty } from "../orchestration/subagent-model-routing";
import type { AgentSessionEvent } from "../session/agent-session";
import type { ResolvedToolProfile } from "../tools/tool-profiles";
import type { AssignmentContract } from "./assignment-contract";
import type { AssignmentFailureClass, RecoveryAttempt, RecoveryCapsule, RecoveryDecision } from "./recovery-policy";
import type { NestedRepoPatch } from "./worktree";
import type { WriteScope } from "./write-scope";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

export type AssignmentVerificationStatus = "submitted" | "verifying" | "verified" | "verification_failed";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** EventBus channel for subagent lifecycle (start/end) */
export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	/** See {@link SubagentLifecyclePayload.detached}. */
	detached?: boolean;
}

/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	/**
	 * Spawn runs as a detached background job: the parent turn keeps working
	 * while this agent runs. Sync task spawns (parent blocked on the call) and
	 * eval `agent()` bridge spawns (rendered inside their eval cell) leave this
	 * unset — surfaces like the subagent HUD only list detached spawns.
	 */
	detached?: boolean;
}

/** Display cap for a normalized one-line label (roster line, registry `displayName`, prompt field). */
export const ROLE_LABEL_MAX = 80;
/** Schema bound on the raw `role` input, before it is label-normalized at every use site. */
export const ROLE_INPUT_MAX = 256;
const ROLE_INPUT_SCHEMA = `string <= ${ROLE_INPUT_MAX}` as const;

export const taskItemSchema = type({
	"id?": "string",
	"description?": "string",
	"role?": ROLE_INPUT_SCHEMA,
	"model?": "string",
	"difficulty?": "'low'|'medium'|'high'",
	assignment: "string",
	"fork?": "boolean",
	"cwd?": "string",
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"id?": "string",
	"description?": "string",
	"role?": ROLE_INPUT_SCHEMA,
	assignment: "string",
	"model?": "string",
	"difficulty?": "'low'|'medium'|'high'",
	"isolated?": "boolean",
	"fork?": "boolean",
	"cwd?": "string",
	"+": "delete",
});

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	/** Stable agent id; default = generated AdjectiveNoun. */
	id?: string;
	/** UI label, not seen by the subagent. */
	description?: string;
	/** Specialist role/expertise this subagent embodies; shapes its system-prompt identity and display name. */
	role?: string;
	/** Explicit model selector for this spawn; resolves through subagent aliases/catalog before agent defaults. */
	model?: string;
	/** Requested subtask difficulty; independent from execution tier. Maps deterministically to `pi/smol` | `pi/task` | `pi/slow` via `resolveSubagentModelRouting`. */
	difficulty?: SubagentTaskDifficulty;
	/** The work; required by the schema. */
	assignment?: string;
	/** Run this spawn in an isolated worktree (batch form; flat form carries it top-level). */
	isolated?: boolean;
	/**
	 * Fork mode: instead of a fresh context, inherit the parent's exact prefix
	 * — system prompt, tool set, model, and a read-only snapshot of parent
	 * history — so the provider prompt cache is re-read instead of rebuilt.
	 * For quick in-context lookups; ignores output schemas and agent-specific
	 * prompts/tools.
	 */
	fork?: boolean;
	/** Working directory for this spawn; defaults to parent session cwd. */
	cwd?: string;
	/** Frozen execution envelope resolved before spawn allocation. */
	executionProfile?: AgentExecutionProfile;
	/** Resolved source-aware tool ceiling for the child. */
	toolProfile?: ResolvedToolProfile;
	/** Runtime collaboration authorization applied to the child. */
	collaborationPolicy?: CollaborationPolicy;
	/** Explicit assignment contract used for verified execution. */
	assignmentContract?: AssignmentContract;
	/** Stable identifier for the causal/implementation family in orchestration portfolios. */
	strategyFamily?: string;
	/** How much shared batch context this spawn receives. */
	contextPolicy?: ContextPolicy;
	/** Declared concurrent write ownership; internal-only and not wire parsed. */
	writeScope?: WriteScope;
	/** Staged synthesis: reveal first-pass sibling findings instead of blind header. */
	revealSiblingFindings?: boolean;
	/** Findings from sibling workers for staged synthesis phase. */
	siblingFindings?: string;
	/** Fresh-child recovery capsule; absent for initial and legacy spawns. */
	recoveryCapsule?: RecoveryCapsule;
	/** Planned fresh-child recovery attempt. */
	recoveryAttempt?: RecoveryAttempt;
}

export const taskSchema = type({
	agent: "string",
	"id?": "string",
	"description?": "string",
	"role?": ROLE_INPUT_SCHEMA,
	"model?": "string",
	"difficulty?": "'low'|'medium'|'high'",
	assignment: "string",
	"isolated?": "boolean",
	"fork?": "boolean",
	"cwd?": "string",
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	agent: "string",
	"id?": "string",
	"description?": "string",
	"role?": ROLE_INPUT_SCHEMA,
	"model?": "string",
	"difficulty?": "'low'|'medium'|'high'",
	assignment: "string",
	"fork?": "boolean",
	"cwd?": "string",
	"+": "delete",
});
const taskSchemaBatch = type({
	agent: "string",
	context: "string",
	tasks: taskItemSchemaIsolated.array(),
	"+": "delete",
});
const taskSchemaBatchNoIsolation = type({
	agent: "string",
	context: "string",
	tasks: taskItemSchema.array(),
	"+": "delete",
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema;

export function getTaskSchema(options: { isolationEnabled: boolean; batchEnabled: boolean }): DynamicTaskSchema {
	if (options.batchEnabled) {
		return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
	}
	return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
}

/**
 * Runtime params union over both wire shapes. The model sees exactly one shape
 * (`{ agent, context, tasks[] }` when `task.batch` is on, `{ agent, ...item }`
 * otherwise); runtime stays permissive so internal callers and stale
 * transcripts using the flat form keep working under either setting.
 */
export interface TaskParams {
	/** Agent type; required. */
	agent?: string;
	/** Stable agent id (flat form); default = generated AdjectiveNoun. */
	id?: string;
	/** UI label (flat form), not seen by the subagent. */
	description?: string;
	/** Specialist role/expertise this subagent embodies; shapes its system-prompt identity and display name. */
	role?: string;
	/** Explicit model selector for this spawn; resolves through subagent aliases/catalog before agent defaults. */
	model?: string;
	/** Requested subtask difficulty (flat form). See {@link TaskItem.difficulty}. */
	difficulty?: SubagentTaskDifficulty;
	/** The work (flat form). */
	assignment?: string;
	/** Batch form (`task.batch`): one subagent per item. */
	tasks?: TaskItem[];
	/** Batch form: shared background prepended to every assignment; required by the batch schema. */
	context?: string;
	/** Run in an isolated worktree (flat form; per-item in batch form). */
	isolated?: boolean;
	/** Fork mode (flat form): inherit the parent's exact prefix + history snapshot. See {@link TaskItem.fork}. */
	fork?: boolean;
	/** Working directory override for this spawn (flat form); defaults to parent session cwd. */
	cwd?: string;
}

/**
 * One-line, length-capped label safe for a single roster line, a registry
 * `displayName`, or a system-prompt field. Collapses every run of whitespace
 * AND control/format characters — including U+0085 NEL, ESC/ANSI, and the
 * zero-width separators that `\s` misses — to a single space, then caps length.
 * So untrusted text (a spawn `role`, a peer activity gist) can neither break the
 * line, inject prompt structure, nor smuggle terminal escapes. Caps at `max`
 * characters (clamped to >= 1; default `ROLE_LABEL_MAX`), appending an ellipsis when truncated.
 */
export function oneLineLabel(text: string, max = ROLE_LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	// Count/cut by code point, not UTF-16 code unit, so truncation can never
	// split an astral character into a lone surrogate.
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}

/**
 * Display name for a spawned subagent: its tailored `role` (label-normalized)
 * when one is given, else the agent type's name. Empty/whitespace roles fall
 * back to the agent name.
 */
export function resolveSubagentDisplayName(role: string | undefined, agentName: string): string {
	const trimmed = role?.trim();
	return trimmed ? oneLineLabel(trimmed) : agentName;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Optional pre-run context prefetcher for read-only repo scouting. */
	prefetch?: AgentPrefetch;
	source: AgentSource;
	filePath?: string;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	executionProfile?: AgentExecutionProfile;
	toolProfile?: ResolvedToolProfile;
	collaborationPolicy?: CollaborationPolicy;
	assignmentContract?: AssignmentContract;
	/** Declared concurrent write ownership for spawn observability. */
	writeScope?: WriteScope;
	assignmentVerificationStatus?: AssignmentVerificationStatus;
	profileTier?: AgentTier;
	collaborationMode?: CollaborationMode;
	failureClass?: AssignmentFailureClass;
	recoveryAttempt?: number;
	recoveryTier?: AgentTier;
	recoveryProvider?: string;
	nextRecoveryAction?: RecoveryDecision["action"];
	isError?: boolean;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	/** Count of assistant requests (assistant message_end events) across the run. Drives the soft request budget guard. */
	requests: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/**
	 * Current per-turn context size: latest assistant message's `usage.totalTokens`.
	 * This is the number to compare against `contextWindow` — what compaction
	 * decides on, what the user typically reads as "how full is the context".
	 * Distinct from `tokens`, which is a lifetime billing-volume counter.
	 */
	contextTokens?: number;
	/** Model's context window in tokens, when known. Lets the UI render `<curr>/<window>` gauges. */
	contextWindow?: number;
	/** Cumulative billing cost in USD, accumulated incrementally from message_end events. */
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Undefined when the model could not be resolved. */
	resolvedModel?: string;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Auto-retry state when the subagent is sleeping between provider retries
	 * (e.g. 429 rate-limit with retry-after). Cleared when the retry resolves
	 * or fails. Surfacing this to the parent prevents the task tool from
	 * looking indefinitely "in progress" when a child is actually blocked on
	 * provider quota.
	 */
	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};
	/**
	 * Terminal retry failure surfaced once the subagent gave up retrying
	 * (e.g. retry-after exceeded the cap, or all attempts exhausted). Carries
	 * the final error so the parent UI can render "blocked: rate-limited"
	 * instead of waiting for a status that never arrives.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/**
	 * Snapshot of the most recent `task` tool call's in-flight `TaskToolDetails`,
	 * captured from `tool_execution_update`. Lets the parent UI surface live
	 * nested-subagent progress while this agent is still inside its own `task`
	 * call. Cleared when the call ends — finalized data lives in
	 * `extractedToolData.task` after that.
	 */
	inflightTaskDetails?: TaskToolDetails;
	/** Deterministic model-routing provenance for this spawn's resolved route. Immutable; absent for legacy no-difficulty/no-explicit-model spawns predating this field. */
	readonly modelRouting?: SubagentModelRoutingDecision;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	description?: string;
	executionProfile?: AgentExecutionProfile;
	toolProfile?: ResolvedToolProfile;
	collaborationPolicy?: CollaborationPolicy;
	assignmentContract?: AssignmentContract;
	assignmentVerificationStatus?: AssignmentVerificationStatus;
	contractDigest?: string;
	contractRevision?: number;
	failureClass?: AssignmentFailureClass;
	recoveryAttempt?: number;
	recoveryTier?: AgentTier;
	recoveryProvider?: string;
	nextRecoveryAction?: RecoveryDecision["action"];
	isError?: boolean;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/** Count of assistant requests (assistant message_end events) across the run. */
	requests: number;
	/** Latest per-turn context size at task completion. See `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Model's context window in tokens, when known. */
	contextWindow?: number;
	modelOverride?: string | string[];
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Omitted from tool-result JSON when undefined to keep wire payloads small. */
	resolvedModel?: string;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Terminal retry failure, when the subagent exited because the auto-retry
	 * loop gave up (retry-after exceeded the cap, or all attempts exhausted).
	 * Lets the parent task tool surface a "blocked: rate-limited" outcome
	 * instead of a generic failure.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
	/** Deterministic model-routing provenance for this spawn's resolved route. Immutable. See {@link AgentProgress.modelRouting}. */
	readonly modelRouting?: SubagentModelRoutingDecision;
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}
