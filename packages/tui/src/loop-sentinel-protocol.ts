/**
 * Shared protocol for the off-thread loop sentinel (issue #5372).
 *
 * The on-loop {@link ../loop-watchdog LoopWatchdog} can only log a block once
 * its delayed tick eventually fires — a *terminal* wedge (the event loop never
 * yields again) is therefore invisible: the process burns a core for hours with
 * no log line and ignores SIGTERM, because JS signal handlers cannot run while
 * the loop is blocked. The sentinel closes that gap from a worker thread with
 * its own event loop: the main thread heartbeats into a SharedArrayBuffer each
 * watchdog tick and mirrors the live loop phase into it; the worker detects a
 * stale heartbeat and reports the wedge in real time while it is still going.
 *
 * This module is deliberately side-effect-free (imported by the CLI worker
 * dispatch before profile bootstrap) and hosts the pure, fully testable pieces:
 * the SAB layout/codec and the judge state machine. The worker entry and the
 * client are thin shells around these.
 *
 * SAB layout (little-endian, 512 bytes):
 * - bytes 0..7   BigInt64 heartbeat, `Date.now()` ms (wall clock is the only
 *   time base the two threads reliably share; `performance.now()` origins can
 *   differ between a worker and its parent)
 * - bytes 8..15  BigInt64 timestamp of the last phase-mirror write, ms
 * - bytes 16..19 Int32 phase seqlock (even = stable, odd = write in progress)
 * - bytes 20..23 Int32 phase byte length
 * - bytes 24..279 UTF-8 phase label bytes
 */

/** Hidden argv selector the worker host dispatches on (see coding-agent cli.ts). */
export const LOOP_SENTINEL_WORKER_ARG = "__omp_worker_loop_sentinel";

export const SENTINEL_SAB_BYTES = 512;
const HEARTBEAT_I64_INDEX = 0;
const PHASE_AT_I64_INDEX = 1;
const PHASE_SEQ_I32_INDEX = 4;
const PHASE_LEN_I32_INDEX = 5;
const PHASE_BYTES_OFFSET = 24;
export const PHASE_BYTES_MAX = 256;

/**
 * Fraction of a stale interval that may be process CPU time while the gap is
 * still treated as system sleep rather than a wedge. Mirrors the watchdog's
 * `CPU_BUSY_RATIO`: suspend/resume and a CPU-bound wedge both produce an
 * arbitrarily large heartbeat gap, so only a gap the process spent negligible
 * CPU on is suppressed.
 */
export const SENTINEL_CPU_BUSY_RATIO = 0.01;

export interface SentinelViews {
	i64: BigInt64Array;
	i32: Int32Array;
	phaseBytes: Uint8Array;
}

export function createSentinelViews(buffer: SharedArrayBuffer): SentinelViews {
	return {
		i64: new BigInt64Array(buffer, 0, 2),
		i32: new Int32Array(buffer, 0, PHASE_BYTES_OFFSET / 4),
		phaseBytes: new Uint8Array(buffer, PHASE_BYTES_OFFSET, PHASE_BYTES_MAX),
	};
}

export function writeHeartbeat(views: SentinelViews, nowMs: number): void {
	Atomics.store(views.i64, HEARTBEAT_I64_INDEX, BigInt(Math.trunc(nowMs)));
}

