import { logger, postmortem, Snowflake, workerHostEntry } from "@oh-my-pi/pi-utils";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../bridge-timeout";
import { attachSessionOwner, resolveOwnerScopedSessionKey, type SessionOwners } from "../executor-base";
import { shouldDetachKernel } from "../py/spawn-options";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
import { WorkerCore } from "./worker-core";
// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.
import type {
	JsDisplayOutput,
	RunErrorPayload,
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "./worker-protocol";

export { rewriteImports, wrapCode } from "./shared/rewrite-imports";
export type { JsDisplayOutput } from "./worker-protocol";

export interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

interface WorkerHandle {
	mode: "process" | "worker" | "inline";
	send(msg: WorkerInbound): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): Promise<boolean>;
	terminate(): Promise<void>;
}

interface PendingRun {
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
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
	cwd: string;
	worker: WorkerHandle;
	state: "alive" | "dead";
	pending: Map<string, PendingRun>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

interface StartingJsSession extends SessionOwners {
	promise: Promise<JsSession>;
}

const sessions = new Map<string, JsSession>();
const startingSessions = new Map<string, StartingJsSession>();
const resettingSessions = new Map<string, Promise<void>>();
// Worker startup (module-graph import + WorkerCore construction) is infrastructure
// cost, not user compute. Floor it independently of Bun's 5s default per-test timeout
// so a slow cold-start under load isn't aborted mid-init — terminating a still-
// initializing eval runtime triggers the same kind of terminate-race that motivates
// avoiding `vm.runInContext` (see shared/indirect-eval.ts), here surfacing as a
// SIGILL/SIGSEGV. Callers that pass a larger per-cell budget still dominate.
const WORKER_INIT_TIMEOUT_MS = 15_000;
const WORKER_CLOSE_TIMEOUT_MS = 1_000;
const JS_EVAL_PROCESS_ARG = "__omp_worker_js_eval_process";
// Active graceful-close grace period before a worker that ack'd `close` but never
// emitted its `close` event is force-terminated. Defaults to the production floor;
// tests override it (and restore it) to exercise the close-timeout -> terminate
// path without a real wall-clock wait.
let workerCloseTimeoutMs: number = WORKER_CLOSE_TIMEOUT_MS;
let useWorkerThreadForTests = false;

/**
 * Test-only seam: override the graceful-close grace period (ms). Returns the
 * previous value so callers can restore it. Production always uses
 * {@link WORKER_CLOSE_TIMEOUT_MS}; never call this outside tests.
 */
export function setWorkerCloseTimeoutMsForTests(ms: number): number {
	const previous = workerCloseTimeoutMs;
	workerCloseTimeoutMs = ms;
	return previous;
}

/** Test-only seam for the legacy Worker lifecycle mocks. */
export function setJsEvalWorkerThreadForTests(enabled: boolean): boolean {
	const previous = useWorkerThreadForTests;
	useWorkerThreadForTests = enabled;
	return previous;
}

export async function executeInVmContext(options: {
	sessionKey: string;
	sessionId: string;
	/** Logical owner identifier; scopes `reset` on shared contexts and retained-worker cleanup. */
	ownerId?: string;
	cwd: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	reset?: boolean;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
}): Promise<{ value: unknown }> {
	const sessionKey = resolveOwnerScopedSessionKey({
		baseKey: options.sessionKey,
		ownerId: options.ownerId,
		reset: options.reset === true,
		hasSession: key => sessions.has(key) || startingSessions.has(key),
		getOwners: key => sessions.get(key) ?? startingSessions.get(key),
	});
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
	} else {
		// Internal coordination: wait for any in-flight reset to settle and
		// then run on the freshly-rebuilt context.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(
		sessionKey,
		{ cwd: options.cwd, sessionId: options.sessionId, localRoots: options.localRoots },
		options.timeoutMs,
		options.ownerId,
	);
	return await runOnce(session, options);
}

export async function resetVmContext(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!session) return;
	sessions.delete(sessionKey);
	await killSession(session, new ToolError("JS context reset"), { force: false });
}

export async function disposeAllVmContexts(): Promise<void> {
	const pending = [...startingSessions.values()].map(starting => starting.promise);
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = Array.from(sessions.values());
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.includes(result.value)) all.push(result.value);
	}
	sessions.clear();
	await Promise.all(all.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })));
}

/**
 * Shut down retained JS contexts owned solely by `ownerId` (e.g. a subagent's
 * private fork); shared contexts just drop the owner registration.
 */
