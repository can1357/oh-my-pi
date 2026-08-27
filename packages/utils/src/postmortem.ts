/**
 * Cleanup and postmortem handler utilities.
 *
 * This module provides a system for registering and running cleanup callbacks
 * in response to process exit, signals, or fatal exceptions. It is intended to
 * allow reliably releasing resources or shutting down subprocesses, files, sockets, etc.
 */

import * as fs from "node:fs";
import inspector from "node:inspector";
import { isMainThread } from "node:worker_threads";
import * as logger from "./logger";
import { restoreTerminalStderr } from "./stderr-guard";

// Cleanup reasons, in order of priority/meaning.
export enum Reason {
	PRE_EXIT = "pre_exit", // Pre-exit phase (not used by default)
	EXIT = "exit", // Normal process exit
	SIGINT = "sigint", // Ctrl-C or SIGINT
	SIGTERM = "sigterm", // SIGTERM
	SIGHUP = "sighup", // SIGHUP
	UNCAUGHT_EXCEPTION = "uncaught_exception", // Fatal exception
	UNHANDLED_REJECTION = "unhandled_rejection", // Unhandled promise rejection
	MANUAL = "manual", // Manual cleanup (not triggered by process)
}

// Internal list of active cleanup callbacks (in registration order)
const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];
// Tracks cleanup run state (to prevent recursion/reentry issues)
let cleanupStage: "idle" | "running" | "complete" = "idle";
const CLEANUP_DEADLINE_MS = 10_000;
/**
 * Symbol stamped by the extension-load guard onto the throwing replacement it
 * installs over `process.exit` / `process.reallyExit`, carrying the native
 * primitive that replacement shadows.
 *
 * Host-owned shutdown ({@link exitProcess}) reads through it so a signal that
 * lands while the guard is active still terminates the process (#6488), while
 * a signal that lands after the guard has restored the native exit also
 * terminates cleanly (#7393). `Symbol.for` so it survives duplicate module
 * instances across bundles/realms.
 */
export const NATIVE_PROCESS_EXIT = Symbol.for("omp.postmortem.nativeProcessExit");

type HardExitFn = (code?: number) => never;

/**
 * Hard-exit the process through the native primitive, resolved on every call.
 *
 * The native exit is deliberately re-resolved here rather than bound at module
 * load: the extension/hook loader's `withHostGuard` transiently swaps
 * `process.reallyExit`/`process.exit` for a stub that throws
 * `ExtensionExitError`, and the shipped bundle defers this module's evaluation
 * until first access — which can land inside that guard window, so binding at
 * init could freeze the throwing stub forever and turn every later shutdown
 * (SIGHUP/SIGINT/fatal) into an unhandled-rejection loop (#7393). When the
 * guard is active the stub carries the native exit under
 * {@link NATIVE_PROCESS_EXIT}; unwrapping it lets a mid-guard signal still exit
 * (#6488). Otherwise the current `process.reallyExit`/`process.exit` is native.
 */
function exitProcess(code: number): never {
	const current: HardExitFn = typeof process.reallyExit === "function" ? process.reallyExit : process.exit;
	const behind = Reflect.get(current, NATIVE_PROCESS_EXIT);
	const nativeExit = typeof behind === "function" ? (behind as HardExitFn) : current;
	return nativeExit.call(process, code) as never;
}
let cleanupPromise: Promise<void> | undefined;
let stdioDisconnectRegistrations = 0;

/** User-facing command printed before fatal cleanup so interrupted work can be resumed. */
export interface FatalRecoveryHint {
	/** Stable label identifying the recoverable session or process. */
	label: string;
	/** Complete shell command the user can execute to resume the interrupted work. */
	command: string;
}

type FatalRecoveryHintProvider = () => FatalRecoveryHint | undefined;
const fatalRecoveryHintProviders = new Set<FatalRecoveryHintProvider>();

/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each callback is invoked at most once. Handles errors and prevents reentrancy.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason: Reason): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return cleanupPromise ?? Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	// Call .cleanup() for each callback that is still "armed".
	// Use Promise.try to handle sync/async, but only those armed.
	const promises = callbackList.toReversed().map(callback => {
		return Promise.try(() => callback(reason));
	});

	const cleanupSettled = Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		cleanupStage = "complete";
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		cleanupStage = "complete";
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	cleanupPromise = Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
	});
	return cleanupPromise;
}

// Register signal and error event handlers to trigger cleanup before exit.
// Main thread: full signal handling (SIGINT, SIGTERM, SIGHUP) + exceptions + exit
// Worker thread: exit only (workers use self.addEventListener for exceptions)
let inspectorOpened = false;

/** Origin of an EPIPE raised by a process communication channel. */
export type BrokenPipeSource = "ipc-send" | "stdio-write";

