import { setLoopPhaseMirror } from "@oh-my-pi/pi-utils/loop-phase";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	createSentinelViews,
	LOOP_SENTINEL_WORKER_ARG,
	type LoopSentinelInit,
	type LoopSentinelPing,
	type LoopSentinelPong,
	SENTINEL_SAB_BYTES,
	writeHeartbeat,
	writePhase,
} from "./loop-sentinel-protocol";

/**
 * Main-thread client for the off-thread loop sentinel (issue #5372). Owns the
 * SharedArrayBuffer, spawns the worker, mirrors live loop-phase transitions
 * into the SAB via {@link setLoopPhaseMirror}, and exposes `beat()` for the
 * watchdog to stamp each tick. Everything here is best-effort: a spawn failure
 * degrades to the existing on-loop watchdog instead of breaking the TUI.
 */

export interface LoopSentinelHandle {
	/** Stamp the shared heartbeat; called by the watchdog every armed tick. */
	beat(): void;
	stop(): void;
}

const DEFAULT_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_THRESHOLD_MS = 10_000;

function parsePositiveMsEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function spawnSentinelWorker(): Worker {
	const hostEntry = workerHostEntry();
	return hostEntry
		? new Worker(hostEntry, { type: "module", argv: [LOOP_SENTINEL_WORKER_ARG] })
		: new Worker(new URL("./loop-sentinel-worker.ts", import.meta.url).href, { type: "module" });
}

/**
 * Start the sentinel. Returns `undefined` when disabled (`OMP_LOOP_SENTINEL=0`),
 * under `bun test` (which sets `NODE_ENV=test`; force on with
 * `OMP_LOOP_SENTINEL=1`), or when the worker cannot be spawned. Tunables:
 * `OMP_LOOP_SENTINEL_THRESHOLD_MS` moves the first-report threshold (default
 * 10s); `OMP_LOOP_WEDGE_KILL_AFTER_MS` opts in to a hard SIGKILL once a
 * CPU-bound wedge exceeds that ceiling (default off) — the escape hatch for
 * the "SIGTERM does nothing, kill -9 required" failure mode.
 */
export function startLoopSentinel(): LoopSentinelHandle | undefined {
	if (process.env.OMP_LOOP_SENTINEL === "0") return undefined;
	if (process.env.NODE_ENV === "test" && process.env.OMP_LOOP_SENTINEL !== "1") return undefined;
	try {
		const buffer = new SharedArrayBuffer(SENTINEL_SAB_BYTES);
		const views = createSentinelViews(buffer);
		writeHeartbeat(views, Date.now());
		const worker = spawnSentinelWorker();
		// Best-effort probe: a sentinel that dies must never take the TUI with it.
		worker.addEventListener("error", () => {});
		(worker as { unref?: () => void }).unref?.();
		const init: LoopSentinelInit = {
			type: "init",
			buffer,
			checkIntervalMs: DEFAULT_CHECK_INTERVAL_MS,
			thresholdMs: parsePositiveMsEnv("OMP_LOOP_SENTINEL_THRESHOLD_MS") ?? DEFAULT_THRESHOLD_MS,
			killAfterMs: parsePositiveMsEnv("OMP_LOOP_WEDGE_KILL_AFTER_MS") ?? 0,
		};
		worker.postMessage(init);
		setLoopPhaseMirror((label: string | undefined) => writePhase(views, label, Date.now()));
		return {
			beat(): void {
				writeHeartbeat(views, Date.now());
			},
			stop(): void {
				setLoopPhaseMirror(undefined);
				worker.terminate();
			},
		};
	} catch {
		return undefined;
	}
}

/** Distribution smoke for source, npm-bundle, and compiled worker routing. */
export async function smokeTestLoopSentinelWorker(): Promise<void> {
	const worker = spawnSentinelWorker();
	const pending = Promise.withResolvers<void>();
	const onMessage = (event: MessageEvent<LoopSentinelPong>): void => {
		if (event.data.ok === true) pending.resolve();
		else pending.reject(new Error("loop sentinel worker smoke mismatch"));
	};
	const onError = (event: ErrorEvent): void => {
		pending.reject(event.error instanceof Error ? event.error : new Error(event.message));
	};
	const onClose = (): void => {
		pending.reject(new Error("Loop sentinel worker exited before responding"));
	};
	worker.addEventListener("message", onMessage);
	worker.addEventListener("error", onError);
	worker.addEventListener("close", onClose);
	try {
		const ping: LoopSentinelPing = { type: "ping" };
		worker.postMessage(ping);
		await pending.promise;
	} finally {
		worker.removeEventListener("message", onMessage);
		worker.removeEventListener("error", onError);
		worker.removeEventListener("close", onClose);
		worker.terminate();
	}
}
