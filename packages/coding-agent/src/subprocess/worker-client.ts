import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	$env,
	isBunTestRuntime,
	isCompiledBinary,
	logger,
	postmortem,
	stripWindowsExtendedLengthPathPrefix,
	workerHostEntry,
} from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

/**
 * Shared lifecycle scaffolding for the ONNX inference subprocess clients
 * (mnemopi embeddings, speech-to-text, tiny-model titles/completions, TTS).
 * Each runs `onnxruntime-node` inside a dedicated Bun child process so the NAPI
 * constructor/finalizer never executes in the main agent address space — those
 * destructors segfault Bun on shutdown (issues #1606 / #1607 / #3031).
 *
 * Only the genuinely identical pieces live here: the worker-handle shape, the
 * spawn-command resolution, the parent-env snapshot, the `Bun.spawn` wiring,
 * the inline "worker unavailable" stub, and the ping/pong smoke probe. Each
 * client keeps its own divergent request/response correlation, streaming, and
 * teardown semantics.
 */

/** Minimal inbound contract shared by every worker: a correlated `ping`. */
export type WorkerInboundBase = { type: "ping"; id: string };

/** Structured log line forwarded from a worker to the parent logger. */
export type WorkerLogMessage = {
	type: "log";
	level: "debug" | "warn" | "error";
	msg: string;
	meta?: Record<string, unknown>;
};

/** Minimal outbound contract shared by every worker: `pong`, `error`, `log`. */
export type WorkerOutboundBase =
	| { type: "pong"; id: string }
	| { type: "error"; id: string; error: string }
	| WorkerLogMessage;

/**
 * Parent-side view of a worker subprocess: send typed inbound messages,
 * subscribe to outbound messages and worker errors, and hard-terminate.
 */
