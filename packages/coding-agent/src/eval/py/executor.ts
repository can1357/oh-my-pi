import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getProjectDir, logger } from "@pk-nerdsaver-ai/pi-utils";
import { Settings } from "../../config/settings";
import { OutputSink } from "../../session/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import {
	attachSessionOwner,
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	settleWithin,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { JsStatusEvent } from "../js/shared/types";
import type { EvalCancellationCause, EvalProcessErrorEvidence } from "../types";
import {
	checkPythonKernelAvailability,
	formatKernelProcessErrorEvidence,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelExecutionError,
	PythonKernel,
} from "./kernel";
import { resolveExplicitPythonRuntime } from "./runtime";
import { ensurePyToolBridge, registerPyToolBridge } from "./tool-bridge";

export type PythonKernelMode = "session" | "per-call";

export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch */
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used only for timeout-annotation text when the
	 * caller drives cancellation via the eval watchdog `signal` instead of a
	 * wall-clock `deadlineMs`/`timeoutMs`. Does not arm a timer.
	 */
	idleTimeoutMs?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Logical owner identifier for retained kernel cleanup */
	kernelOwnerId?: string;
	/** Kernel mode (session reuse vs per-call) */
	kernelMode?: PythonKernelMode;
	/**
	 * Explicit interpreter path (`python.interpreter` resolved from the
	 * session's settings). Skips automatic runtime discovery when set.
	 */
	interpreter?: string;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Session file path for accessing task outputs */
	sessionFile?: string;
	/**
	 * Effective artifacts directory for the current session. Subagents share
	 * the parent's directory, so this can differ from `sessionFile`'s sibling
	 * dir. When present, exported to the kernel as `PI_ARTIFACTS_DIR` and
	 * preferred over `PI_SESSION_FILE`-derived paths.
	 */
	artifactsDir?: string;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * On-disk roots the prelude helpers (`read`/`write`) substitute for
	 * internal-URL schemes (e.g. `{ local: "/…/artifacts/local" }`). Exported to
	 * the kernel as `PI_EVAL_LOCAL_ROOTS` (JSON) so `write("local://x")` lands
	 * where `read local://x` resolves instead of a literal `local:/` directory.
	 */
	localRoots?: Record<string, string>;
	/**
	 * ToolSession used to resolve host-side `tool.<name>(args)` calls made from
	 * the Python prelude's bridge proxy. When omitted, the bridge env vars are
	 * not injected and any `tool.foo(...)` raises in Python.
	 */
	toolSession?: ToolSession;
	/** Callback for status events emitted by tool bridge invocations. */
	emitStatus?: (event: JsStatusEvent) => void;
	/**
	 * Live status events streamed as they are emitted (both host-side bridge
	 * helpers like `agent()` and kernel-side `display`/`log`/`phase`). Mirrors
	 * what lands in `displayOutputs` so callers can render progress before the
	 * cell finishes.
	 */
	onStatus?: (event: JsStatusEvent) => void;
	/** @internal Bridge session id, set by `executePython` before delegating. */
	bridgeSessionId?: string;
	/** @internal Bridge endpoint info, set by `executePython` before delegating. */
	bridge?: { url: string; token: string };
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface PythonResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether cancellation was caused by a timeout */
	timedOut?: boolean;
	cancellationCause?: EvalCancellationCause;
	effectiveTimeoutMs?: number;
	/** Structured CalledProcessError / TimeoutExpired fields from the runner. */
	processError?: EvalProcessErrorEvidence;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Rich display outputs captured from display_data/execute_result */
	displayOutputs: KernelDisplayOutput[];
	/** Whether stdin was requested */
	stdinRequested: boolean;
}

// ---------------------------------------------------------------------------
// Session bookkeeping
//
// One PythonKernel subprocess per (session id, cwd, interpreter) tuple. The
// runner mutates process-global cwd/sys.path during execution, so cross-directory
// work must never share a live kernel. Multiple agent owners can still register against
// the same tuple; the kernel stays alive until the last owner detaches.
// ---------------------------------------------------------------------------

interface PythonSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: PythonKernel;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

