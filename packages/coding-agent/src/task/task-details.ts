import { type } from "@oh-my-pi/omptype";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "../utils/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Formats sanitized task identifiers as hierarchy breadcrumbs. */
export function formatTaskId(id: string): string {
	// Ids are name-based (e.g. "Anna", "Anna-2"); a "." separates nesting levels
	// (e.g. "Anna.Bob"). Render the hierarchy with a ">" breadcrumb.
	const sanitizedId = sanitizeText(id);
	const segments = sanitizedId.split(".");
	return segments.length < 2 ? sanitizedId : segments.join(">");
}

/** Tests whether a persisted tool result carries a task snapshot. */
export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/**
 * Enforcement policy for a structured subagent output schema.
 *
 * `permissive` preserves legacy retry-budget overrides; `strict` turns every
 * invalid final payload, including an exhausted retry override, into a failed
 * `schema_violation` result.
 */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Origin of the schema selected for a structured subagent invocation. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final validation state of a structured subagent invocation. */
export type StructuredSubagentValidationStatus = "valid" | "invalid" | "unavailable";

/**
 * Parsed structured completion and its schema-validation metadata.
 *
 * `data` is present whenever a payload could be assembled or parsed, even when
 * strict validation rejects it. `error` explains unavailable or invalid
 * validation without requiring consumers to parse presentation text.
 */
export interface StructuredSubagentOutput {
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	status: StructuredSubagentValidationStatus;
	data?: unknown;
	error?: string;
}

/** Display cap for a normalized one-line label (roster line, registry `displayName`, prompt field). */
export const LABEL_MAX = 80;

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	/** Stable agent name; becomes the registry/IRC id. Default = generated AdjectiveNoun. */
	name?: string;
	/** Agent type to run this item (e.g. "scout"). Defaults to the spawn policy's default agent. */
	agent?: string;
	/** One exact per-call model, gated by `task.perCallModel`. */
	model?: string;
	/** Inline instructions; exactly one of task or steps is required. */
	task?: string;
	/** Ordered stages sent instead of `task` (`task.steps`), each once the child delivered the previous (several share a prompt past four). */
	steps?: string[];
	/** How open-ended the work is; required by the schema and the child's sole `auto` thinking classification input. */
	solutionSpace?: string;
	/** Per-spawn thinking effort: lowest/middle/highest level the resolved model supports. Overrides the agent's default selector (e.g. `auto`). */
	effort?: "lo" | "med" | "hi";
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Eval-defined tool names exposed to this child. */
	tools?: string[];
	/** Run this spawn in an isolated worktree (batch form; flat form carries it top-level). */
	isolated?: boolean;
}

/**
 * Runtime params union over both wire shapes. The model sees exactly one shape
 * (`{ context, tasks[] }` when `task.batch` is on, `{ name?, agent?, task }`
 * otherwise); runtime stays permissive so internal callers and stale
 * transcripts using the flat form keep working under either setting.
 */
export interface TaskParams {
	/** Stable agent name (flat form). */
	name?: string;
	/** Agent type to spawn (flat form); omitted values resolve from the session spawn policy. */
	agent?: string;
	/** See {@link TaskItem.model}. */
	model?: string;
	/** The work (flat form). */
	task?: string;
	/** Ordered stages (flat form); see {@link TaskItem.steps}. */
	steps?: string[];
	/** How open-ended the work is (flat form); see {@link TaskItem.solutionSpace}. */
	solutionSpace?: string;
	/** Per-spawn thinking effort (flat form): lowest/middle/highest level the resolved model supports. */
	effort?: "lo" | "med" | "hi";
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Eval-defined tool names exposed to the flat-form child. */
	tools?: string[];
	/** Batch form (`task.batch`): one subagent per item. */
	tasks?: TaskItem[];
	/** Batch form: shared background prepended to every assignment; required by the batch schema. */
	context?: string;
	/** Run in an isolated worktree (flat form; per-item in batch form). */
	isolated?: boolean;
}

