import * as path from "node:path";
import { logger, Snowflake, workerHostEntry } from "@oh-my-pi/pi-utils";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	killWorkerSubprocess,
	resolveWorkerSpawnCmd,
	settlesWithin,
	WORKER_EXIT_CONFIRM_MS,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import type { ToolSession } from "../../tools";
import { ToolAbortError } from "../../tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../bridge-timeout";
import { getEnabledEvalPreludes } from "../preludes";
import {
	attachSessionOwner,
	EvalKernelNotRunningError,
	formatKernelReclaimNotice,
	type SessionOwners,
} from "../executor-base";
import { shouldDetachKernel } from "../py/spawn-options";
import { updateEvalState } from "../state";
import { SupersededKernelReaper, type SupersededReclaimOutcome } from "../superseded-reclaim";
import type { EvalShadowCellSession } from "../speculation/cell-session";
import { getActiveEvalShadowCell } from "../speculation/runtime-context";
import type { ShadowPlan } from "../speculation/types";
import type { EvalDisplayOutput, EvalToolDescriptor, EvalToolInvokeResult } from "../types";
import { type ShadowSnapshot, shadowSnapshotDigest } from "./shared/runtime";
import { projectJavaScriptShadowPlan } from "./speculation";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.
import type {
	EvalPreludeSource,
	JsToolRequest,
	RunErrorPayload,
	SessionSnapshot,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";

export { rewriteImports, wrapCode } from "./shared/rewrite-imports";

export interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: EvalDisplayOutput) => void;
	/** Shows the user `out://` replies of the run's bridged tool calls; absent, those calls are refused. */
	onReply?: (text: string) => void;
}

/** Isolated runtime transport used by the context manager and startup regression fixtures. */
export interface JsEvalWorkerHandle {
	mode: "process" | "worker";
	send(msg: WorkerInbound): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	/** Ask the worker to exit; true once it has, false when it did not answer in time. */
	close(): Promise<boolean>;
	/**
	 * Kill the worker; true once its exit has been seen, false when it was not
	 * seen within {@link WORKER_EXIT_CONFIRM_MS}. Sending the kill is not the
	 * answer: a caller that must not lose a live worker keeps it on false.
	 */
	terminate(): Promise<boolean>;
}

/** Startup dependencies overridden by tests to exercise process-to-Worker recovery. */
export interface JsEvalWorkerFactories {
	spawnProcess(): JsEvalWorkerHandle;
	spawnWorker(): JsEvalWorkerHandle;
}

interface PendingRun {
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
	shadowCell?: EvalShadowCellSession;
	resolve(value: { value: unknown }): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	/**
	 * Host calls currently inside a `deferExternalAbort` phase — `agent()`
	 * isolation worktree setup and merge/cherry-pick, which ignore their abort
	 * once started. Settling the run while one is live would return the cell on
	 * top of a git operation still rewriting the repo, so the abort path drains
	 * this first. Mirrors the Python bridge's shielded-signal contract.
	 */
	deferDepth: number;
	/** Resolves once {@link deferDepth} falls back to zero. */
	deferDrained?: PromiseWithResolvers<void>;
	/** Set once the turn was cancelled; blocks new bridge calls during the drain. */
	aborted: boolean;
	/**
	 * A worker `result` withheld because the cell still has bridge calls in
	 * flight. `#runOne` reports a finished run without awaiting its pending
	 * tools, so a floated or caught `agent()` would otherwise settle the run —
	 * tearing down the abort listener — while the subagent kept going with
	 * nothing left able to cancel it. Delivered once the last call drains.
	 */
	heldResult?: Extract<WorkerOutbound, { type: "result" }>;
	settled: boolean;
}

interface JsSession {
	sessionKey: string;
	sessionId: string;
	kernelId: string;
	cwd: string;
	packageRoot?: string;
	packageEnvironment?: string;
	worker: JsEvalWorkerHandle;
	state: "alive" | "dead";
	stateSessions: Set<ToolSession>;
	pending: Map<string, PendingRun>;
	pendingSnapshots: Map<string, PromiseWithResolvers<Extract<WorkerOutbound, { type: "shadow-snapshot" }>>>;
	pendingShadowRuns: Map<string, PromiseWithResolvers<Extract<WorkerOutbound, { type: "shadow-run" }>>>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
	/**
	 * Callers currently holding this context: a cell from the moment it
	 * acquires the session, and a borrower such as a subagent that can call the
	 * context's kernel-defined tools.
	 */
	activeUses: number;
}

interface StartingJsSession extends SessionOwners {
	promise: Promise<JsSession>;
}

const sessions = new Map<string, JsSession>();
/**
 * The session key each explicit owner acquired last. A superseded context is
 * only reclaimed once every owner registered against it has moved on, and
 * `ownerIds` alone cannot say that: an id attached at one key stays there for
 * the context's life.
 */
const ownerKeys = new Map<string, string>();
const reaper = new SupersededKernelReaper<JsSession>();
const startingSessions = new Map<string, StartingJsSession>();
const resettingSessions = new Map<string, Promise<void>>();
/**
 * Workers a reclaim terminated, by owner and then by key: the worker that went
 * and the directory it ran in. The next cell on such a key runs in a fresh
 * worker with none of the globals, timers or subprocesses the caller built
 * up, and nothing else here would say so — a reclaim that works is silent.
 *
 * Written in the same synchronous step that takes the context out of
 * `sessions`, never after the kill it then awaits, so a cell, a reset or a
 * disposal landing while the worker is still closing already sees it and
 * nothing late writes it back. Said to that owner's next cell there that runs
 * in a different worker, then dropped; also dropped by that owner's reset of
 * the key, and with the owner when it is disposed.
 */
