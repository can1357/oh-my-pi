/**
 * Subprocess-backed Python runner.
 *
 * Speaks NDJSON with `runner.py` over stdin/stdout. One subprocess per kernel
 * instance; sessions reuse a single subprocess across executions. Cancellation
 * is `kill("SIGINT")` which raises a real `KeyboardInterrupt` inside user
 * code. Shutdown writes `{"type":"exit"}` and escalates to SIGTERM/SIGKILL on
 * timeout.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $flag, isBunTestRuntime, logger, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import type { Subprocess } from "bun";
import { $ } from "bun";
import { Settings } from "../../config/settings";
import { type KernelDisplayOutput, renderKernelDisplay } from "./display";
import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
	resolvePythonRuntime,
} from "./runtime";
import { hostHasInheritableConsole, shouldHideKernelWindow } from "./spawn-options";

export type { KernelDisplayOutput, PythonStatusEvent } from "./display";
export { renderKernelDisplay } from "./display";

const TRACE_IPC = $flag("PI_PYTHON_IPC_TRACE");

// Cache the runner script on disk so the subprocess loads it normally. Cached
// per script hash so installs don't race across versions.
const RUNNER_CACHE_DIR = path.join(os.tmpdir(), "omp-python-runner");
let RUNNER_SCRIPT_PATH: string | null = null;

async function ensureRunnerScript(): Promise<string> {
	if (RUNNER_SCRIPT_PATH) return RUNNER_SCRIPT_PATH;
	await fs.promises.mkdir(RUNNER_CACHE_DIR, { recursive: true });
	const hash = Bun.hash(RUNNER_SCRIPT).toString(36);
	const target = path.join(RUNNER_CACHE_DIR, `runner-${hash}.py`);
	if (!fs.existsSync(target)) {
		await Bun.write(target, RUNNER_SCRIPT);
	}
	RUNNER_SCRIPT_PATH = target;
	return target;
}

const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;
// How long to wait after SIGINT for the runner to emit `done`. If the cell is
// stuck in code that ignores Python signals (e.g. a C extension holding the
// GIL), we escalate to a full subprocess shutdown so the host queue unblocks
// instead of hanging the session forever. The grace window is intentionally
// generous: a clean interrupt is far preferable to losing the persistent
// kernel's state, so we only kill as a last-resort recovery path.
const INTERRUPT_ESCALATION_MS = 5_000;

export type KernelRuntimeEnv = Record<string, string | null>;

export interface KernelExecuteOptions {
	id?: string;
	/** Runtime working directory applied immediately before this request executes. */
	cwd?: string;
	/** Managed runtime environment variables applied immediately before this request executes. */
	env?: KernelRuntimeEnv;
	signal?: AbortSignal;
	onChunk?: (text: string) => Promise<void> | void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	timeoutMs?: number;
	silent?: boolean;
	storeHistory?: boolean;
	allowStdin?: boolean;
}

/** Structured fields accepted from a Python runner error frame. */
export interface KernelErrorFrame {
	ename?: unknown;
	evalue?: unknown;
	traceback?: unknown;
	command?: unknown;
	returncode?: unknown;
	stdout?: unknown;
	stderr?: unknown;
}

/** Error evidence returned by a kernel execution without traceback parsing. */
export interface KernelExecutionError {
	name: string;
	value: string;
	traceback: string[];
	command?: string;
	returncode?: number;
	stdout?: string;
	stderr?: string;
}

function asOptionalString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every(item => typeof item === "string" || typeof item === "number")) {
		return value.map(String).join(" ");
	}
	return undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Copy explicit process-failure fields from a runner error frame.
 * Never invents command/returncode/stdout/stderr by parsing traceback text.
 */
export function mapKernelErrorFrame(frame: KernelErrorFrame): KernelExecutionError {
	const traceback = Array.isArray(frame.traceback) ? frame.traceback.map(String) : [];
	const error: KernelExecutionError = {
		name: String(frame.ename ?? "Error"),
		value: String(frame.evalue ?? ""),
		traceback,
	};
	const command = asOptionalString(frame.command);
	const returncode = asOptionalNumber(frame.returncode);
	const stdout = asOptionalString(frame.stdout);
	const stderr = asOptionalString(frame.stderr);
	if (command !== undefined) error.command = command;
	if (returncode !== undefined) error.returncode = returncode;
	if (stdout !== undefined) error.stdout = stdout;
	if (stderr !== undefined) error.stderr = stderr;
	return error;
}