/**
 * Classify EPIPE errors from worker IPC and stdio without treating unrelated
 * broken pipes as globally recoverable.
 */
export function classifyBrokenPipe(err: Error): BrokenPipeSource | undefined {
	if (!("code" in err) || err.code !== "EPIPE" || !("syscall" in err)) return undefined;
	if (err.syscall === "send") return "ipc-send";
	if (err.syscall === "write") return "stdio-write";
	return undefined;
}

/** Whether an EPIPE came from an IPC `send()` to an optional worker. */
export function isIpcSendEpipe(err: Error): boolean {
	return classifyBrokenPipe(err) === "ipc-send";
}

/**
 * Whether an uncaught error is Bun's asynchronous `ERR_SOCKET_CLOSED` thrown
 * from inside `node:net` internals with no application frames on the stack.
 *
 * Bun ≥1.4 can fire the close callback of an already-closed `node:net` socket
 * on a fresh stack; the throw bypasses every callsite try/catch and surfaces
 * here as a process-level uncaughtException. Closing an already-closed socket
 * is inherently a no-op — the socket owner's own `error`/`close` handlers
 * still drive recovery — so tearing the session down for it is pure loss.
 * Only frameless internal stacks qualify: an `ERR_SOCKET_CLOSED` raised
 * through application code keeps the fatal path.
 */
export function isInternalSocketClosedError(err: unknown): boolean {
	if (!(err instanceof Error) || !("code" in err) || err.code !== "ERR_SOCKET_CLOSED") return false;
	const frames = (err.stack ?? "").split("\n").slice(1);
	if (frames.length === 0) return false;
	let hasNetFrame = false;
	const internal = frames.every(frame => {
		const trimmed = frame.trim();
		if (trimmed === "" || trimmed === "at unknown" || trimmed === "at native") return true;
		if (!/\(node:[^)]*\)$/.test(trimmed) && !/^at node:/.test(trimmed)) return false;
		hasNetFrame ||= trimmed.includes("node:net:");
		return true;
	});
	return internal && hasNetFrame;
}

/**
 * Detect Bun's advanced-serialization (structured-clone) IPC decode failure.
 *
 * When a worker subprocess spawned with `serialization: "advanced"` sends a
 * malformed or truncated frame, Bun raises the decode failure as a
 * process-level `uncaughtException` in the *parent* rather than routing it to
 * the channel's `ipc()` callback (oven-sh/bun#37287). The error is a bare
 * `TypeError: Unable to deserialize data.` whose only own property is `message`
 * — it carries no `code`, no `syscall`, and no `stack`. Matching all four traits
 * keeps unrelated application `TypeError`s (which always carry a populated
 * multi-frame stack) on the fatal path, so a genuine bug is never silently
 * swallowed.
 *
 * Every advanced-serialization channel in this process is an optional worker
 * subsystem (TTS, STT, tiny-title, mnemopi embeddings, JS eval), so one
 * worker's bad frame must fault only that worker — via its own `onExit`/error
 * path — never tear down the whole session. Callers log-and-continue instead of
 * taking the fatal path. Mirrors {@link classifyBrokenPipe} for the send side
 * (#2997, #9158).
 */
export function isWorkerIpcDeserializeError(err: unknown): boolean {
	return (
		err instanceof TypeError &&
		err.message === "Unable to deserialize data." &&
		!err.stack &&
		!("code" in err) &&
		!("syscall" in err)
	);
}

/** Recycle callbacks for the active advanced-serialization worker IPC channels. */
const workerIpcFaultHandlers = new Set<(err: Error) => void>();

/**
 * Register a fault/recycle callback for an active advanced-serialization worker
 * IPC channel.
 *
 * Bun surfaces a malformed frame as a process-global `uncaughtException`
 * ({@link isWorkerIpcDeserializeError}) with no way to attribute it to a
 * specific channel, so when one fires every registered handler is invoked to
 * conservatively fault its worker — reject in-flight requests and recycle the
 * subprocess — instead of leaving pending work to await forever. Returns an
 * unregister function; callers MUST unregister when the worker exits.
 */
export function registerWorkerIpcFaultHandler(handler: (err: Error) => void): () => void {
	workerIpcFaultHandlers.add(handler);
	return () => workerIpcFaultHandlers.delete(handler);
}

/** Invoke every registered worker IPC fault handler, isolating handler throws. */
function faultWorkerIpcChannels(err: Error): void {
	for (const handler of workerIpcFaultHandlers) {
		try {
			handler(err);
		} catch (handlerErr) {
			logger.warn("Worker IPC fault handler threw", { err: handlerErr });
		}
	}
}

/**
 * Treat unhandled stdout EPIPE rejections as a graceful peer disconnect.
 *
 * Stdio protocol servers call this for their process lifetime so a closed
 * client pipe runs registered cleanup callbacks instead of the fatal path.
 * The returned callback removes the registration.
 */
