/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.ompk/agent/agents/*.md (user-level)
 *   - .ompk/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Usage } from "@pk-nerdsaver-ai/pi-ai";
import { $env, getAgentDir, logger, prompt, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import type { ToolSession } from "..";
import { resolveModelOverride } from "../config/model-resolver";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { MCPManager } from "../mcp/manager";
import type { Theme } from "../modes/theme/theme";
import {
	createNativeTaskExecutor,
	getNativeTaskRuntime,
	parseNativeTaskReceipt,
} from "../operational/native-task-executor";
import {
	nativeTaskJson,
	parseNativeTaskCheckpoint,
	parseNativeTaskDefinition,
	parseNativeTaskJobPayload,
	parseNativeTaskPolicy,
} from "../operational/native-task-payload";
import { DurableRunner } from "../operational/runner";
import { OperationalStore } from "../operational/store";
import {
	type AgentHarness,
	defaultAgentTypeHarnessPolicy,
	filterSkillsForHarness,
	resolveAgentHarness,
} from "../orchestration/agent-harness";
import { shouldRejectDuplicateBlockedSpawn } from "../orchestration/approach-registry";
import { type CollaborationPolicy, clampCollaborationPolicyForContext } from "../orchestration/collaboration-policy";
import { compileLanePolicy, resolveWorkerMode } from "../orchestration/context-policy";
import {
	recordApproachUpdateTelemetry,
	recordBlockerTelemetry,
	recordSpawnResultTelemetry,
	recordSpawnTelemetry,
} from "../orchestration/orchestration-telemetry";
import {
	resolveSubagentModelRouting,
	type SubagentModelRoutingDecision,
} from "../orchestration/subagent-model-routing";
import { snapshotFromAssignmentFields } from "../orchestration/task-contract";
import planModeSubagentPrompt from "../prompts/system/plan-mode-subagent.md" with { type: "text" };
import subagentPrefetchEvidenceTemplate from "../prompts/system/subagent-prefetch-evidence.md" with { type: "text" };
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import {
	assertCodeWriteTarget,
	type DelegatedIo,
	delegatedIoToolNames,
	isPathWithinWorkspace,
} from "../session/delegated-io";
import { truncateForPrompt } from "../tools/approval";
import { isIrcEnabled } from "../tools/irc";
import { formatBytes, formatDuration } from "../tools/render-utils";
import type { ResolvedToolProfile } from "../tools/tool-profiles";
import { type CodeWriteReceipt, observeCodeWrite, type PreparedCodeWrite, prepareCodeWrite } from "./code-write";
import { integrateTaskResult } from "./integration";
import {
	composeTaskSpawnPolicyResult,
	createSpawnPlan,
	type SpawnPlan,
	type SpawnPlanDiagnostic,
	type TaskSpawnPolicyInput,
	tierToRouteLabel,
} from "./spawn-plan";
import {
	type AgentDefinition,
	type AgentProgress,
	type CodeWriteRequest,
	canSpawnAtDepth,
	type EvidenceDigestRequest,
	getTaskSchema,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
import { validateWriteScopes } from "./write-scope";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager } from "../async";
import type { LocalProtocolOptions } from "../internal-urls";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { generateCommitMessage } from "../utils/commit-message-generator";
import type { AssignmentVerifierRunners } from "./assignment-verifier";
import { projectDelegatedIoResult, projectEvidenceDigest } from "./delegated-output";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import type { RecoveryAttempt } from "./recovery-policy";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { buildRepoEvidence, formatRepoEvidence } from "./repo-evidence";
import {
	captureBaseline,
	captureDeltaPatch,
	cleanupIsolation,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type IsolationHandle,
	parseIsolationMode,
	type WorktreeBaseline,
} from "./worktree";

interface RenderSubagentPromptOptions {
	readonly assignment: string;
	readonly prefetchEvidence?: string;
	readonly evidenceDigest?: EvidenceDigestRequest;
	readonly codeWrite?: CodeWriteRequest;
}

interface PrefetchEvidenceResult {
	readonly evidence?: string;
	readonly warning?: string;
}

interface ResolvePrefetchEvidenceOptions {
	readonly agent: AgentDefinition;
	readonly cwd: string;
	readonly assignment: string;
	readonly context?: string;
	readonly signal?: AbortSignal;
	readonly enabled: boolean;
}
type OrchestratedTaskParams = TaskParams &
	Partial<
		Pick<
			TaskItem,
			| "executionProfile"
			| "toolProfile"
			| "collaborationPolicy"
			| "assignmentContract"
			| "recoveryCapsule"
			| "recoveryAttempt"
			| "strategyFamily"
			| "contextPolicy"
			| "revealSiblingFindings"
			| "siblingFindings"
			| "writeScope"
		>
	>;

interface VerificationCapableToolSession extends ToolSession {
	assignmentVerifierRunners?: AssignmentVerifierRunners;
	getActualChangedFiles?: () => readonly string[] | undefined;
}

interface PreparedSpawn {
	readonly projectAgentsDir: string | null;
	readonly agent: AgentDefinition;
	readonly effectiveAgent: AgentDefinition;
	readonly plan: SpawnPlan;
	readonly modelOverride: string | string[] | undefined;
	readonly modelRouting: SubagentModelRoutingDecision;
	readonly parentActiveModelPattern: string | undefined;
	readonly harness: AgentHarness;
	readonly toolProfile: ResolvedToolProfile;
	readonly collaborationPolicy: CollaborationPolicy;
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly codeWrite?: PreparedCodeWrite;
}

type SpawnPreparationResult =
	| { readonly ok: true; readonly prepared: PreparedSpawn }
	| { readonly ok: false; readonly result: AgentToolResult<TaskToolDetails> };

function formatSpawnPlanDiagnostics(diagnostics: readonly SpawnPlanDiagnostic[]): string {
	return diagnostics
		.map(
			diagnostic =>
				`- [${diagnostic.code}] ${diagnostic.message}${diagnostic.selector ? ` (selector: ${diagnostic.selector})` : ""}`,
		)
		.join("\n");
}

function renderSubagentUserPrompt(options: RenderSubagentPromptOptions): string {
	const evidence = options.prefetchEvidence
		? prompt.render(subagentPrefetchEvidenceTemplate, { evidence: options.prefetchEvidence })
		: "";
	return prompt.render(subagentUserPromptTemplate, {
		assignment: options.assignment.trim(),
		prefetchEvidence: evidence,
		evidenceDigest: options.evidenceDigest,
		codeWrite: options.codeWrite,
	});
}

async function resolvePrefetchEvidence(options: ResolvePrefetchEvidenceOptions): Promise<PrefetchEvidenceResult> {
	if (!options.enabled || options.agent.prefetch !== "repo-evidence") return {};
	try {
		const candidates = await buildRepoEvidence({
			cwd: options.cwd,
			query: [options.context, options.assignment].filter(Boolean).join("\n\n"),
			signal: options.signal,
		});
		return { evidence: candidates.length > 0 ? formatRepoEvidence(candidates) : undefined };
	} catch (error) {
		const warning =
			"Repo evidence prefetch failed; continuing normally. Disable with `task.prefetch.enabled=false` if this keeps happening.";
		logger.warn("Task prefetch failed; continuing without prefetched evidence", {
			agent: options.agent.name,
			prefetch: options.agent.prefetch,
			error: error instanceof Error ? error.message : String(error),
			disableWith: "task.prefetch.enabled=false",
		});
		return { warning };
	}
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"search",
	"find",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"irc",
	"ask",
	"job",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
	"resolve",
	"report_finding",
	"search_tool_bm25",
]);

const PLAN_MODE_AGENT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["ast_grep", "report_finding"]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

/**
 * Collapse an agent description to a single short paragraph for the task tool
 * schema. The `<agents>` roster is re-sent in the tool description every turn,
 * so with 50+ discovered agents the full front-matter body adds ~6–8KB of
 * context bloat per turn. Keep only the first paragraph and cap it near 300
 * chars so each entry stays small while remaining informative.
 */
export function truncateAgentDescription(description: string): string {
	const firstParagraph = description.split(/\n\s*\n/, 1)[0] ?? "";
	const collapsed = firstParagraph.replace(/\s*\n\s*/g, " ").trim();
	if (collapsed.length <= 300) return collapsed;
	const window = collapsed.slice(0, 300);
	const lastSentence = window.lastIndexOf(". ");
	if (lastSentence >= 80) return window.slice(0, lastSentence + 1);
	return `${window}…`;
}

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	agents: AgentDefinition[],
	maxConcurrency: number,
	isolationEnabled: boolean,
	disabledAgents: string[],
	batchEnabled: boolean,
	asyncEnabled: boolean,
	ircEnabled: boolean,
	parentSpawns: string,
): string {
	const spawningDisabled = parentSpawns === "";
	let filteredAgents = disabledAgents.length > 0 ? agents.filter(a => !disabledAgents.includes(a.name)) : agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (parentSpawns !== "*") {
		const allowed = new Set(
			parentSpawns
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		);
		filteredAgents = filteredAgents.filter(a => allowed.has(a.name));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: truncateAgentDescription(agent.description),
		readOnly: isReadOnlyAgent(agent),
	}));
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		spawningDisabled,
		MAX_CONCURRENCY: maxConcurrency,
		isolationEnabled,
		batchEnabled,
		asyncEnabled,
		ircEnabled,
	});
}

