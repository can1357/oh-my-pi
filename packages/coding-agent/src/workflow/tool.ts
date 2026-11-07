/**
 * The `workflow` tool: one deterministic orchestration script over subagents,
 * with a synchronous per-call journal and `resumeFrom` prefix replay.
 *
 * `agent()` calls go through the ordinary task executor
 * (`runStructuredSubagent`, `structured: false`): the child is a normal
 * subagent with the usual spawn policy, model approval, and concurrency
 * limits, and its final assistant message is the call's result.
 *
 * The script runs inside a terminable Bun Worker (see vm.ts); a workflow
 * AbortController cancels any child still outstanding when the script ends,
 * and their journal transitions are drained before the tool returns.
 *
 * The journal lives under the session directory
 * (`<session dir>/workflow/<session>/journal.jsonl`) and is appended
 * synchronously before and after every call, so a killed run can be resumed:
 * a matching completed prefix is replayed from the cache and only the
 * divergence tail executes. Each call is keyed by a deterministic call path
 * (parallel item scope + per-scope counter), not by completion order, so an
 * unchanged script replays all completed calls regardless of how its sibling
 * promises settled. Prefix matching is strict - once one call differs or
 * failed, every later call executes even if its prompt hash matches.
 */
import { randomUUID } from "node:crypto";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { assertNotRemoteA2aAgent } from "../a2a/agent-bridge";
import { acquireSessionSpawnPermit, releaseSessionSpawnPermit } from "../task/spawn-limiter";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { ToolSession } from "../tools";
import { throwIfAborted } from "../tools/tool-errors";
import {
	hashAgentCall,
	resolveWorkflowJournalPath,
	WorkflowJournal,
	type WorkflowCallRecord,
	type WorkflowLegacyCallRecord,
	type WorkflowJournalLine,
} from "./journal";
import {
	runWorkflowScript,
	type WorkflowAgentBridge,
	type WorkflowAgentCaller,
	type WorkflowAgentResult,
	type WorkflowRunResult,
	WorkflowScriptError,
} from "./vm";

const workflowSchema = type({
	script: type("string").describe(
		"JavaScript async function body. Helpers: agent(prompt, opts?), parallel(items, fn, {concurrency}), pipeline(items, ...stages), phase(name), log(...), clock(), args (the call's args string). Return a JSON-serializable value.",
	),
	"args?": type("string").describe("Input string exposed to the script as `args` (default empty)."),
	"resumeFrom?": type("string").describe(
		"Run id returned by a previous workflow call. Its completed prefix is replayed from the journal; only the divergence tail executes.",
	),
});

export type WorkflowParams = typeof workflowSchema.infer;

export interface WorkflowToolDetails {
	runId: string;
	journalPath: string;
	/** Agent calls executed in this run (including retries after divergence). */
	executed: number;
	/** Agent calls replayed from `resumeFrom` without execution. */
	cached: number;
	/** The script's return value. */
	result: unknown;
}

export interface WorkflowToolOptions {
	/** Test seam / host override for the child-agent executor. */
	runner?: WorkflowAgentCaller;
	/** Override the session-derived journal location. */
	journalPath?: string;
	/** Bound on the script's synchronous portion (default: 30 s). */
	syncTimeoutMs?: number;
	/** Bound on draining cancelled agent() calls once the run ends (default: 10 s). */
	drainTimeoutMs?: number;
}

export const WORKFLOW_TOOL_NAME = "workflow";