/**
 * One-line, length-capped label safe for a single roster line, a registry
 * `displayName`, or a system-prompt field. Collapses every run of whitespace
 * AND control/format characters — including U+0085 NEL, ESC/ANSI, and the
 * zero-width separators that `\s` misses — to a single space, then caps length.
 * So untrusted text (a generated task label, a peer activity gist) can neither
 * break the line, inject prompt structure, nor smuggle terminal escapes. Caps at
 * `max` characters (clamped to >= 1; default `LABEL_MAX`), appending an ellipsis when truncated.
 */
export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	// Count/cut by code point, not UTF-16 code unit, so truncation can never
	// split an astral character into a lone surrogate.
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
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

/** Details extracted from a subagent `yield` tool call for final-result assembly and task rendering. */
export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	/** A string label is terminal; a non-empty array of labels is incremental. */
	type?: string | string[];
	/** True when an incremental workpool yield completed every item in its batch. */
	complete?: boolean;
	/**
	 * Set by the in-tool yield validator when it exhausted its retry budget and
	 * accepted schema-invalid data anyway. The executor preserves that override
	 * during post-mortem validation.
	 */
	schemaOverridden?: boolean;
}

/**
 * What an agent's model is producing while a response streams: its reasoning, its prose, or a tool
 * call it is still writing, with the call's argument preview and intent so far.
 */
export type AgentStreaming =
	| { kind: "thinking" }
	| { kind: "text" }
	| { kind: "call"; tool: string; args?: string; argsKey?: string; intent?: string };

/**
 * Progress tracking for a single agent.
 *
 * The executor's run monitor replaces a field's value when it changes and never mutates it in
 * place: it publishes a snapshot only when some field other than `durationMs` differs by identity
 * from the last one it sent, so an in-place change would go unpublished until the next heartbeat.
 */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	/** Argument key selected for the display preview, when known. */
	currentToolArgsKey?: string;
	/** Intent the model attached to the current call; undefined when that call carried none. */
	currentToolIntent?: string;
	currentToolStartMs?: number;
	/**
	 * What the model is producing now, while a response streams. A call it finished writing stays
	 * until it starts running ({@link currentTool}); reasoning and prose clear when the response ends.
	 */
	streaming?: AgentStreaming;
	recentTools: Array<{
		tool: string;
		args: string;
		argsKey?: string;
		intent?: string;
		isError?: boolean;
		/** Lines an edit call added and removed, by its diff; absent for other calls and failed ones. */
		added?: number;
		removed?: number;
		endMs: number;
	}>;
	recentOutput: string[];
	toolCount: number;
	/** Count of assistant requests (assistant message_end events) across the run. Drives the soft request budget guard. */
	requests: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/**
	 * Current per-turn occupied context: the latest assistant message's
	 * provider-reported `usage.contextTokens` when present, else its billable
	 * `totalTokens` minus orchestration tokens (the same accounting session
	 * compaction uses). This is the number to compare against `contextWindow` —
	 * what compaction decides on, what the user typically reads as "how full
	 * is the context". Distinct from `tokens`, which is a lifetime
	 * billing-volume counter.
	 */
	contextTokens?: number;
	/** Model's context window in tokens, when known. Lets the UI render `<curr>/<window>` gauges. */
	contextWindow?: number;
	/** Cumulative billing cost in USD, accumulated incrementally from message_end events. */
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Undefined when the model could not be resolved. */
	resolvedModel?: string;
	/** Provider/id including routing, with no added thinking suffix. */
	resolvedModelIdentity?: string;
	/** Explicit thinking metadata; never inferred from the model identity. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when {@link resolvedModel} is the target of an active retry fallback (not the originally configured model). Lets observer-only UIs (collab guests, Agent Hub rows with no live session) flag the fallback and keep the provider. */
	resolvedModelIsFallback?: boolean;
	/** Extension routing note (e.g. model-pools) explaining why {@link resolvedModel} was chosen. */
	resolvedModelRoute?: string;
	/** True when a live advisor was attached to this run's session, not merely enabled in settings. */
	advisor?: boolean;
	/** The agent's latest self-estimate of task completion (0–100), from the periodic `task.completionProbe` side request. */
	completionPercent?: number;
	/**
	 * The agent's current step in its own words (one line, ≤ 80 chars), from the
	 * same probe reply as {@link completionPercent}. Running rows prefer it over
	 * `lastIntent`; the job widget uses it as its stage line.
	 */
	stage?: string;
	/**
	 * What the agent says shows its progress live (one line, ≤ 200 chars), e.g.
	 * "BENCH lines in bg_2 pipe:1, tok_s higher is better, target 70% of roofline";
	 * from the probe reply. Feeds the job widget author's brief; never rendered.
	 */
	watch?: string;
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
}