/** Model-visible evidence block for CalledProcessError / TimeoutExpired fields. */
export function formatKernelProcessErrorEvidence(error: KernelExecutionError): string {
	const lines: string[] = [];
	if (error.command !== undefined) lines.push(`command: ${error.command}`);
	if (error.returncode !== undefined) lines.push(`return code: ${error.returncode}`);
	if (error.stdout !== undefined) lines.push(`stdout:\n${error.stdout}`);
	if (error.stderr !== undefined) lines.push(`stderr:\n${error.stderr}`);
	return lines.join("\n");
}

export interface KernelExecuteResult {
	status: "ok" | "error";
	executionCount?: number;
	error?: KernelExecutionError;
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	/**
	 * True when the kernel subprocess was killed as part of settling this
	 * execution (e.g. SIGINT was ignored and we escalated to shutdown, or the
	 * kernel died unexpectedly). When false, the kernel remains reusable.
	 */
	kernelKilled?: boolean;
}

export interface KernelShutdownResult {
	confirmed: boolean;
}

interface KernelLifecycleOptions {
	signal?: AbortSignal;
	deadlineMs?: number;
}

interface KernelStartOptions extends KernelLifecycleOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	/**
	 * Explicit interpreter path (`python.interpreter` from the session's
	 * settings). When set, runtime discovery is skipped entirely.
	 */
	interpreter?: string;
}

interface KernelShutdownOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
	/** The probed-working runtime, when one was found. */
	runtime?: PythonRuntime;
}

function getRemainingTimeMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	return Math.max(0, deadlineMs - Date.now());
}

function createAbortError(name: "AbortError" | "TimeoutError", message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function throwIfAborted(signal: AbortSignal | undefined, fallbackReason: string): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof Error) throw reason;
	throw createAbortError("AbortError", typeof reason === "string" ? reason : fallbackReason);
}

// Cache successful probes per resolved cwd + explicit interpreter: every cell
// otherwise pays one (or two — backend.isAvailable + ensureKernelAvailable)
// interpreter spawns even when the kernel is already hot. Failures are not
// cached so installing a Python mid-session is picked up on the next attempt.
const availabilityCache = new Map<string, Promise<PythonKernelAvailability>>();

