/**
 * Process-global pause gate for agent loops.
 *
 * Every agent in a process — main session, in-process subagents, advisor —
 * funnels through {@link ../agent-loop!agentLoop}, which polls this gate at its
 * two action boundaries: before each model call and before each tool call
 * starts. Engaging the gate therefore freezes all of them at the next safe
 * point without aborting anything: in-flight provider streams and
 * already-started tool executions run to completion, then every loop parks
 * until {@link AgentPauseGate.resume}. Queued steering/follow-up messages stay
 * queued and deliver normally after resume.
 *
 * A run's own `AbortSignal` still unwinds a parked loop immediately: the park
 * releases on abort (without releasing the gate), so cancelling one run never
 * requires resuming the whole process.
 *
 * Hosts drive the singleton {@link agentPauseGate} (e.g. the TUI `/pause`
 * command); library code only ever reads it.
 *
 * A request issued outside an agent loop — a compaction summary, a memory
 * extraction, an edit repair, a judge question — never reaches those two
 * boundaries, so it carries {@link AgentPauseGate.dispatchHold} as its
 * `beforeDispatch` instead, and the provider layer parks it there.
 */

import type { DispatchHold } from "@oh-my-pi/pi-ai";
import { raceWithSignal } from "@oh-my-pi/pi-ai/utils/abort";

/** Listener invoked with the new state on every pause/resume transition. */
export type AgentPauseListener = (paused: boolean) => void;

/** Freeze switch shared by every agent loop in the process. See module docs. */
export class AgentPauseGate {
	/** Pending while paused; resolved and cleared on resume. */
	#gate: PromiseWithResolvers<void> | undefined;
	#pausedAt = 0;
	#listeners = new Set<AgentPauseListener>();

	/** True while the gate is engaged. */
	get paused(): boolean {
		return this.#gate !== undefined;
	}

	/** Epoch ms when the current pause began; undefined when running. */
	get pausedAt(): number | undefined {
		return this.#gate ? this.#pausedAt : undefined;
	}

	/** Engage the gate. Returns false (and does nothing) when already paused. */
	pause(): boolean {
		if (this.#gate) return false;
		this.#gate = Promise.withResolvers<void>();
		this.#pausedAt = Date.now();
		this.#notify(true);
		return true;
	}

	/**
	 * Release the gate, waking every parked loop. Returns the pause duration in
	 * ms, or undefined when the gate was not engaged.
	 */
	resume(): number | undefined {
		const gate = this.#gate;
		if (!gate) return undefined;
		this.#gate = undefined;
		gate.resolve();
		this.#notify(false);
		return Date.now() - this.#pausedAt;
	}

	/** Subscribe to pause/resume transitions. Returns an unsubscribe function. */
	onChange(listener: AgentPauseListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Park until the gate is released. Resolves immediately when not paused.
	 * An abort on `signal` releases only this wait — the gate stays engaged —
	 * so a cancelled run unwinds while the rest of the process stays frozen.
	 */
	async waitUntilResumed(signal?: AbortSignal): Promise<void> {
		// Loop: resume() swaps the gate promise, so a pause re-engaged while a
		// waiter is between awaits must re-park instead of slipping through.
		while (this.#gate) {
			if (signal?.aborted) return;
			const gate = this.#gate.promise;
			if (!signal) {
				await gate;
				continue;
			}
			const abort = Promise.withResolvers<void>();
			const onAbort = () => abort.resolve();
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				await Promise.race([gate, abort.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		}
	}

	/**
	 * The `beforeDispatch` hold for a request issued outside an agent loop. It
	 * parks the request until the gate is released, then runs `next` — the
	 * caller's own hold — so a caller's check of what changed under the pause
	 * runs after the wait, not before it. A pause engaged while `next` waits
	 * parks the request again once `next` answers, and `next` runs again after
	 * that resume too, so the hold settles only when the gate is open as `next`
	 * answers.
	 *
	 * Its probe ({@link DispatchHold.isClosed}) reads the gate, `signal`, and
	 * `next`'s own probe when it has one. The transport reads it in the same
	 * synchronous step that sends, so a request carrying this hold never
	 * reaches the wire while the gate is engaged. A `next` without a probe is
	 * only awaited.
	 *
	 * `signal` ends the whole wait, on the gate and on `next` alike, and the
	 * hold then rejects with its reason; once it has aborted the hold rejects
	 * as soon as it is asked, gate open or not. Pass the request's own signal,
	 * so a cancelled request unparks, or a wider lifetime that includes it (a
	 * session's), so a request whose owner went away fails instead of
	 * dispatching. `next` itself keeps running when the wait ends this way: it
	 * is the caller's, and other requests may share it. With the gate open and
	 * `next` answering at once the hold costs a request no microtask, and a
	 * caller that can also run outside a paused process (a one-shot CLI) needs
	 * no branch of its own.
	 */
	dispatchHold(signal?: AbortSignal, next?: DispatchHold): DispatchHold {
		const hold: DispatchHold = () => {
			if (signal?.aborted) return Promise.reject(signal.reason);
			if (this.#gate) return this.#holdUntilOpen(signal, next, undefined);
			const pending = next?.();
			return pending ? this.#holdUntilOpen(signal, next, pending) : undefined;
		};
		hold.isClosed = () => this.#gate !== undefined || signal?.aborted === true || next?.isClosed?.() === true;
		return hold;
	}

	/**
	 * Wait out `pending` (what `next` returned), then the gate, running `next`
	 * again after every wait on the gate, until the gate is open when `next`
	 * has answered.
	 */
	async #holdUntilOpen(
		signal: AbortSignal | undefined,
		next: DispatchHold | undefined,
		pending: Promise<void> | void,
	): Promise<void> {
		for (;;) {
			if (pending) await raceWithSignal(pending, signal);
			signal?.throwIfAborted();
			if (!this.#gate) return;
			await this.waitUntilResumed(signal);
			signal?.throwIfAborted();
			pending = next?.();
		}
	}

	#notify(paused: boolean): void {
		for (const listener of this.#listeners) {
			try {
				listener(paused);
			} catch {
				// Host UI listeners must never break the gate.
			}
		}
	}
}

/** The process-wide gate polled by the agent loop. */
export const agentPauseGate = new AgentPauseGate();