const reclaimedWorkers = new Map<string, Map<string, { kernelId: string; cwd: string }>>();

/** A worker whose kill could not be confirmed: no context's any more, only a process still to end. */
interface UnconfirmedWorker {
	worker: JsEvalWorkerHandle;
	kernelId: string;
	/** Owners whose disposal still retries it, once; that disposal drops itself from here. */
	owners: Set<string>;
}

/**
 * Workers whose kill could not be confirmed, kept so a disposal can try again
 * rather than return with them forgotten. Each is out of `sessions` and dead
 * to every caller — no cell, reclaim or notice reaches it — so this is cleanup
 * debt only, kept apart from who owns a live context and who is owed a
 * notice. An owner's disposal retries that owner's once; the process-wide
 * disposal retries every one. A worker stuck in truly uninterruptible kernel
 * I/O stays until that I/O completes or is aborted.
 */
const unconfirmedWorkers = new Set<UnconfirmedWorker>();

// Worker startup (module-graph import + WorkerCore construction) is infrastructure
// cost, not user compute. Floor it independently of Bun's 5s default per-test timeout
// so a slow cold-start under load isn't aborted mid-init — terminating a still-
// initializing eval runtime triggers the same kind of terminate-race that motivates
// avoiding `vm.runInContext` (see shared/indirect-eval.ts), here surfacing as a
// SIGILL/SIGSEGV. Callers that pass a larger per-cell budget still dominate.
const WORKER_INIT_TIMEOUT_MS = 15_000;
const WORKER_CLOSE_TIMEOUT_MS = 1_000;
const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";
const productionWorkerFactories: JsEvalWorkerFactories = {
	spawnProcess: spawnJsProcess,
	spawnWorker: spawnBunWorker,
};
let workerFactories = productionWorkerFactories;

/**
 * Test-only seam for exercising isolated-runtime startup transitions. Returns
 * an idempotent restore callback so tests cannot strand a process-wide factory.
 */
export function setJsEvalWorkerFactoriesForTests(factories: JsEvalWorkerFactories): () => void {
	const previous = workerFactories;
	workerFactories = factories;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (workerFactories === factories) workerFactories = previous;
	};
}

