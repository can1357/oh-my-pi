/**
 * Main-side routing of subagent runs between the main thread and pooled worker threads
 * (served there by `./services/executor`).
 *
 * - {@link runSubprocessPlaced} runs the whole subagent (child session creation,
 *   monitoring, lifecycle finalization) where the pool places it: on this thread or in a
 *   worker, which stays retained afterwards while the child's session is open there.
 * - {@link runFollowUpTurnOnHome} sends a follow-up turn to the thread its session is homed
 *   on; from a worker, to main, which routes it on.
 * - {@link revivePersistedPlaced} cold-revives a parked agent where the pool places it, like
 *   a fresh spawn.
 * - A worker that dies mid-run or mid-turn turns the call into a failed `SingleResult` whose
 *   error names the worker; the agent's ref is left `parked` (revivable from its transcript)
 *   or `aborted` (no transcript).
 *
 * Kept apart from the thread service so importing it never evaluates the service list.
 */
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import {
	type ExecutorOptions,
	type FollowUpTurnOptions,
	type SubagentRunRequest,
	subagentRunRequest,
} from "../task/executor";
import type { PersistedReviveSpec } from "../task/persisted-revive";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../task/types";
import { type EventBus, emitSubagentFrame } from "../utils/event-bus";
import { isMainThread, type ThreadId } from "./identity";
import type { WorkerThreadLink } from "./protocol";
import { RemoteAgentSession } from "./remote-agent-session";
import { bridgeIntegrationOptions } from "./services/integrations";
import { existingSubagentWorkerPool, type SubagentWorker, type SubagentWorkerPool } from "./subagent-worker";

/** This worker's link to main, once the executor thread service installed it. */
let mainLink: WorkerThreadLink | undefined;

/** Worker thread: the link follow-up turns of sessions homed elsewhere are forwarded over. */
export function setWorkerMainLink(link: WorkerThreadLink): void {
	mainLink = link;
}

/** What a failed result for a run lost with its worker reports. */
interface LostRun {
	readonly index: number;
	readonly id: string;
	readonly agent: AgentDefinition;
	readonly task: string;
	readonly assignment?: string;
	readonly description?: string;
	readonly modelOverride?: string | string[];
	readonly modelRole?: string;
	readonly parentToolCallId?: string;
	readonly detached?: boolean;
	readonly eventBus?: EventBus;
	readonly subagentEventBus?: EventBus;
}

function workerGone(worker: SubagentWorker | undefined, home: ThreadId): string {
	return `Subagent worker ${home} exited mid-run: ${worker?.exitReason ?? "worker is gone"}`;
}

/**
 * The failed result of a run whose worker died. The worker's own `settled` frame never
 * came, so emit it here; a ref the worker never attached a session to is settled too
 * (refs with an attached session were already detached by the agents service).
 */
function lostRunResult(run: LostRun, error: string, startTime: number): SingleResult {
	const registry = AgentRegistry.global();
	const ref = registry.get(run.id);
	if (ref && !ref.session && ref.status === "running") {
		registry.setStatus(run.id, ref.sessionFile ? "parked" : "aborted", ref);
	}
	emitSubagentFrame(run.eventBus, run.subagentEventBus, TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: run.id,
		agent: run.agent.name,
		parentToolCallId: run.parentToolCallId,
		detached: run.detached,
		agentSource: run.agent.source,
		description: run.description,
		status: "failed",
		sessionFile: ref?.sessionFile ?? undefined,
		index: run.index,
	});
	return {
		index: run.index,
		id: run.id,
		agent: run.agent.name,
		agentSource: run.agent.source,
		task: run.task,
		assignment: run.assignment,
		description: run.description,
		exitCode: 1,
		output: "",
		stderr: error,
		truncated: false,
		durationMs: Date.now() - startTime,
		tokens: 0,
		requests: 0,
		modelOverride: run.modelOverride,
		modelRole: run.modelRole,
		error,
	};
}

