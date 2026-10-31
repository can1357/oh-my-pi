/**
 * Grace before the kernel an eval session leaves behind is shut down.
 *
 * A retained kernel is keyed by its eval session id, cwd and interpreter, so an
 * agent that changes directory acquires a different kernel and strands the one
 * it was using. Shutting the stranded one down the instant the next cell lands
 * would throw away the namespace of anyone stepping out of a directory and back
 * — a `cd`, one cell, and `cd` back loses every variable. Waiting instead lets
 * the common round trip keep its state, while a kernel the session really has
 * left stops holding its heap minutes later rather than for the life of the
 * host process.
 *
 * Two minutes is the shape of the round trip this protects: long enough for an
 * agent to run a handful of cells elsewhere and come back, short enough that a
 * long-lived host is not carrying a kernel nobody has touched. The clock starts
 * when the session is superseded, not when the kernel falls idle, so a cell
 * still running when its owner walks away is measured from the same moment; a
 * kernel still busy at the far end of the grace is re-armed, not killed and not
 * forgotten. The grace only ever delays the shutdown; it never delays a
 * disposal, because a session ending or the process exiting cancels the timer
 * and shuts the kernel down through the ordinary path.
 */
export const SUPERSEDED_KERNEL_GRACE_MS = 120_000;

let graceMs = SUPERSEDED_KERNEL_GRACE_MS;

/**
 * What one reclaim attempt did. `deferred` means a guard that holds only for
 * now — a cell, a borrow, a frame the runner still owes — blocked the
 * shutdown, so the grace is armed again instead of dropped.
 */
export type SupersededReclaimOutcome = "settled" | "deferred";

/**
 * Shorten (or restore) the grace so a test can watch a real reclaim instead of
 * waiting two minutes. Test-only; not part of the runtime surface.
 */
export function setSupersededKernelGraceMs(ms?: number): void {
	graceMs = ms ?? SUPERSEDED_KERNEL_GRACE_MS;
}

/**
 * Pending and in-flight reclaims of superseded kernels, one reaper per
 * language registry.
 *
 * The session stays registered while its timer runs, so reacquiring it inside
 * the grace is an ordinary cache hit that keeps the namespace and cancels the
 * timer. The reclaim itself re-checks every guard when the timer fires, so a
 * borrow or a cell that started during the grace is never killed by it — and a
 * reclaim those guards defer is armed again, because the owner that walked
 * away may never run the next cell that would arm a new one.
 */
export class SupersededKernelReaper<TSession extends object> {
	readonly #timers = new Map<TSession, Timer>();
	readonly #inFlight = new Set<Promise<void>>();
	/** Bumped per session by {@link cancel}, so a reclaim in flight cannot re-arm one that was just reacquired. */
	readonly #cancellations = new WeakMap<TSession, number>();
	/** Bumped by {@link cancelAll}, so nothing re-arms after a dispose took the sessions over. */
	#generation = 0;

	/** Arm the grace for `session`, unless it is already armed. */
	schedule(session: TSession, reclaim: () => Promise<SupersededReclaimOutcome>): void {
		if (this.#timers.has(session)) return;
		this.#arm(session, reclaim, this.#generation, this.#cancellations.get(session) ?? 0);
	}

	#arm(
		session: TSession,
		reclaim: () => Promise<SupersededReclaimOutcome>,
		generation: number,
		cancellation: number,
	): void {
		const timer = setTimeout(() => {
			this.#timers.delete(session);
			// A failed reclaim is logged by the caller, never thrown at whoever
			// happens to be disposing.
			const running = reclaim().then(
				outcome => {
					if (outcome !== "deferred") return;
					// Nothing re-arms behind a dispose or a reacquisition that
					// landed while this attempt was running.
					if (this.#generation !== generation) return;
					if ((this.#cancellations.get(session) ?? 0) !== cancellation) return;
					if (this.#timers.has(session)) return;
					this.#arm(session, reclaim, generation, cancellation);
				},
				() => {},
			);
			this.#inFlight.add(running);
			void running.finally(() => this.#inFlight.delete(running));
		}, graceMs);
		// Never hold the host open for a kernel it is about to throw away.
		timer.unref?.();
		this.#timers.set(session, timer);
	}

	/** Drop a pending reclaim: the session was reacquired, or is being disposed. */
	cancel(session: TSession): void {
		this.#cancellations.set(session, (this.#cancellations.get(session) ?? 0) + 1);
		const timer = this.#timers.get(session);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#timers.delete(session);
	}

	/** Drop every pending reclaim, for a dispose that shuts the sessions down itself. */
	cancelAll(): void {
		this.#generation += 1;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}

	/** Settle reclaims already running, so a dispose cannot return with a runner still up. */
	async settle(): Promise<void> {
		await Promise.all(this.#inFlight);
	}
}
