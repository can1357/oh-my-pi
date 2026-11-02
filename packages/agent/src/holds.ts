import { exemptFromRequestHolds, type RequestHoldView, type RequestHolds } from "@oh-my-pi/pi-ai";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { AgentHold } from "./types";

/**
 * Holds on an agent's model requests and tool calls (see `Agent.addHold`).
 *
 * The rule every effect follows — a model request sent, a tool executed, a
 * speculative run's policy run: no effect starts past a hold. The last await
 * before the effect is a check of the holds registered at that moment
 * ({@link HoldViews.check}), and nothing the host controls runs between that
 * check and the effect: the check is synchronous and the effect starts in the
 * same turn.
 *
 * The holds are also the agent's {@link RequestHolds}: the agent runs in an
 * async context that carries them (`Agent.runInRequestContext`), so every
 * model request started in it — by the loop, a tool, a hook, a timer — waits
 * for them at its transport's send, not only the loop's own requests.
 */

/** Opens one model request's or tool call's view of a hold. */
export type OpenAgentHold = () => AgentHold;

/**
 * The holds registered with an agent, as they are at each moment. Nothing
 * copies them: every check a request or call makes reads them live through
 * its {@link HoldViews}.
 */
export class AgentHolds implements RequestHolds {
	readonly #registrations = new Set<OpenAgentHold>();
	/** Settles at the next registration or removal, then is replaced. */
	#changed = Promise.withResolvers<void>();

	/**
	 * Registers `open` until the returned disposer is called. Each call
	 * registers anew, so one `open` registered twice holds as two holds.
	 */
	add(open: OpenAgentHold): () => void {
		const registration: OpenAgentHold = () => open();
		this.#registrations.add(registration);
		this.#signalChange();
		return () => {
			if (this.#registrations.delete(registration)) this.#signalChange();
		};
	}

	/** One model request's or tool call's views of these holds; it opens none until it checks. */
	open(): HoldViews {
		return new HoldViews(this.#registrations, () => this.#changed.promise);
	}

	/**
	 * {@link open}, unless the current context is exempt from these holds (see
	 * `runOutsideRequestHolds`): work the holds themselves wait for — a
	 * `session_moved` handler's prompt and the tools it runs — would otherwise
	 * wait for itself.
	 */
	openInContext(): HoldViews | undefined {
		return exemptFromRequestHolds(this) ? undefined : this.open();
	}

	#signalChange(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<void>();
		changed.resolve();
	}
}

/**
 * One model request's or tool call's views of an agent's holds. Each check
 * reads the registrations as they are then. A registration the request has
 * not met before gets its view opened at that check — once: the view lasts
 * the rest of the request, so its own state (a deadline, say) is never
 * reset by a later check. A registration removed since the last check has
 * its view released at the next one, and a check waiting on it wakes. Every
 * view opened is released exactly once: then, or by {@link release}.
 */
export class HoldViews implements RequestHoldView {
	readonly #registrations: ReadonlySet<OpenAgentHold>;
	readonly #changed: () => Promise<void>;
	readonly #views = new Map<OpenAgentHold, AgentHold>();

	constructor(registrations: ReadonlySet<OpenAgentHold>, changed: () => Promise<void>) {
		this.#registrations = registrations;
		this.#changed = changed;
	}

	/**
	 * Asks every hold registered now, synchronously: `undefined` when none
	 * holds, else what to wait for before checking again — everything the
	 * holds returned, or a registration or removal, whichever comes first.
	 * At an effect's boundary the caller starts the effect in the turn of the
	 * check that returned `undefined`, with no await between them.
	 */
	check(): Promise<void> | undefined {
		// Taken before any hold is asked: a registration or removal while they
		// are asked wakes the wait too.
		const changed = this.#changed();
		for (const [registration, view] of this.#views) {
			if (this.#registrations.has(registration)) continue;
			this.#views.delete(registration);
			view.release?.();
		}
		const pending: Promise<void>[] = [];
		for (const registration of this.#registrations) {
			let view = this.#views.get(registration);
			if (!view) {
				view = registration();
				this.#views.set(registration, view);
			}
			const wait = view.pending();
			if (wait) pending.push(wait);
		}
		if (pending.length === 0) return undefined;
		return Promise.race([Promise.all(pending).then(() => undefined), changed]);
	}

	/**
	 * Waits until a check finds no hold holding; rejects when `signal`
	 * aborts. For a check ahead of preparation only: it returns a turn after
	 * that check, so an effect's boundary loops on {@link check} instead.
	 */
	async pass(signal: AbortSignal | undefined): Promise<void> {
		for (let held = this.check(); held; held = this.check()) await untilAborted(signal, held);
	}

	/** The request or call no longer waits on any hold: releases every view still open, each once. */
	release(): void {
		const views = [...this.#views.values()];
		this.#views.clear();
		for (const view of views) view.release?.();
	}
}