function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject fields the current configuration does not accept. `schema` is never
 * accepted (structured output comes from the agent definition's `output`
 * frontmatter, the inherited session schema, or an eval-workflow
 * `agent(..., schema)` call); `tasks`/`context` require `task.batch`, except
 * authenticated native replay may retain shared `context` for its single spawn.
 */
function validateShapeParams(
	batchEnabled: boolean,
	params: TaskParams,
	allowNativeContext = false,
): string | undefined {
	if ((params as Record<string, unknown>).schema !== undefined) {
		return "The task tool does not accept `schema`. Rely on the selected agent definition's `output` schema or the inherited session schema; workflows needing ad-hoc structured output use eval `agent(prompt, schema)`.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(
			field => params[field] !== undefined && (field !== "context" || !allowNativeContext),
		);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`assignment\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. `agent` is
 * always required. With `task.batch` the model-facing shape is
 * `{ agent, context, tasks[] }` — `tasks` non-empty with per-item assignments
 * and unique ids, `context` non-empty, no top-level `assignment` alongside.
 * The flat `{ agent, ...item }` form stays accepted at runtime under either
 * setting (internal callers, stale transcripts). Returns a problem
 * description, or undefined when valid.
 */
function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const agent = typeof params.agent === "string" ? params.agent.trim() : "";
	if (!agent) {
		return "Missing `agent`. Provide an agent type to spawn.";
	}
	const hasAssignment = typeof params.assignment === "string" && params.assignment.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ id?, description?, assignment }).";
		}
		if (hasAssignment) {
			return "Top-level `assignment` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.assignment !== "string" || item.assignment.trim() === "") {
				return `Task ${i + 1}${item?.id ? ` (\`${item.id}\`)` : ""} is missing \`assignment\`. Every task needs complete, self-contained instructions.`;
			}
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const id = item.id?.trim();
			if (!id) continue;
			const key = id.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task id ${existing === id ? `\`${id}\`` : `\`${existing}\` / \`${id}\``}. Provided ids must be unique within a call (case-insensitive).`;
			}
			seen.set(key, id);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		const batchWriteScopeIssue = writeScopeProblem(params);
		if (batchWriteScopeIssue) return batchWriteScopeIssue;
		return undefined;
	}
	if (!hasAssignment) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `assignment`. Provide complete, self-contained instructions for the agent.";
	}
	const flatWriteScopeIssue = writeScopeProblem(params);
	if (flatWriteScopeIssue) return flatWriteScopeIssue;
	return undefined;
}

/**
 * Cross-lane write-ownership validation before any allocation. Per-lane edit
 * capability is enforced later at the harness seam where the resolved profile
 * is known; here `editCapable: false` checks overlap/isolation/shape only.
 */
function writeScopeProblem(params: TaskParams): string | undefined {
	const items = resolveSpawnItems(params);
	const diagnostics = validateWriteScopes(
		items.map((item, index) => ({
			laneId: item.id?.trim() || `task-${index + 1}`,
			writeScope: item.writeScope,
			isolated: item.isolated ?? ("isolated" in params ? params.isolated : undefined),
			editCapable: false,
		})),
	);
	if (diagnostics.length === 0) return undefined;
	return `Write-scope conflict:\n${diagnostics.map(d => `- [${d.code}] ${d.message}`).join("\n")}`;
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const internal = params as OrchestratedTaskParams;
	return [
		{
			id: params.id,
			description: params.description,
			role: params.role,
			model: params.model,
			difficulty: params.difficulty,
			evidenceDigest: params.evidenceDigest,
			codeWrite: params.codeWrite,
			assignment: params.assignment,
			executionProfile: internal.executionProfile,
			toolProfile: internal.toolProfile,
			collaborationPolicy: internal.collaborationPolicy,
			assignmentContract: internal.assignmentContract,
			recoveryCapsule: internal.recoveryCapsule,
			recoveryAttempt: internal.recoveryAttempt,
			strategyFamily: internal.strategyFamily,
			contextPolicy: internal.contextPolicy,
			revealSiblingFindings: internal.revealSiblingFindings,
			siblingFindings: internal.siblingFindings,
			writeScope: internal.writeScope,
			fork: params.fork,
		},
	];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. `tasks` never leaks into a spawn; the shared
 * `context` rides along unchanged. Keys are only materialized when present —
 * `#runSpawn` distinguishes an absent `isolated` from an explicit one. The
 * item's `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem): OrchestratedTaskParams {
	const spawn: OrchestratedTaskParams = { agent: params.agent };
	if (item.id !== undefined) spawn.id = item.id;
	if (item.description !== undefined) spawn.description = item.description;
	if (item.role !== undefined) spawn.role = item.role;
	if (item.model !== undefined) spawn.model = item.model;
	if (item.difficulty !== undefined) spawn.difficulty = item.difficulty;
	if (item.evidenceDigest !== undefined) spawn.evidenceDigest = item.evidenceDigest;
	if (item.codeWrite !== undefined) spawn.codeWrite = item.codeWrite;
	if (item.assignment !== undefined) spawn.assignment = item.assignment;
	if (item.fork !== undefined) spawn.fork = item.fork;
	if (params.context !== undefined) spawn.context = params.context;
	if (item.executionProfile !== undefined) spawn.executionProfile = item.executionProfile;
	if (item.toolProfile !== undefined) spawn.toolProfile = item.toolProfile;
	if (item.collaborationPolicy !== undefined) spawn.collaborationPolicy = item.collaborationPolicy;
	if (item.assignmentContract !== undefined) spawn.assignmentContract = item.assignmentContract;
	if (item.strategyFamily !== undefined) spawn.strategyFamily = item.strategyFamily;
	if (item.contextPolicy !== undefined) spawn.contextPolicy = item.contextPolicy;
	if (item.revealSiblingFindings !== undefined) spawn.revealSiblingFindings = item.revealSiblingFindings;
	if (item.siblingFindings !== undefined) spawn.siblingFindings = item.siblingFindings;
	if (item.writeScope !== undefined) spawn.writeScope = item.writeScope;
	if (item.recoveryCapsule !== undefined) spawn.recoveryCapsule = item.recoveryCapsule;
	if (item.recoveryAttempt !== undefined) spawn.recoveryAttempt = item.recoveryAttempt;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	// Batch form carries cwd per-item; flat form carries it top-level.
	if (item.cwd !== undefined) {
		spawn.cwd = item.cwd;
	} else if ("cwd" in params) {
		spawn.cwd = params.cwd;
	}
	return spawn;
}

/** Generic worker agents whose output sharpens with a tailored `role` rather than the bare type. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "quick_task"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specialists when it spawns generic role-less workers and still holds spawn
 * capacity (DepthCapacity: it currently has the `task` tool). Fires when a
 * generic `task`/`quick_task` spawn carries no `role`, or when one call clones
 * the same agent ≥2× all without roles. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentName: string | undefined,
	items: TaskItem[],
	depthCapacity: boolean,
): string | undefined {
	if (!depthCapacity) return undefined;
	const rolelessCount = items.filter(item => !item.role?.trim()).length;
	if (rolelessCount === 0) return undefined;
	const generic = agentName !== undefined && GENERIC_SPAWN_AGENTS.has(agentName);
	const cloned = items.length >= 2 && rolelessCount === items.length;
	if (!generic && !cloned) return undefined;
	const label = agentName ?? "task";
	return (
		`Tip: spawned ${rolelessCount} \`${label}\` worker${rolelessCount === 1 ? "" : "s"} without a \`role\`. ` +
		`Tailored specialists outperform generic workers — give each spawn a \`role\` naming its expertise ` +
		`(e.g. "Auth-flow security reviewer"). Depth budget remains, so decompose into named specialists ` +
		`rather than cloning one generic worker.`
	);
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via `irc`
 * when one call creates ≥2 live siblings and it still holds spawn capacity.
 * Returns undefined when there is nothing to coordinate or IRC is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`Coordinate: ${items.length} siblings are running together. If their work overlaps, have them ` +
		`message each other via \`irc\` (by id, or "all" to broadcast) before editing shared files — ` +
		`live coordination beats a serial handoff. Check \`irc\` op:"list" to see who is doing what.`
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge, plus — only when the siblings keep running after this
 * call (`willRunAsync`) — the coordination suggestion. Coordination is gated on
 * async because a sync fanout's siblings have already finished, so a
 * "coordinate while they run" hint would misfire. Returns undefined when
 * neither applies.
 */