export function registerStdioDisconnectHandling(): () => void {
	let registered = true;
	stdioDisconnectRegistrations++;
	return () => {
		if (!registered) return;
		registered = false;
		stdioDisconnectRegistrations--;
	};
}

// Well-known key marking an error as an *expected* teardown artifact (e.g. a
// browser run-scope abort at normal run end). `Symbol.for` so the marker
// survives duplicate module instances across bundles/realms.
const EXPECTED_CLEANUP = Symbol.for("omp.expectedCleanupError");

/**
 * Mark an error as expected cleanup fallout so the global fatal handlers
 * downgrade it to a log line instead of tearing down the process. Use for
 * abort reasons fired by routine resource teardown (browser run end, tab
 * close) whose rejections may surface on fire-and-forget promises with no
 * consumer. Returns the same error for inline use at the `abort()` callsite.
 */
export function markExpectedCleanupError<T extends object>(reason: T): T {
	(reason as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] = true;
	return reason;
}

/**
 * Whether `reason` (or any error in its `cause` chain) was marked via
 * {@link markExpectedCleanupError}. Walks the chain because the unhandled
 * reason is often a wrapper (`AbortError`) with the marked abort reason as
 * its `cause`.
 */
export function isExpectedCleanupError(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if ((current as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] === true) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** Interceptors consulted by the global `unhandledRejection` handler before the fatal path. */
const rejectionInterceptors = new Set<(reason: unknown) => boolean>();

/**
 * Register an interceptor consulted before an unhandled rejection tears the
 * process down. A consuming interceptor owns reporting and keeps the process alive.
 */
export function interceptUnhandledRejections(interceptor: (reason: unknown) => boolean): () => void {
	rejectionInterceptors.add(interceptor);
	return () => rejectionInterceptors.delete(interceptor);
}

/**
 * Register a synchronous recovery command to print when the process exits
 * through an uncaught exception or unhandled rejection.
 */
export function registerFatalRecoveryHint(provider: FatalRecoveryHintProvider): () => void {
	fatalRecoveryHintProviders.add(provider);
	return () => fatalRecoveryHintProviders.delete(provider);
}

function escapeFatalHintText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => {
		const code = char.codePointAt(0) ?? 0;
		return `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

function formatFatalRecoveryHints(): string {
	const lines: string[] = [];
	const seenCommands = new Set<string>();
	for (const provider of fatalRecoveryHintProviders) {
		try {
			const hint = provider();
			if (!hint?.command || seenCommands.has(hint.command)) continue;
			seenCommands.add(hint.command);
			lines.push(`  ${escapeFatalHintText(hint.label)}: ${escapeFatalHintText(hint.command)}`);
		} catch (err) {
			logger.warn("Fatal recovery hint provider failed", { err });
		}
	}
	return lines.length > 0 ? `\n[Recovery]\n${lines.join("\n")}\n` : "";
}

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

async function exitAfterFatal(label: string, logMessage: string, err: Error, reason: Reason): Promise<void> {
	const forcedExit = setTimeout(() => exitProcess(1), CLEANUP_DEADLINE_MS);
	try {
		restoreTerminalStderr();
		// A revoked terminal can make stream writes raise another fatal error. Use
		// the descriptor directly so failure stays synchronous and contained.
		try {
			fs.writeSync(2, `${formatFatalError(label, err)}${formatFatalRecoveryHints()}`);
		} catch {}
		logger.error(logMessage, { err });
		await runCleanup(reason);
	} finally {
		clearTimeout(forcedExit);
		exitProcess(1);
	}
}

if (isMainThread) {
	process
		.on("SIGINT", async () => {
			await runCleanup(Reason.SIGINT);
			exitProcess(130); // 128 + SIGINT (2)
		})
		.on("SIGUSR1", () => {
			if (inspectorOpened) return;
			inspectorOpened = true;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			process.stderr.write(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async thrown => {
			if (isExpectedCleanupError(thrown)) {
				logger.warn("Ignoring expected cleanup exception", { err: thrown });
				return;
			}
			const err = thrown instanceof Error ? thrown : new Error(String(thrown));
			// Bun can surface a worker IPC send race through uncaughtException
			// instead of unhandledRejection. Apply the same optional-worker
			// containment in either global error channel.
			if (isIpcSendEpipe(err)) {
				logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
				return;
			}
			// A malformed advanced-serialization frame from a worker subprocess
			// surfaces here as a process-level uncaughtException (oven-sh/bun#37287)
			// rather than in the channel's ipc() callback, and Bun gives no way to
			// tell which channel produced it. Contain it to the worker layer: keep
			// the session alive and conservatively fault every active advanced-IPC
			// worker so its owning client rejects in-flight requests and recycles
			// the subprocess — a worker that sent a bad frame but stays alive would
			// otherwise never fire onExit and leave callers awaiting forever.
			// Mirrors the ipc-send EPIPE containment below (#9158, #2997).
			if (isWorkerIpcDeserializeError(err)) {
				logger.warn("Malformed worker IPC frame; faulting active worker subsystems", { err });
				faultWorkerIpcChannels(err);
				return;
			}
			if (isInternalSocketClosedError(err)) {
				logger.warn("Ignoring async ERR_SOCKET_CLOSED from node:net internals; socket owner recovers itself", {
					err,
				});
				return;
			}
			await exitAfterFatal("Uncaught Exception", "Uncaught exception", err, Reason.UNCAUGHT_EXCEPTION);
		})
		.on("unhandledRejection", async reason => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			const brokenPipeSource = classifyBrokenPipe(err);
			// EPIPE from an IPC `send()` (`syscall: "send"`) originates from a
			// worker subprocess whose pipe broke between the exit being observed
			// and the next `proc.send()` — a race window that Bun surfaces as an
			// async rejection rather than the synchronous "cannot be used after
			// the process has exited" guard. Every `send()` target is an optional
			// worker subsystem (TTS, STT, tiny-title, MCP servers), so a broken
			// send pipe must never take down the whole session. Log and continue
			// instead of exiting; the owning client detects the dead worker via
			// its own `onExit`/error path and respawns or disables it. See #2997.
			if (brokenPipeSource === "ipc-send") {
				logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
				return;
			}
			if (brokenPipeSource === "stdio-write" && stdioDisconnectRegistrations > 0) {
				logger.warn("Stdio peer disconnected; shutting down gracefully", { err });
				await runQuit(0, "native");
				return;
			}
			if (isExpectedCleanupError(reason)) {
				logger.warn("Ignoring expected cleanup rejection", { err });
				return;
			}
			for (const interceptor of rejectionInterceptors) {
				try {
					if (interceptor(reason)) return;
				} catch (interceptorErr) {
					logger.warn("Unhandled-rejection interceptor threw; continuing with fatal path", {
						err: interceptorErr,
					});
				}
			}
			await exitAfterFatal("Unhandled Rejection", "Unhandled rejection", err, Reason.UNHANDLED_REJECTION);
		})
		.on("exit", async () => {
			void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
		})
		.on("SIGTERM", async () => {
			await runCleanup(Reason.SIGTERM);
			exitProcess(143); // 128 + SIGTERM (15)
		})
		.on("SIGHUP", async () => {
			await runCleanup(Reason.SIGHUP);
			exitProcess(129); // 128 + SIGHUP (1)
		});
} else {
	// Worker thread: only register exit handler for cleanup.
	// DO NOT register uncaughtException/unhandledRejection handlers here -
	// they would swallow errors before the worker's own handlers (self.addEventListener)
	// can report failures back to the parent thread.
	process.on("exit", () => {
		void runCleanup(Reason.EXIT);
	});
}

/**
 * Register a process cleanup callback, to be run on shutdown, signal, or fatal error.
 *
 * Returns a Callback instance that can be used to cancel (unregister) or manually clean up.
 * If register is called after cleanup already began, invokes callback on a microtask.
 */
export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	const cancel = () => {
		const index = callbackList.indexOf(exec);
		if (index >= 0) {
			callbackList.splice(index, 1);
		}
		done = true;
	};

	if (cleanupStage !== "idle") {
		// Cleanup is already in progress or complete; run late registrations once
		// without re-entering the global cleanup pass.
		logger.debug("Cleanup already started; running late callback once", { id });
		try {
			callback(Reason.MANUAL);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
		return () => {};
	}

	// Register callback as "armed" (active).
	callbackList.push(exec);
	return cancel;
}

/**
 * Runs all cleanup callbacks without exiting.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

/** Controls how manual process shutdown handles terminal output. */
export interface QuitOptions {
	/** Wait for buffered stdout before exiting; disable after the terminal has disconnected. */
	drainStdout?: boolean;
}

async function runQuit(code: number, exitMode: "guarded" | "native", options: QuitOptions = {}): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return; // Workers: cleanup done, let worker exit naturally
	}

	if (options.drainStdout !== false && process.stdout.writableLength > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", resolve);
		await Promise.race([promise, Bun.sleep(5000)]);
	}

	switch (exitMode) {
		case "guarded":
			return process.exit(code);
		case "native":
			return exitProcess(code);
	}
}

/**
 * Runs all cleanup callbacks and exits through the current `process.exit`.
 *
 * In main thread: waits for stdout drain unless disabled, then calls `process.exit()`.
 * In workers: runs cleanup only (process.exit would kill entire process).
 */
export function quit(code: number = 0, options: QuitOptions = {}): Promise<void> {
	return runQuit(code, "guarded", options);
}
