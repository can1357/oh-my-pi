import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";
import { resolveV8EvalBinary } from "@oh-my-pi/pi-natives";
import { ConcatSink, isRecord, logger, Snowflake, withTimeout } from "@oh-my-pi/pi-utils";
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
import type { EvalTableColumn, EvalView } from "../../tools/details/eval";
import { cfgEvalV8MaxHeapMb } from "../settings";
import { updateEvalState } from "../state";
import type { EvalDisplayOutput } from "../types";
import { handleV8ToolCall, handleV8UrlRead, handleV8UrlWrite, type V8HostBridgeOptions } from "./host-bridge";
import type { V8ErrorPayload, V8Inbound, V8Outbound } from "./protocol";

const V8_INIT_TIMEOUT_MS = 10_000;
const V8_CANCEL_GRACE_MS = 250;
const V8_CLOSE_TIMEOUT_MS = 1_000;
const MAX_V8_INBOUND_FRAME_BYTES = 15 * 1024 * 1024;
const MAX_V8_OUTBOUND_FRAME_BYTES = 16 * 1024 * 1024;
const ALLOWED_GUEST_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const activeV8BridgeSession = new AsyncLocalStorage<string>();
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
	state: "alive" | "closing" | "dead";
	stateSessions: Set<ToolSession>;
	pending: Map<string, PendingV8Run>;
	runTail: Promise<void>;
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
	asyncWrapped?: boolean;
	finalExprReturned?: boolean | null;
	timeoutMs?: number;
	runState: V8RunState;
}): Promise<void> {
	const { sessionKey } = options;
	if (activeV8BridgeSession.getStore() === sessionKey) {
		throw new ToolError("Nested language: 'v8' calls on the same session are not supported.");
	}
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
	const prevTail = session.runTail.catch(() => undefined);
	const { promise: currentRun, resolve: releaseRun } = Promise.withResolvers<void>();
	session.runTail = Promise.allSettled([prevTail, currentRun]).then(() => undefined);
	try {
		await raceAbort(prevTail, options.runState.signal, "V8 execution aborted while queued");
		if (session.state !== "alive") {
			throw new ToolError("V8 isolate exited before starting cell");
		}
		await runOnce(session, options);
	} finally {
		releaseRun();
	}
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
		await withTimeout(session.readyPromise, V8_INIT_TIMEOUT_MS, "Timed out waiting for omp-v8-eval ready");
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
		await withTimeout(promise, V8_INIT_TIMEOUT_MS, "Timed out running omp-v8-eval smoke cell");
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
		void entry.promise
			.catch(() => undefined)
			.finally(() => {
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
		await withTimeout(session.readyPromise, initTimeout, "Timed out waiting for V8 isolate to initialize");
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
		runTail: Promise.resolve(),
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
	const reader = (session.proc.stdout as ReadableStream<Uint8Array>).getReader();
	const buffer = new ConcatSink();
	const decoder = new TextDecoder();
	let bufferedBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let pos = 0;
			while (pos < value.length) {
				const nl = value.indexOf(0x0a, pos);
				if (nl === -1) {
					const rem = value.length - pos;
					if (bufferedBytes + rem > MAX_V8_OUTBOUND_FRAME_BYTES) {
						throw new ToolError("V8 isolate outbound frame exceeded 16 MiB limit");
					}
					buffer.append(value.subarray(pos));
					bufferedBytes += rem;
					break;
				}
				const segLen = nl - pos;
				if (bufferedBytes + segLen > MAX_V8_OUTBOUND_FRAME_BYTES) {
					throw new ToolError("V8 isolate outbound frame exceeded 16 MiB limit");
				}
				let lineBytes: Uint8Array;
				if (bufferedBytes === 0) {
					lineBytes = value.subarray(pos, nl);
				} else {
					buffer.append(value.subarray(pos, nl));
					lineBytes = buffer.flush()!;
				}
				pos = nl + 1;
				if (lineBytes.length > 0) {
					const msg = JSON.parse(decoder.decode(lineBytes)) as V8Outbound;
					handleV8Message(session, msg);
				}
				if (bufferedBytes > 0) {
					buffer.clear();
					bufferedBytes = 0;
				}
			}
		}
		if (bufferedBytes > 0) {
			const tail = buffer.flush();
			buffer.clear();
			if (tail && tail.length > 0) {
				const msg = JSON.parse(decoder.decode(tail)) as V8Outbound;
				handleV8Message(session, msg);
			}
		}
	} catch (error) {
		if (session.state === "alive") {
			const err = new ToolError(
				`V8 isolate protocol stream failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			session.rejectReady(err);
			await killV8SessionFor(session, err, { force: true });
		}
	} finally {
		reader.releaseLock();
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
			const sanitized = sanitizeGuestDisplayOutput(msg.output);
			if (sanitized) pending?.runState.onDisplay?.(sanitized);
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
		const value = await activeV8BridgeSession.run(session.sessionKey, () =>
			executor({
				session: pending.toolSession,
				parentToolCallId: pending.runState.parentToolCallId,
				signal: ctrl.signal,
				cellTimeoutMs: pending.cellTimeoutMs,
				onReply: pending.runState.onReply,
				onDisplay: output => pending.runState.onDisplay?.(output),
				emitStatus: event => pending.runState.onDisplay?.({ type: "status", event }),
			}),
		);
		let encoded: string;
		try {
			encoded = `${JSON.stringify({ type: "tool-reply", id: callId, ok: true, value })}\n`;
		} catch (serError) {
			sendToV8(session, {
				type: "tool-reply",
				id: callId,
				ok: false,
				error: toErrorPayload(
					new ToolError(
						`Tool reply is not JSON-serializable: ${serError instanceof Error ? serError.message : String(serError)}`,
					),
				),
			});
			return;
		}
		if (Buffer.byteLength(encoded, "utf8") > MAX_V8_INBOUND_FRAME_BYTES) {
			sendToV8(session, {
				type: "tool-reply",
				id: callId,
				ok: false,
				error: toErrorPayload(new ToolError("Tool reply exceeds 15 MiB V8 bridge limit")),
			});
			return;
		}
		writeRawToV8(session, encoded);
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
		asyncWrapped?: boolean;
		finalExprReturned?: boolean | null;
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
			const encoded = encodeV8Frame({
				type: "run",
				runId,
				code: options.code,
				filename: options.filename,
				finalExprSuppressed: options.finalExprSuppressed,
				asyncWrapped: options.asyncWrapped,
				finalExprReturned: options.finalExprReturned,
			});
			if (Buffer.byteLength(encoded, "utf8") > MAX_V8_INBOUND_FRAME_BYTES) {
				throw new ToolError("V8 cell payload exceeds 15 MiB frame limit");
			}
			writeRawToV8(session, encoded);
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
	if (session.state === "dead" || session.state === "closing") return;
	session.state = "closing";
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
	session.state = "dead";
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

function sanitizeGuestView(raw: unknown): EvalView | undefined {
	if (!isRecord(raw) || typeof raw.kind !== "string") return undefined;
	if (raw.kind === "table") {
		if (!Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return undefined;
		const columns: EvalTableColumn[] = [];
		for (const col of raw.columns) {
			if (!isRecord(col) || typeof col.head !== "string") return undefined;
			if (col.numeric !== undefined && typeof col.numeric !== "boolean") return undefined;
			columns.push(col.numeric !== undefined ? { head: col.head, numeric: col.numeric } : { head: col.head });
		}
		const rows: string[][] = [];
		for (const row of raw.rows) {
			if (!Array.isArray(row) || !row.every(cell => typeof cell === "string")) return undefined;
			rows.push([...row]);
		}
		return { kind: "table", columns, rows };
	}
	if (raw.kind === "json") {
		if (!Object.hasOwn(raw, "value")) return undefined;
		return { kind: "json", value: raw.value };
	}
	if (raw.kind === "markdown") {
		if (typeof raw.text !== "string") return undefined;
		return { kind: "markdown", text: raw.text };
	}
	return undefined;
}

function sanitizeGuestDisplayOutput(raw: unknown): EvalDisplayOutput | undefined {
	if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
	if (raw.type === "image") {
		if (
			typeof raw.data !== "string" ||
			raw.data.length === 0 ||
			typeof raw.mimeType !== "string" ||
			!ALLOWED_GUEST_IMAGE_MIME_TYPES.has(raw.mimeType)
		) {
			return undefined;
		}
		return { type: "image", data: raw.data, mimeType: raw.mimeType };
	}
	if (raw.type === "view") {
		if (typeof raw.text !== "string") return undefined;
		const view = sanitizeGuestView(raw.view);
		if (!view) return undefined;
		return { type: "view", text: raw.text, view };
	}
	if (raw.type === "status") {
		if (!isRecord(raw.event)) return undefined;
		const op = raw.event.op;
		if (op !== "log" && op !== "phase") return undefined;
		return {
			type: "status",
			event: {
				op,
				...(typeof raw.event.message === "string" ? { message: raw.event.message } : {}),
				...(typeof raw.event.title === "string" ? { title: raw.event.title } : {}),
			},
		};
	}
	return undefined;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, fallbackMessage: string): Promise<T> {
	if (!signal) return await promise;
	if (signal.aborted) throw abortReasonError(signal.reason, fallbackMessage);
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(abortReasonError(signal.reason, fallbackMessage));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function encodeV8Frame(msg: V8Inbound): string {
	let encoded = `${JSON.stringify(msg)}\n`;
	if (Buffer.byteLength(encoded, "utf8") <= MAX_V8_INBOUND_FRAME_BYTES) return encoded;
	if (msg.type === "tool-reply" && !msg.ok) {
		const bounded: V8Inbound = {
			type: "tool-reply",
			id: msg.id,
			ok: false,
			error: {
				name: msg.error.name,
				message: `${msg.error.message.slice(0, 64 * 1024)}... [truncated]`,
				isAbort: msg.error.isAbort,
				isToolError: msg.error.isToolError,
			},
		};
		encoded = `${JSON.stringify(bounded)}\n`;
		if (Buffer.byteLength(encoded, "utf8") <= MAX_V8_INBOUND_FRAME_BYTES) return encoded;
	}
	throw new ToolError("V8 inbound frame exceeds 15 MiB limit");
}

function writeRawToV8(session: V8Session, payload: string): void {
	if (session.state === "dead") return;
	try {
		const res = session.proc.stdin.write(payload);
		void Promise.resolve(res).catch(err => {
			logger.debug("v8 isolate stdin write failed", { error: err instanceof Error ? err.message : String(err) });
		});
	} catch (err) {
		logger.debug("v8 isolate stdin write failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function sendToV8(session: V8Session, msg: V8Inbound): void {
	if (session.state === "dead") return;
	try {
		writeRawToV8(session, encodeV8Frame(msg));
	} catch (err) {
		logger.debug("v8 isolate stdin encode failed", { error: err instanceof Error ? err.message : String(err) });
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