const sessions = new Map<string, PythonSession>();
const startingSessions = new Map<string, Promise<PythonSession>>();
const resettingSessions = new Map<string, Promise<void>>();

function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitPythonRuntime(interpreter, cwd, {}).pythonPath;
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	return `${sessionId}\0${normalizedCwd}\0${normalizeExplicitInterpreter(normalizedCwd, interpreter)}`;
}

// ---------------------------------------------------------------------------
// Cancellation plumbing
// ---------------------------------------------------------------------------

class PythonExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = "PythonExecutionCancelledError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new PythonExecutionCancelledError(true);
	}
	return remainingMs;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

type PythonTimeoutCause = "execution timeout" | "idle watchdog timeout";

function isCancellationError(error: unknown): boolean {
	return (
		error instanceof PythonExecutionCancelledError ||
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
}

function isTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
	if (error instanceof PythonExecutionCancelledError) return error.timedOut;
	if (error instanceof DOMException) return error.name === "TimeoutError";
	if (error instanceof Error && error.name === "TimeoutError") return true;
	const reason = signal?.reason;
	if (reason instanceof DOMException) return reason.name === "TimeoutError";
	return reason instanceof Error ? reason.name === "TimeoutError" : false;
}

function resolveTimeoutCause(timeoutMs: number | undefined, idleTimeoutMs: number | undefined): PythonTimeoutCause {
	return timeoutMs === undefined && idleTimeoutMs !== undefined ? "idle watchdog timeout" : "execution timeout";
}

function formatTimeoutAnnotation(timeoutMs: number | undefined, cause: PythonTimeoutCause): string {
	if (timeoutMs === undefined) return `Command timed out (${cause}; effective duration unavailable)`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds (${cause}; effective duration ${secs} seconds)`;
}

function formatKernelTimeoutAnnotation(
	timeoutMs: number | undefined,
	kernelKilled: boolean,
	cause: PythonTimeoutCause,
): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	const elapsed = secs === undefined ? "at the configured limit" : `after ${secs}s`;
	const effectiveDuration = secs === undefined ? "unavailable" : `${secs} seconds`;
	const timeoutFact = `eval cell timed out ${elapsed} (${cause}; effective duration ${effectiveDuration})`;
	if (kernelKilled) {
		return `${timeoutFact}; the kernel was unresponsive to interrupt, was killed, and will be recreated on the next call.`;
	}
	return `${timeoutFact}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

function toProcessErrorEvidence(error: KernelExecutionError): EvalProcessErrorEvidence | undefined {
	const evidence: EvalProcessErrorEvidence = {
		...(error.command !== undefined ? { command: error.command } : {}),
		...(error.returncode !== undefined ? { returncode: error.returncode } : {}),
		...(error.stdout !== undefined ? { stdout: error.stdout } : {}),
		...(error.stderr !== undefined ? { stderr: error.stderr } : {}),
	};
	return error.command !== undefined ||
		error.returncode !== undefined ||
		error.stdout !== undefined ||
		error.stderr !== undefined
		? evidence
		: undefined;
}

function cancellationFields(
	timedOut: boolean,
	effectiveTimeoutMs: number | undefined,
): Pick<PythonResult, "timedOut" | "cancellationCause" | "effectiveTimeoutMs"> {
	return {
		timedOut,
		cancellationCause: timedOut ? "idle_watchdog_timeout" : "abort",
		effectiveTimeoutMs,
	};
}

function createCancelledPythonResult(
	timedOut: boolean,
	timeoutMs: number | undefined,
	cause: PythonTimeoutCause = resolveTimeoutCause(timeoutMs, timeoutMs),
): PythonResult {
	const output = timedOut ? formatTimeoutAnnotation(timeoutMs, cause) : "";
	const base = createCancelledKernelResult(output);
	return {
		...base,
		...cancellationFields(timedOut, timeoutMs),
	};
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await PythonKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
	});
}

