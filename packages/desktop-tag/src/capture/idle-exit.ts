/**
 * Idle-exit supervisor for the ompk-tag gateway.
 *
 * When enabled (CAPTURE_IDLE_EXIT_MS > 0), the gateway shuts itself down
 * after `timeoutMs` with no authorized inbound activity and no active runs.
 * Active work resets the clock on every tick, so the idle window effectively
 * starts when the last run finishes or the last authorized update arrives.
 *
 * Shutdown is lossless by design (capture runs resume from session files, the
 * pid lock is released on exit), and the /telegram controller passes a
 * default timeout when it spawns the daemon — an explicitly set
 * CAPTURE_IDLE_EXIT_MS (including 0 = never) always wins.
 */

/** Handle returned by the platform `setInterval`; module-internal. */
type IntervalHandle = ReturnType<typeof setInterval>;

export interface IdleExitSupervisorOptions {
	/** Idle window in ms; <= 0 disables the supervisor entirely. */
	timeoutMs: number;
	/** True while runs are active; each tick then counts as activity. */
	hasActiveWork: () => boolean;
	/** Invoked exactly once when the idle window elapses. */
	onIdle: () => void;
	/** Tick cadence; defaults to a quarter of the timeout, clamped. */
	checkIntervalMs?: number;
	now?: () => number;
}

export interface IdleExitSupervisor {
	readonly enabled: boolean;
	/** Record activity; resets the idle window. */
	noteActivity(): void;
	/** One check; exposed so tests can drive the supervisor without timers. */
	tick(): void;
	/** Begin ticking on an unref'd interval. Idempotent. */
	start(): void;
	/** Stop ticking. Safe to call any number of times. */
	stop(): void;
}

/** Parse CAPTURE_IDLE_EXIT_MS; missing, invalid, or negative means disabled. */
export function parseIdleExitTimeoutMs(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return 0;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

export function createIdleExitSupervisor(options: IdleExitSupervisorOptions): IdleExitSupervisor {
	const timeoutMs = Math.floor(options.timeoutMs);
	const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
	const now = options.now ?? (() => Date.now());
	const checkIntervalMs =
		options.checkIntervalMs ?? Math.min(30_000, Math.max(1_000, Math.floor(timeoutMs / 4) || 1_000));

	let lastActivityAt = now();
	let timer: IntervalHandle | undefined;
	let fired = false;

	const tick = (): void => {
		if (!enabled || fired) return;
		if (options.hasActiveWork()) {
			lastActivityAt = now();
			return;
		}
		if (now() - lastActivityAt >= timeoutMs) {
			fired = true;
			supervisor.stop();
			options.onIdle();
		}
	};

	const supervisor: IdleExitSupervisor = {
		enabled,
		noteActivity() {
			lastActivityAt = now();
		},
		tick,
		start() {
			if (!enabled || timer !== undefined) return;
			timer = setInterval(tick, checkIntervalMs);
			// Never hold the process open for the idle check alone.
			timer.unref?.();
		},
		stop() {
			if (timer === undefined) return;
			clearInterval(timer);
			timer = undefined;
		},
	};
	return supervisor;
}
