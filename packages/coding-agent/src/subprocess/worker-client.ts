import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary, logger, workerHostEntry } from "@pk-nerdsaver-ai/pi-utils";
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
	proc: Subprocess<"ignore", "ignore", "ignore">;
	inbound: Set<(message: Outbound) => void>;
	errors: Set<(error: Error) => void>;
	/**
	 * Flipped to `true` right before the deliberate SIGKILL so `onExit` can
	 * distinguish the expected hard-kill from a crash (SIGSEGV from a native
	 * fault, OOM SIGKILL, operator `kill -9`). Only the latter surfaces as a
	 * worker error so callers don't await forever.
	 */
	intentionalExit: { value: boolean };
}

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
 * declared worker-host entry with a cwd-relative script path (Bun's subprocess
 * IPC is more reliable that way under `bun test`), falling back to this
 * package's own `src/cli.ts` when no host entry is declared (bun test, SDK
 * embedding).
 */
export function resolveWorkerSpawnCmd(workerArg: string): WorkerSpawnCommand {
	if (isCompiledBinary()) return { cmd: [process.execPath, workerArg] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [process.execPath, path.basename(hostEntry), workerArg], cwd: path.dirname(hostEntry) };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [process.execPath, "src/cli.ts", workerArg], cwd: packageRoot };
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
 * Spawn an inference worker subprocess and wire its IPC fan-out. The child
 * inherits no stdio (native model runtimes may otherwise print progress or
 * decoded text and corrupt the chat scrollback) and is `unref`'d outside `bun
 * test` so an idle worker never blocks process exit. `exitLabel` prefixes the
 * worker-error message surfaced for an unexpected (non-intentional) exit.
 */
export function createWorkerSubprocess<Outbound>(options: {
	spawnCommand: WorkerSpawnCommand;
	env: Record<string, string>;
	exitLabel: string;
}): SpawnedSubprocess<Outbound> {
	const inbound = new Set<(message: Outbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const proc = Bun.spawn({
		cmd: options.spawnCommand.cmd,
		cwd: options.spawnCommand.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			for (const handler of inbound) handler(message as Outbound);
		},
		onExit(_proc, exitCode, signalCode) {
			if (exitCode === 0) return;
			// Swallow only the expected SIGKILL from `terminate()`; every other
			// signal exit (SIGSEGV from a native fault, OOM SIGKILL, operator
			// `kill -9`) is a real worker death that must fault in-flight
			// requests so callers don't await forever.
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			const err = new Error(`${options.exitLabel} exited with ${reason}`);
			for (const handler of errors) handler(err);
		},
	});
	// Don't keep the parent event loop alive on an idle worker; the dispose
	// path calls `terminate()` explicitly. Bun's test runner starves IPC for
	// unref'd subprocesses, so keep it referenced only under tests.
	if (!isBunTestRuntime()) proc.unref();
	return { proc, inbound, errors, intentionalExit };
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