export interface WorkerHandle<Inbound, Outbound> {
	send(message: Inbound): void;
	onMessage(handler: (message: Outbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

/**
 * A {@link WorkerHandle} that can also be (un)referenced so a pending request
 * keeps the parent event loop alive while an idle worker never blocks exit.
 */
export interface RefCountedWorkerHandle<Inbound, Outbound> extends WorkerHandle<Inbound, Outbound> {
	/** Re-reference the subprocess so a pending request keeps the parent event loop alive. */
	ref(): void;
	/** Drop the reference once the worker is idle so it never blocks process exit. */
	unref(): void;
}

/** The raw spawned subprocess plus the parent-side fan-out sets. */
export interface SpawnedSubprocess<Outbound> {
	proc: Subprocess<"ignore", "ignore", number | "ignore">;
	inbound: Set<(message: Outbound) => void>;
	errors: Set<(error: Error) => void>;
	/**
	 * Flipped to `true` right before the deliberate SIGKILL so `onExit` can
	 * distinguish the expected hard-kill from a crash (SIGSEGV from a native
	 * fault, OOM SIGKILL, operator `kill -9`). Only the latter surfaces as a
	 * worker error so callers don't await forever.
	 */
	intentionalExit: { value: boolean };
	/**
	 * Resolves when the file-backed stderr capture has drained after worker
	 * exit. `onExit` waits on this before surfacing the crash so the exit-error
	 * carries the *whole* tail, not whatever happened to be flushed before the
	 * exit event fired. Tests can await it deterministically instead of racing
	 * wall-clock timers.
	 */
	stderrDrained: Promise<void>;
}

/**
 * Bound on the tail of worker stderr surfaced with a crash. Sized to comfortably
 * hold a full ONNX Runtime/glibc traceback (a few KiB) without letting a chatty
 * native runtime OOM the parent on repeated warnings.
 */
const STDERR_TAIL_LIMIT_BYTES = 16 * 1024;

export interface WorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

/**
 * Cold-starting a worker from a compiled binary (decompress + module graph
 * load) is slow on contended CI runners; the probe only proves the worker
 * spawns and ponges, so a generous bound removes flakes without weakening it.
 */
export const SMOKE_TEST_TIMEOUT_MS = 30_000;

/**
 * Resolve the command used to relaunch the agent CLI into worker mode. In a
 * compiled binary the entry point is the binary itself; otherwise re-enter the
 * declared worker-host entry by absolute path. Workers deliberately spawn
 * without a pinned cwd there: they share the parent's foreground process
 * group, and terminal cwd heuristics (kitty's new_tab_with_cwd) read the
 * newest process in that group, so anchoring them to the install dir leaks
 * into newly opened terminal tabs. With no declared host entry (bun test, SDK
 * embedding) fall back to a cwd-relative `src/cli.ts`, which Bun subprocess
 * IPC handles more reliably under `bun test`.
 */
export function resolveWorkerSpawnCmd(workerArg: string): WorkerSpawnCommand {
	const executable = stripWindowsExtendedLengthPathPrefix(process.execPath);
	if (isCompiledBinary()) return { cmd: [executable, workerArg] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [executable, hostEntry, workerArg] };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [executable, "src/cli.ts", workerArg], cwd: packageRoot };
}

/**
 * Snapshot the parent environment for the child. `process.env` carries
 * `undefined` slots that `Bun.spawn` rejects, so filter them out; an optional
 * `overlay` (e.g. the tiny-model device/dtype vars) wins over inherited keys.
 */
export function workerEnvFromParent(overlay?: Record<string, string>): Record<string, string> {
	const base = $env as Record<string, string | undefined>;
	const merged: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") merged[key] = value;
	}
	if (overlay) {
		for (const key in overlay) merged[key] = overlay[key];
	}
	return merged;
}

/**
 * `LD_LIBRARY_PATH` overlay that lets a dlopen'd native addon find its C++
 * runtime. The ONNX addons installed on demand under `~/.omp/agent/cache/**`
 * are `process.dlopen`'d and need `libstdc++.so.6` / `libgcc_s.so.1`; because
 * each addon carries its own `DT_RUNPATH`, an RPATH on our executable cannot
 * satisfy them, so the path has to come from the environment. On distros where
 * those libraries are outside the loader's default search path (NixOS) the
 * packaged build exports `OMP_NATIVE_LIBRARY_PATH` (see `nix/package.nix`).
 * Appended last so an inherited `LD_LIBRARY_PATH` keeps precedence.
 * Pure for testability; see {@link inferenceWorkerEnv} for the spawn-time glue.
 */
export function nativeLibraryPathOverlay(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): Record<string, string> {
	if (platform !== "linux") return {};
	const native = env.OMP_NATIVE_LIBRARY_PATH;
	if (typeof native !== "string" || native.length === 0) return {};
	const inherited = env.LD_LIBRARY_PATH;
	return { LD_LIBRARY_PATH: inherited ? `${inherited}:${native}` : native };
}

/**
 * Env for an ONNX inference worker: the parent env plus the native library
 * path. Only these workers get it — the daemon broker spawns user PTY sessions
 * and eval kernels through {@link workerEnvFromParent}, and rewriting the
 * loader search path of arbitrary user commands risks a `GLIBCXX` mismatch.
 */
export function inferenceWorkerEnv(overlay?: Record<string, string>): Record<string, string> {
	return workerEnvFromParent({ ...nativeLibraryPathOverlay($env, process.platform), ...overlay });
}

/**
 * Spawn an inference worker subprocess and wire its IPC fan-out. Stdio is
 * captured (stderr redirected to a temp file, stdout ignored) so native
 * runtimes can't corrupt the chat scrollback while the crash reason still
 * reaches the parent. The file-backed capture deliberately avoids Bun
 * `ReadableStream` pipes: even an unref'd child with a piped stderr stream can
 * keep the parent event loop alive. After the worker exits, the last
 * {@link STDERR_TAIL_LIMIT_BYTES} are appended to the `onExit` error so
 * `tts/mnemopi/…: worker error` lines carry the actual stack instead of a bare
 * exit code (issue #4324). The child is `unref`'d outside `bun test` so an idle
 * worker never blocks process exit. `exitLabel` prefixes the worker-error
 * message surfaced for an unexpected (non-intentional) exit.
 */
export function createWorkerSubprocess<Outbound>(options: {
	spawnCommand: WorkerSpawnCommand;
	env: Record<string, string>;
	exitLabel: string;
	/** Start the child as a new process-group/session leader where Bun supports it. */
	detached?: boolean;
	/** Treat exit code 0 as unexpected; eval cells can call process.exit(0). */
	reportCleanExit?: boolean;
	/** Whether an idle worker should stop keeping the parent event loop alive. */
	unref?: boolean;
}): SpawnedSubprocess<Outbound> {
	const inbound = new Set<(message: Outbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const stderrTail = new StderrTail(STDERR_TAIL_LIMIT_BYTES);
	const stderrDrained = Promise.withResolvers<void>();
	const stderrCapture = createStderrCapture(options.exitLabel);
	let stderrDrainStarted = false;
	// Reassigned once the worker IPC fault handler is registered (after spawn);
	// invoked from onExit to drop the registration.
	let unregisterFault: () => void = () => {};
	const startStderrDrain = (): void => {
		if (stderrDrainStarted) return;
		stderrDrainStarted = true;
		void drainStderrCapture(stderrCapture, options.exitLabel, stderrTail).finally(() => stderrDrained.resolve());
	};
	const proc = Bun.spawn({
		cmd: options.spawnCommand.cmd,
		cwd: options.spawnCommand.cwd,
		detached: options.detached,
		env: options.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: stderrCapture.target,
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			for (const handler of inbound) handler(message as Outbound);
		},
		onExit(_proc, exitCode, signalCode) {
			unregisterFault();
			startStderrDrain();
			if (exitCode === 0 && !options.reportCleanExit) return;
			// Swallow only the expected SIGKILL from `terminate()`; every other
			// signal exit (SIGSEGV from a native fault, OOM SIGKILL, operator
			// `kill -9`) is a real worker death that must fault in-flight
			// requests so callers don't await forever.
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			// The stderr target is drained only after exit so idle unref'd
			// workers do not keep the parent alive; wait for that drain before
			// surfacing the error so the tail is complete.
			void stderrDrained.promise.finally(() => {
				const suffix = stderrTail.suffix();
				const err = new Error(`${options.exitLabel} exited with ${reason}${suffix}`);
				for (const handler of errors) handler(err);
			});
		},
	});
	// Bun raises a malformed advanced-serialization frame as a process-global
	// uncaughtException with no channel attribution (oven-sh/bun#37287). Register
	// a fault handler so that failure rejects this worker's in-flight requests and
	// recycles it — a worker that sent a bad frame but stays alive never fires
	// onExit, so callers would otherwise await forever. Unregistered in onExit.
	let faulted = false;
	unregisterFault = postmortem.registerWorkerIpcFaultHandler(cause => {
		if (faulted) return;
		faulted = true;
		const err = new Error(`${options.exitLabel}: worker sent a malformed IPC frame; recycling worker`, { cause });
		for (const handler of errors) handler(err);
		// Recycle the (possibly still-alive) worker; mark the exit intentional so
		// the SIGKILL's onExit does not surface a duplicate error.
		intentionalExit.value = true;
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	});
	// Don't keep the parent event loop alive on an idle worker; the dispose
	// path calls `terminate()` explicitly. Bun's test runner starves IPC for
	// unref'd subprocesses, so keep it referenced only under tests.
	if (!isBunTestRuntime() && options.unref !== false) proc.unref();
	return { proc, inbound, errors, intentionalExit, stderrDrained: stderrDrained.promise };
}

/**
 * Bounded buffer of the *tail* of a stderr stream. Appended chunks are
 * concatenated and truncated from the front once they exceed `limit`, so the
 * final `suffix()` always reflects the most recent output — where native
 * crash tracebacks land.
 */
class StderrTail {
	#chunks: Uint8Array[] = [];
	#bytes = 0;
	constructor(readonly limit: number) {}