export function composeSpawnAdvisory(args: {
	agentName: string | undefined;
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agentName, args.items, args.depthCapacity),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

/**
 * Process-level memo for create-time agent discovery, keyed by resolved cwd.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process and the
 * walk-up + plugin-registry scan in `discoverAgents` is identical for a given
 * cwd, so repeat creations reuse the first scan. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * the memo automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.role === "string" && params.role.trim()) {
			lines.push(`Role: ${truncateForPrompt(params.role)}`);
		}
		if (typeof params.id === "string" && params.id.trim()) {
			lines.push(`Task: ${truncateForPrompt(params.id)}`);
		}
		if (typeof params.assignment === "string") {
			lines.push(`Assignment:\n${truncateForPrompt(params.assignment)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
			if (typeof firstTask.id === "string" && firstTask.id.trim()) {
				lines.push(`Task: ${truncateForPrompt(firstTask.id)}`);
			}
			if (typeof firstTask.role === "string" && firstTask.role.trim()) {
				lines.push(`Role: ${truncateForPrompt(firstTask.role)}`);
			}
			if (typeof firstTask.assignment === "string") {
				lines.push(`Assignment:\n${truncateForPrompt(firstTask.assignment)}`);
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Sized from
	 * `task.maxConcurrency` at first use; later setting changes do not resize it.
	 */
	#spawnSemaphore: Semaphore | undefined;

	get parameters(): TaskToolSchemaInstance {
		// codeWrite may require isolation even when the ordinary default is none.
		const isolationEnabled = true;
		return getTaskSchema({ isolationEnabled, batchEnabled: this.#isBatchEnabled() });
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Dynamic description that reflects current disabled-agent settings */
	get description(): string {
		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		const maxConcurrency = this.session.settings.get("task.maxConcurrency");
		const isolationMode = this.session.settings.get("task.isolation.mode");
		return renderDescription(
			this.#discoveredAgents,
			maxConcurrency,
			isolationMode !== "none",
			disabledAgents,
			this.#isBatchEnabled(),
			this.session.settings.get("async.enabled"),
			isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			this.session.getSessionSpawns() ?? "*",
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		this.#spawnSemaphore ??= new Semaphore(this.session.settings.get("task.maxConcurrency"));
		return this.#spawnSemaphore;
	}
	async #prepareSpawn(params: OrchestratedTaskParams, signal?: AbortSignal): Promise<SpawnPreparationResult> {
		const startedAt = Date.now();
		const native = this.session.nativeTaskExecution
			? getNativeTaskRuntime(this.session.nativeTaskExecution)
			: undefined;
		const { agents, projectAgentsDir } = native
			? { agents: [parseNativeTaskDefinition(native.payload.agentDefinition)], projectAgentsDir: null }
			: await discoverAgents(this.session.cwd);
		const fail = (text: string): SpawnPreparationResult => ({
			ok: false,
			result: {
				content: [{ type: "text", text }],
				details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startedAt },
			},
		});
		if (signal?.aborted) return fail("Task spawn aborted before policy evaluation.");

		const agentName = params.agent ?? "";
		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(candidate => candidate.name).join(", ") || "none";
			return fail(`Unknown agent "${agentName}". Available: ${available}`);
		}

		const disabledAgents = this.session.settings.get("task.disabledAgents") as string[];
		if (disabledAgents.includes(agentName)) {
			const enabled = agents
				.filter(candidate => !disabledAgents.includes(candidate.name))
				.map(candidate => candidate.name);
			return fail(
				`Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
			);
		}
		if (this.#blockedAgent && agentName === this.#blockedAgent) {
			return fail(
				`Cannot spawn ${this.#blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
			);
		}
		const parentSpawns = this.session.getSessionSpawns() ?? "*";
		const allowedSpawns = parentSpawns.split(",").map(value => value.trim());
		if (parentSpawns === "" || (parentSpawns !== "*" && !allowedSpawns.includes(agentName))) {
			const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
			return fail(`Cannot spawn '${agentName}'. Allowed: ${allowed}`);
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeBaseTools = ["read", "search", "find", "lsp", "web_search"];
		const planModeTools = [
			...planModeBaseTools,
			...(agent.tools ?? []).filter(
				tool => PLAN_MODE_AGENT_TOOL_ALLOWLIST.has(tool) && !planModeBaseTools.includes(tool),
			),
		];
		let effectiveAgent: AgentDefinition = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModeSubagentPrompt}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;
		let codeWrite: PreparedCodeWrite | undefined;
		if (params.codeWrite !== undefined) {
			if (params.evidenceDigest !== undefined) return fail("Task codeWrite cannot be combined with evidenceDigest.");
			if (params.fork === true) return fail("Task codeWrite requires a fresh spawn; fork is not supported.");
			if (effectiveAgent.output !== undefined || this.session.outputSchema !== undefined)
				return fail("Task codeWrite rejects output schemas; its native receipt is the only result contract.");
			if (planModeState?.enabled) return fail("Task codeWrite is unavailable in read-only plan mode.");
			try {
				codeWrite = await prepareCodeWrite(
					params.codeWrite,
					path.resolve(this.session.cwd, params.cwd ?? "."),
					signal,
				);
				params.codeWrite = codeWrite.request;
			} catch (error) {
				return fail(`Task codeWrite validation failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (params.evidenceDigest !== undefined) {
			const digest = params.evidenceDigest;
			if (
				!digest ||
				!Array.isArray(digest.paths) ||
				digest.paths.length === 0 ||
				digest.paths.some(value => typeof value !== "string" || !value.trim()) ||
				typeof digest.question !== "string" ||
				!digest.question.trim()
			) {
				return fail("Task evidenceDigest requires non-empty paths and an exact question.");
			}
			if (params.fork === true) {
				return fail("Task evidenceDigest requires a fresh spawn; fork mode inherits the parent's model.");
			}
		}
		if (params.evidenceDigest || codeWrite) {
			effectiveAgent = {
				...effectiveAgent,
				tools: delegatedIoToolNames(codeWrite ? { kind: "code-write", ...codeWrite } : { kind: "evidence-digest" }),
				spawns: [],
				readSummarize: false,
			};
		}
		if (
			(codeWrite ||
				(this.session.settings.get("fusion.enabled") === true &&
					this.session.settings.get("fusion.mode") === "autonomous" &&
					!isReadOnlyAgent(effectiveAgent))) &&
			params.isolated === false
		) {
			return fail("Isolation is required for this task.");
		}

		if (params.difficulty && params.fork === true) {
			return fail(
				`Task spawn rejected: "difficulty" cannot be combined with "fork: true". Fork mode inherits the parent's exact model, so it is incompatible with difficulty-based routing; omit "difficulty" for a forked spawn, or set "fork: false" (or omit it) to route by difficulty.`,
			);
		}
		const explicitModelSelector = params.model?.trim() || undefined;
		const parentActiveModelPattern = this.session.getActiveModelString?.();
		const routingResult = resolveSubagentModelRouting({
			requestedModel: explicitModelSelector,
			requestedDifficulty: params.difficulty,
			taskKind: params.codeWrite ? "code-write" : params.evidenceDigest ? "evidence-digest" : undefined,
			agentName,
			agentModelDefault: effectiveAgent.model,
			settings: this.session.settings,
			modelRegistry: this.session.modelRegistry,
			parentActiveModelPattern,
			sessionDefaultModelPattern: this.session.getModelString?.(),
		});
		if (!routingResult.ok) {
			return fail(
				`Task spawn model routing failed:\n- [${routingResult.error.kind}] ${routingResult.error.message}`,
			);
		}
		const modelRouting = routingResult.decision;
		const modelOverride = routingResult.modelPatterns;

		const assignment = (params.assignment ?? "").trim();
		const agentId = params.id?.trim() ?? "";
		const agentPolicies = this.session.settings.getAgentPolicies();
		const hasExplicitTypePolicy = Boolean(agentName && agentPolicies[agentName]);
		const settingsPolicy = this.session.settings.resolveAgentPolicy(agentId, agentName);
		// Orchestration seed for known light types — only when settings did not
		// name that type explicitly (explicit policies may raise or further narrow).
		const typeHarnessSeed = hasExplicitTypePolicy ? undefined : defaultAgentTypeHarnessPolicy(agentName);
		const correlationId = `task-spawn-${Snowflake.next()}`;
		let planned = createSpawnPlan({
			correlationId,
			agentName,
			assignment,
			description: params.description,
			profile: params.executionProfile,
			profileInput: params.executionProfile
				? undefined
				: {
						agentTypePolicy: typeHarnessSeed,
						agentIdPolicy: settingsPolicy,
						override: params.assignmentContract
							? {
									autonomy: params.assignmentContract.autonomy,
									workClass: params.assignmentContract.workClass,
								}
							: undefined,
					},
			modelPatterns: modelOverride.length > 0 ? modelOverride : undefined,
			requestedModel: modelRouting.source === "explicit" ? modelOverride[0] : undefined,
			modelRouting,
			manualModelSelection: Boolean(explicitModelSelector),
			fusionSidekick: false,
			softRequestBudget: this.session.settings.get("task.softRequestBudget"),
			maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
			isSelectorAvailable: this.session.modelRegistry
				? selector =>
						resolveModelOverride([selector], this.session.modelRegistry!, this.session.settings).model !==
						undefined
				: undefined,
		});
		if (!planned.ok) {
			return fail(`Task spawn plan rejected:\n${formatSpawnPlanDiagnostics(planned.diagnostics)}`);
		}

		const extensionRunner = (this.session as ToolSession & { extensionRunner?: ExtensionRunner }).extensionRunner;
		if (extensionRunner) {
			const policyInput: TaskSpawnPolicyInput = Object.freeze({
				correlationId: planned.plan.correlationId,
				agentName: planned.plan.agentName,
				assignment: planned.plan.assignment,
				workClass: planned.plan.profile.workClass,
				autonomy: planned.plan.profile.autonomy,
				eligible: planned.plan.eligible,
				requestedModel: planned.plan.requestedModel,
				fusionSidekick: false,
				manualModelSelection: planned.plan.manualModelSelection,
			});
			try {
				const policyResult = await extensionRunner.emitTaskSpawnPolicy(policyInput, signal);
				planned = composeTaskSpawnPolicyResult(planned.plan, policyResult);
			} catch (error) {
				if (signal?.aborted) return fail("Task spawn aborted during policy evaluation.");
				const message = error instanceof Error ? error.message : String(error);
				return fail(`Task spawn policy failed before allocation:\n- [policy-hook-error] ${message}`);
			}
			if (signal?.aborted) return fail("Task spawn aborted during policy evaluation.");
			if (!planned.ok) {
				return fail(`Task spawn plan rejected:\n${formatSpawnPlanDiagnostics(planned.diagnostics)}`);
			}
		}

		const toolPolicyActive =
			settingsPolicy !== undefined ||
			typeHarnessSeed !== undefined ||
			params.executionProfile !== undefined ||
			params.assignmentContract !== undefined;
		const stagedFindingsRevealed =
			params.contextPolicy === "staged" &&
			params.revealSiblingFindings === true &&
			Boolean(params.siblingFindings?.trim());
		const harness = resolveAgentHarness({
			execution: planned.plan.profile,
			agentName,
			role: params.role,
			agentTools: toolPolicyActive ? effectiveAgent.tools : undefined,
			autoloadSkills: effectiveAgent.autoloadSkills,
			parentId: this.session.getAgentId?.() ?? MAIN_AGENT_ID,
			requireYield: true,
			contextPolicy: params.contextPolicy,
			siblingFindingsRevealed: stagedFindingsRevealed,
		});
		const toolProfile =
			params.toolProfile ??
			(params.evidenceDigest || codeWrite
				? Object.freeze({
						...harness.toolProfile,
						// The native contract supplies the exact capability ceiling, independently of
						// legacy harness aliases (find/search versus glob/grep) and discovery defaults.
						maximum: Object.freeze(
							effectiveAgent.tools!.map(name =>
								Object.freeze({ source: name === "yield" ? ("hidden" as const) : ("builtin" as const), name }),
							),
						),
						allowDiscovery: false,
						toolsConstrained: true,
					})
				: harness.toolProfile);
		const collaborationPolicy = clampCollaborationPolicyForContext(
			params.collaborationPolicy ?? harness.collaborationPolicy,
			params.contextPolicy,
			{ siblingFindingsRevealed: stagedFindingsRevealed },
		);
		if (params.writeScope) {
			const writeScopeDiagnostics = validateWriteScopes([
				{
					laneId: params.id?.trim() || agentName,
					writeScope: params.writeScope,
					isolated: params.isolated === true,
					editCapable: toolProfile.editMode !== "none",
				},
			]);
			if (writeScopeDiagnostics.length > 0) {
				return fail(
					`Task spawn rejected by write-scope validation:\n${writeScopeDiagnostics.map(d => `- [${d.code}] ${d.message}`).join("\n")}`,
				);
			}
		}
		// Reject duplicate blocked spawns: if the strategy family is already blocked with
		// the same fingerprint in the parent's approach registry, fail the spawn early.
		if (params.strategyFamily) {
			const registry = this.session.getApproachRegistry?.();
			if (registry) {
				const contract = params.assignmentContract;
				const priorBlockedRoutes =
					contract && "priorBlockedRoutes" in contract ? contract.priorBlockedRoutes : undefined;
				// Register any prior blocked routes from the assignment contract into the registry
				if (priorBlockedRoutes) {
					for (const route of priorBlockedRoutes) {
						if (route.blockerFingerprint) {
							registry.markBlocked(
								route.family,
								route.mechanism,
								route.blocker,
								undefined,
								route.blockerFingerprint,
							);
						}
					}
				}
				// Find the fingerprint for this strategy family from prior blocked routes
				const priorFingerprint = priorBlockedRoutes?.find(
					r => r.family === params.strategyFamily,
				)?.blockerFingerprint;
				if (shouldRejectDuplicateBlockedSpawn(registry, params.strategyFamily, priorFingerprint)) {
					return fail(
						`Spawn rejected: strategy family "${params.strategyFamily}" was already blocked with the same blocker fingerprint. Use a materially different approach or mechanism.`,
					);
				}
			}
		}

		// Privacy-safe routing provenance: difficulty, selection source, profile
		// name, and selector metadata only — never assignment text or credentials.
		recordSpawnTelemetry(this.session.getOrchestrationTelemetry?.() ?? { emit: () => {}, events: [] }, {
			sessionId: this.session.getSessionId?.() ?? undefined,
			correlationId: planned.plan.correlationId,
			agentName,
			strategyFamily: params.strategyFamily,
			workerMode: resolveWorkerMode(agentName),
			contextPolicy: params.contextPolicy ?? "shared",
			routeLabel: tierToRouteLabel(planned.plan.profile.tier),
			taskContractClass: params.assignmentContract ? "assignment-contract" : undefined,
			metadata: Object.freeze({
				requestedDifficulty: modelRouting.requestedDifficulty,
				modelSelectionSource: modelRouting.source,
				modelProfileName: modelRouting.profileName,
				modelRole: modelRouting.role,
				candidateSelectors: modelRouting.candidateSelectors,
			}),
		});
		if (params.assignmentContract && this.session.setActiveTaskContract) {
			const contract = params.assignmentContract;
			this.session.setActiveTaskContract(
				snapshotFromAssignmentFields({
					objective: contract.objective,
					deliverables: contract.deliverables,
					acceptance: contract.acceptance,
					nonSolutions: "nonSolutions" in contract ? contract.nonSolutions : undefined,
					failureModes: "failureModes" in contract ? contract.failureModes : undefined,
				}),
			);
		}
		// Callers may inject tool/collaboration ceilings; skill/decision surface
		// still comes from the orchestration-selected harness for the plan profile.
		const effectiveHarness: AgentHarness =
			params.toolProfile || params.collaborationPolicy
				? Object.freeze({
						...harness,
						toolProfile,
						collaborationPolicy,
					})
				: harness;

		return {
			ok: true,
			prepared: {
				projectAgentsDir,
				agent,
				effectiveAgent,
				plan: planned.plan,
				modelOverride: planned.plan.eligible.map(candidate => candidate.selector),
				modelRouting,
				parentActiveModelPattern,
				harness: effectiveHarness,
				toolProfile,
				collaborationPolicy,
				extensionRunner,
				codeWrite,
			},
		};
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = session.nativeTaskExecution
			? {
					agents: [
						parseNativeTaskDefinition(getNativeTaskRuntime(session.nativeTaskExecution).payload.agentDefinition),
					],
				}
			: await discoverAgentsForCreate(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		let params = repairTaskParams(rawParams as TaskParams);
		const nativeExecution = this.session.nativeTaskExecution !== undefined;
		if (this.session.nativeTaskExecution !== undefined) {
			const native = getNativeTaskRuntime(this.session.nativeTaskExecution);
			const policy = parseNativeTaskPolicy(native.payload.policy);
			params = {
				...params,
				model: native.payload.effectiveModel,
				difficulty: undefined,
				...{
					executionProfile: policy.executionProfile,
					toolProfile: policy.toolProfile,
					collaborationPolicy: policy.collaborationPolicy,
				},
			};
		}
		const batchEnabled = !nativeExecution && this.#isBatchEnabled();
		const validationError =
			validateShapeParams(batchEnabled, params, nativeExecution) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}
		const requests = [params, ...(params.tasks ?? [])];
		if (
			requests.some(request => request.codeWrite) &&
			requests.some(request => Object.hasOwn(request, "output") || Object.hasOwn(request, "outputSchema"))
		) {
			return createTaskModeError(
				"Task codeWrite rejects output schemas; its native receipt is the only result contract.",
			);
		}

		// Autonomous planning root: surface handoffs from durable jobs that
		// settled outside an inline dispatch (external runner, recovery, or
		// /fusion controls); the queued messages drive the next planning turn.
		if (this.session.drainAutonomousTaskHandoffs) {
			for (const handoff of this.session.drainAutonomousTaskHandoffs()) {
				this.session.queueDeferredMessage?.(handoff);
			}
		}

		const spawnItems = resolveSpawnItems(params);
		const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);
		const asyncEnabled = !this.session.nativeTaskExecution && this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const depthCapacity = canSpawnAtDepth(
			this.session.settings.get("task.maxRecursionDepth") ?? 2,
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);
		// Coordination only makes sense when the siblings keep running after this
		// call returns (async). In the sync fallback they have already completed,
		// so a "coordinate while they run" hint would misfire.
		const willRunAsync = !!manager && selectedAgent?.blocking !== true;
		const advisory =
			this.session.suppressSpawnAdvisory || spawnItems.some(item => item.codeWrite || item.evidenceDigest)
				? undefined
				: composeSpawnAdvisory({
						agentName: params.agent,
						items: spawnItems,
						depthCapacity,
						ircEnabled,
						willRunAsync,
					});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		// Build and policy-compose every spawn before allocating any externally visible
		// id, job, worktree, or session. A rejected batch therefore leaves no partial
		// artifacts in either asynchronous or synchronous execution.
		const preparedItems: Array<{
			item: TaskItem;
			spawnParams: OrchestratedTaskParams;
			prepared: PreparedSpawn;
		}> = [];
		for (const item of spawnItems) {
			const itemParams = spawnParamsFor(params, item);
			const preparation = await this.#prepareSpawn(itemParams, signal);
			if (!preparation.ok) return withAdvisory(preparation.result);
			if (preparation.prepared.codeWrite) item.codeWrite = preparation.prepared.codeWrite.request;
			preparedItems.push({ item, spawnParams: itemParams, prepared: preparation.prepared });
		}

		if (!asyncEnabled || !manager || selectedAgent?.blocking === true) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or an agent definition that declares
			// `blocking: true`. The session-scoped semaphore still bounds fan-out
			// across parallel task calls.
			if (asyncEnabled && !manager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			return withAdvisory(
				await this.#executeSyncFanout(
					toolCallId,
					params,
					spawnItems,
					preparedItems.map(item => item.prepared),
					signal,
					onUpdate,
				),
			);
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const agentLabel = params.agent ?? "task";
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			spawnParams: OrchestratedTaskParams;
			prepared: PreparedSpawn;
			progress: AgentProgress;
		}> = [];
		for (let index = 0; index < preparedItems.length; index++) {
			const { item, spawnParams, prepared } = preparedItems[index];
			const agentId = await outputManager.allocate(item.id?.trim() || generateTaskName());
			const assignment = (item.assignment ?? "").trim();
			spawns.push({
				agentId,
				item,
				spawnParams,
				prepared,
				progress: {
					index,
					id: agentId,
					agent: agentLabel,
					agentSource: prepared.agent.source,
					status: "pending",
					task: renderSubagentUserPrompt({
						assignment,
						evidenceDigest: item.evidenceDigest,
						codeWrite: item.codeWrite,
					}),
					assignment,
					description: item.description,
					executionProfile: prepared.plan.profile,
					toolProfile: prepared.toolProfile,
					collaborationPolicy: prepared.collaborationPolicy,
					assignmentContract: spawnParams.assignmentContract,
					recoveryAttempt: spawnParams.recoveryAttempt?.attempt,
					recoveryTier: spawnParams.recoveryAttempt?.tier,
					recoveryProvider: spawnParams.recoveryAttempt?.provider,
					modelRouting: prepared.modelRouting,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}

		// Aggregate async state for the one tool call: every spawn's job reports
		// into the shared progress snapshot; the call stays "running" until all
		// jobs settle, then turns "failed" if any spawn failed. The single-spawn
		// case passes the job's own suggestion through (pre-batch behavior).
		const single = spawns.length === 1;
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = spawns[0].agentId;
		const buildAsyncDetails = (state: "running" | "completed" | "failed", jobId: string): TaskToolDetails => ({
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: single ? state : settledCount < spawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: single ? jobId : primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string; description?: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of spawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawn.spawnParams,
					agentId: spawn.agentId,
					progress: spawn.progress,
					prepared: spawn.prepared,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId, description: spawn.item.description });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				if (spawn.spawnParams.assignmentContract) {
					this.session.setActiveTaskContract?.(undefined);
				}
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to start background task job${single ? "" : "s"}: ${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		if (single) {
			const { agentId, jobId, description } = started[0];
			const coordinationHint = ircEnabled
				? `DM \`${agentId}\` via \`irc\` to coordinate while it runs; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
				: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`;
			const descriptionSuffix = description ? ` — ${description}` : "";
			onUpdate?.({
				content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
				details: buildAsyncDetails("running", jobId),
			});
			return withAdvisory({
				content: [
					{
						type: "text",
						text: `Spawned agent \`${agentId}\` (job \`${jobId}\`)${descriptionSuffix}. The result will be delivered when it yields. ${coordinationHint}`,
					},
				],
				details: buildAsyncDetails("running", jobId),
			});
		}

		const coordinationHint = ircEnabled
			? `DM these ids via \`irc\` to coordinate while they run; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
			: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task by id.`;
		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
				: "";
		const startedListing = started
			.map(({ agentId, jobId, description }) => {
				const prefix = `- \`${agentId}\` (job \`${jobId}\`)`;
				return description ? `${prefix} — ${description}` : prefix;
			})
			.join("\n");
		onUpdate?.({
			content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
			details: buildAsyncDetails("running", primaryJobId),
		});
		return withAdvisory({
			content: [
				{
					type: "text",
					text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary} Each result will be delivered when that agent yields.\n${startedListing}\n${coordinationHint}`,
				},
			],
			details: buildAsyncDetails("running", primaryJobId),
		});
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its yield text. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: OrchestratedTaskParams;
		agentId: string;
		progress: AgentProgress;
		prepared: PreparedSpawn;
		ircEnabled: boolean;
		buildDetails: (state: "running" | "completed" | "failed", jobId: string) => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): string {
		const {
			manager,
			toolCallId,
			spawnParams,
			agentId,
			progress,
			prepared,
			ircEnabled,
			buildDetails,
			onUpdate,
			onSettled,
		} = options;
		const buildFollowUpHint = (aborted: boolean): string => {
			if (spawnParams.codeWrite || spawnParams.evidenceDigest) return "";
			if (aborted) {
				return `\n\n${agentId} was aborted — transcript at history://${agentId}`;
			}
			const followUp = ircEnabled ? "message it via `irc` to follow up; " : "";
			return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ jobId: ownJobId, signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const semaphore = this.#getSpawnSemaphore();
				await semaphore.acquire();
				const acquiredAt = Date.now();
				if (runSignal.aborted) {
					semaphore.release();
					progress.status = "aborted";
					onSettled?.(true);
					if (spawnParams.assignmentContract) {
						this.session.setActiveTaskContract?.(undefined);
					}
					throw new Error("Aborted before execution");
				}
				markRunning();
				progress.status = "running";
				await reportProgress(
					`Running background task ${agentId}...`,
					buildDetails("running", ownJobId) as unknown as Record<string, unknown>,
				);
				try {
					const result = await this.#executeSync(
						toolCallId,
						spawnParams,
						runSignal,
						undefined,
						agentId,
						progress.index,
						true,
						prepared,
						{ invokedAt: startedAt, acquiredAt },
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success.
					const resultFailed =
						!singleResult ||
						(singleResult.aborted ?? false) ||
						singleResult.isError === true ||
						singleResult.exitCode !== 0;
					progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.assignmentVerificationStatus = singleResult?.assignmentVerificationStatus;
					progress.failureClass = singleResult?.failureClass;
					progress.recoveryAttempt = singleResult?.recoveryAttempt;
					progress.recoveryTier = singleResult?.recoveryTier;
					progress.recoveryProvider = singleResult?.recoveryProvider;
					progress.nextRecoveryAction = singleResult?.nextRecoveryAction;
					progress.isError = singleResult?.isError;
					progress.retryState = undefined;
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(
						statusText,
						buildDetails(resultFailed ? "failed" : "completed", ownJobId) as unknown as Record<string, unknown>,
					);
					onUpdate?.({
						content: [{ type: "text", text: statusText }],
						details: buildDetails(resultFailed ? "failed" : "completed", ownJobId),
					});
					const deliveryText = `${finalText}${buildFollowUpHint(singleResult?.aborted === true)}`;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText);
					}
					return deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText, buildDetails("failed", ownJobId) as unknown as Record<string, unknown>);
					onUpdate?.({
						content: [{ type: "text", text: statusText }],
						details: buildDetails("failed", ownJobId),
					});
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				} finally {
					semaphore.release();
				}
			},
			{
				id: agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: (text, details) => {
					const progressDetails = (details as TaskToolDetails | undefined) ?? buildDetails("running", agentId);
					onUpdate?.({ content: [{ type: "text", text }], details: progressDetails });
				},
			},
		);
	}

	/**
	 * Sync fallback fan-out (no job manager, or a `blocking: true` agent): run
	 * every spawn to completion inline and merge the per-spawn payloads into a
	 * single tool result. The session-scoped semaphore still bounds concurrency
	 * across parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawnItems: TaskItem[],
		preparedItems: readonly PreparedSpawn[],
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const semaphore = this.#getSpawnSemaphore();
		if (spawnItems.length === 1) {
			const invokedAt = Date.now();
			await semaphore.acquire();
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawnItems[0]),
					signal,
					onUpdate,
					this.session.nativeTaskExecution
						? getNativeTaskRuntime(this.session.nativeTaskExecution).payload.agentId
						: undefined,
					0,
					false,
					preparedItems[0],
					{ invokedAt, acquiredAt },
				);
			} finally {
				semaphore.release();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawnItems.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const { results: payloads } = await mapWithConcurrencyLimit(
			spawnItems,
			spawnItems.length,
			async (item, index, workerSignal) => {
				const invokedAt = Date.now();
				await semaphore.acquire();
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onUpdate
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) {
									latestProgress.set(index, { ...progress, index });
									emitCombined();
								}
							}
						: undefined;
					return await this.#executeSync(
						toolCallId,
						spawnParamsFor(params, item),
						workerSignal,
						itemOnUpdate,
						undefined,
						index,
						false,
						preparedItems[index],
						{ invokedAt, acquiredAt },
					);
				} finally {
					semaphore.release();
				}
			},
			signal,
		);

		const results: SingleResult[] = [];
		const contentParts: string[] = [];
		const outputPaths: string[] = [];
		const usageTotals = createUsageTotals();
		let hasUsage = false;
		let projectAgentsDir: string | null = null;
		for (let index = 0; index < spawnItems.length; index++) {
			const payload = payloads[index];
			if (!payload) {
				contentParts.push(`Task ${spawnItems[index].id?.trim() || `#${index + 1}`}: cancelled before start.`);
				if (spawnParamsFor(params, spawnItems[index]).assignmentContract) {
					this.session.setActiveTaskContract?.(undefined);
				}
				continue;
			}
			projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
			const text = payload.content.find(part => part.type === "text")?.text;
			if (text) contentParts.push(text);
			for (const result of payload.details?.results ?? []) {
				results.push({ ...result, index });
				if (result.usage) {
					addUsageTotals(usageTotals, result.usage);
					hasUsage = true;
				}
				if (result.outputPath) outputPaths.push(result.outputPath);
			}
		}

		return {
			content: [{ type: "text", text: contentParts.join("\n\n") }],
			details: {
				projectAgentsDir,
				results,
				totalDurationMs: Date.now() - startTime,
				usage: hasUsage ? usageTotals : undefined,
				outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
			},
		};
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		toolCallId: string,
		params: OrchestratedTaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		prepared?: PreparedSpawn,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(
			toolCallId,
			params,
			signal,
			onUpdate,
			preAllocatedId,
			spawnIndex,
			detached,
			prepared,
			launchTiming,
		);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		toolCallId: string,
		params: OrchestratedTaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		preplanned?: PreparedSpawn,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const preparation = preplanned
			? ({ ok: true, prepared: preplanned } as const)
			: await this.#prepareSpawn(params, signal);
		if (!preparation.ok) return preparation.result;
		const prepared = preparation.prepared;
		const {
			projectAgentsDir,
			agent,
			effectiveAgent,
			plan: spawnPlan,
			modelOverride,
			modelRouting,
			parentActiveModelPattern,
			harness,
			toolProfile,
			collaborationPolicy,
			extensionRunner,
		} = prepared;
		const agentName = agent.name;
		const rawSharedContext =
			this.session.nativeTaskExecution !== undefined || this.#isBatchEnabled()
				? params.context?.trim() || undefined
				: undefined;
		const { context: sharedContext } = compileLanePolicy({
			contextPolicy: params.contextPolicy,
			sharedContext: rawSharedContext,
			requestedCollaboration: collaborationPolicy,
			siblingFindings:
				params.contextPolicy === "staged" && params.revealSiblingFindings ? params.siblingFindings : undefined,
		});
		const assignment = (params.assignment ?? "").trim();
		const configuredIsolationMode = this.session.settings.get("task.isolation.mode");
		const spawnCwd = prepared.codeWrite?.workspaceRoot ?? path.resolve(this.session.cwd, params.cwd ?? ".");
		const isAutonomous =
			this.session.settings.get("fusion.enabled") === true &&
			this.session.settings.get("fusion.mode") === "autonomous";
		const mandatoryIsolation = Boolean(prepared.codeWrite) || (isAutonomous && !isReadOnlyAgent(effectiveAgent));
		if (mandatoryIsolation && params.isolated === false)
			return createTaskModeError("Isolation is required for this task.");
		const isolationMode = mandatoryIsolation && configuredIsolationMode === "none" ? "auto" : configuredIsolationMode;
		const isIsolated = isolationMode !== "none" && (mandatoryIsolation || params.isolated === true);
		const mergeMode = this.session.settings.get("task.isolation.merge");
		const commitStyle = this.session.settings.get("task.isolation.commits");
		const taskDepth = this.session.taskDepth ?? 0;
		const subagentLspEnabled = (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp");
		const planModeState = this.session.getPlanModeState?.();
		const thinkingLevelOverride = effectiveAgent.thinkingLevel;

		if (isolationMode === "none" && "isolated" in params) {
			if (params.assignmentContract) {
				this.session.setActiveTaskContract?.(undefined);
			}
			return {
				content: [{ type: "text", text: "Task isolation is disabled." }],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		// Output schema priority: agent frontmatter > inherited parent session.
		// The task call itself never carries a schema; workflows needing ad-hoc
		// structured output go through eval agent(prompt, schema).
		const effectiveOutputSchema = effectiveAgent.output ?? this.session.outputSchema;

		if (isAutonomous && !this.session.nativeTaskExecution) {
			let store: OperationalStore | undefined;
			try {
				if ((this.session as VerificationCapableToolSession).assignmentVerifierRunners)
					throw new Error("Native task dependency unavailable: in-memory assignment verifier runners.");
				if (params.fork) throw new Error("Native task dependency unavailable: forked parent context.");
				if (!this.session.modelRegistry) throw new Error("Native task dependency unavailable: model registry.");
				const selected = resolveModelOverride(
					Array.isArray(modelOverride) ? modelOverride : modelOverride ? [modelOverride] : [],
					this.session.modelRegistry,
					this.session.settings,
				).model;
				if (!selected) throw new Error("Native task dependency unavailable: pinned worker model.");
				store = OperationalStore.open();
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				const agentId = preAllocatedId ?? (await outputManager.allocate(params.id?.trim() || generateTaskName()));
				const payload = parseNativeTaskJobPayload(
					nativeTaskJson({
						version: 1,
						cwd: spawnCwd,
						agentId,
						parentSessionId: this.session.getSessionId?.() ?? null,
						taskDepth,
						params: { ...params, cwd: "." },
						effectiveModel: `${selected.provider}/${selected.id}`,
						agentDefinition: effectiveAgent,
						policy: {
							isolationMode,
							mergeMode,
							maxRecursionDepth: this.session.settings.get("task.maxRecursionDepth"),
							maxRuntimeMs: spawnPlan.maxRuntimeMs,
							outputSchema: effectiveOutputSchema ?? null,
							executionProfile: spawnPlan.profile ?? null,
							toolProfile: toolProfile ?? null,
							collaborationPolicy: collaborationPolicy ?? null,
						},
					}),
				);
				const runner = new DurableRunner({
					store,
					executor: createNativeTaskExecutor({
						store,
						artifactsDir: path.join(getAgentDir(), "operational", "native-tasks"),
					}),
				});
				const job = runner.enqueue({ type: "native_task", payload: nativeTaskJson(payload) });
				const settled = await runner.runJobById(job.id, signal);
				if (!settled) throw new Error(`Native task could not claim durable job ${job.id}.`);
				// The tool result below is this job's handoff; the autonomous
				// drain must not re-report it as an externally settled update.
				// Only terminal states are suppressed — a still-queued or paused
				// job must remain eligible for a later handoff.
				if (settled.status === "completed" || settled.status === "failed" || settled.status === "cancelled") {
					this.session.markAutonomousTaskJobReported?.(job.id);
				}
				const receipt = settled.status === "completed" ? parseNativeTaskReceipt(settled.result) : undefined;
				let output =
					receipt?.output ??
					`Native task ${settled.id} is ${settled.status}. ${settled.error ?? "Inspect its checkpoint for recovery artifacts."}`;
				let truncated = false;
				// Reconstructed sessions have a different artifact registry. Publish only the
				// projected receipt/digest to the original parent's canonical agent handle.
				const parentArtifacts = this.session.getArtifactManager?.();
				const parentOutputDir = this.session.getArtifactsDir?.();
				const parentOutputPath = parentOutputDir
					? path.join(parentOutputDir, `${agentId}.md`)
					: receipt?.outputPath;
				const checkpoint = store.getCheckpoint(job.id)?.data;
				const recovery = checkpoint ? parseNativeTaskCheckpoint(checkpoint) : undefined;
				const rawTranscript = receipt?.artifacts.find(file => file.endsWith(".delegated.log"));
				const successfulDigest = Boolean(params.evidenceDigest) && receipt?.exitCode === 0;
				const rawText =
					rawTranscript && (parentArtifacts || successfulDigest)
						? await fs.readFile(rawTranscript, "utf8")
						: undefined;
				const transcriptArtifact =
					parentArtifacts && rawText !== undefined
						? `artifact://${await parentArtifacts.save(rawText, "native-task")}`
						: rawTranscript;
				if (successfulDigest) {
					if (rawText === undefined || !transcriptArtifact) {
						throw new Error("Native evidence digest is missing its retained full-output artifact.");
					}
					({ output, truncated } = projectEvidenceDigest(rawText, transcriptArtifact));
				}
				if (parentOutputPath) {
					await fs.mkdir(path.dirname(parentOutputPath), { recursive: true });
					await fs.writeFile(parentOutputPath, output);
				}
				const result: SingleResult = {
					index: spawnIndex,
					id: agentId,
					agent: agentName,
					agentSource: effectiveAgent.source,
					task: assignment,
					assignment,
					description: params.description,
					exitCode: receipt?.exitCode ?? 1,
					output,
					stderr: "",
					truncated,
					durationMs: Date.now() - startTime,
					tokens: 0,
					requests: 0,
					isError: settled.status !== "completed",
					error: settled.status !== "completed" ? output : undefined,
					durableJobId: job.id,
					changesApplied: receipt?.changesApplied ?? false,
					mergeSummary: receipt?.mergeSummary,
					outputPath: parentOutputPath,
					outputMeta: { lineCount: output.split("\n").length, charCount: output.length },
					transcriptArtifact,
					patchPath: recovery?.patchPaths.find(file => file.endsWith("root.patch")),
					branchName: receipt?.branchName ?? recovery?.branchName ?? undefined,
					delegatedIoKind: params.codeWrite ? "code-write" : params.evidenceDigest ? "evidence-digest" : undefined,
				};
				return this.#buildResultPayload(
					result,
					projectAgentsDir,
					Date.now() - startTime,
					result.mergeSummary ?? "",
				);
			} catch (error) {
				return createTaskModeError(
					`Native durable task blocked: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				store?.close();
			}
		}

		let repoRoot: string | null = null;
		let baseline: WorktreeBaseline | null = null;
		if (isIsolated) {
			try {
				repoRoot = await getRepoRoot(spawnCwd);
				baseline = await captureBaseline(repoRoot);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (params.assignmentContract) {
					this.session.setActiveTaskContract?.(undefined);
				}
				return {
					content: [{ type: "text", text: `Isolated task execution requires a git repository. ${message}` }],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}
		}
		const nativeRuntime = this.session.nativeTaskExecution
			? getNativeTaskRuntime(this.session.nativeTaskExecution)
			: undefined;
		nativeRuntime?.prepare(baseline);

		const preferredIsolationBackend = parseIsolationMode(isolationMode);

		// Derive artifacts directory
		const parentArtifactManager = this.session.getArtifactManager?.() ?? undefined;
		const sessionFile = this.session.getSessionFile();
		const artifactsDir =
			nativeRuntime?.artifactsDir ??
			this.session.getArtifactsDir?.() ??
			(sessionFile ? sessionFile.slice(0, -6) : null);
		const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

		const localProtocolOptions: LocalProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			getSessionId: this.session.getSessionId ?? (() => null),
		};

		// When the session is executing an approved plan, hand the overall plan to
		// every subagent so they share the main agent's plan context. Skipped in
		// plan mode (read-only exploration uses planModeSubagentPrompt instead) and
		// when no plan file exists at the session's reference path.
		const planReference = planModeState?.enabled
			? undefined
			: await loadOverallPlanReference(
					this.session.getPlanReferencePath?.() ?? "local://PLAN.md",
					localProtocolOptions,
				);

		try {
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });

			// Allocation is the first externally visible spawn side effect. Planning,
			// selector validation, and extension policy composition have all settled.
			const outputManager =
				this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			const agentId = preAllocatedId ?? (await outputManager.allocate(params.id?.trim() || generateTaskName()));

			const availableSkills = filterSkillsForHarness(harness, this.session.skills ?? [], agent.autoloadSkills);
			// Resolve autoload skills from agent definition against the harness-filtered set
			const resolvedAutoloadSkills =
				agent.autoloadSkills?.length && availableSkills.length > 0
					? agent.autoloadSkills
							.map(name => availableSkills.find(s => s.name === name))
							.filter((s): s is NonNullable<typeof s> => s !== undefined)
					: [];
			const contextFiles = this.session.contextFiles?.filter(
				file => path.basename(file.path).toLowerCase() !== "agents.md",
			);
			const promptTemplates = this.session.promptTemplates;
			const parentEvalSessionId = this.session.getEvalSessionId?.() ?? undefined;
			const mcpManager = this.session.mcpManager ?? MCPManager.instance();

			// Progress tracking for the single agent
			let latestProgress: AgentProgress = {
				index: spawnIndex,
				id: agentId,
				agent: agentName,
				agentSource: agent.source,
				status: "pending",
				task: renderSubagentUserPrompt({
					assignment,
					evidenceDigest: params.evidenceDigest,
					codeWrite: params.codeWrite,
				}),
				assignment,
				executionProfile: spawnPlan.profile,
				toolProfile,
				collaborationPolicy,
				assignmentContract: params.assignmentContract,
				recoveryAttempt: params.recoveryAttempt?.attempt,
				recoveryTier: params.recoveryAttempt?.tier,
				recoveryProvider: params.recoveryAttempt?.provider,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				modelOverride,
				modelRouting,
				description: params.description,
			};
			const emitProgress = () => {
				onUpdate?.({
					content: [{ type: "text", text: `Running agent ${agentId}...` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress: [latestProgress],
					},
				});
			};
			emitProgress();

			const buildCommitMessageFn = () =>
				commitStyle === "ai" && this.session.modelRegistry
					? async (diff: string) => {
							return generateCommitMessage(
								diff,
								this.session.modelRegistry!,
								this.session.settings,
								this.session.getSessionId?.() ?? undefined,
							);
						}
					: undefined;

			const prefetch = await resolvePrefetchEvidence({
				agent: effectiveAgent,
				cwd: spawnCwd,
				assignment,
				context: sharedContext,
				signal,
				enabled: this.session.settings.get("task.prefetch.enabled"),
			});
			if (prefetch.warning) {
				latestProgress = { ...latestProgress, recentOutput: [prefetch.warning, ...latestProgress.recentOutput] };
				emitProgress();
			}
			const verificationSession = this.session as VerificationCapableToolSession;
			const renderedTask = renderSubagentUserPrompt({
				assignment,
				prefetchEvidence: prefetch.evidence,
				evidenceDigest: params.evidenceDigest,
				codeWrite: params.codeWrite,
			});

			let generatedReceipt: CodeWriteReceipt | undefined;
			const sharedRunOptions = {
				cwd: spawnCwd,
				agent: effectiveAgent,
				task: renderedTask,
				assignment,
				context: sharedContext,
				planReference,
				description: params.description,
				role: params.role,
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				id: agentId,
				taskDepth,
				delegatedIo: params.evidenceDigest ? { kind: "evidence-digest" as const } : undefined,
				pinnedModel: nativeRuntime?.payload.effectiveModel,
				keepAlive: nativeRuntime || params.codeWrite || params.evidenceDigest ? false : undefined,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				spawnPlan,
				executionProfile: spawnPlan.profile,
				toolProfile,
				collaborationPolicy,
				harnessGuidance: harness.kind !== "full" ? harness.decisionSurface.guidance : undefined,
				assignmentContract: params.assignmentContract,
				recoveryCapsule: params.recoveryCapsule,
				recoveryAttempts: params.recoveryAttempt ? [params.recoveryAttempt] : undefined,
				extensionRunner,
				assignmentVerifierRunners: verificationSession.assignmentVerifierRunners,
				actualChangedFiles: verificationSession.getActualChangedFiles?.(),
				allocateRecoveryId: (recovery: RecoveryAttempt) =>
					outputManager.allocate(`${agentId}-recovery-${recovery.attempt}`),
				modelOverride,
				modelRouting,
				contextMode: params.fork === true ? ("fork" as const) : undefined,
				forkContext: params.fork === true ? this.session.getForkContext?.() : undefined,
				parentActiveModelPattern,
				thinkingLevel: thinkingLevelOverride,
				outputSchema: effectiveOutputSchema,
				sessionFile,
				persistArtifacts: !!artifactsDir || Boolean(params.codeWrite || params.evidenceDigest),
				artifactsDir: effectiveArtifactsDir,
				maxRuntimeMs: spawnPlan.maxRuntimeMs,
				enableLsp: subagentLspEnabled,
				signal,
				eventBus: this.session.eventBus,
				onProgress: (progress: AgentProgress) => {
					// Shallow snapshot; recentTools is mutated in place by the
					// executor, the rest is reassigned or immutable. A deep clone
					// here cost O(extractedToolData) per progress event.
					latestProgress = params.codeWrite
						? {
								...progress,
								recentTools: [],
								recentOutput: [],
								extractedToolData: undefined,
								retryFailure: undefined,
								lastIntent: undefined,
							}
						: { ...progress, recentTools: progress.recentTools.slice() };
					emitProgress();
				},
				authStorage: this.session.authStorage,
				modelRegistry: this.session.modelRegistry,
				settings: this.session.settings,
				mcpManager,
				contextFiles,
				skills: availableSkills,
				autoloadSkills: resolvedAutoloadSkills,
				workspaceTree: this.session.workspaceTree,
				promptTemplates,
				rules: this.session.rules,
				preloadedExtensionPaths: this.session.extensionPaths,
				preloadedCustomToolPaths: this.session.customToolPaths,
				localProtocolOptions,
				parentArtifactManager,
				clientBridge: this.session.getClientBridge?.(),
				parentHindsightSessionState: this.session.getHindsightSessionState?.(),
				parentMnemopiSessionState: this.session.getMnemopiSessionState?.(),
				parentTelemetry: this.session.getTelemetry?.(),
				parentEvalSessionId,
				parentAgentId: this.session.getAgentId?.() ?? MAIN_AGENT_ID,
			};

			const runTask = async (): Promise<SingleResult> => {
				if (!isIsolated) {
					nativeRuntime?.executing(null);
					return runSubprocess(sharedRunOptions);
				}

				const taskStart = Date.now();
				let isolationHandle: IsolationHandle | undefined;
				try {
					if (!repoRoot || !baseline) {
						throw new Error("Isolated task execution not initialized.");
					}
					const taskBaseline = structuredClone(baseline);

					isolationHandle = await ensureIsolation(
						repoRoot,
						nativeRuntime
							? `${agentId}-attempt-${nativeRuntime.checkpoint.attempt}-${Snowflake.next()}`
							: agentId,
						preferredIsolationBackend,
					);
					const isolationDir = isolationHandle.mergedDir;
					nativeRuntime?.executing(isolationDir);

					const isolatedCwd = path.resolve(isolationDir, path.relative(repoRoot, spawnCwd));
					const code = prepared.codeWrite;
					const delegatedIo: DelegatedIo | undefined = code
						? {
								kind: "code-write",
								workspaceRoot: isolatedCwd,
								reference: isPathWithinWorkspace(repoRoot, code.reference)
									? path.resolve(isolationDir, path.relative(repoRoot, code.reference))
									: code.reference,
								target: path.resolve(isolatedCwd, code.request.target),
							}
						: sharedRunOptions.delegatedIo;
					if (delegatedIo?.kind === "code-write") await assertCodeWriteTarget(delegatedIo);
					// Isolated runs re-discover extensions/custom tools inside the
					// worktree instead of reusing the parent's source paths.
					const result = await runSubprocess({
						...sharedRunOptions,
						worktree: isolatedCwd,
						delegatedIo,
						task:
							code && delegatedIo?.kind === "code-write"
								? renderSubagentUserPrompt({
										assignment,
										codeWrite: {
											...code.request,
											reference: delegatedIo.reference,
											target: delegatedIo.target,
										},
									})
								: renderedTask,
						preloadedExtensionPaths: undefined,
						preloadedCustomToolPaths: undefined,
					});
					try {
						const delta = await captureDeltaPatch(isolationDir, taskBaseline);
						result.patchPath = path.join(effectiveArtifactsDir, `${agentId}.patch`);
						await Bun.write(result.patchPath, delta.rootPatch);
						result.nestedPatches = delta.nestedPatches;
						if (code && delegatedIo?.kind === "code-write") {
							const expected = path.relative(repoRoot, code.target).replaceAll("\\", "/");
							const touched = delta.rootTouchedFiles;
							if (delta.nestedPatches.length || touched.length !== 1 || touched[0] !== expected)
								throw new Error("codeWrite changed paths other than its target, or produced no target patch.");
							generatedReceipt = await observeCodeWrite(delegatedIo, code.request.target);
						}
						if (
							mergeMode === "branch" &&
							result.exitCode === 0 &&
							!result.error &&
							!result.isError &&
							!result.aborted
						) {
							const committed = await commitToBranch(
								isolationDir,
								taskBaseline,
								agentId,
								params.description,
								code ? undefined : buildCommitMessageFn(),
								delta,
							);
							result.branchName = committed?.branchName;
						}
					} catch (error) {
						result.error = error instanceof Error ? error.message : String(error);
						result.exitCode = 1;
						result.isError = true;
					}
					return result;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						index: spawnIndex,
						id: agentId,
						agent: agent.name,
						agentSource: agent.source,
						task: renderedTask,
						assignment,
						description: params.description,
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						requests: 0,
						modelOverride,
						modelRouting,
						error: message,
					};
				} finally {
					if (isolationHandle) {
						await cleanupIsolation(isolationHandle);
					}
				}
			};

			const result = await runTask();
			if (nativeRuntime) {
				await nativeRuntime.complete(result, baseline, generatedReceipt);
				return this.#buildResultPayload(
					result,
					projectAgentsDir,
					Date.now() - startTime,
					result.mergeSummary ?? "",
				);
			}
			// Emit spawn_result telemetry
			{
				const telemetrySink = this.session.getOrchestrationTelemetry?.() ?? { emit: () => {}, events: [] };
				const yieldEntries = result.extractedToolData?.yield;
				const yieldData =
					Array.isArray(yieldEntries) && yieldEntries.length > 0
						? (yieldEntries[0] as Record<string, unknown>)
						: undefined;
				const resultStatus =
					yieldData?.status != null
						? String(yieldData.status)
						: result.aborted
							? "aborted"
							: result.exitCode === 0
								? "success"
								: "failed";
				recordSpawnResultTelemetry(telemetrySink, {
					sessionId: this.session.getSessionId?.() ?? undefined,
					correlationId: spawnPlan.correlationId,
					agentName,
					strategyFamily: params.strategyFamily,
					workerMode: resolveWorkerMode(agentName),
					verificationOutcome: resultStatus,
					metadata: {
						exitCode: result.exitCode,
						resolvedModel: result.resolvedModel,
						requestedDifficulty: modelRouting.requestedDifficulty,
						modelSelectionSource: modelRouting.source,
					},
				});
				// Update approach registry and emit blocker/approach_update when the child
				// reported a blocked or falsified outcome.
				if ((resultStatus === "blocked" || resultStatus === "falsified") && params.strategyFamily) {
					const registry = this.session.getApproachRegistry?.();
					if (registry) {
						const blockerText =
							Array.isArray(yieldData?.blockers) && (yieldData.blockers as unknown[]).length > 0
								? String((yieldData.blockers as unknown[])[0])
								: resultStatus;
						const record = registry.markBlocked(params.strategyFamily, agentName, blockerText);
						recordBlockerTelemetry(telemetrySink, {
							sessionId: this.session.getSessionId?.() ?? undefined,
							strategyFamily: params.strategyFamily,
							blockerFingerprint: record.blockerFingerprint ?? "",
							metadata: { agentName, blockerText },
						});
						recordApproachUpdateTelemetry(telemetrySink, {
							sessionId: this.session.getSessionId?.() ?? undefined,
							strategyFamily: params.strategyFamily,
							metadata: { status: resultStatus, blockerText },
						});
					}
				}
			}

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			if (isIsolated && repoRoot) {
				await integrateTaskResult({
					result,
					repoRoot,
					mergeMode,
					signal,
					commitMessage: buildCommitMessageFn(),
					codeWrite: prepared.codeWrite ? { kind: "code-write", ...prepared.codeWrite } : undefined,
				});
				changesApplied = result.changesApplied ?? false;
				mergeSummary = result.mergeSummary ?? "";
			}

			// Cleanup temp directory if used
			const shouldCleanupTempArtifacts =
				tempArtifactsDir && !isIsolated && !params.evidenceDigest && !params.codeWrite;
			if (shouldCleanupTempArtifacts) {
				await fs.rm(tempArtifactsDir, { recursive: true, force: true });
			}

			result.changesApplied = changesApplied ?? undefined;
			result.mergeSummary = mergeSummary || undefined;
			if (params.codeWrite || params.evidenceDigest) {
				if (prepared.codeWrite && generatedReceipt && result.exitCode === 0 && !result.error && !result.isError) {
					try {
						const observed = await observeCodeWrite(
							{ kind: "code-write", ...prepared.codeWrite },
							prepared.codeWrite.request.target,
						);
						// Git applies configured worktree conversions (for example core.autocrlf).
						// The receipt describes the integrated file, not its pre-integration byte representation.
						generatedReceipt = { ...observed, changesApplied: result.changesApplied === true };
					} catch (error) {
						result.exitCode = 1;
						result.isError = true;
						result.error = error instanceof Error ? error.message : String(error);
					}
				}
				await projectDelegatedIoResult({
					result,
					kind: params.codeWrite ? "code-write" : "evidence-digest",
					artifactsDir: effectiveArtifactsDir,
					artifactManager: parentArtifactManager,
					receipt: generatedReceipt,
				});
			}
			return this.#buildResultPayload(result, projectAgentsDir, Date.now() - startTime, mergeSummary);
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
			};
		} finally {
			if (params.assignmentContract) {
				this.session.setActiveTaskContract?.(undefined);
			}
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		if (result.delegatedIoKind) {
			return {
				content: [{ type: "text", text: result.output }],
				details: { projectAgentsDir, results: [result], totalDurationMs, usage: result.usage },
			};
		}
		const status = result.aborted
			? "cancelled"
			: result.isError === true
				? "failed verification"
				: result.exitCode === 0 && result.error
					? "merge failed"
					: result.exitCode === 0
						? "completed"
						: `failed (exit ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}