/** Run `call` on `worker`; a rejection caused by the worker dying becomes `lost(reason)`. */
async function callOnWorker(
	worker: SubagentWorker,
	call: () => Promise<SingleResult>,
	lost: (reason: string) => SingleResult,
): Promise<SingleResult> {
	try {
		return await call();
	} catch (error) {
		if (worker.alive) throw error;
		return lost(workerGone(worker, worker.threadId));
	}
}

/**
 * Main thread: run the subagent of `options` where `pool` places it (see
 * {@link SubagentWorkerPool.place}): in a worker, or through `runHere` on this thread, its
 * run counted either way. For a worker, the integration options are converted synchronously
 * at placement, so a parent telemetry config captures the caller's active span.
 */
export async function runSubprocessPlaced(
	pool: SubagentWorkerPool,
	options: ExecutorOptions,
	runHere: (options: ExecutorOptions) => Promise<SingleResult>,
): Promise<SingleResult> {
	const placed = pool.place();
	let request: SubagentRunRequest | undefined;
	try {
		request = placed.worker ? subagentRunRequest(bridgeIntegrationOptions(options)) : undefined;
	} catch (error) {
		placed.release();
		throw error;
	}
	const startTime = Date.now();
	const placement = await pool.settle(placed);
	try {
		const worker = placement.worker;
		if (!worker || !request) return await runHere(options);
		return await callOnWorker(
			worker,
			() => worker.link.call("runSubprocess", request),
			error => lostRunResult(options, error, startTime),
		);
	} finally {
		placement.release();
	}
}

function followUpRun(options: FollowUpTurnOptions): LostRun {
	return {
		index: options.index ?? 0,
		id: options.id,
		agent: options.agent,
		task: options.message,
		description: options.description,
		modelRole: options.modelRole,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		eventBus: options.eventBus,
		subagentEventBus: options.subagentEventBus,
	};
}

/**
 * Run a follow-up turn of `session`, a live session homed on another thread, on its home:
 * from main, the session's worker; from a worker, main (which routes on).
 */
export async function runFollowUpTurnOnHome(
	session: AgentSessionHandle,
	options: FollowUpTurnOptions,
): Promise<SingleResult> {
	if (!isMainThread()) {
		if (!mainLink) throw new Error("executor service: worker link to main is not installed");
		return mainLink.call("runFollowUpTurn", options);
	}
	if (!(session instanceof RemoteAgentSession)) {
		throw new Error(`Subagent ${options.id} has a live session of unknown origin; cannot route its follow-up turn.`);
	}
	const startTime = Date.now();
	const worker = existingSubagentWorkerPool()?.forThread(session.home);
	if (!worker?.alive) return lostRunResult(followUpRun(options), workerGone(worker, session.home), startTime);
	// A running turn occupies its worker for placement like a fresh run.
	const endRun = worker.beginRun();
	try {
		return await callOnWorker(
			worker,
			() => worker.link.call("runFollowUpTurn", options),
			error => lostRunResult(followUpRun(options), error, startTime),
		);
	} finally {
		endRun();
	}
}

/**
 * Main thread: cold-revive the agent of `spec` where `pool` places it, like a fresh spawn: in a
 * worker (returning its mirror) or through `reviveHere` on this thread.
 */
export async function revivePersistedPlaced(
	pool: SubagentWorkerPool,
	spec: PersistedReviveSpec,
	expected: AgentRef,
	reviveHere: (spec: PersistedReviveSpec, expected: AgentRef) => Promise<AgentSessionHandle>,
): Promise<AgentSessionHandle> {
	const placement = await pool.acquire();
	try {
		if (!placement.worker) return await reviveHere(spec, expected);
		return await placement.worker.link.call("revivePersisted", spec, expected);
	} finally {
		// A worker-homed revived session's open mirror retains its worker from here on.
		placement.release();
	}
}