	append(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.#chunks.push(chunk);
		this.#bytes += chunk.length;
		while (this.#bytes > this.limit && this.#chunks.length > 1) {
			const head = this.#chunks.shift();
			if (head) this.#bytes -= head.length;
		}
		if (this.#bytes > this.limit && this.#chunks.length === 1) {
			const only = this.#chunks[0];
			const start = only.length - this.limit;
			this.#chunks[0] = only.subarray(start);
			this.#bytes = this.limit;
		}
	}

	/** Human-readable trailer for an exit error, or `""` when nothing was captured. */
	suffix(): string {
		if (this.#bytes === 0) return "";
		const merged = new Uint8Array(this.#bytes);
		let offset = 0;
		for (const chunk of this.#chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		const text = new TextDecoder().decode(merged).replace(/\s+$/u, "");
		if (text.length === 0) return "";
		return `: ${text}`;
	}
}

interface StderrCapture {
	target: number | "ignore";
	fd: number | null;
	dir: string | null;
	cleanupOnExit: (() => void) | null;
}

/** Create a file-backed stderr target that does not pin Bun's event loop. */
function createStderrCapture(exitLabel: string): StderrCapture {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-worker-stderr-"));
		const fd = fs.openSync(path.join(dir, "stderr.log"), "w+");
		const cleanupOnExit = (): void => cleanupStderrCapture({ target: fd, fd, dir, cleanupOnExit: null });
		process.once("exit", cleanupOnExit);
		return { target: fd, fd, dir, cleanupOnExit };
	} catch (error) {
		logger.debug(`${exitLabel} stderr capture unavailable`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return { target: "ignore", fd: null, dir: null, cleanupOnExit: null };
	}
}

function cleanupStderrCapture(capture: StderrCapture): void {
	if (capture.cleanupOnExit) process.off("exit", capture.cleanupOnExit);
	if (capture.fd !== null) {
		try {
			fs.closeSync(capture.fd);
		} catch {
			// Already closed.
		}
		capture.fd = null;
	}
	if (capture.dir) {
		try {
			fs.rmSync(capture.dir, { recursive: true, force: true });
		} catch {
			// Best-effort temp cleanup.
		}
		capture.dir = null;
	}
}

/**
 * Drain a worker's file-backed stderr target after it exits: forward each
 * decoded tail line to `logger.debug`, and record the bytes in `tail` so the
 * eventual exit error can carry the most recent output. Never rejects — cleanup
 * failures must not fault the parent.
 */
async function drainStderrCapture(capture: StderrCapture, exitLabel: string, tail: StderrTail): Promise<void> {
	try {
		if (capture.fd === null) return;
		const size = fs.fstatSync(capture.fd).size;
		if (size <= 0) return;
		const length = Math.min(size, tail.limit);
		const buffer = new Uint8Array(length);
		fs.readSync(capture.fd, buffer, 0, length, size - length);
		tail.append(buffer);
		for (const rawLine of new TextDecoder().decode(buffer).split("\n")) {
			const line = rawLine.replace(/\r$/u, "");
			if (line.length > 0) logger.debug(`${exitLabel} stderr`, { line });
		}
	} catch {
		// The worker may have exited while the parent is already tearing down,
		// or the temp file may have been removed by process-exit cleanup.
	} finally {
		cleanupStderrCapture(capture);
	}
}

/**
 * Wrap a {@link SpawnedSubprocess} as a {@link WorkerHandle}. The `send`
 * strategy is injected so each client keeps its exact IPC-send behaviour (e.g.
 * `safeSend` vs an inline guarded `proc.send`). `terminate()` SIGKILLs: the
 * point of subprocess isolation is that the parent never runs
 * `onnxruntime-node`'s NAPI finalizer (it crashes Bun on Windows), so the OS
 * reclaims the model memory instead. The intentional-exit flag is flipped
 * *before* the kill so `onExit` can tell it apart from a native crash.
 */
export function createWorkerHandle<Inbound, Outbound>(
	spawned: SpawnedSubprocess<Outbound>,
	send: (message: Inbound) => void,
): WorkerHandle<Inbound, Outbound> {
	const { proc, inbound, errors, intentionalExit } = spawned;
	return {
		send,
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
	};
}

/**
 * A stand-in handle used when the worker subprocess cannot be spawned. It
 * ponges `ping` (so the smoke probe and readiness checks still resolve) and
 * answers every other request with the spawn error so callers fail fast
 * instead of awaiting forever.
 */
export function createUnavailableWorker<
	Inbound extends { type: string; id: string },
	Outbound extends { type: string },
>(error: unknown): WorkerHandle<Inbound, Outbound> {
	const listeners = new Set<(message: Outbound) => void>();
	const errorMessage = error instanceof Error ? error.message : String(error);
	const emit = (message: WorkerOutboundBase): void => {
		// The stub only ever emits pong/error — members of every concrete worker
		// Outbound union — but the generic cannot prove it, hence the assertion.
		for (const listener of listeners) listener(message as unknown as Outbound);
	};
	return {
		send(message) {
			queueMicrotask(() => {
				if (message.type === "ping") {
					emit({ type: "pong", id: message.id });
					return;
				}
				emit({ type: "error", id: message.id, error: errorMessage });
			});
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async terminate() {
			listeners.clear();
		},
	};
}

/**
 * Spawn a worker handle, falling back to {@link createUnavailableWorker} (after
 * a warning) when the subprocess cannot be created so the feature degrades
 * gracefully instead of throwing into callers.
 */
export function spawnWorkerOrUnavailable<Handle>(
	spawn: () => Handle,
	unavailable: (error: unknown) => Handle,
	warnMessage: string,
): Handle {
	try {
		return spawn();
	} catch (error) {
		logger.warn(warnMessage, { error: error instanceof Error ? error.message : String(error) });
		return unavailable(error);
	}
}

/** Forward a worker's structured `log` message to the matching logger level. */
export function logWorkerMessage(message: WorkerLogMessage): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

/**
 * Drive the ping/pong readiness probe wired into `omp --smoke-test`: send one
 * `ping`, resolve on the first `pong` (ignoring `log` chatter), and reject on
 * any other message, a worker error, or the timeout. Always tears the handle
 * down on the way out. `label` prefixes the failure messages.
 */
export async function smokeTestWorker<Inbound extends { type: string; id: string }, Outbound extends { type: string }>(
	handle: WorkerHandle<Inbound, Outbound>,
	label: string,
	timeoutMs: number,
): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`${label} did not pong within ${timeoutMs}ms`)), timeoutMs);
	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "pong") {
			resolve();
			return;
		}
		if (message.type === "log") return;
		reject(new Error(`${label}: expected pong, got ${JSON.stringify(message)}`));
	});
	const unsubscribeError = handle.onError(reject);
	try {
		handle.send({ type: "ping", id: "smoke" } as Inbound);
		await promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
		await handle.terminate();
	}
}
