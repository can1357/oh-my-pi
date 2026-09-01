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

interface CleanupRegistration {
	id: string;
	callback: (reason: Reason) => Promise<void> | void;
	exitOnly: boolean;
	cancelled: boolean;
	lastPass: number;
}

// Active cleanup callbacks in registration order. Registrations survive
// keep-alive passes; `lastPass` enforces at-most-once invocation per pass.
const callbackList: CleanupRegistration[] = [];
// Tracks cleanup run state (to prevent recursion/reentry issues).
let cleanupStage: "idle" | "running" | "complete" = "idle";
let cleanupPass = 0;
let activeCleanupReason: Reason | undefined;
let activeCleanupKeepAlive = false;
// Promises of callbacks invoked late (registered while a pass runs), joined by
// the active pass before it settles so `cleanup()`/signal exits await them.
let activeLatePromises: Promise<void>[] | undefined;
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

function invokeCleanup(
	registration: CleanupRegistration,
	reason: Reason,
	keepAlive: boolean,
	pass: number,
): Promise<void> | void {
	if (registration.cancelled || registration.lastPass === pass) return;
	if (registration.exitOnly && keepAlive) return;
	registration.lastPass = pass;
	return registration.callback(reason);
}

/**
 * Internal: runs all registered cleanup callbacks for the given reason.
 * Ensures each registration is invoked at most once per pass, handles errors,
 * and prevents reentrancy.
 *
 * `keepAlive` marks a manual cleanup that keeps the process running (see
 * {@link cleanup}). Such a pass returns the stage to `idle`; registrations stay
 * active for later resources and the eventual real exit. Exit-only callbacks
 * skip keep-alive passes without consuming their registration. An exit-driven
 * pass instead settles to `complete` and stays there.
 *
 * Returns a Promise that settles after all cleanups complete or error out.
 */
function runCleanup(reason: Reason, keepAlive = false): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return cleanupPromise ?? Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	const pass = ++cleanupPass;
	activeCleanupReason = reason;
	activeCleanupKeepAlive = keepAlive;
	const late: Promise<void>[] = [];
	activeLatePromises = late;
	const settle = (): void => {
		if (activeLatePromises === late) activeLatePromises = undefined;
		if (cleanupPass !== pass) return;
		cleanupStage = keepAlive ? "idle" : "complete";
		if (keepAlive) {
			activeCleanupReason = undefined;
			activeCleanupKeepAlive = false;
		}
	};

	// Snapshot the pass. Registrations added while a keep-alive cleanup runs are
	// invoked by register() when appropriate and remain active for later passes.
	const promises = callbackList.toReversed().map(registration => {
		return Promise.try(() => invokeCleanup(registration, reason, keepAlive, pass));
	});

	const cleanupSettled = Promise.allSettled(promises).then(async results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		// Join callbacks registered while this pass ran (already error-caught);
		// each batch may register more. The deadline race still bounds the pass.
		while (late.length > 0) await Promise.allSettled(late.splice(0));
		settle();
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		settle();
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	const passPromise = Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
		// A re-armed pass must drop only its own settled promise; an older
		// deadline-limited pass may finish after a newer one has already started.
		if (keepAlive && cleanupPass === pass && cleanupPromise === passPromise) cleanupPromise = undefined;
	});
	cleanupPromise = passPromise;
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
	Reflect.set(reason, EXPECTED_CLEANUP, true);
	return reason;
}

function hasExpectedCleanupMarker(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if (Reflect.get(current, EXPECTED_CLEANUP) === true) return true;
		current = Reflect.get(current, "cause");
	}
	return false;
}

/**
 * Whether `reason` (or any object in its bounded `cause` chain) was explicitly
 * marked via {@link markExpectedCleanupError}. Runtime error names and codes
 * are intentionally insufficient: unmarked `AbortError` and socket failures
 * can originate from application code and must remain fatal when unhandled.
 */