/** Default executor: one inline `task` subagent per call, final message as result. */
export function createWorkflowAgentRunner(session: ToolSession, signal?: AbortSignal): WorkflowAgentCaller {
	return async (prompt, opts) => {
		throwIfAborted(signal);
		// Only the task tool can route a remote A2A agent to its endpoint; the VM
		// would run the placeholder definition locally.
		assertNotRemoteA2aAgent(session, opts?.agent);
		// One more spawn path in the session, behind the same semaphore as the
		// task tool and the pi.spawnSubagent seam.
		await acquireSessionSpawnPermit(session, signal);
		try {
			const { result } = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: prompt,
				...(opts?.agent !== undefined ? { agent: opts.agent } : {}),
				...(opts?.context !== undefined ? { context: opts.context } : {}),
				structured: false,
				detached: false,
				enableIrc: false,
				...(signal !== undefined ? { signal } : {}),
				identity: { label: opts?.agent !== undefined ? `workflow:${opts.agent}` : "workflow" },
			});
			// The executor reports a failed run as a value, not a throw. Mirror its
			// success predicate (`!aborted && exitCode === 0 && !error`) so the
			// journal records `failed` and a resume re-executes instead of caching
			// the failure as a completed answer.
			if (result.aborted === true || result.exitCode !== 0 || result.error !== undefined) {
				const reason =
					result.error ??
					(result.aborted === true
						? result.abortReason?.trim() || "the run was aborted"
						: `the run exited with code ${result.exitCode}`);
				throw new Error(reason);
			}
			return { result: result.output.trim(), tokens: result.tokens ?? 0 };
		} finally {
			releaseSessionSpawnPermit(session);
		}
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function renderValue(value: unknown): string {
	try {
		const json = JSON.stringify(value, null, 2);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

/**
 * Runs one workflow script.
 *
 * `resumeFrom` names a prior run id (not a path): the journal is resolved from
 * the current session, matching calls are replayed with `cached: true`, and
 * the journal records every replay and execution under a fresh run id.
 */
export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = WORKFLOW_TOOL_NAME;
	/** Spawns subagents through the task executor. */
	readonly approval = "exec" as const;
	readonly label = "Workflow";
	readonly description =
		"Run one deterministic JavaScript workflow over subagents. The script body is an async function with agent(prompt, opts?), parallel(items, fn, {concurrency}) (default 4), pipeline(items, ...stages), phase(name), log(...), clock(), and args. agent() spawns a task subagent and returns { result, tokens }. Only one parallel/pipeline fan-out may be in flight at a time; nesting or overlapping them is rejected. Determinism is enforced: require, import/import(), process, Date, Date.now, Math.random, eval, and new Function are rejected. Every call is journaled; pass resumeFrom to replay matching completed calls by structural path.";
	readonly parameters = workflowSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Run a deterministic JavaScript workflow over subagents with journal resume";

	readonly #session: ToolSession;
	readonly #options: WorkflowToolOptions;

	constructor(session: ToolSession, options: WorkflowToolOptions = {}) {
		this.#session = session;
		this.#options = options;
	}

	static create(session: ToolSession, options: WorkflowToolOptions = {}): WorkflowTool {
		return new WorkflowTool(session, options);
	}

	async execute(
		_id: string,
		params: WorkflowParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WorkflowToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		throwIfAborted(signal);
		if (typeof params.script !== "string" || params.script.trim().length === 0) {
			throw new ToolError("workflow: script must be a non-empty string");
		}

		const journalPath = resolveWorkflowJournalPath(this.#session, this.#options.journalPath);
		const journal = new WorkflowJournal(journalPath);
		const resumeFrom = params.resumeFrom;
		const cachedRun = resumeFrom !== undefined ? journal.readRun(resumeFrom) : undefined;
		if (resumeFrom !== undefined && cachedRun === undefined) {
			throw new ToolError(`workflow: resumeFrom run ${resumeFrom} was not found in ${journalPath}`);
		}

		// A resumed run's own prefix is recorded as `cached`; accepting it lets a
		// run be resumed again after a second kill.
		const isReplayable = (call: { status: string }): boolean =>
			call.status === "completed" || call.status === "cached";
		const cachedByPath = new Map<string, WorkflowCallRecord>();
		// Runs journaled before call paths existed resume as they were written:
		// by invocation index, with a strict prefix (the prompt hash still has to
		// match, so a reordered parallel fan-out re-executes instead of replaying
		// another item's answer).
		const legacyByIndex = new Map<number, WorkflowLegacyCallRecord>();
		if (cachedRun?.format === "legacy") {
			for (const call of cachedRun.calls) if (isReplayable(call)) legacyByIndex.set(call.index, call);
		} else {
			for (const call of cachedRun?.calls ?? []) if (isReplayable(call)) cachedByPath.set(call.callPath, call);
		}
		const legacyResume = cachedRun?.format === "legacy";
		let legacyPrefixIntact = true;

		const runId = `wf-${randomUUID()}`;
		const controller = new AbortController();
		const runnerSignal = signal !== undefined ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		let rootPrefixIntact = true;
		const divergentScopes = new Set<string>();
		const poolPrefixes = new Map<string, boolean>();
		let nextIndex = 0;
		let executed = 0;
		let cached = 0;
		const runner = this.#options.runner ?? createWorkflowAgentRunner(this.#session, runnerSignal);
		// The journal closes when the tool returns: a call abandoned after
		// ignoring cancellation keeps only its `started` line, so a resume
		// re-executes it instead of trusting an answer nobody awaited.
		let journalOpen = true;
		const record = (line: WorkflowJournalLine): void => {
			if (journalOpen) journal.append(line);
		};

		const journalRunner: WorkflowAgentBridge = async (prompt, opts, context) => {
			throwIfAborted(context.signal);
			const index = nextIndex;
			nextIndex += 1;
			const { callPath } = context;
			const agent = opts?.agent ?? "default";
			const promptHash = hashAgentCall({ prompt, agent: opts?.agent, context: opts?.context });
			const scope = callPath.slice(0, callPath.lastIndexOf(":"));
			const pool = scope.slice(0, scope.lastIndexOf("."));
			if (scope !== "r" && !poolPrefixes.has(pool)) poolPrefixes.set(pool, rootPrefixIntact);
			let prior: WorkflowLegacyCallRecord | undefined;
			if (legacyResume) {
				prior = legacyPrefixIntact ? legacyByIndex.get(index) : undefined;
			} else {
				prior = (scope === "r" ? rootPrefixIntact : poolPrefixes.get(pool) && !divergentScopes.has(scope))
					? cachedByPath.get(callPath)
					: undefined;
			}

			if (prior !== undefined && prior.promptHash === promptHash) {
				cached += 1;
				record({
					runId,
					index,
					callPath,
					promptHash,
					agent,
					result: prior.result,
					tokens: prior.tokens,
					status: "cached",
				});
				return { result: prior.result ?? "", tokens: prior.tokens, cached: true };
			}

			rootPrefixIntact = false;
			legacyPrefixIntact = false;
			divergentScopes.add(scope);
			record({ runId, index, callPath, promptHash, agent, result: null, tokens: 0, status: "started" });
			executed += 1;
			try {
				const outcome: WorkflowAgentResult = await runner(prompt, opts, context);
				record({
					runId,
					index,
					callPath,
					promptHash,
					agent,
					result: outcome.result,
					tokens: outcome.tokens,
					status: "completed",
				});
				return outcome;
			} catch (error) {
				record({
					runId,
					index,
					callPath,
					promptHash,
					agent,
					result: null,
					tokens: 0,
					status: "failed",
					error: errorMessage(error),
				});
				throw error;
			}
		};

		let run: WorkflowRunResult;
		try {
			run = await runWorkflowScript({
				script: params.script,
				args: params.args ?? "",
				agent: journalRunner,
				controller,
				...(signal !== undefined ? { signal } : {}),
				...(this.#options.syncTimeoutMs !== undefined ? { syncTimeoutMs: this.#options.syncTimeoutMs } : {}),
				...(this.#options.drainTimeoutMs !== undefined ? { drainTimeoutMs: this.#options.drainTimeoutMs } : {}),
				onLog: line => onUpdate?.({ content: [{ type: "text", text: `workflow log: ${line}` }] }),
				onPhase: name => onUpdate?.({ content: [{ type: "text", text: `workflow phase: ${name}` }] }),
			});
		} catch (error) {
			// An abort must surface as an abort, not as a script failure.
			if (signal?.aborted) throwIfAborted(signal);
			const reason = error instanceof WorkflowScriptError ? error.message : errorMessage(error);
			throw new ToolError(`workflow ${runId} failed: ${reason}\njournal: ${journalPath}`);
		} finally {
			journalOpen = false;
		}

		const phases = run.phases.length > 0 ? `phases: ${run.phases.join(" > ")}\n` : "";
		const logLines = run.logs.length > 0 ? `log:\n${run.logs.map(line => `  ${line}`).join("\n")}\n` : "";
		const text = [
			`workflow ${runId}: ${executed} executed, ${cached} cached`,
			...(run.abandonedCalls > 0
				? [
						`${run.abandonedCalls} agent() call(s) ignored cancellation and were abandoned; a resume re-executes them`,
					]
				: []),
			`journal: ${journalPath}`,
			phases + logLines,
			`result:\n${renderValue(run.value)}`,
		]
			.filter(part => part.length > 0)
			.join("\n");

		return {
			content: [{ type: "text", text }],
			details: { runId, journalPath, executed, cached, result: run.value },
		};
	}
}