export async function executeInVmContext(options: {
	sessionKey: string;
	sessionId: string;
	/** Logical owner identifier; scopes retained-worker cleanup via {@link disposeVmContextsByOwner}. */
	ownerId?: string;
	cwd: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	/** Selected package directory consulted only after the importing file's project. */
	packageRoot?: string;
	/** Model-visible description of the selected package environment. */
	packageEnvironment?: string;
	reset?: boolean;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
}): Promise<{ value: unknown }> {
	const { sessionKey, ownerId } = options;
	if (options.reset) {
		// Coalesce concurrent resets: an existing in-flight reset already
		// produces a fresh context, so a follow-up `reset: true` cell should
		// just wait for it rather than failing the user-visible call.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetVmContext(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
		// A caller that asked for a fresh context is not surprised by one, so
		// what a reclaim took from this owner here goes unsaid rather than
		// explaining a restart the caller ordered.
		if (ownerId !== undefined) forgetReclaimedWorker(ownerId, sessionKey);
	} else {
		// Internal coordination: wait for any in-flight reset to settle and
		// then run on the freshly-rebuilt context.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	// `acquireSession` records this owner at `sessionKey` before it knows
	// whether a worker can be started there, so the move away from wherever the
	// owner was is already real when a startup rejects — both spawn factories
	// failing, an init that never answers. The boundary therefore opens
	// *before* the acquisition: the rejection and the ordinary end of the cell
	// leave through the same `finally`.
	let session: JsSession | undefined;
	try {
		session = await acquireSession(
			sessionKey,
			{
				cwd: options.cwd,
				sessionId: options.sessionId,
				localRoots: options.localRoots,
				packageRoot: options.packageRoot,
				packageEnvironment: options.packageEnvironment,
			},
			options.session,
			options.timeoutMs,
			ownerId,
		);
		reconcileSupersededJsSessions();
		// The worker this owner had here was reclaimed while it worked
		// elsewhere, so this cell is the first thing that can say the earlier
		// globals are gone — including a cell that started while that worker
		// was still closing. Emitted before the cell's own output, which also
		// carries it when the cell throws, and after the acquisition so a
		// startup that fails leaves it owed.
		const reclaimed = ownerId === undefined ? undefined : reclaimedWorkers.get(ownerId)?.get(sessionKey);
		if (reclaimed !== undefined && ownerId !== undefined) {
			forgetReclaimedWorker(ownerId, sessionKey);
			if (reclaimed.kernelId !== session.kernelId) {
				options.runState.onText?.(`${formatKernelReclaimNotice("JS worker", reclaimed.cwd, "worker")}\n`);
			}
		}
		const result = await runOnce(session, options);
		if (session.state === "alive" && path.isAbsolute(options.filename)) {
			updateEvalState(options.session, {
				language: "js",
				kernelId: session.kernelId,
				alive: true,
				loadedPath: options.filename,
			});
		}
		return result;
	} finally {
		// This cell is done holding the context, and its owner may have moved on
		// while it ran — an older key whose cold start finished last is
		// superseded the moment its only cell ends.
		if (session) session.activeUses -= 1;
		reconcileSupersededJsSessions();
	}
}

/**
 * Arm or disarm the reclaim grace on every retained JavaScript context, in one
 * pass over the registry. The grace runs from the moment a context is found
 * superseded, not from when it falls idle.
 *
 * A retained JavaScript context is keyed by the eval session id, which ends in
 * `:cwd:<cwd>`, so an owner that changes directory — or whose eval session id
 * gains its on-disk session file — acquires a *new* worker and strands the
 * previous one. Nothing reclaimed it: its heap stayed resident until the host
 * process exited, whether it was the isolated subprocess or the Bun Worker
 * thread the host falls back to, which no process list shows.
 *
 * Whether a context is stranded is a property of the registry as a whole —
 * where each of its owners is working now — not of the call that happens to
 * notice, so the question is asked about every context from every point that
 * can change the answer: a cell acquiring or releasing one, a borrow ending,
 * an owner departing. The rules match the Python registry's
 * `reconcileSupersededSessions`: a context is armed once every agent
 * registered against it has run its latest cell elsewhere, a caller holding it
 * or work in flight keeps it alive when the grace expires, and a reclaim those
 * guards stop is armed again rather than dropped.
 */
function reconcileSupersededJsSessions(): void {
	for (const [key, session] of Array.from(sessions.entries())) {
		// Armed on ownership alone; the fire-time guards decide. See the Python
		// registry's `reconcileSupersededSessions` for why a busy context is armed.
		if (isSuperseded(key, session)) reaper.schedule(session, () => reclaimSuperseded(key, session));
		else reaper.cancel(session);
	}
}

/** Terminate the worker under `key`, unless a fire-time guard still holds it. */
async function reclaimSuperseded(key: string, session: JsSession): Promise<SupersededReclaimOutcome> {
	if (!isSuperseded(key, session) || session.state !== "alive") return "settled";
	if (session.activeUses > 0) return "deferred";
	if (session.pending.size > 0 || session.pendingSnapshots.size > 0 || session.pendingShadowRuns.size > 0) {
		return "deferred";
	}
	sessions.delete(key);
	// The globals this key held are gone from the moment the context leaves
	// the map: a cell arriving now gets a fresh worker while this one may take
	// a second more to close. So the loss is recorded in this same step, not
	// after the kill, and nothing that settles later writes it again.
	for (const owner of session.ownerIds) {
		let byKey = reclaimedWorkers.get(owner);
		if (byKey === undefined) {
			byKey = new Map();
			reclaimedWorkers.set(owner, byKey);
		}
		byKey.set(key, { kernelId: session.kernelId, cwd: session.cwd });
	}
	await killSession(session, new ToolError("JS context left behind by its session"), { force: false });
	return "settled";
}

function forgetReclaimedWorker(owner: string, key: string): void {
	const byKey = reclaimedWorkers.get(owner);
	if (byKey === undefined) return;
	byKey.delete(key);
	if (byKey.size === 0) reclaimedWorkers.delete(owner);
}

/**
 * Whether `session` under `key` is one nobody is still working at, and may
 * therefore be armed or shut down.
 */
function isSuperseded(key: string, session: JsSession): boolean {
	if (sessions.get(key) !== session) return false;
	return everyOwnerMovedAway(key, session);
}

/**
 * Whether every agent registered against `session` has since run a cell under
 * another key. A fallback owner is a session id invented for a caller that
 * gave none, and two such callers are indistinguishable, so a context carrying
 * one is never reclaimed.
 */
function everyOwnerMovedAway(key: string, session: JsSession): boolean {
	if (session.hasFallbackOwner || session.ownerIds.size === 0) return false;
	for (const owner of session.ownerIds) {
		if (ownerKeys.get(owner) !== key) continue;
		return false;
	}
	return true;
}

/**
 * Hold the live JavaScript context for `sessionKey` so a superseded-context
 * reclaim leaves it alone, and return the release. Borrowers that can call its
 * kernel-defined tools between cells — a background subagent given `tools=[…]`
 * — hold one for as long as that is true.
 */
export function borrowVmContext(sessionKey: string): () => void {
	const session = sessions.get(sessionKey);
	if (!session) return () => {};
	session.activeUses += 1;
	reaper.cancel(session);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		session.activeUses -= 1;
		// The borrow was this context's only reason to be spared, and cancelling
		// its timer was this borrow's doing: a context the owner had already left
		// gets no later cell to arm it again.
		reconcileSupersededJsSessions();
	};
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Describe or invoke tools defined in a retained JavaScript kernel. */
export async function invokeJsTool(
	request: JsToolRequest,
	options: {
		sessionKey: string;
		session: ToolSession;
		signal?: AbortSignal;
	},
): Promise<EvalToolInvokeResult | { ok: true; tools: EvalToolDescriptor[]; missing: string[] }> {
	const session = sessions.get(options.sessionKey);
	if (!session || session.state !== "alive") throw new EvalKernelNotRunningError("JavaScript");

	const runId = `tool-${crypto.randomUUID()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	let envelope: unknown;
	const pending: PendingRun = {
		runId,
		runState: { signal: options.signal },
		toolSession: options.session,
		resolve,
		reject,
		toolCalls: new Map(),
		deferDepth: 0,
		aborted: false,
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		if (pending.settled) return;
		pending.aborted = true;
		pending.settled = true;
		const error = reasonToError(options.signal?.reason, "Tool invocation aborted");
		for (const controller of pending.toolCalls.values()) controller.abort(error);
		reject(error);
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		if (!pending.settled) safeSend(session, { type: "tool", runId, ...request });
		envelope = (await promise).value;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}

	if (!isUnknownRecord(envelope) || envelope.ok !== true) {
		return { ok: false, error: "JavaScript tool request returned an invalid response" };
	}
	if (request.op === "call") {
		if (!("value" in envelope)) return { ok: false, error: "JavaScript tool call returned an invalid response" };
		return { ok: true, value: envelope.value };
	}

	const rawTools = Array.isArray(envelope.tools) ? envelope.tools : [];
	const tools: EvalToolDescriptor[] = [];
	for (const rawTool of rawTools) {
		if (!isUnknownRecord(rawTool)) continue;
		const { name, description, parameters } = rawTool;
		if (typeof name !== "string" || typeof description !== "string" || !isUnknownRecord(parameters)) continue;
		tools.push({ name, description, parameters, language: "js" });
	}
	const missing = Array.isArray(envelope.missing)
		? envelope.missing.filter((name): name is string => typeof name === "string")
		: [];
	return { ok: true, tools, missing };
}

/**
 * Captures a retained runtime's safe user-global snapshot without executing user
 * code. A busy runtime returns `null`; callers must execute normally.
 */
export async function snapshotVmContext(options: {
	sessionKey: string;
	cwd: string;
	sessionId: string;
	localRoots?: Record<string, string>;
	timeoutMs?: number;
}): Promise<ShadowSnapshot | null> {
	const session = sessions.get(options.sessionKey);
	if (session?.state !== "alive") return null;
	const id = `snapshot-${Snowflake.next()}`;
	const deferred = Promise.withResolvers<Extract<WorkerOutbound, { type: "shadow-snapshot" }>>();
	session.pendingSnapshots.set(id, deferred);
	try {
		session.worker.send({
			type: "shadow-snapshot",
			id,
			snapshot: {
				cwd: options.cwd,
				sessionId: options.sessionId,
				localRoots: options.localRoots,
				packageRoot: session.packageRoot,
				packageEnvironment: session.packageEnvironment,
			},
		});
		const reply = await raceWithTimeout(
			deferred.promise,
			options.timeoutMs ?? WORKER_INIT_TIMEOUT_MS,
			"JS shadow snapshot timed out",
		);
		return reply.eligible ? (reply.snapshot ?? null) : null;
	} finally {
		session.pendingSnapshots.delete(id);
	}
}

export interface JavaScriptShadowPlanningResult {
	snapshot: ShadowSnapshot;
	digest: string;
	plan: ShadowPlan;
}

/**
 * Retained-only planning seam. It never starts a worker and never executes the
 * candidate source; unavailable or busy runtimes fall back to normal eval.
 */
export async function shadowPlanIfPresent(options: {
	sessionKey: string;
	cwd: string;
	sessionId: string;
	code: string;
	localRoots?: Record<string, string>;
	timeoutMs?: number;
}): Promise<JavaScriptShadowPlanningResult | null> {
	const snapshot = await snapshotVmContext(options);
	if (!snapshot) return null;
	return {
		snapshot,
		digest: shadowSnapshotDigest(snapshot),
		plan: await projectJavaScriptShadowPlan(options.code, {
			snapshot: snapshot.values,
			initialGlobals: snapshot.initialGlobals,
		}),
	};
}

/**
 * Atomically rechecks a retained runtime's snapshot before starting a real
 * cell. `null` means the caller must discard speculative outcomes and use the
 * normal execution path.
 */
export async function runIfSnapshotMatches(options: {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	code: string;
	filename: string;
	runState: VmRunState;
	expectedRevision: number;
	expectedDigest: string;
}): Promise<{ value: unknown } | null> {
	const session = sessions.get(options.sessionKey);
	if (session?.state !== "alive") return null;
	try {
		return await runOnce(session, options);
	} catch (error) {
		if (error instanceof ToolError && error.message === "JS shadow snapshot changed") return null;
		throw error;
	}
}

export async function resetVmContext(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!session) return;
	reaper.cancel(session);
	sessions.delete(sessionKey);
	await killSession(session, new ToolError("JS context reset"), { force: false });
}

export async function disposeAllVmContexts(): Promise<void> {
	// A disposal never waits out a grace: the timers go, and the contexts they
	// held are killed below like any other.
	reaper.cancelAll();
	ownerKeys.clear();
	reclaimedWorkers.clear();
	// A reclaim that fired just before the cancel removed its context from the
	// map and may still be closing that worker; a dispose must not return
	// while one is up. Joined alongside the kills below, not ahead of them.
	const reclaiming = reaper.running();
	const reclaims = reaper.settle();
	// Workers an earlier kill could not confirm get their attempt alongside.
	const earlier = [...unconfirmedWorkers];
	const pending = [...startingSessions.values()].map(starting => starting.promise);
	startingSessions.clear();
	const all = Array.from(sessions.values());
	sessions.clear();
	const started = Promise.allSettled(pending).then(results =>
		Promise.all(
			results.flatMap(result => {
				if (result.status !== "fulfilled" || all.includes(result.value)) return [];
				const session = result.value;
				if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
				return [killSession(session, new ToolError("JS context disposed"), { force: false })];
			}),
		),
	);
	await Promise.all([
		reclaims,
		started,
		retryUnconfirmedWorkers(earlier),
		...all.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })),
	]);
	// A joined reclaim whose kill went unconfirmed gets one more attempt; what
	// this disposal's own kills could not confirm is kept for the next one.
	await retryUnconfirmedWorkers(unconfirmedOf(reclaiming));
}

/**
 * Shut down retained JS contexts owned solely by `ownerId`; contexts with other
 * owners (e.g. an in-memory session keyed only by cwd) just drop the registration.
 */
export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	// Everything up to the first `await` is one synchronous step, so no grace
	// expires between the reclaims found running and the sweep.
	//
	// A reclaim already running removed its context from the map before it
	// awaited the kill, so the sweep below cannot see that worker and would
	// return while it is still up. This owner's reclaims are joined alongside
	// its own kills; another owner's are not this disposal's to wait for.
	const reclaiming = reaper.running().filter(session => session.ownerIds.has(ownerId));
	const reclaims = reaper.settle(reclaiming);
	// What an earlier kill of this owner's workers could not confirm gets its
	// attempt alongside this disposal's own kills.
	const earlier = [...unconfirmedWorkers].filter(entry => entry.owners.has(ownerId));
	// This owner is gone, so it is at no key: a context it shared stops waiting
	// on it, and nobody is left to tell what a reclaim took from it.
	ownerKeys.delete(ownerId);
	reclaimedWorkers.delete(ownerId);
	const toKill: JsSession[] = [];
	for (const [key, session] of Array.from(sessions.entries())) {
		if (!session.ownerIds.has(ownerId)) continue;
		reaper.cancel(session);
		if (session.ownerIds.size > 1) {
			session.ownerIds.delete(ownerId);
			continue;
		}
		sessions.delete(key);
		toKill.push(session);
	}
	const startingToKill: StartingJsSession[] = [];
	for (const [sessionKey, starting] of Array.from(startingSessions.entries())) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			startingToKill.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	const started = Promise.allSettled(startingToKill.map(starting => starting.promise)).then(results =>
		Promise.all(
			results.flatMap(result => {
				if (result.status !== "fulfilled") return [];
				const session = result.value;
				if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
				return [killSession(session, new ToolError("JS context disposed"), { force: false })];
			}),
		),
	);
	await Promise.all([
		reclaims,
		started,
		retryUnconfirmedWorkers(earlier),
		...toKill.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })),
	]);
	// A joined reclaim whose kill went unconfirmed gets one more attempt.
	await retryUnconfirmedWorkers(unconfirmedOf(reclaiming));
	// What is still unconfirmed is no longer this owner's to retry: only the
	// process-wide disposal tries again, so a later disposal under the same
	// owner id does not inherit a debt it never incurred.
	for (const entry of unconfirmedWorkers) entry.owners.delete(ownerId);
	// A context this owner shared with another agent kept only its registration
	// dropped above. Nobody is left to notice that, so the arming question is
	// asked again here: the agents it still belongs to may have moved away long
	// ago.
	reconcileSupersededJsSessions();
}

/** The unconfirmed workers left by the kills of `sessions`. */
function unconfirmedOf(sessions: readonly JsSession[]): UnconfirmedWorker[] {
	const kernelIds = new Set(sessions.map(session => session.kernelId));
	return [...unconfirmedWorkers].filter(entry => kernelIds.has(entry.kernelId));
}

/**
 * Kill each of `entries` again. One whose exit is now seen is forgotten; one
 * that still cannot be confirmed — a process stuck in truly uninterruptible
 * kernel I/O outlives every kill until that I/O completes or is aborted — is
 * logged and kept.
 */
async function retryUnconfirmedWorkers(entries: readonly UnconfirmedWorker[]): Promise<void> {
	await Promise.all(
		entries.map(async entry => {
			if (!unconfirmedWorkers.has(entry)) return;
			if (await entry.worker.terminate().catch(() => false)) {
				unconfirmedWorkers.delete(entry);
				return;
			}
			logger.warn("JS eval worker still did not confirm exit; kept for the next disposal", {
				kernelId: entry.kernelId,
			});
		}),
	);
}

/** Keep `worker`, whose kill could not be confirmed, where a disposal will try again. */
function keepUnconfirmedWorker(worker: JsEvalWorkerHandle, kernelId: string, owners: Iterable<string>): void {
	logger.warn("JS eval worker did not confirm exit; kept for disposal to retry", { kernelId });
	unconfirmedWorkers.add({ worker, kernelId, owners: new Set(owners) });
}

/**
 * Smoke probe: spawn the JS evaluator through the worker-host entry and prove
 * it answers the `init` handshake in a real isolated subprocess (not the inline
 * fallback). Catches silent process-load and init-message regressions
 * that otherwise strand every cell on the init timeout in a distribution build —
 * the failure mode that motivated `installWorkerInbox`. Wired into
 * `omp --smoke-test` so binary / source / tarball installs all exercise it.
 */
export async function smokeTestJsEvalWorker(): Promise<void> {
	const worker = spawnJsWorker();
	const session: JsSession = {
		sessionKey: "smoke",
		sessionId: "smoke",
		kernelId: `js-${Snowflake.next()}`,
		cwd: process.cwd(),
		worker,
		state: "alive",
		stateSessions: new Set(),
		pending: new Map(),
		pendingSnapshots: new Map(),
		pendingShadowRuns: new Map(),
		ownerIds: new Set(),
		hasFallbackOwner: false,
		activeUses: 0,
	};
	try {
		await initWorker(session, { cwd: process.cwd(), sessionId: "smoke" }, WORKER_INIT_TIMEOUT_MS);
		if (worker.mode !== "process") {
			throw new Error("JS eval worker smoke fell back from the isolated subprocess");
		}
	} finally {
		await worker.terminate().catch(() => undefined);
	}
}

function javascriptPreludeSources(session: ToolSession): EvalPreludeSource[] {
	const definitions = getEnabledEvalPreludes(session.getEvalPreludes?.() ?? []);
	return definitions.flatMap(definition =>
		definition.javascript.trim().length === 0
			? []
			: [{ name: definition.name, exports: [...definition.exports], source: definition.javascript }],
	);
}

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		localRoots?: Record<string, string>;
		packageRoot?: string;
		packageEnvironment?: string;
		code: string;
		filename: string;
		runState: VmRunState;
		expectedRevision?: number;
		expectedDigest?: string;
	},
): Promise<{ value: unknown }> {
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	const pending: PendingRun = {
		runId,
		runState: options.runState,
		toolSession: options.session,
		shadowCell: getActiveEvalShadowCell(),
		resolve,
		reject,
		toolCalls: new Map(),
		deferDepth: 0,
		aborted: false,
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		const reason = options.runState.signal?.reason;
		const abortError = reasonToError(reason, "Execution aborted");
		// Stop delegated work at once — this is what kills spawned subagents —
		// and refuse further bridge calls so the drain below stays bounded to
		// phases that had already started.
		pending.aborted = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(abortError);
		// A critical host phase ignores its abort once started (isolation
		// worktree setup, merge/cherry-pick). Killing the worker now would
		// settle the cell on top of a git operation still in progress, so wait
		// for it. Hard-kill is still the only way to interrupt synchronous user
		// code, hence it stays the terminal step either way.
		const drained = pending.deferDepth > 0 ? pending.deferDrained?.promise : undefined;
		if (drained) {
			void drained.then(() => killSessionFor(session, abortError, { force: true }));
			return;
		}
		void killSessionFor(session, abortError, { force: true });
	};

	if (options.runState.signal?.aborted) {
		queueMicrotask(onAbort);
	} else {
		options.runState.signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		if (options.packageRoot !== undefined) session.packageRoot = options.packageRoot;
		if (options.packageEnvironment !== undefined) session.packageEnvironment = options.packageEnvironment;
		const snapshot = {
			cwd: options.cwd,
			sessionId: options.sessionId,
			localRoots: options.localRoots,
			preludes: javascriptPreludeSources(options.session),
			packageRoot: session.packageRoot,
			packageEnvironment: session.packageEnvironment,
		};
		if (options.expectedRevision !== undefined && options.expectedDigest !== undefined) {
			const id = `shadow-run-${Snowflake.next()}`;
			const admission = Promise.withResolvers<Extract<WorkerOutbound, { type: "shadow-run" }>>();
			session.pendingShadowRuns.set(id, admission);
			try {
				session.worker.send({
					type: "run-if-snapshot-matches",
					id,
					runId,
					code: options.code,
					filename: options.filename,
					snapshot,
					expectedRevision: options.expectedRevision,
					expectedDigest: options.expectedDigest,
				});
				const reply = await raceWithTimeout(
					admission.promise,
					WORKER_INIT_TIMEOUT_MS,
					"JS shadow admission timed out",
				);
				if (!reply.eligible) throw new ToolError("JS shadow snapshot changed");
			} finally {
				session.pendingShadowRuns.delete(id);
			}
		} else {
			session.worker.send({ type: "run", runId, code: options.code, filename: options.filename, snapshot });
		}
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

async function acquireSession(
	sessionKey: string,
	snapshot: SessionSnapshot,
	toolSession: ToolSession,
	timeoutMs?: number,
	ownerId?: string,
): Promise<JsSession> {
	// Where this owner is working now: every key it is not at is one it has
	// moved away from, which is what arms a reclaim.
	if (ownerId !== undefined) ownerKeys.set(ownerId, sessionKey);
	const existing = sessions.get(sessionKey);
	if (existing && existing.state === "alive") {
		existing.sessionId = snapshot.sessionId;
		existing.cwd = snapshot.cwd;
		existing.packageRoot = snapshot.packageRoot;
		existing.packageEnvironment = snapshot.packageEnvironment;
		attachSessionOwner(existing, snapshot.sessionId, ownerId);
		// Reacquired inside its grace: keep the context and its globals.
		reaper.cancel(existing);
		// Held before returning, so no reclaim can run between this lookup and
		// the caller taking its hold. The caller releases it.
		existing.activeUses += 1;
		markJsSessionAlive(existing, toolSession, snapshot.packageEnvironment);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, snapshot.sessionId, ownerId);
		const session = await starting.promise;
		session.activeUses += 1;
		markJsSessionAlive(session, toolSession, snapshot.packageEnvironment);
		return session;
	}
	// oxlint-disable-next-line prefer-const -- captured by the startup closure before assignment
	let startingSession!: StartingJsSession;

	const startup = (async (): Promise<JsSession> => {
		// Attach the message listener before sending init. Both Bun Worker messages
		// and subprocess IPC can arrive immediately after the evaluator loads.
		const worker = spawnJsWorker();
		const session: JsSession = {
			sessionKey,
			sessionId: snapshot.sessionId,
			kernelId: `js-${Snowflake.next()}`,
			cwd: snapshot.cwd,
			packageRoot: snapshot.packageRoot,
			packageEnvironment: snapshot.packageEnvironment,
			worker,
			state: "alive",
			stateSessions: new Set(),
			pending: new Map(),
			pendingSnapshots: new Map(),
			pendingShadowRuns: new Map(),
			ownerIds: new Set(),
			hasFallbackOwner: false,
			// Born held for the caller that started it, which releases it when
			// its cell ends; publishing to `sessions` precedes that hold by a
			// tick otherwise.
			activeUses: 1,
		};
		// Init headroom is the fixed infrastructure floor; the caller's per-cell timeout
		// dominates when larger so users can grant more by raising `timeout` on a cell.
		const readyTimeoutMs = Math.max(WORKER_INIT_TIMEOUT_MS, timeoutMs ?? 0);
		while (true) {
			try {
				await initWorker(session, snapshot, readyTimeoutMs);
				break;
			} catch (error) {
				// Runtime crash/load failures surface asynchronously via the runtime's
				// error callback, after the synchronous spawn try/catch has returned.
				// Recover once from the subprocess into a Bun Worker. A second isolated
				// runtime failure must surface; running the cell on this host thread
				// would make synchronous user code impossible to cancel.
				const failed = session.worker;
				if (!(await failed.terminate().catch(() => false))) {
					keepUnconfirmedWorker(failed, session.kernelId, startingSession.ownerIds);
				}
				if (failed.mode === "worker") {
					throw new Error(
						`Failed to initialize isolated JS eval worker: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
				logger.warn("JS eval subprocess init failed; retrying with a Bun Worker", {
					error: error instanceof Error ? error.message : String(error),
				});
				session.worker = workerFactories.spawnWorker();
				session.state = "alive";
			}
		}
		session.ownerIds = new Set(startingSession.ownerIds);
		session.hasFallbackOwner = startingSession.hasFallbackOwner;
		// Publish only while this startup still owns the key: owner disposal or
		// a concurrent dispose-all may have already reaped the starting record,
		// and publishing here would resurrect a context that was just torn down.
		if (startingSessions.get(sessionKey) === startingSession) {
			sessions.set(sessionKey, session);
		}
		return session;
	})();
	startingSession = {
		ownerIds: new Set(),
		hasFallbackOwner: false,
		promise: startup,
	};
	attachSessionOwner(startingSession, snapshot.sessionId, ownerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		const session = await startup;
		markJsSessionAlive(session, toolSession, snapshot.packageEnvironment);
		return session;
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function initWorker(session: JsSession, snapshot: SessionSnapshot, timeoutMs: number): Promise<void> {
	const worker = session.worker;
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let resolved = false;
	const unsubscribeMessage = worker.onMessage(msg => {
		if (!resolved && msg.type === "ready") {
			resolved = true;
			resolveReady();
			return;
		}
		if (!resolved && msg.type === "init-failed") {
			resolved = true;
			rejectReady(errorFromPayload(msg.error));
			return;
		}
		handleSessionMessage(session, msg);
	});
	const unsubscribeError = worker.onError(error => {
		if (!resolved) {
			resolved = true;
			rejectReady(error);
			return;
		}
		// Worker died after a successful handshake: tear the session down so the
		// in-flight run (and the next acquire) fail fast instead of hanging on a
		// worker that will never reply.
		void killSessionFor(session, error, { force: true });
	});
	try {
		// Attach listeners and send init before awaiting ready. The worker now
		// emits ready only in response to init, so this ordering is race-free.
		worker.send({ type: "init", snapshot });
		await raceWithTimeout(readyPromise, timeoutMs, "Timed out initializing JS eval worker");
	} catch (error) {
		// Handshake failed (timeout, init-failed, or worker error): drop both listeners
		// so the abandoned worker can't keep routing messages into a session the caller
		// is about to discard or retry on the isolated Worker fallback.
		unsubscribeMessage();
		unsubscribeError();
		throw error;
	}
}

function handleSessionMessage(session: JsSession, msg: WorkerOutbound): void {
	switch (msg.type) {
		case "text": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onText?.(msg.chunk);
			return;
		}
		case "display": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onDisplay?.(msg.output);
			return;
		}
		case "tool-call":
			void handleToolCall(session, msg);
			return;
		case "result":
			settlePending(session, msg);
			return;
		case "shadow-snapshot": {
			const pending = session.pendingSnapshots.get(msg.id);
			if (pending) pending.resolve(msg);
			return;
		}
		case "shadow-run": {
			const pending = session.pendingShadowRuns.get(msg.id);
			if (pending) pending.resolve(msg);
			return;
		}
		case "log":
			logWorkerMessage(msg);
			return;
		case "ready":
		case "init-failed":
		case "closed":
			return;
	}
}