export function isExpectedCleanupError(reason: unknown): boolean {
	return hasExpectedCleanupMarker(reason);
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

async function exitAfterFatal(output: string, logMessage: string, err: Error, reason: Reason): Promise<never> {
	const forcedExit = setTimeout(() => exitProcess(1), CLEANUP_DEADLINE_MS);
	try {
		// Cleanup callbacks are invoked synchronously before runCleanup returns its
		// completion promise. TUI owners therefore hand the cursor back before the
		// fatal report is written, while slower resource cleanup continues afterward.
		const cleanup = runCleanup(reason);
		restoreTerminalStderr();
		// A revoked terminal can make stream writes raise another fatal error. Use
		// the descriptor directly so failure stays synchronous and contained.
		try {
			fs.writeSync(2, output);
		} catch {}
		logger.error(logMessage, { err });
		await cleanup;
	} finally {
		clearTimeout(forcedExit);
		exitProcess(1);
	}
}

/**
 * Reports a caught top-level failure after terminal owners restore their display, then exits.
 */
export async function fatal(error: unknown): Promise<never> {
	const err = error instanceof Error ? error : new Error(String(error));
	const output = `${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n${formatFatalRecoveryHints()}`;
	if (!isMainThread) {
		process.stderr.write(output);
		process.exit(1);
	}
	return exitAfterFatal(output, "Fatal error", err, Reason.UNHANDLED_REJECTION);
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
			// Only explicitly marked exceptions are safe here. Structural
			// AbortError/socket classification is limited to promise rejections:
			// a synchronously thrown error may indicate an application bug.
			if (hasExpectedCleanupMarker(thrown)) {
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
			await exitAfterFatal(
				`${formatFatalError("Uncaught Exception", err)}${formatFatalRecoveryHints()}`,
				"Uncaught exception",
				err,
				Reason.UNCAUGHT_EXCEPTION,
			);
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
			await exitAfterFatal(
				`${formatFatalError("Unhandled Rejection", err)}${formatFatalRecoveryHints()}`,
				"Unhandled rejection",
				err,
				Reason.UNHANDLED_REJECTION,
			);
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

/** Controls when a registered cleanup callback participates in cleanup passes. */
export interface CleanupRegistrationOptions {
	/**
	 * Run only on a real exit, never during a manual keep-alive cleanup.
	 * The registration remains armed when a keep-alive pass skips it.
	 */
	exitOnly?: boolean;
}

/**
 * Registers a cleanup callback for shutdown, signals, fatal errors, and
 * repeatable manual cleanup passes.
 *
 * Registrations persist across keep-alive {@link cleanup} passes and run at
 * most once per pass. Set `exitOnly` for resources the continuing process still
 * holds (open databases, cached handles): keep-alive passes skip the callback
 * without consuming its registration, while the eventual real exit runs it.
 *
 * A callback registered during a running keep-alive pass joins future passes;
 * normal callbacks also run immediately for the current pass. Registrations
 * made during a real exit run immediately.
 *
 * Returns a function that permanently cancels the registration.
 */
export function register(
	id: string,
	callback: (reason: Reason) => void | Promise<void>,
	options: CleanupRegistrationOptions = {},
): () => void {
	const registration: CleanupRegistration = {
		id,
		callback,
		exitOnly: options.exitOnly ?? false,
		cancelled: false,
		lastPass: 0,
	};
	const cancel = (): void => {
		registration.cancelled = true;
		const index = callbackList.indexOf(registration);
		if (index >= 0) callbackList.splice(index, 1);
	};
	const invokeLate = (reason: Reason, keepAlive: boolean): void => {
		try {
			const pending = invokeCleanup(registration, reason, keepAlive, cleanupPass);
			if (!pending) return;
			const tracked = pending.catch(error => {
				const err = error instanceof Error ? error : new Error(String(error));
				logger.error("Cleanup callback failed", { err, id, stack: err.stack });
			});
			// Join the active pass so cleanup()/signal exits await it; after a
			// completed exit pass there is nothing left to join.
			activeLatePromises?.push(tracked);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	if (cleanupStage === "idle") {
		callbackList.push(registration);
		return cancel;
	}

	const reason = activeCleanupReason ?? Reason.MANUAL;
	if (cleanupStage === "running" && activeCleanupKeepAlive) {
		// The current pass already snapshotted its callbacks. Keep the new owner
		// registered for future passes; normal callbacks also join this pass now.
		callbackList.push(registration);
		if (!registration.exitOnly) invokeLate(reason, true);
		return cancel;
	}

	// A real exit is running or complete. There is no later pass to arm for, so
	// invoke every late registration now, including exit-only callbacks.
	logger.debug("Cleanup already started; running late callback once", { id });
	invokeLate(reason, false);
	return cancel;
}

/**
 * Runs all cleanup callbacks without exiting, then re-arms the system so
 * resources opened afterwards are still cleaned at the eventual real exit.
 * Use this in workers or when you need to clean up but continue execution.
 */
export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL, true);
}

/** Controls how manual process shutdown handles terminal output. */
export interface QuitOptions {
	/** Wait for buffered stdout before exiting; disable after the terminal has disconnected. */
	drainStdout?: boolean;
}

/**
 * Waits (bounded) for buffered stdout to reach the terminal. Used before
 * process exit and before an exec-replace, where unflushed output would be
 * lost with the process image.
 */
export async function drainStdout(): Promise<void> {
	if (process.stdout.writableLength === 0) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	process.stdout.once("drain", resolve);
	await Promise.race([promise, Bun.sleep(5000)]);
}

async function runQuit(code: number, exitMode: "guarded" | "native", options: QuitOptions = {}): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return; // Workers: cleanup done, let worker exit naturally
	}

	if (options.drainStdout !== false) {
		await drainStdout();
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