export async function checkPythonKernelAvailability(
	cwd: string,
	interpreter?: string,
): Promise<PythonKernelAvailability> {
	if (isBunTestRuntime() || $flag("PI_PYTHON_SKIP_CHECK")) {
		return { ok: true };
	}
	const resolvedCwd = path.resolve(cwd);
	const key = `${resolvedCwd}\0${interpreter ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return await cached;
	const probe = probePythonKernelAvailability(resolvedCwd, interpreter);
	availabilityCache.set(key, probe);
	const result = await probe;
	if (!result.ok && availabilityCache.get(key) === probe) {
		availabilityCache.delete(key);
	}
	return result;
}

async function probePythonKernelAvailability(cwd: string, interpreter?: string): Promise<PythonKernelAvailability> {
	try {
		const settings = await Settings.init();
		const { env } = settings.getShellConfig();
		const baseEnv = filterEnv(env);
		const runtimes = interpreter
			? [resolveExplicitPythonRuntime(interpreter, cwd, baseEnv)]
			: enumeratePythonRuntimes(cwd, baseEnv);
		if (runtimes.length === 0) {
			return { ok: false, reason: "Python executable not found on PATH" };
		}
		// Probe each candidate in priority order and use the first that actually
		// runs. A managed env left behind by a removed `uv` install can exist on
		// disk yet fail to execute; falling through to the next candidate lets a
		// working system Python take over instead of failing the whole session.
		const failures: string[] = [];
		for (const runtime of runtimes) {
			try {
				const probe = await $`${runtime.pythonPath} -c "import sys;sys.exit(0)"`
					.quiet()
					.nothrow()
					.cwd(cwd)
					.env(runtime.env);
				if (probe.exitCode === 0) {
					return { ok: true, pythonPath: runtime.pythonPath, runtime };
				}
				failures.push(`${runtime.pythonPath} (exit code ${probe.exitCode})`);
			} catch (err) {
				failures.push(`${runtime.pythonPath} (${err instanceof Error ? err.message : String(err)})`);
			}
		}
		return {
			ok: false,
			pythonPath: runtimes[0].pythonPath,
			reason: `No working Python interpreter found. Tried: ${failures.join("; ")}`,
		};
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

type FrameType = "started" | "stdout" | "stderr" | "display" | "result" | "error" | "done";

interface Frame extends KernelErrorFrame {
	type: FrameType;
	id?: string;
	data?: string;
	bundle?: Record<string, unknown>;
	status?: "ok" | "error";
	executionCount?: number;
	cancelled?: boolean;
}

interface PendingExecution {
	resolve: (result: KernelExecuteResult) => void;
	options?: KernelExecuteOptions;
	status: "ok" | "error";
	executionCount?: number;
	error?: KernelExecutionError;
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
	kernelKilled: boolean;
	settled: boolean;
	escalationTimer?: NodeJS.Timeout;
}

export class PythonKernel {
	readonly id: string;
	#proc: Subprocess | null = null;
	#stdin: Bun.FileSink | null = null;
	#alive = true;
	#disposed = false;
	#shutdownConfirmed = false;
	#exitedPromise: Promise<number> | null = null;
	#pending = new Map<string, PendingExecution>();
	#readBuffer = "";

	private constructor(id: string) {
		this.id = id;
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const availability = await logger.time(
			"PythonKernel.start:availabilityCheck",
			checkPythonKernelAvailability,
			options.cwd,
			options.interpreter,
		);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		// Reuse the interpreter the availability probe selected so the spawned
		// kernel matches what we verified actually runs. The fallback computes a
		// runtime only for the skip-check fast path (test runtime /
		// PI_PYTHON_SKIP_CHECK), where no candidate was probed.
		let runtime = availability.runtime;
		if (!runtime) {
			const { env: shellEnv } = (await Settings.init()).getShellConfig();
			runtime = options.interpreter
				? resolveExplicitPythonRuntime(options.interpreter, options.cwd, filterEnv(shellEnv))
				: resolvePythonRuntime(options.cwd, filterEnv(shellEnv));
		}
		const spawnEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(runtime.env)) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (typeof value === "string") spawnEnv[key] = value;
		}
		// Unbuffered IO is critical for streaming.
		spawnEnv.PYTHONUNBUFFERED = "1";
		spawnEnv.PYTHONIOENCODING = "utf-8";

		const scriptPath = await ensureRunnerScript();
		const kernel = new PythonKernel(Snowflake.next());

		const proc = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
			cwd: options.cwd,
			env: spawnEnv,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Detached from any inherited console only when the host itself
			// has no console — kernel32!GetConsoleWindow() is authoritative
			// (works even when every stdio stream is redirected), with a
			// TTY-OR fallback when the FFI probe is unavailable. See #1960
			// for the numpy/pandas LoadLibraryExW hang + SIGINT-recovery
			// failure that motivates the predicate.
			windowsHide: shouldHideKernelWindow({
				platform: process.platform,
				hostHasInheritableConsole: hostHasInheritableConsole(),
			}),
		});
		kernel.#proc = proc;
		kernel.#stdin = proc.stdin;
		kernel.#exitedPromise = proc.exited;
		void kernel.#exitedPromise.then(code => {
			kernel.#alive = false;
			kernel.#abortPendingExecutions(`Python kernel exited with code ${code}`, { kernelKilled: true });
		});

		kernel.#startReader(proc.stdout as ReadableStream<Uint8Array>);
		kernel.#startStderrDrain(proc.stderr as ReadableStream<Uint8Array>);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			const initScript = buildInitScript(options.cwd, options.env);
			await kernel.#executeWithBudget(initScript, startup.signal, startupBudget, "Python kernel init");
			await kernel.#executeWithBudget(PYTHON_PRELUDE, startup.signal, startupBudget, "Python kernel prelude");
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		if (!this.isAlive()) {
			throw new Error("Python kernel is not running");
		}

		const msgId = options?.id ?? Snowflake.next();
		const { promise, resolve } = Promise.withResolvers<KernelExecuteResult>();
		const pending: PendingExecution = {
			resolve,
			options,
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
			settled: false,
			kernelKilled: false,
		};
		this.#pending.set(msgId, pending);

		const finalize = () => {
			if (pending.settled) return;
			pending.settled = true;
			this.#pending.delete(msgId);
			cleanup();
			resolve({
				status: pending.status,
				executionCount: pending.executionCount,
				error: pending.error,
				cancelled: pending.cancelled,
				timedOut: pending.timedOut,
				stdinRequested: pending.stdinRequested,
				kernelKilled: pending.kernelKilled,
			});
		};

		const requestCancel = () => {
			if (pending.settled || pending.escalationTimer) return;
			void this.interrupt();
			const escalation = setTimeout(() => {
				if (pending.settled) return;
				logger.warn("Python runner did not respond to SIGINT; terminating subprocess", {
					kernelId: this.id,
				});
				// SIGINT was ignored; mark the cell as kernel-killed so callers can
				// surface the harsher recovery message. `shutdown()` aborts pending
				// executions immediately and escalates to SIGTERM/SIGKILL, so the
				// host queue unblocks even if the runner is stuck in a
				// non-interruptible state.
				pending.kernelKilled = true;
				void this.shutdown();
			}, INTERRUPT_ESCALATION_MS);
			escalation.unref?.();
			pending.escalationTimer = escalation;
		};

		const onAbort = () => {
			pending.cancelled = true;
			pending.timedOut = pending.timedOut || isTimeoutReason(options?.signal?.reason);
			requestCancel();
		};
		const timeoutId =
			typeof options?.timeoutMs === "number" && options.timeoutMs > 0
				? setTimeout(() => {
						pending.timedOut = true;
						pending.cancelled = true;
						requestCancel();
					}, options.timeoutMs)
				: undefined;

		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			if (pending.escalationTimer) clearTimeout(pending.escalationTimer);
			pending.escalationTimer = undefined;
			options?.signal?.removeEventListener("abort", onAbort);
		};

		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		// Stash finalize on the pending entry so the reader can call it on `done`.
		(pending as PendingExecution & { finalize: () => void }).finalize = finalize;

		const payload = JSON.stringify({
			id: msgId,
			code,
			cwd: options?.cwd,
			env: options?.env,
			silent: options?.silent ?? false,
			storeHistory: options?.storeHistory ?? !(options?.silent ?? false),
		});

		try {
			await this.#writeLine(payload);
		} catch (err) {
			pending.cancelled = true;
			pending.error = {
				name: "TransportError",
				value: err instanceof Error ? err.message : String(err),
				traceback: [],
			};
			finalize();
		}

		return promise;
	}

	async interrupt(): Promise<void> {
		if (!this.#proc || this.#disposed) return;
		try {
			this.#proc.kill("SIGINT");
		} catch (err) {
			logger.warn("Failed to interrupt python runner", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async shutdown(options?: KernelShutdownOptions): Promise<KernelShutdownResult> {
		if (this.#shutdownConfirmed) return { confirmed: true };

		this.#alive = false;
		this.#abortPendingExecutions("Python kernel shutdown", { kernelKilled: true });

		const timeoutMs = options?.timeoutMs ?? SHUTDOWN_GRACE_MS;
		const proc = this.#proc;
		if (!proc) {
			this.#shutdownConfirmed = true;
			this.#disposed = true;
			return { confirmed: true };
		}

		try {
			await this.#writeLine(JSON.stringify({ type: "exit" })).catch(() => {});
		} catch {
			/* writer may already be closed */
		}

		try {
			this.#stdin?.end();
		} catch {
			/* ignore */
		}

		const exited = this.#waitForExitWithTimeout(timeoutMs);
		let result = await exited;
		if (!result) {
			try {
				proc.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}
		if (!result) {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			result = await this.#waitForExitWithTimeout(timeoutMs);
		}

		const confirmed = !!result;
		this.#shutdownConfirmed = confirmed;
		this.#disposed = true;
		return { confirmed };
	}

	#abortPendingExecutions(reason: string, options?: { kernelKilled?: boolean }): void {
		if (this.#pending.size === 0) return;
		const pending = Array.from(this.#pending.values());
		this.#pending.clear();
		const kernelKilledDefault = options?.kernelKilled ?? false;
		for (const entry of pending) {
			if (entry.settled) continue;
			entry.settled = true;
			void entry.options?.onChunk?.(`[kernel] ${reason}\n`);
			entry.resolve({
				status: "error",
				cancelled: true,
				timedOut: entry.timedOut,
				stdinRequested: entry.stdinRequested,
				executionCount: entry.executionCount,
				error: entry.error,
				kernelKilled: entry.kernelKilled || kernelKilledDefault,
			});
		}
	}

	async #writeLine(line: string): Promise<void> {
		if (!this.#stdin) {
			throw new Error("Python kernel stdin is not open");
		}
		if (TRACE_IPC) {
			logger.debug("PythonKernel send", { preview: line.slice(0, 120) });
		}
		this.#stdin.write(`${line}\n`);
		this.#stdin.flush();
	}

	#startReader(stream: ReadableStream<Uint8Array>): void {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					this.#readBuffer += decoder.decode(value, { stream: true });
					await this.#flushFrames();
				}
				this.#readBuffer += decoder.decode();
				await this.#flushFrames();
			} catch (err) {
				logger.warn("Python kernel reader failed", { error: err instanceof Error ? err.message : String(err) });
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		};
		void loop();
	}

	#startStderrDrain(stream: ReadableStream<Uint8Array>): void {
		// Wrapper writes its own crashes to stderr; surface them via logger so the
		// host operator can debug runtime issues without polluting tool output.
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const loop = async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const text = decoder.decode(value);
					if (text.trim()) {
						logger.warn("Python runner stderr", { text });
					}
				}
			} catch {
				/* ignore */
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		};
		void loop();
	}

	async #flushFrames(): Promise<void> {
		while (true) {
			const nl = this.#readBuffer.indexOf("\n");
			if (nl < 0) return;
			const line = this.#readBuffer.slice(0, nl);
			this.#readBuffer = this.#readBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: Frame;
			try {
				frame = JSON.parse(line) as Frame;
			} catch (err) {
				logger.warn("Python runner emitted invalid JSON", {
					line: line.slice(0, 200),
					error: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			if (TRACE_IPC) {
				logger.debug("PythonKernel recv", { type: frame.type, id: frame.id });
			}
			await this.#handleFrame(frame);
		}
	}

	async #handleFrame(frame: Frame): Promise<void> {
		const rid = frame.id;
		if (!rid) return;
		const pending = this.#pending.get(rid) as (PendingExecution & { finalize?: () => void }) | undefined;
		if (!pending) return;

		switch (frame.type) {
			case "started":
				return;
			case "stdout":
			case "stderr": {
				const text = frame.data ?? "";
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				return;
			}
			case "display":
			case "result": {
				const bundle = frame.bundle ?? {};
				const { text, outputs } = await renderKernelDisplay(bundle);
				if (text && pending.options?.onChunk) {
					await pending.options.onChunk(text);
				}
				if (outputs.length > 0 && pending.options?.onDisplay) {
					for (const output of outputs) {
						await pending.options.onDisplay(output);
					}
				}
				return;
			}
			case "error": {
				pending.status = "error";
				pending.error = mapKernelErrorFrame(frame);
				const traceback = pending.error.traceback;
				const message =
					traceback.length > 0
						? `${traceback.join("\n")}\n`
						: `${pending.error.name}: ${pending.error.value}\n`;
				if (pending.options?.onChunk) {
					await pending.options.onChunk(message);
				}
				return;
			}
			case "done": {
				if (typeof frame.executionCount === "number") {
					pending.executionCount = frame.executionCount;
				}
				if (frame.status === "error" && pending.status === "ok") {
					pending.status = "error";
				}
				if (frame.cancelled) {
					pending.cancelled = true;
				}
				pending.finalize?.();
				return;
			}
		}
	}

	async #executeWithBudget(
		code: string,
		signal: AbortSignal | undefined,
		timeoutMs: number,
		label: string,
	): Promise<void> {
		const controller = new AbortController();
		const cleanups: Array<() => void> = [];
		if (signal) {
			if (signal.aborted) {
				controller.abort(signal.reason);
			} else {
				const onAbort = () => controller.abort(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				cleanups.push(() => signal.removeEventListener("abort", onAbort));
			}
		}
		const timer =
			timeoutMs > 0
				? setTimeout(() => controller.abort(createAbortError("TimeoutError", `${label} timed out`)), timeoutMs)
				: undefined;
		if (timer) cleanups.push(() => clearTimeout(timer));
		try {
			throwIfAborted(controller.signal, label);
			const result = await this.execute(code, {
				signal: controller.signal,
				silent: true,
				storeHistory: false,
			});
			if (result.cancelled) {
				throw createAbortError(result.timedOut ? "TimeoutError" : "AbortError", `${label} cancelled`);
			}
			if (result.status === "error") {
				const reason = result.error?.value ?? "Python kernel init failed";
				throw new Error(`${label} failed: ${reason}`);
			}
		} finally {
			for (const cleanup of cleanups) cleanup();
		}
	}

	#waitForExitWithTimeout(timeoutMs: number): Promise<number | null> {
		if (!this.#exitedPromise) return Promise.resolve(0);
		const exitedPromise = this.#exitedPromise;
		const timeout = new Promise<null>(resolve => {
			const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
			timer.unref?.();
		});
		return Promise.race([exitedPromise.then(code => code as number | null), timeout]);
	}
}

function isTimeoutReason(reason: unknown): boolean {
	if (reason instanceof DOMException) return reason.name === "TimeoutError";
	if (reason instanceof Error) return reason.name === "TimeoutError";
	return false;
}

function buildInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
	const envPayload = Object.fromEntries(envEntries);
	return [
		"import os, sys",
		`__omp_cwd = ${JSON.stringify(cwd)}`,
		"os.chdir(__omp_cwd)",
		`__omp_env = ${JSON.stringify(envPayload)}`,
		"for __omp_key, __omp_val in __omp_env.items():\n    os.environ[__omp_key] = __omp_val",
		"if __omp_cwd not in sys.path:\n    sys.path.insert(0, __omp_cwd)",
	].join("\n");
}
