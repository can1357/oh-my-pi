import type { BridgeRunSummary } from "./bridge";
import { type BridgeLogger, consoleBridgeLogger } from "./logger";

/** The slice of {@link ScreenpipeBridge} the runner drives; structural so tests can fake it. */
export interface PollableBridge {
	runOnce(): Promise<BridgeRunSummary>;
}

export interface ScreenpipeBridgeRunnerOptions {
	readonly bridge: PollableBridge;
	/** Delay between successful polls. Default 60s. */
	readonly pollIntervalMs?: number;
	/** Ceiling for the failure backoff. Default 15 minutes. */
	readonly maximumBackoffMs?: number;
	readonly logger?: BridgeLogger;
}

/**
 * Delay before the next poll: the plain interval after a success, doubling
 * from one interval per consecutive failure (capped) otherwise — a local
 * screenpipe daemon being down is routine, not exceptional, and must not
 * produce a warn-spam loop.
 */
export function computeNextPollDelayMs(
	consecutiveFailures: number,
	pollIntervalMs: number,
	maximumBackoffMs: number,
): number {
	if (consecutiveFailures <= 0) return pollIntervalMs;
	const exponent = Math.min(consecutiveFailures - 1, 30);
	return Math.min(pollIntervalMs * 2 ** exponent, maximumBackoffMs);
}

/**
 * Owns the poll loop around {@link ScreenpipeBridge.runOnce}: one timer chain
 * (never overlapping polls), failure backoff, and an unref'd timer so an idle
 * loop never keeps the host process alive. `stop()` waits for an in-flight
 * poll so hosts can dispose it deterministically during shutdown.
 */
export class ScreenpipeBridgeRunner {
	#bridge: PollableBridge;
	#pollIntervalMs: number;
	#maximumBackoffMs: number;
	#logger: BridgeLogger;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inFlight: Promise<void> | undefined;
	#stopped = true;
	#consecutiveFailures = 0;

	constructor(options: ScreenpipeBridgeRunnerOptions) {
		this.#bridge = options.bridge;
		this.#pollIntervalMs = options.pollIntervalMs ?? 60_000;
		this.#maximumBackoffMs = options.maximumBackoffMs ?? 15 * 60_000;
		if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs <= 0)
			throw new Error("pollIntervalMs must be a positive integer");
		if (!Number.isSafeInteger(this.#maximumBackoffMs) || this.#maximumBackoffMs < this.#pollIntervalMs)
			throw new Error("maximumBackoffMs must be an integer >= pollIntervalMs");
		this.#logger = options.logger ?? consoleBridgeLogger;
	}

	get running(): boolean {
		return !this.#stopped;
	}

	/** Begin polling; the first poll runs immediately. Idempotent. */
	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		// A restart is a fresh lifecycle: without this reset, a streak carried
		// over from before stop() would keep the interval backed off and
		// suppress the new lifecycle's first-failure warning.
		this.#consecutiveFailures = 0;
		this.#schedule(0);
	}

	/** Halt the loop and wait for any in-flight poll to finish. Idempotent. */
	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		await this.#inFlight;
	}

	#schedule(delayMs: number): void {
		if (this.#stopped) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#inFlight = this.#poll().finally(() => {
				this.#inFlight = undefined;
			});
		}, delayMs);
		// A pending poll must not keep the host process alive on exit.
		this.#timer.unref?.();
	}

	async #poll(): Promise<void> {
		try {
			const summary = await this.#bridge.runOnce();
			this.#consecutiveFailures = 0;
			if (summary.emittedClipCount > 0) {
				this.#logger.info("screenpipe bridge emitted activity clips", {
					emittedClipCount: summary.emittedClipCount,
					fetchedFrameCount: summary.fetchedFrameCount,
					openSegmentCount: summary.openSegmentCount,
					cursorFrameId: summary.cursorFrameId,
				});
			}
		} catch (error) {
			this.#consecutiveFailures++;
			// Warn on the first failure of a streak, then stay quiet while the
			// backoff grows — a stopped daemon would otherwise flood the log.
			if (this.#consecutiveFailures === 1) {
				this.#logger.warn("screenpipe bridge poll failed; backing off", { error: String(error) });
			}
		}
		this.#schedule(computeNextPollDelayMs(this.#consecutiveFailures, this.#pollIntervalMs, this.#maximumBackoffMs));
	}
}
