import { performance } from "node:perf_hooks";
import { logger, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";

export interface LoopWatchdogOptions {
	/** How far ahead each probe tick is scheduled, in ms. Default 250. */
	intervalMs?: number;
	/** A tick later than this past its deadline counts as a block. Default 250. */
	thresholdMs?: number;
	/** Overshoot beyond this is suppressed only when the process burned negligible CPU. Default 60_000. */
	sleepMs?: number;
	/** Monotonic clock source; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Process CPU time in ms; injectable for tests. Default `process.cpuUsage`. */
	cpuNow?: () => number;
	/** Timer source; injectable for tests. Default `setTimeout`. */
	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
}

/**
 * Timer handle the watchdog arms. `cancel`, when present, is invoked on stop()
 * so a stopped watchdog leaves no armed timer to wake the loop even once.
 */
interface LoopWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

/**
 * Fraction of a missed interval that may be process CPU time while the gap is
 * still treated as system sleep. Keep this near zero: cgroup throttling and
 * scheduler contention can make a CPU-bound loop consume far less CPU than wall
 * time. One percent allows a little measurement/background jitter while erring
 * toward reporting a severe stall instead of hiding it.
 */
const CPU_BUSY_RATIO = 0.01;

/**
 * Always-on event-loop lag probe. Each tick is scheduled `intervalMs` ahead of
 * a recorded deadline; a tick that fires `thresholdMs` past its deadline means
 * the loop was blocked that long. The overshoot is logged once on the rising
 * edge (one block ⇒ one line, deduped via `#wasBlocked`), tagged with the phase
 * active during the elapsed interval via {@link takeRecentLoopPhase} — which
 * survives the synchronous push/pop the instrumented hot paths do before this
 * delayed tick can run — so the stall names its cause instead of "unknown".
 *
 * The handle is `unref`'d so the probe never keeps the process alive, and stop()
 * cancels the armed timer when the handle exposes `cancel` (the default
 * `setTimeout` handle does, via `clearTimeout`). The `#generation` guard remains
 * as a fallback for injected handles that cannot cancel.
 *
 * A long overshoot is classified by CPU time rather than by duration. System
 * sleep and a CPU-bound wedge both produce an arbitrarily large gap, so duration
 * alone cannot tell them apart, and suppressing on duration discards exactly the
 * worst stalls. Only a gap the process spent negligible CPU on is treated as
 * sleep. CPU accounting is process-wide, so worker activity errs toward logging.
 */
export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#sleepMs: number;
	#now: () => number;
	#cpuNow: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#expected = 0;
	#expectedCpu = 0;
	#wasBlocked = false;
	#running = false;
	// Bumped by stop(); each scheduled tick captures the generation it was armed
	// under and no-ops if it no longer matches, so a start()→stop()→start() cycle
	// cannot leave the pre-stop timer chain rescheduling itself in parallel.
	#generation = 0;
	#handle: LoopWatchdogTimer | undefined;

	constructor(options: LoopWatchdogOptions = {}) {
		this.#intervalMs = options.intervalMs ?? 250;
		this.#thresholdMs = options.thresholdMs ?? 250;
		this.#sleepMs = options.sleepMs ?? 60_000;
		this.#now = options.now ?? (() => performance.now());
		this.#cpuNow =
			options.cpuNow ??
			(() => {
				const usage = process.cpuUsage();
				return (usage.user + usage.system) / 1000;
			});
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return { unref: () => timer.unref?.(), cancel: () => clearTimeout(timer) };
			});
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#wasBlocked = false;
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	#armTick(): void {
		const generation = this.#generation;
		this.#expected = this.#now() + this.#intervalMs;
		this.#expectedCpu = this.#cpuNow();
		this.#handle = this.#schedule(() => this.#tick(generation), this.#intervalMs);
		this.#handle.unref?.();
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const blockedMs = this.#now() - this.#expected;
		const cpuMs = this.#cpuNow() - this.#expectedCpu;
		// Consume the recent phase every tick (block or not) so attribution is
		// scoped to the just-elapsed interval and never carries a stale phase
		// forward to a later, phase-less block.
		const phase = takeRecentLoopPhase();
		if (blockedMs > this.#thresholdMs) {
			if (blockedMs > this.#sleepMs && cpuMs < blockedMs * CPU_BUSY_RATIO) {
				// A long gap the process did not spend CPU on: it was suspended.
				this.#wasBlocked = false;
			} else if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				logger.warn("ui.loop-blocked", {
					blockedMs: Math.round(blockedMs),
					cpuMs: Math.round(cpuMs),
					phase: phase ?? "unknown",
				});
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
