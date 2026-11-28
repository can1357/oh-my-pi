import * as os from "node:os";
import * as path from "node:path";
import { resolveV8EvalBinary } from "@oh-my-pi/pi-natives";
import { isRecord, logger, readJsonl, Snowflake } from "@oh-my-pi/pi-utils";
import { registerOnBoard } from "../../daemon/client";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import {
	abortReasonError,
	attachSessionOwner,
	type DisposeByOwnerOptions,
	formatKernelRestartNotice,
	type SessionOwners,
} from "../executor-base";
import { cfgEvalV8MaxHeapMb } from "../settings";
import { updateEvalState } from "../state";
import type { EvalDisplayOutput } from "../types";
import { handleV8ToolCall, handleV8UrlRead, handleV8UrlWrite, type V8HostBridgeOptions } from "./host-bridge";
import type { V8ErrorPayload, V8Inbound, V8Outbound } from "./protocol";

const V8_INIT_TIMEOUT_MS = 10_000;
const V8_CANCEL_GRACE_MS = 250;
const V8_CLOSE_TIMEOUT_MS = 1_000;

export interface V8RunState {
	signal?: AbortSignal;
	parentToolCallId?: string;
	onText?: (chunk: string) => void;
	onDisplay?: (output: EvalDisplayOutput) => void;
	onReply?: (text: string) => void;
}

interface PendingV8Run {
	runId: string;
	runState: V8RunState;
	toolSession: ToolSession;
	cellTimeoutMs?: number;
	resolve(): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	aborted: boolean;
	heldResult?: Extract<V8Outbound, { type: "result" }>;
	settled: boolean;
}

interface V8Session {
	sessionKey: string;
	sessionId: string;
	kernelId: string;
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	state: "alive" | "dead";
	stateSessions: Set<ToolSession>;
	pending: Map<string, PendingV8Run>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
	readyPromise: Promise<void>;
	resolveReady: () => void;
	rejectReady: (err: Error) => void;
	closedPromise: Promise<boolean>;
	resolveClosed: (ok: boolean) => void;
	stderrLines: string[];
	boardDispose: () => void;
}

interface StartingV8Session extends SessionOwners {
	sessionId: string;
	promise: Promise<V8Session>;
}

const sessions = new Map<string, V8Session>();
const startingSessions = new Map<string, StartingV8Session>();
const resettingSessions = new Map<string, Promise<void>>();
const lostSessions = new Map<string, Set<string>>();

export function hasLiveV8Isolate(sessionKey: string): boolean {
	return sessions.get(sessionKey)?.state === "alive";
}

export async function executeInV8Isolate(options: {
	sessionKey: string;
	sessionId: string;
	ownerId?: string;
	session: ToolSession;
	reset?: boolean;
	code: string;
	filename: string;
	finalExprSuppressed?: boolean;
	timeoutMs?: number;
	runState: V8RunState;
}): Promise<void> {
	const { sessionKey } = options;
	if (options.reset) {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetV8Isolate(sessionKey);
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
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}

	const session = await acquireV8Session(
		sessionKey,
		options.sessionId,
		options.session,
		options.timeoutMs,
		options.ownerId,
	);
	if (!options.reset && lostSessions.delete(sessionKey)) {
		options.runState.onText?.(`${formatKernelRestartNotice("V8 isolate")}\n`);
	}
	await runOnce(session, options);
	if (session.state === "alive" && path.isAbsolute(options.filename)) {
		updateEvalState(options.session, {
			language: "v8",
			kernelId: session.kernelId,
			alive: true,
			loadedPath: options.filename,
		});
	}
}

export async function resetV8Isolate(sessionKey: string): Promise<void> {
	lostSessions.delete(sessionKey);
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!session) return;
	sessions.delete(sessionKey);
	await killV8Session(session, new ToolError("V8 isolate reset"), { force: false });
}