/**
 * Maintain {@link PendingRun.deferDepth} from the bridge's pause/resume status
 * events so an abort can wait out a critical `agent()` phase instead of
 * settling the cell over a half-applied merge.
 */
function trackDeferPhase(pending: PendingRun, event: JsStatusEvent): void {
	if (event.deferExternalAbort !== true) return;
	if (event.op === EVAL_TIMEOUT_PAUSE_OP) {
		pending.deferDepth++;
		pending.deferDrained ??= Promise.withResolvers<void>();
		return;
	}
	if (event.op !== EVAL_TIMEOUT_RESUME_OP || pending.deferDepth === 0) return;
	pending.deferDepth--;
	if (pending.deferDepth > 0) return;
	pending.deferDrained?.resolve();
	pending.deferDrained = undefined;
}

async function handleToolCall(session: JsSession, msg: Extract<WorkerOutbound, { type: "tool-call" }>): Promise<void> {
	const pending = session.pending.get(msg.runId);
	if (!pending) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run no longer active" } },
		});
		return;
	}
	if (pending.aborted) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run was interrupted" } },
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.toolSession,
			signal: ctrl.signal,
			identity: msg.identity,
			shadowCell: pending.shadowCell,
			onReply: pending.runState.onReply,
			emitStatus: (event: JsStatusEvent) => {
				trackDeferPhase(pending, event);
				pending.runState.onDisplay?.({ type: "status", event });
			},
		});
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		// Last call of a run whose worker result was withheld: settle it now.
		const held = pending.heldResult;
		if (held && !pending.settled && !pending.aborted && pending.toolCalls.size === 0) {
			finishPending(pending, held);
		}
	}
}