export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	const toKill: JsSession[] = [];
	for (const session of Array.from(sessions.values())) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toKill.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
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
	for (const session of toKill) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const started = await Promise.allSettled(startingToKill.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		toKill.push(session);
	}
	await Promise.all(
		toKill.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })),
	);
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
		cwd: process.cwd(),
		worker,
		state: "alive",
		pending: new Map(),
		ownerIds: new Set(),
		hasFallbackOwner: false,
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

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		localRoots?: Record<string, string>;
		code: string;
		filename: string;
		runState: VmRunState;
	},
): Promise<{ value: unknown }> {
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	const pending: PendingRun = {
		runId,
		runState: options.runState,
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
		session.worker.send({
			type: "run",
			runId,
			code: options.code,
			filename: options.filename,
			snapshot: { cwd: options.cwd, sessionId: options.sessionId, localRoots: options.localRoots },
		});
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

async function acquireSession(
	sessionKey: string,
	snapshot: SessionSnapshot,
	timeoutMs?: number,
	ownerId?: string,
): Promise<JsSession> {
	const existing = sessions.get(sessionKey);
	if (existing && existing.state === "alive") {
		existing.sessionId = snapshot.sessionId;
		existing.cwd = snapshot.cwd;
		attachSessionOwner(existing, snapshot.sessionId, ownerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, snapshot.sessionId, ownerId);
		return await starting.promise;
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
			cwd: snapshot.cwd,
			worker,
			state: "alive",
			pending: new Map(),
			ownerIds: new Set(),
			hasFallbackOwner: false,
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
				// Preserve the full process -> Worker -> inline ladder for those failures.
				const failed = session.worker;
				await failed.terminate().catch(() => undefined);
				if (failed.mode === "inline") throw error;
				if (failed.mode === "process") {
					logger.warn("JS eval subprocess init failed; retrying with a Bun Worker", {
						error: error instanceof Error ? error.message : String(error),
					});
					session.worker = spawnBunWorker();
				} else {
					logger.warn("JS eval worker init failed; retrying with inline worker (no sync-loop guard)", {
						error: error instanceof Error ? error.message : String(error),
					});
					session.worker = spawnInlineWorker();
				}
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
		return await startup;
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
		// is about to discard or retry on the inline fallback.
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
		pending.resolve({ value: undefined });
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
	for (const pending of session.pending.values()) {
		if (pending.settled) continue;
		pending.settled = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
	session.pending.clear();
	if (options.force) {
		await session.worker.terminate().catch(() => undefined);
		return;
	}
	if (await session.worker.close().catch(() => false)) return;
	await session.worker.terminate().catch(() => undefined);
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

function spawnJsWorker(): WorkerHandle {
	if (!useWorkerThreadForTests) {
		try {
			return spawnJsProcess();
		} catch (err) {
			// Fall through to the Bun Worker rung: a worker thread still interrupts
			// synchronous infinite loops via terminate(), which the inline fallback
			// cannot.
			logger.warn("JS eval subprocess spawn failed; falling back to a Bun Worker", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return spawnBunWorker();
}

function spawnBunWorker(): WorkerHandle {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_js_eval"] })
			: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline JS eval worker (no sync-loop guard)", {
			error: err instanceof Error ? err.message : String(err),
		});
		return spawnInlineWorker();
	}
}

function spawnJsProcess(): WorkerHandle {
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
				void base.terminate().finally(() => finish(true));
			});
			const timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			base.send({ type: "close" });
			return await promise;
		},
		terminate: () => base.terminate(),
	};
}

function wrapBunWorker(worker: Worker): WorkerHandle {
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
			const timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			worker.postMessage({ type: "close" } satisfies WorkerInbound);
			return await closed;
		},
		async terminate() {
			worker.terminate();
		},
	};
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown JS eval worker error");
}

/**
 * Inline fallback for environments where Bun cannot spawn the worker entry
 * (e.g. some test runners). Preserves behavior but cannot interrupt synchronous
 * infinite loops because user code runs on the main thread.
 */
function spawnInlineWorker(): WorkerHandle {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const workerTransport: Transport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg);
			}),
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	const core = new WorkerCore(workerTransport, {
		mode: "inline",
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				hostListeners.clear();
				workerListeners.clear();
				resolve(value);
			};
			unsubscribe = this.onMessage(msg => {
				if (msg.type === "closed") finish(true);
			});
			this.send({ type: "close" });
			const timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			return await closed;
		},
		async terminate() {
			hostListeners.clear();
			workerListeners.clear();
			core.dispose();
		},
	};
}
