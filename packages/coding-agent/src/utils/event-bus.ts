import { logger } from "@oh-my-pi/pi-utils";

/**
 * Methods are bound arrow fields: upstream Pi's `createEventBus()` returns
 * closures, so extensions (e.g. `pi-gemini-acp`) detach `pi.events.on` and
 * `pi.events.emit` and call them without a receiver.
 */
export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
	/** Reports a running handler to whoever owns extension-callback lifetimes for this bus's
	 *  session. A `pi.events` subscription is invoked by the bus, not by the extension runner, so
	 *  this is the only party that can see when one starts. */
	#own: <T>(result: T) => T = result => result;
	#ownerInstalled = false;

	/** Installs the callback owner once. A later call is ignored: the first binding on this bus is
	 *  its session's, and a bus an embedder shares with a second session must not have its
	 *  callbacks reattributed to the newcomer. */
	setCallbackOwner(own: <T>(result: T) => T): void {
		if (this.#ownerInstalled) return;
		this.#ownerInstalled = true;
		this.#own = own;
	}

	emit = (channel: string, data: unknown): void => {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	};

	on = (channel: string, handler: (data: unknown) => void): (() => void) => {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const safeHandler = async (data: unknown) => {
			try {
				await this.#own(handler(data) as unknown);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		this.#listeners.get(channel)!.add(safeHandler);
		return () => this.#listeners.get(channel)?.delete(safeHandler);
	};

	clear = (): void => {
		this.#listeners.clear();
	};
}

/**
 * Publishes a subagent frame on the session bus and the observability bus.
 * SDK embedders may pass the same EventBus for both slots; the identity check
 * skips the aliased re-emit so listeners never see duplicate frames.
 */
export function emitSubagentFrame(
	eventBus: EventBus | undefined,
	subagentEventBus: EventBus | undefined,
	channel: string,
	payload: unknown,
): void {
	eventBus?.emit(channel, payload);
	if (subagentEventBus && subagentEventBus !== eventBus) {
		subagentEventBus.emit(channel, payload);
	}
}
