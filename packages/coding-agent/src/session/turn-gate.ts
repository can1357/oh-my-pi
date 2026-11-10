/**
 * Turn ownership for an {@link AgentSession} under `subagent_stop` holds.
 *
 * Every turn start on the session's agent goes through {@link TurnGate.start}, which decides admission from the
 * claim's kind in the same tick as the dispatch, so no turn can pass a check, await, and then start inside a hold
 * taken meanwhile. Refused work parks here and replays once it may run; holds are cancelled here only.
 */
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";

/**
 * What a turn is to the holds, decided where the turn is created:
 * - `holder`: a hold's own continuation; runs once no other claim's reservation is open.
 * - `recovery`: the running work's own follow-through (retries, stream guards, idle deliveries); waits only while a
 *   hold's handlers consult.
 * - `background`: anything else that would start a turn on its own (wakes, asides, queued drains, compaction
 *   continuations, hidden next turns, agent prompts); waits for the last release.
 * - `user`: a user's prompt, retry, resume or restore; cancels the holds and runs once they release.
 */
export type TurnClaimKind = "holder" | "recovery" | "background" | "user";

/** One `subagent_stop` hold, from the start of its pass until its result is published. */
export interface HoldState {
	readonly cancel: AbortController;
	/** Handlers are judging the candidate: recovery turns wait so it cannot change under the verdict. */
	consulting: boolean;
}

export interface TurnClaim {
	readonly kind: TurnClaimKind;
	/** `holder` only: the hold this turn continues. */
	readonly hold?: HoldState;
	/**
	 * Refused non-user claims: start the work again once admissible. Called at most once per park, by the gate's
	 * replay; the same function parked again before its replay is one replay, stamped with the later park.
	 */
	readonly park?: () => void;
}

export interface TurnGateHost {
	/** Stamp for parked claims: real cancellations and transcript resets change it; a turn-stop does not. */
	cancellationGeneration(): number;
	/** Settles once the submissions admitted now have dispatched, queued or bailed; undefined when there are none. */
	whenAdmittedSubmissionsSettled(): Promise<void> | undefined;
}

/** A claim's in-flight bracket, from its setup to its settle: a holder waits until every foreign one ends. */
export interface TurnReservation {
	/** The reserved turn went live: its undo no longer runs. */
	started(): void;
	/** Ends the reservation, first running the undo of a turn that never went live. Idempotent. */
	end(): Promise<void>;
}

/** An `Agent` without its turn starts: a host given this can only start turns through the session's gate. */
export type TurnlessAgent = Omit<Agent, "prompt" | "continue">;

type ParkedClaim = { park: () => void; stamp: number; kind: TurnClaimKind };

export class TurnGate {
	readonly #host: TurnGateHost;
	readonly #holds = new Map<HoldState, (() => void) | undefined>();
	readonly #reservations = new Set<TurnClaim>();
	#parked: ParkedClaim[] = [];
	#changed = Promise.withResolvers<void>();
	#dispatching = false;
	#cancelling: "interrupt" | "user" | undefined;

	constructor(host: TurnGateHost) {
		this.#host = host;
	}

	get held(): boolean {
		return this.#holds.size > 0;
	}

	/** True only during {@link start}'s synchronous dispatch call: the agent's turn gate admits exactly that call. */
	get dispatching(): boolean {
		return this.#dispatching;
	}

	/** Why the holds are being cancelled, read by their abort listeners during {@link cancelAll}. */
	get cancelling(): "interrupt" | "user" | undefined {
		return this.#cancelling;
	}

	/** Takes a hold; `runSignal`, the run's own cancellation, cancels it until its release. */
	hold(runSignal?: AbortSignal): HoldState {
		const hold: HoldState = { cancel: new AbortController(), consulting: false };
		let unlink: (() => void) | undefined;
		if (runSignal) {
			const cancelWithRun = (): void => hold.cancel.abort(runSignal.reason);
			if (runSignal.aborted) cancelWithRun();
			else {
				runSignal.addEventListener("abort", cancelWithRun, { once: true });
				unlink = () => runSignal.removeEventListener("abort", cancelWithRun);
			}
		}
		this.#holds.set(hold, unlink);
		this.#notify();
		return hold;
	}

	consult(hold: HoldState): void {
		hold.consulting = true;
	}

	/** The verdict is in: recovery claims parked while no other hold consults replay now. */
	endConsult(hold: HoldState): void {
		if (!hold.consulting) return;
		hold.consulting = false;
		this.#notify();
		this.#replay(true);
	}