export async function disposeV8IsolatesByOwner(ownerId: string, options?: DisposeByOwnerOptions): Promise<void> {
	const keepSessionId = options?.keepSessionId;
	const toKill: V8Session[] = [];
	for (const session of Array.from(sessions.values())) {
		if (!session.ownerIds.has(ownerId) || session.sessionId === keepSessionId) continue;
		if (session.ownerIds.size === 1) {
			toKill.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	const startingToKill: StartingV8Session[] = [];
	for (const [sessionKey, starting] of Array.from(startingSessions.entries())) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId) || starting.sessionId === keepSessionId) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			startingToKill.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	for (const [sessionKey, ownerIds] of lostSessions) {
		if (ownerIds.delete(ownerId) && ownerIds.size === 0) lostSessions.delete(sessionKey);
	}
	for (const session of toKill) {
		if (sessions.get(session.sessionKey) !== session) continue;
		sessions.delete(session.sessionKey);
		lostSessions.set(session.sessionKey, new Set(session.ownerIds));
	}
	const started = await Promise.allSettled(startingToKill.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		toKill.push(session);
	}
	await Promise.all(
		toKill.map(session => killV8Session(session, new ToolError("V8 isolate disposed"), { force: false })),
	);
}

export async function smokeTestV8EvalProcess(): Promise<void> {
	const binPath = resolveV8EvalBinary();
	if (!binPath) return;

	const session = spawnV8Session("smoke", "smoke", 32);
	try {
		await raceWithTimeout(session.readyPromise, V8_INIT_TIMEOUT_MS, "Timed out waiting for omp-v8-eval ready");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let output = "";
		const pending: PendingV8Run = {
			runId: "smoke-v8",
			runState: {
				onText: chunk => {
					output += chunk;
				},
			},
			toolSession: {} as ToolSession,
			resolve,
			reject,
			toolCalls: new Map(),
			aborted: false,
			settled: false,
		};
		session.pending.set(pending.runId, pending);
		sendToV8(session, {
			type: "run",
			runId: pending.runId,
			code: "print(JSON.stringify({ bun: typeof Bun, proc: typeof process, fetch: typeof fetch, sum: 40 + 2 }))",
			filename: "smoke.js",
		});
		await raceWithTimeout(promise, V8_INIT_TIMEOUT_MS, "Timed out running omp-v8-eval smoke cell");
		const parsed: unknown = JSON.parse(output.trim().split("\n").at(-1) ?? "null");
		if (
			!isRecord(parsed) ||
			parsed.bun !== "undefined" ||
			parsed.proc !== "undefined" ||
			parsed.fetch !== "undefined" ||
			parsed.sum !== 42
		) {
			throw new Error(`V8 eval smoke probe unexpected result: ${output}`);
		}
	} finally {
		await killV8Session(session, new ToolError("V8 smoke finished"), { force: true });
	}
}

async function acquireV8Session(
	sessionKey: string,
	sessionId: string,
	toolSession: ToolSession,
	timeoutMs: number | undefined,
	ownerId: string | undefined,
): Promise<V8Session> {
	const existing = sessions.get(sessionKey);
	if (existing && existing.state === "alive") {
		attachSessionOwner(existing, sessionId, ownerId);
		markV8SessionAlive(existing, toolSession);
		return existing;
	}

	let starting = startingSessions.get(sessionKey);
	if (!starting) {
		const maxHeapMb = Math.max(16, Math.min(2048, Math.trunc(cfgEvalV8MaxHeapMb.get(toolSession.settings) || 256)));
		const entry: StartingV8Session = {
			sessionId,
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: undefined as unknown as Promise<V8Session>,
		};
		entry.promise = (async (): Promise<V8Session> => {
			const session = await startV8Session(sessionKey, sessionId, maxHeapMb, timeoutMs);
			session.ownerIds = new Set(entry.ownerIds);
			session.hasFallbackOwner = entry.hasFallbackOwner;
			if (startingSessions.get(sessionKey) === entry && session.state === "alive") {
				sessions.set(sessionKey, session);
			} else {
				await killV8Session(session, new ToolError("V8 isolate disposed before ready"), { force: false });
			}
			return session;
		})();
		starting = entry;
		startingSessions.set(sessionKey, entry);
		void entry.promise.finally(() => {
			if (startingSessions.get(sessionKey) === entry) startingSessions.delete(sessionKey);
		});
	}
	attachSessionOwner(starting, sessionId, ownerId);
	const session = await starting.promise;
	attachSessionOwner(session, sessionId, ownerId);
	if (session.state !== "alive") {
		throw new ToolError("V8 isolate exited before starting cell");
	}
	markV8SessionAlive(session, toolSession);
	return session;
}