async function acquireSession(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<PythonSession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachSessionOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		const session = await starting;
		attachSessionOwner(session, sessionId, options.kernelOwnerId);
		return session;
	}
	const startup = (async () => {
		const kernel = await startKernel(cwd, options);
		const session: PythonSession = {
			sessionKey,
			sessionId,
			cwd,
			kernel,
			ownerIds: new Set(),
			hasFallbackOwner: false,
		};
		sessions.set(sessionKey, session);
		return session;
	})();
	startingSessions.set(sessionKey, startup);
	try {
		const session = await startup;
		attachSessionOwner(session, sessionId, options.kernelOwnerId);
		return session;
	} finally {
		if (startingSessions.get(sessionKey) === startup) startingSessions.delete(sessionKey);
	}
}

async function replaceSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<void> {
	const old = session.kernel;
	const remaining = getRemainingTimeoutMs(options.deadlineMs);
	await old
		.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
		.catch(() => undefined);
	if (sessions.get(session.sessionKey) !== session) {
		throw new PythonExecutionCancelledError(false);
	}
	requireRemainingTimeoutMs(options.deadlineMs);
	const next = await startKernel(cwd, options);
	if (sessions.get(session.sessionKey) !== session) {
		await next.shutdown().catch(() => undefined);
		throw new PythonExecutionCancelledError(false);
	}
	session.kernel = next;
}

async function resetSession(sessionKey: string): Promise<void> {
	const existing = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.catch(() => undefined));
	if (!existing) return;
	sessions.delete(sessionKey);
	await existing.kernel.shutdown().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Public dispose entry points
// ---------------------------------------------------------------------------