/** Deliver a worker `result` to the waiting {@link runOnce}. */
function finishPending(pending: PendingRun, msg: Extract<WorkerOutbound, { type: "result" }>): void {
	pending.settled = true;
	pending.heldResult = undefined;
	if (msg.ok) {
		pending.resolve({ value: msg.value });
		return;
	}
	pending.reject(errorFromPayload(msg.error));
}

function settlePending(session: JsSession, msg: Extract<WorkerOutbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;
	// Once the turn is cancelled the scheduled kill is the sole settler, so a
	// late worker result can't cut the abort drain short.
	if (pending.aborted) return;
	// A cell owns every bridge call it starts. The worker finishes a run without
	// awaiting its outstanding tool calls, so `agent(...)` that is floated or
	// caught would settle the run here — `runOnce` then drops the abort listener
	// and the pending entry, leaving the subagent running with nothing able to
	// cancel it. Hold the result until the last call drains.
	if (pending.toolCalls.size > 0) {
		pending.heldResult = msg;
		return;
	}
	finishPending(pending, msg);
}

async function killSessionFor(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (sessions.get(session.sessionKey) === session) {
		sessions.delete(session.sessionKey);
	}
	await killSession(session, error, options);
}

async function killSession(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (session.state === "dead") return;
	session.state = "dead";
	for (const toolSession of session.stateSessions) {
		updateEvalState(toolSession, { language: "js", kernelId: session.kernelId, alive: false });
	}
	for (const pending of session.pending.values()) {
		if (pending.settled) continue;
		pending.settled = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
	session.pending.clear();
	for (const pending of session.pendingSnapshots.values()) pending.reject(error);
	session.pendingSnapshots.clear();
	for (const pending of session.pendingShadowRuns.values()) pending.reject(error);
	session.pendingShadowRuns.clear();
	const confirmed = options.force
		? await session.worker.terminate().catch(() => false)
		: (await session.worker.close().catch(() => false)) || (await session.worker.terminate().catch(() => false));
	if (!confirmed) keepUnconfirmedWorker(session.worker, session.kernelId, session.ownerIds);
}

function markJsSessionAlive(session: JsSession, toolSession: ToolSession, environment: string | undefined): void {
	if (session.state !== "alive") return;
	session.stateSessions.add(toolSession);
	updateEvalState(toolSession, {
		language: "js",
		kernelId: session.kernelId,
		alive: true,
		environment,
		interpreter: `Bun ${Bun.version}`,
	});
}

function safeSend(session: JsSession, msg: WorkerInbound): void {
	if (session.state !== "alive") return;
	try {
		session.worker.send(msg);
	} catch (err) {
		logger.debug("js worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function reasonToError(reason: unknown, fallback: string): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new ToolAbortError(reason);
	return new ToolAbortError(fallback);
}

function errorFromPayload(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Execution aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { message: String(error) };
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

function spawnJsWorker(): JsEvalWorkerHandle {
	try {
		return workerFactories.spawnProcess();
	} catch (error) {
		// A worker thread remains isolated and can interrupt synchronous user code
		// via terminate(), so it is the only safe recovery from subprocess spawn.
		logger.warn("JS eval subprocess spawn failed; falling back to a Bun Worker", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return workerFactories.spawnWorker();
}

function spawnBunWorker(): JsEvalWorkerHandle {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_js_eval"] })
			: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (error) {
		throw new Error(
			`Failed to start isolated JS eval worker: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}

function spawnJsProcess(): JsEvalWorkerHandle {
	const spawned = createWorkerSubprocess<WorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(JS_EVAL_PROCESS_ARG),
		env: workerEnvFromParent(),
		exitLabel: "JS eval worker",
		detached: shouldDetachKernel(process.platform),
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<WorkerInbound, WorkerOutbound>(spawned, message =>
		safeSendIpc(spawned.proc, message, "js-eval"),
	);
	return {
		mode: "process",
		send: message => base.send(message),
		onMessage: handler => base.onMessage(handler),
		onError: handler => base.onError(handler),
		async close() {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				resolve(value);
			};
			unsubscribe = base.onMessage(message => {
				if (message.type !== "closed") return;
				// Acknowledged: the kill below ends it, and only its seen exit
				// means it closed.
				clearTimeout(timeout);
				void killWorkerSubprocess(spawned).then(finish);
			});
			const timeout = setTimeout(() => finish(false), WORKER_CLOSE_TIMEOUT_MS);
			base.send({ type: "close" });
			return await promise;
		},
		terminate: () => killWorkerSubprocess(spawned),
	};
}

function wrapBunWorker(worker: Worker): JsEvalWorkerHandle {
	// Watched from the start, so an exit that happened before teardown asked is still seen.
	const exited = Promise.withResolvers<void>();
	worker.addEventListener("close", () => exited.resolve(), { once: true });
	return {
		mode: "worker",
		send(msg) {
			worker.postMessage(msg);
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`JS eval worker message error: ${String(event.data)}`));
			const onClose = (): void => handler(new Error("JS eval worker exited"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			worker.addEventListener("close", onClose);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
				worker.removeEventListener("close", onClose);
			};
		},
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let sawClosedAck = false;
			let sawWorkerExit = false;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				worker.removeEventListener("close", onClose);
				resolve(value);
			};
			const finishIfClosed = (): void => {
				if (sawClosedAck && sawWorkerExit) finish(true);
			};
			const onClose = (): void => {
				sawWorkerExit = true;
				finishIfClosed();
			};
			unsubscribe = this.onMessage(msg => {
				if (msg.type !== "closed") return;
				sawClosedAck = true;
				finishIfClosed();
			});
			worker.addEventListener("close", onClose);
			const timeout = setTimeout(() => finish(false), WORKER_CLOSE_TIMEOUT_MS);
			worker.postMessage({ type: "close" } satisfies WorkerInbound);
			return await closed;
		},
		async terminate() {
			worker.terminate();
			return await settlesWithin(exited.promise, WORKER_EXIT_CONFIRM_MS);
		},
	};
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown JS eval worker error");
}