async function startV8Session(
	sessionKey: string,
	sessionId: string,
	maxHeapMb: number,
	timeoutMs: number | undefined,
): Promise<V8Session> {
	const session = spawnV8Session(sessionKey, sessionId, maxHeapMb);
	const initTimeout = Math.max(V8_INIT_TIMEOUT_MS, timeoutMs ?? 0);
	try {
		await raceWithTimeout(session.readyPromise, initTimeout, "Timed out waiting for V8 isolate to initialize");
		return session;
	} catch (error) {
		await killV8Session(session, error instanceof Error ? error : new Error(String(error)), { force: true });
		throw error;
	}
}

function spawnV8Session(sessionKey: string, sessionId: string, maxHeapMb: number): V8Session {
	const binPath = resolveV8EvalBinary();
	if (!binPath) {
		throw new ToolError("Sandboxed V8 eval binary (omp_v8_eval) is not available on this platform.");
	}

	const proc = Bun.spawn([binPath, "--max-heap-mb", String(maxHeapMb)], {
		cwd: os.tmpdir(),
		env: {},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	const { promise: closedPromise, resolve: resolveClosed } = Promise.withResolvers<boolean>();

	const board = registerOnBoard({
		kind: "external",
		scope: { kind: "session", id: sessionId || `process-${process.pid}` },
		key: `v8-eval:${proc.pid}`,
		label: "v8 eval",
		pid: proc.pid,
	});

	const session: V8Session = {
		sessionKey,
		sessionId,
		kernelId: `v8-${Snowflake.next()}`,
		proc,
		state: "alive",
		stateSessions: new Set(),
		pending: new Map(),
		ownerIds: new Set(),
		hasFallbackOwner: false,
		readyPromise,
		resolveReady,
		rejectReady,
		closedPromise,
		resolveClosed,
		stderrLines: [],
		boardDispose: () => board.dispose(),
	};

	const stdoutDone = pumpV8Stdout(session);
	const stderrDone = pumpV8Stderr(session);
	void proc.exited.then(async exitCode => {
		board.dispose();
		await Promise.allSettled([stdoutDone, stderrDone]);
		session.resolveClosed(exitCode === 0);
		if (session.state === "alive") {
			const detail = session.stderrLines.slice(-6).join("\n").trim();
			const reason = detail
				? `V8 isolate exited unexpectedly (code ${exitCode}): ${detail}`
				: `V8 isolate exited unexpectedly (code ${exitCode}; possible out-of-memory); state cleared`;
			const err = new ToolError(reason);
			session.rejectReady(err);
			await killV8SessionFor(session, err, { force: true });
		}
	});

	return session;
}

async function pumpV8Stdout(session: V8Session): Promise<void> {
	try {
		for await (const msg of readJsonl<V8Outbound>(session.proc.stdout)) {
			handleV8Message(session, msg);
		}
	} catch (error) {
		if (session.state === "alive") {
			const err = new ToolError(
				`V8 isolate protocol stream failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			session.rejectReady(err);
			await killV8SessionFor(session, err, { force: true });
		}
	}
}

async function pumpV8Stderr(session: V8Session): Promise<void> {
	try {
		const text = await new Response(session.proc.stderr).text();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			session.stderrLines.push(trimmed);
			if (session.stderrLines.length > 30) session.stderrLines.shift();
		}
	} catch {
		// Best-effort stderr capture only.
	}
}

function handleV8Message(session: V8Session, msg: V8Outbound): void {
	switch (msg.type) {
		case "ready":
			session.resolveReady();
			return;
		case "closed":
			session.resolveClosed(true);
			return;
		case "text": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onText?.(msg.chunk);
			return;
		}
		case "display": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onDisplay?.(msg.output as EvalDisplayOutput);
			return;
		}
		case "tool-call":
			void dispatchBridgeRequest(session, msg.id, msg.runId, bridgeOptions =>
				handleV8ToolCall(msg.name, msg.args, bridgeOptions),
			);
			return;
		case "url-read":
			void dispatchBridgeRequest(session, msg.id, msg.runId, bridgeOptions =>
				handleV8UrlRead(msg.path, msg.options, bridgeOptions),
			);
			return;
		case "url-write":
			void dispatchBridgeRequest(session, msg.id, msg.runId, bridgeOptions =>
				handleV8UrlWrite(msg.path, msg.data, msg.encoding, bridgeOptions),
			);
			return;
		case "result":
			settlePending(session, msg);
			return;
	}
}

async function dispatchBridgeRequest(
	session: V8Session,
	callId: string,
	runId: string,
	executor: (options: V8HostBridgeOptions) => Promise<unknown>,
): Promise<void> {
	const pending = session.pending.get(runId);
	if (!pending || session.state === "dead") {
		sendToV8(session, { type: "tool-reply", id: callId, ok: false, error: { message: "Run no longer active" } });
		return;
	}
	if (pending.aborted) {
		sendToV8(session, { type: "tool-reply", id: callId, ok: false, error: { message: "Run was interrupted" } });
		return;
	}

	const ctrl = new AbortController();
	pending.toolCalls.set(callId, ctrl);
	try {
		const value = await executor({
			session: pending.toolSession,
			parentToolCallId: pending.runState.parentToolCallId,
			signal: ctrl.signal,
			cellTimeoutMs: pending.cellTimeoutMs,
			onReply: pending.runState.onReply,
			onDisplay: output => pending.runState.onDisplay?.(output),
			emitStatus: event => pending.runState.onDisplay?.({ type: "status", event }),
		});
		sendToV8(session, { type: "tool-reply", id: callId, ok: true, value });
	} catch (error) {
		sendToV8(session, { type: "tool-reply", id: callId, ok: false, error: toErrorPayload(error) });
	} finally {
		pending.toolCalls.delete(callId);
		const held = pending.heldResult;
		if (held && !pending.settled && !pending.aborted && pending.toolCalls.size === 0) {
			finishPending(pending, held);
		}
	}
}

async function runOnce(
	session: V8Session,
	options: {
		session: ToolSession;
		code: string;
		filename: string;
		finalExprSuppressed?: boolean;
		timeoutMs?: number;
		runState: V8RunState;
	},
): Promise<void> {
	const runId = `v8-${crypto.randomUUID()}`;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const pending: PendingV8Run = {
		runId,
		runState: options.runState,
		toolSession: options.session,
		cellTimeoutMs: options.timeoutMs,
		resolve,
		reject,
		toolCalls: new Map(),
		aborted: false,
		settled: false,
	};
	session.pending.set(runId, pending);

	let abortPromise: Promise<void> | undefined;
	const triggerAbort = (): Promise<void> => {
		if (abortPromise) return abortPromise;
		abortPromise = (async () => {
			if (pending.settled) return;
			pending.aborted = true;
			const error = abortReasonError(options.runState.signal?.reason, "V8 execution aborted");
			for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
			sendToV8(session, { type: "cancel", runId });

			// Give V8 a short grace period to unwind terminate_execution() cleanly while keeping state;
			// if it does not settle (e.g. hung native work), kill the isolate process.
			const settledCleanly = await Promise.race([
				promise.then(
					() => true,
					() => true,
				),
				Bun.sleep(V8_CANCEL_GRACE_MS).then(() => false),
			]);
			if (!settledCleanly && !pending.settled) {
				await killV8SessionFor(session, error, { force: true });
			} else if (!pending.settled) {
				pending.settled = true;
				pending.reject(error);
			}
		})();
		return abortPromise;
	};

	const onAbort = (): void => {
		void triggerAbort();
	};
	if (options.runState.signal?.aborted) {
		pending.aborted = true;
		pending.settled = true;
		reject(abortReasonError(options.runState.signal.reason, "V8 execution aborted"));
	} else {
		options.runState.signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		if (!pending.settled && !pending.aborted) {
			sendToV8(session, {
				type: "run",
				runId,
				code: options.code,
				filename: options.filename,
				finalExprSuppressed: options.finalExprSuppressed,
			});
		}
		await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

function finishPending(pending: PendingV8Run, msg: Extract<V8Outbound, { type: "result" }>): void {
	pending.settled = true;
	pending.heldResult = undefined;
	if (msg.ok) {
		pending.resolve();
		return;
	}
	pending.reject(errorFromPayload(msg.error));
}

function settlePending(session: V8Session, msg: Extract<V8Outbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;
	if (pending.aborted) {
		// Clean cancellation during grace window settles the run without killing the isolate.
		finishPending(pending, msg);
		return;
	}
	if (pending.toolCalls.size > 0) {
		pending.heldResult = msg;
		return;
	}
	finishPending(pending, msg);
}

async function killV8SessionFor(session: V8Session, error: Error, options: { force: boolean }): Promise<void> {
	if (sessions.get(session.sessionKey) === session) {
		sessions.delete(session.sessionKey);
		lostSessions.set(session.sessionKey, new Set(session.ownerIds));
	}
	await killV8Session(session, error, options);
}

async function killV8Session(session: V8Session, error: Error, options: { force: boolean }): Promise<void> {
	if (session.state === "dead") return;
	session.state = "dead";
	for (const toolSession of session.stateSessions) {
		updateEvalState(toolSession, { language: "v8", kernelId: session.kernelId, alive: false });
	}
	for (const pending of session.pending.values()) pending.aborted = true;
	for (const pending of session.pending.values()) {
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
	}

	let closedGracefully = false;
	if (!options.force) {
		sendToV8(session, { type: "close" });
		closedGracefully = await Promise.race([session.closedPromise, Bun.sleep(V8_CLOSE_TIMEOUT_MS).then(() => false)]);
	}
	if (!closedGracefully) {
		try {
			session.proc.kill("SIGKILL");
		} catch {
			// Process already exited.
		}
	}
	try {
		await Promise.race([session.proc.exited, Bun.sleep(V8_CLOSE_TIMEOUT_MS)]);
	} catch {
		// Ignore wait errors.
	}
	session.boardDispose();

	for (const pending of session.pending.values()) {
		if (pending.settled) continue;
		pending.settled = true;
		pending.reject(error);
	}
	session.pending.clear();
}

function markV8SessionAlive(session: V8Session, toolSession: ToolSession): void {
	if (session.state !== "alive") return;
	session.stateSessions.add(toolSession);
	updateEvalState(toolSession, {
		language: "v8",
		kernelId: session.kernelId,
		alive: true,
		interpreter: "V8 Isolate",
	});
}

function sendToV8(session: V8Session, msg: V8Inbound): void {
	if (session.state !== "alive") return;
	try {
		session.proc.stdin.write(`${JSON.stringify(msg)}\n`);
	} catch (err) {
		logger.debug("v8 isolate stdin write failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function errorFromPayload(payload: V8ErrorPayload): Error {
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

function toErrorPayload(error: unknown): V8ErrorPayload {
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