	/** Lets other turns run again. The last release replays every parked claim, once submissions admitted by then settle. */
	release(hold: HoldState): void {
		if (!this.#holds.has(hold)) return;
		this.endConsult(hold);
		this.#holds.get(hold)?.();
		this.#holds.delete(hold);
		this.#notify();
		if (this.held) return;
		const settled = this.#host.whenAdmittedSubmissionsSettled();
		if (settled) void settled.then(() => this.#replay(false));
		else this.#replay(false);
	}

	/** Cancels every hold: a user claim, or an interrupt (never a turn-stop). */
	cancelAll(reason: "interrupt" | "user"): void {
		const previous = this.#cancelling;
		this.#cancelling = reason;
		try {
			for (const hold of this.#holds.keys()) hold.cancel.abort();
		} finally {
			this.#cancelling = previous;
		}
	}

	admits(claim: TurnClaim): boolean {
		switch (claim.kind) {
			case "holder": {
				const hold = claim.hold;
				if (!hold || !this.#holds.has(hold) || hold.cancel.signal.aborted) return false;
				for (const reservation of this.#reservations) if (reservation.hold !== hold) return false;
				return true;
			}
			case "recovery":
				return !this.#consulting();
			case "background":
			case "user":
				return !this.held;
		}
	}

	/**
	 * Whether `claim` may start a turn now. A refused claim is handled as {@link start} handles it: a user claim
	 * cancels the holds, any other parks for its replay.
	 */
	tryAdmit(claim: TurnClaim): boolean {
		if (this.admits(claim)) return true;
		if (claim.kind === "user") this.cancelAll("user");
		else if (claim.park) this.#park(claim.park, claim.kind);
		return false;
	}

	/**
	 * Starts `claim`'s turn when admitted: `onAdmitted` then `dispatch`, synchronously, with nothing awaited since the
	 * decision. `undefined` when refused (see {@link tryAdmit}); nothing ran then.
	 */
	start<T>(
		claim: TurnClaim,
		onAdmitted: (() => void) | undefined,
		dispatch: () => Promise<T>,
	): Promise<T> | undefined {
		if (!this.tryAdmit(claim)) return undefined;
		this.#dispatching = true;
		try {
			onAdmitted?.();
			return dispatch();
		} finally {
			this.#dispatching = false;
		}
	}

	/** Resolves once `claim` is admissible; a user claim cancels the holds first. Rejects when `signal` aborts first. */
	async whenAdmissible(claim: TurnClaim, signal?: AbortSignal): Promise<void> {
		while (!this.admits(claim)) {
			if (claim.kind === "user") this.cancelAll("user");
			if (claim.kind === "holder") claim.hold?.cancel.signal.throwIfAborted();
			const changed = this.#changed.promise;
			await (signal ? untilAborted(signal, changed) : changed);
		}
	}

	/** Opens `claim`'s in-flight bracket; `undo` puts back what its setup installed if its turn never goes live. */
	reserve(claim: TurnClaim, undo?: () => void | Promise<void>): TurnReservation {
		// One entry per reservation, even for a claim object reserved twice.
		const entry: TurnClaim = { ...claim };
		this.#reservations.add(entry);
		let live = false;
		let ended = false;
		return {
			started: () => {
				live = true;
			},
			end: async () => {
				if (ended) return;
				ended = true;
				try {
					if (!live) await undo?.();
				} finally {
					if (this.#reservations.delete(entry)) this.#notify();
				}
			},
		};
	}

	/** An abort reset every in-flight bracket: their reservations no longer hold anyone back. */
	clearReservations(): void {
		this.#reservations.clear();
		this.#notify();
	}

	#consulting(): boolean {
		for (const hold of this.#holds.keys()) if (hold.consulting) return true;
		return false;
	}

	#park(park: () => void, kind: TurnClaimKind): void {
		const stamp = this.#host.cancellationGeneration();
		const parked = this.#parked.find(entry => entry.park === park);
		if (parked) parked.stamp = stamp;
		else this.#parked.push({ park, stamp, kind });
	}

	#replay(recoveryOnly: boolean): void {
		if (recoveryOnly ? this.#consulting() : this.held) return;
		const due = recoveryOnly ? this.#parked.filter(entry => entry.kind === "recovery") : this.#parked;
		this.#parked = recoveryOnly ? this.#parked.filter(entry => entry.kind !== "recovery") : [];
		const stamp = this.#host.cancellationGeneration();
		for (const entry of due) {
			// A real cancellation since the park cancelled the work, as it would have an unparked turn.
			if (entry.stamp !== stamp) continue;
			try {
				entry.park();
			} catch (error) {
				logger.warn("Replaying parked turn failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#notify(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<void>();
		changed.resolve();
	}
}