export async function disposeAllKernelSessions(): Promise<void> {
	const pending = [...startingSessions.values()];
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = [...sessions.entries()];
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.some(([, session]) => session === result.value)) {
			all.push([result.value.sessionKey, result.value]);
		}
	}
	for (const [id, session] of all) {
		if (sessions.get(id) === session) sessions.delete(id);
	}
	const results = await Promise.allSettled(all.map(([, session]) => session.kernel.shutdown()));
	for (let i = 0; i < all.length; i += 1) {
		const [id, session] = all[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
		const reason = result.status === "rejected" ? result.reason : "not confirmed";
		logger.warn("Python kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: id,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(id)) sessions.set(id, session);
	}
}

export async function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
	const toShutdown: PythonSession[] = [];
	for (const session of [...sessions.values()]) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const session of toShutdown) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const results = await settleWithin(toShutdown.map(session => session.kernel.shutdown()));
	for (let i = 0; i < toShutdown.length; i += 1) {
		const session = toShutdown[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) {
			session.ownerIds.delete(ownerId);
			continue;
		}
		const reason = result.status === "rejected" ? result.reason : "not confirmed";
		logger.warn("Python kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
	}
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function executeWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	const settings = await Settings.init();
	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	const displayOutputs: KernelDisplayOutput[] = [];
	const deadlineMs = getExecutionDeadlineMs(options);
	let executionTimeoutMs: number | undefined;

	const collectDisplay = (output: KernelDisplayOutput) => {
		if (output.type === "status") {
			options?.onStatus?.(output.event);
			if (isEvalTimeoutControlEvent(output.event)) return;
		}
		displayOutputs.push(output);
	};
	const emitStatus = options?.emitStatus ?? ((event: JsStatusEvent) => collectDisplay({ type: "status", event }));
	const runId = `py-${crypto.randomUUID()}`;
	const unregisterBridge =
		options?.toolSession && options?.bridgeSessionId
			? registerPyToolBridge(options.bridgeSessionId, runId, {
					toolSession: options.toolSession,
					signal: options?.signal,
					emitStatus,
				})
			: null;

	try {
		executionTimeoutMs = requireRemainingTimeoutMs(deadlineMs);
		const result = await kernel.execute(code, {
			cwd: options?.cwd,
			env: buildManagedKernelEnvPatch(options ?? {}),
			id: runId,
			signal: options?.signal,
			timeoutMs: executionTimeoutMs,
			onChunk: text => sink.push(text),
			onDisplay: output => collectDisplay(output),
		});

		if (result.cancelled) {
			const effectiveTimeoutMs = executionTimeoutMs ?? options?.idleTimeoutMs;
			const timeoutCause = resolveTimeoutCause(executionTimeoutMs, options?.idleTimeoutMs);
			const annotation = result.timedOut
				? formatKernelTimeoutAnnotation(effectiveTimeoutMs, result.kernelKilled ?? false, timeoutCause)
				: undefined;
			return {
				exitCode: undefined,
				cancelled: true,
				...cancellationFields(result.timedOut, effectiveTimeoutMs),
				displayOutputs,
				stdinRequested: result.stdinRequested,
				...(await sink.dump(annotation)),
			};
		}

		if (result.stdinRequested) {
			return {
				exitCode: 1,
				cancelled: false,
				displayOutputs,
				stdinRequested: true,
				...(await sink.dump("Kernel requested stdin; interactive input is not supported.")),
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		const processError = result.error && result.status === "error" ? toProcessErrorEvidence(result.error) : undefined;
		const processEvidence =
			result.error && result.status === "error" ? formatKernelProcessErrorEvidence(result.error) : undefined;
		if (processEvidence) sink.push(`${processEvidence}\n`);
		return {
			exitCode,
			cancelled: false,
			...(processError ? { processError } : {}),
			displayOutputs,
			stdinRequested: false,
			...(await sink.dump()),
		};
	} catch (err) {
		if (isCancellationError(err) || options?.signal?.aborted) {
			const timedOut = isTimedOutCancellation(err, options?.signal);
			const effectiveTimeoutMs = executionTimeoutMs ?? options?.idleTimeoutMs;
			const timeoutCause = resolveTimeoutCause(executionTimeoutMs, options?.idleTimeoutMs);
			return {
				exitCode: undefined,
				cancelled: true,
				...cancellationFields(timedOut, effectiveTimeoutMs),
				displayOutputs,
				stdinRequested: false,
				...(await sink.dump(timedOut ? formatTimeoutAnnotation(effectiveTimeoutMs, timeoutCause) : undefined)),
			};
		}
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("Python execution failed", { error: error.message });
		throw error;
	} finally {
		unregisterBridge?.();
	}
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkPythonKernelAvailability(cwd, options.interpreter),
		options,
		PythonExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

async function ensureToolBridge(options: PythonExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensurePyToolBridge();
	} catch (err) {
		logger.warn("Failed to start Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `py-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		return await executeWithKernel(kernel, code, { ...options, cwd });
	} finally {
		await kernel.shutdown().catch(() => undefined);
	}
}

async function executeOnSession(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildSessionKey(sessionId, cwd, options.interpreter);
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = sessionId;
	}
	if (options.reset) {
		// Coalesce concurrent resets: if another reset is in flight for this
		// session, await it instead of throwing — the caller's intent ("start
		// from a clean kernel") is satisfied once that reset settles.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetSession(sessionKey);
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
		// A reset already in progress is an internal coordination state, not a
		// user-visible failure. Wait for it to clear, then proceed with the
		// requested execution on the freshly-restarted kernel.
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(sessionKey, sessionId, cwd, options);
	if (options.signal?.aborted) {
		throw new PythonExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	if (sessions.get(session.sessionKey) !== session) {
		throw new PythonExecutionCancelledError(false);
	}
	if (!session.kernel.isAlive()) {
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeWithKernel(session.kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err) || options.signal?.aborted) throw err;
		if (session.kernel.isAlive()) throw err;
		if (sessions.get(session.sessionKey) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
		// Shared kernels are keyed by cwd, so a dead kernel can be recreated in place
		// without risking cross-directory state bleed.
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
		return await executeWithKernel(session.kernel, code, runOptions);
	}
}

export async function executePythonWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: PythonExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new PythonExecutionCancelledError(
				isTimedOutCancellation(executionOptions.signal.reason, executionOptions.signal),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);

		const kernelMode = executionOptions.kernelMode ?? "session";
		if (kernelMode === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err) || executionOptions.signal?.aborted) {
			const timedOut = isTimedOutCancellation(err, executionOptions.signal);
			const effectiveTimeoutMs = executionOptions.idleTimeoutMs;
			const timeoutCause = resolveTimeoutCause(undefined, executionOptions.idleTimeoutMs);
			return createCancelledPythonResult(timedOut, effectiveTimeoutMs, timeoutCause);
		}
		throw err;
	}
}