export function readHeartbeat(views: SentinelViews): number {
	return Number(Atomics.load(views.i64, HEARTBEAT_I64_INDEX));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Publish the current loop-phase label. Single writer (the main thread); the
 * odd/even seqlock lets the worker read a consistent snapshot without ever
 * blocking the writer. An `undefined` label publishes an empty phase.
 */
export function writePhase(views: SentinelViews, label: string | undefined, atMs: number): void {
	const bytes = label === undefined ? undefined : textEncoder.encode(label);
	const length = bytes === undefined ? 0 : Math.min(bytes.length, PHASE_BYTES_MAX);
	const seq = Atomics.load(views.i32, PHASE_SEQ_I32_INDEX);
	Atomics.store(views.i32, PHASE_SEQ_I32_INDEX, seq + 1);
	if (bytes !== undefined && length > 0) views.phaseBytes.set(bytes.subarray(0, length));
	Atomics.store(views.i32, PHASE_LEN_I32_INDEX, length);
	Atomics.store(views.i64, PHASE_AT_I64_INDEX, BigInt(Math.trunc(atMs)));
	Atomics.store(views.i32, PHASE_SEQ_I32_INDEX, seq + 2);
}

/**
 * Read the mirrored phase, retrying past concurrent writes. Returns `undefined`
 * only when a torn read persists across every retry (writer mid-flight on each
 * attempt) — the caller then reports the wedge without attribution rather than
 * with a corrupt label. The `.slice()` copy is deliberate: `TextDecoder` cannot
 * decode SharedArrayBuffer-backed views.
 */
export function readPhase(views: SentinelViews): { phase: string | undefined; phaseAtMs: number } | undefined {
	for (let attempt = 0; attempt < 3; attempt++) {
		const seqBefore = Atomics.load(views.i32, PHASE_SEQ_I32_INDEX);
		if ((seqBefore & 1) !== 0) continue;
		const length = Math.min(Math.max(Atomics.load(views.i32, PHASE_LEN_I32_INDEX), 0), PHASE_BYTES_MAX);
		const phaseAtMs = Number(Atomics.load(views.i64, PHASE_AT_I64_INDEX));
		const bytes = views.phaseBytes.slice(0, length);
		const seqAfter = Atomics.load(views.i32, PHASE_SEQ_I32_INDEX);
		if (seqAfter !== seqBefore) continue;
		return { phase: length > 0 ? textDecoder.decode(bytes) : undefined, phaseAtMs };
	}
	return undefined;
}

/** Init message the client posts right after spawning the worker. */
export interface LoopSentinelInit {
	type: "init";
	buffer: SharedArrayBuffer;
	/** Worker-side polling interval, ms. */
	checkIntervalMs: number;
	/** Heartbeat staleness at which the first `ui.loop-wedged` line is emitted, ms. */
	thresholdMs: number;
	/** Staleness at which the worker SIGKILLs the wedged process; 0 disables. */
	killAfterMs: number;
}

/** Distribution-smoke ping; the worker answers with {@link LoopSentinelPong}. */
export interface LoopSentinelPing {
	type: "ping";
}

export interface LoopSentinelPong {
	ok: true;
}

export type LoopSentinelMessage = LoopSentinelInit | LoopSentinelPing;

export interface SentinelSample {
	nowMs: number;
	heartbeatMs: number;
	/** Cumulative process CPU time, ms (user + system; process-wide). */
	cpuMs: number;
	phase?: string;
	phaseAtMs?: number;
}

export type SentinelAction =
	| { kind: "report"; blockedMs: number; cpuMs: number; phase: string; phaseAgeMs?: number }
	| { kind: "recovered"; blockedMs: number }
	| { kind: "kill"; blockedMs: number; cpuMs: number; phase: string };

export interface SentinelJudge {
	observe(sample: SentinelSample): SentinelAction | undefined;
}

/**
 * Pure decision engine for the sentinel worker: turns heartbeat samples into
 * at most one action each. A wedge is reported on its rising edge at
 * `thresholdMs`, then re-reported only when its duration doubles (so the log
 * traces the escalation without spamming); a heartbeat advance while a wedge
 * was being reported emits one `recovered` line; a gap the process spent
 * negligible CPU on ({@link SENTINEL_CPU_BUSY_RATIO}) is suspend/resume, not a
 * wedge, and is suppressed. When `killAfterMs` is armed, crossing it yields a
 * single `kill` action — CPU-gated like reports, so a laptop resume can never
 * kill a healthy process.
 */
export function createSentinelJudge(config: { thresholdMs: number; killAfterMs: number }): SentinelJudge {
	let lastBeatMs: number | undefined;
	let baselineCpuMs = 0;
	let reportedUpToMs = 0;
	let lastBlockedMs = 0;
	let killed = false;
	return {
		observe(sample: SentinelSample): SentinelAction | undefined {
			if (killed) return undefined;
			if (lastBeatMs === undefined || sample.heartbeatMs !== lastBeatMs) {
				const wasReporting = reportedUpToMs > 0;
				const priorBlockedMs = lastBlockedMs;
				lastBeatMs = sample.heartbeatMs;
				baselineCpuMs = sample.cpuMs;
				reportedUpToMs = 0;
				lastBlockedMs = 0;
				return wasReporting ? { kind: "recovered", blockedMs: Math.round(priorBlockedMs) } : undefined;
			}
			const blockedMs = sample.nowMs - sample.heartbeatMs;
			lastBlockedMs = blockedMs;
			if (blockedMs < config.thresholdMs) return undefined;
			const cpuMs = sample.cpuMs - baselineCpuMs;
			if (cpuMs < blockedMs * SENTINEL_CPU_BUSY_RATIO) return undefined;
			const phase = sample.phase ?? "unknown";
			if (config.killAfterMs > 0 && blockedMs >= config.killAfterMs) {
				killed = true;
				return { kind: "kill", blockedMs: Math.round(blockedMs), cpuMs: Math.round(cpuMs), phase };
			}
			if (reportedUpToMs === 0 || blockedMs >= reportedUpToMs * 2) {
				reportedUpToMs = blockedMs;
				const phaseAgeMs =
					sample.phaseAtMs !== undefined && sample.phaseAtMs > 0
						? Math.max(0, Math.round(sample.nowMs - sample.phaseAtMs))
						: undefined;
				return { kind: "report", blockedMs: Math.round(blockedMs), cpuMs: Math.round(cpuMs), phase, phaseAgeMs };
			}
			return undefined;
		},
	};
}