/** Calls that only block on the caller's own agents or jobs: `wait` (jobs, services, a peer's reply) and `vibe_wait` (vibe workers). */
const WAITING_TOOLS: Readonly<Record<string, true>> = { wait: true, vibe_wait: true };

/**
 * Whether the agent runs, but inside a call that only waits on its own agents
 * or jobs, so it does no work of its own until that call returns. The subagent
 * HUD and the tray show such agents apart from agents at work.
 */
export function isWaitingOnOwnWork(progress: AgentProgress | undefined): boolean {
	const tool = progress?.status === "running" ? progress.currentTool : undefined;
	return tool !== undefined && WAITING_TOOLS[tool] === true;
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
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	/**
	 * Parsed structured completion and validation metadata, when this invocation
	 * selected an output schema or strict schema mode.
	 */
	structuredOutput?: StructuredSubagentOutput;
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
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Omitted from tool-result JSON when undefined to keep wire payloads small. */
	resolvedModel?: string;
	/** Retains the unambiguous identity from {@link AgentProgress.resolvedModelIdentity}. */
	resolvedModelIdentity?: string;
	/** Retains {@link AgentProgress.resolvedThinkingLevel} after settlement. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when {@link resolvedModel} is the target of an active retry fallback. Mirrors {@link AgentProgress.resolvedModelIsFallback} onto the settled result. */
	resolvedModelIsFallback?: boolean;
	/** Mirrors {@link AgentProgress.resolvedModelRoute} onto the settled result. */
	resolvedModelRoute?: string;
	/** Retains {@link AgentProgress.advisor} after the advised session is disposed. */
	advisor?: boolean;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/**
	 * Ran inside an isolation worktree. Such agents are parked without a
	 * reviver once the worktree is torn down, so they are never resumable or
	 * messageable after the run — summaries must not suggest otherwise.
	 */
	isolated?: boolean;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/**
	 * Whether `patchPath` holds a non-empty root-repo diff. `false` when the
	 * agent's changes all live in nested repos (see `nestedPatchPaths`), so
	 * summaries do not claim the root patch captured anything.
	 */
	hasRootChanges?: boolean;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/**
	 * Baseline commit SHA the task branch was created from. Passed to
	 * `mergeTaskBranches` so cherry-pick uses the inclusive range
	 * `branchBaseSha..branchName` and preserves every agent commit's message.
	 */
	branchBaseSha?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/**
	 * On-disk copies of `nestedPatches`, one file per nested repo, written
	 * before the isolation workspace is torn down. The workspace is the only
	 * other copy of that work, so these paths are the durable record.
	 */
	nestedPatchPaths?: string[];
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

/** Patch and baseline metadata for an isolated nested repository. */
export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

/** Severity level of a review finding. */
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

/** Review severity levels in descending priority. */
export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

/** Validated source location and content of a review finding. */
export interface FindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

const FindingDetailsShape = type({
	"+": "delete",
	title: "string",
	body: "string",
	// Older reports wrote the severity as its ordinal.
	priority: type("'P0' | 'P1' | 'P2' | 'P3'").or(type("0 | 1 | 2 | 3").pipe(ordinal => PRIORITY_LABELS[ordinal])),
	confidence: "0 <= number <= 1",
	file_path: "string > 0",
	line_start: "number",
	line_end: "number",
});

/** Validates and normalizes a persisted review finding. */
export function parseFindingDetails(value: unknown): FindingDetails | undefined {
	const details = FindingDetailsShape(value);
	return details instanceof type.errors ? undefined : details;
}

/** SubmitReviewDetails - used for rendering review results from yield tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}
