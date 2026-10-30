import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";

/** Wraps a callback a session accepts from an extension: inert once that session retires, owned
 *  while it runs. Structural, to keep this module free of extension types. */
export type AcceptedCallbackOwner = {
	ownCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined;
};

/** The session accepting extension callbacks on this stack. `pi.events` is handed to extensions
 *  as the bus itself — an extension comparing it across bindings must see one object — so a
 *  subscription cannot be owned by wrapping the bus. It is owned by WHO IS SUBSCRIBING instead:
 *  the loader runs each factory inside this scope, and every owned callback re-enters it, so a
 *  bus two sessions share attributes each subscription to its own registrant. */
export const extensionCallbackScope = new AsyncLocalStorage<AcceptedCallbackOwner>();

/**
 * Methods are bound arrow fields: upstream Pi's `createEventBus()` returns
 * closures, so extensions (e.g. `pi-gemini-acp`) detach `pi.events.on` and
 * `pi.events.emit` and call them without a receiver.
 */
export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();

	emit = (channel: string, data: unknown): void => {
		const handlers = this.#listeners.get(channel);
		if (handlers) {
			for (const handler of handlers) {
				handler(data);
			}
		}
	};

	/** The owner is captured per SUBSCRIPTION, not per bus: a bus two sessions share must
	 *  attribute each handler to the session that registered it, and must stop calling a retired
	 *  session's handlers while the other session's keep working. */
	on = (channel: string, handler: (data: unknown) => void): (() => void) => {
		if (!this.#listeners.has(channel)) {
			this.#listeners.set(channel, new Set());
		}
		const owner = extensionCallbackScope.getStore();
		const owned = owner ? owner.ownCallback(handler) : handler;
		const safeHandler = async (data: unknown) => {
			try {
				await owned(data);
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
 * The bus one session hands its extensions, bound to that session's callback owner.
 *
 * {@link extensionCallbackScope} attributes a subscription to whoever is accepting ON THE STACK,
 * which is right while an extension factory or an owned callback is running and silent otherwise:
 * a `pi` reference captured and used later — from a `setTimeout`, from another session's handler —
 * subscribes with no owner at all, or with the wrong one. A reference knows which session gave it
 * out even when the stack does not, so the binding travels with the reference.
 *
 * This is a view, not a second bus: `emit` and `on` reach the shared transport, so a handler
 * registered through this facade is called by anyone emitting on the underlying bus, and both
 * stay detachable (an extension may call `const { on } = pi.events`). Only who owns a new
 * subscription changes.
 */
export class OwnedEventBus extends EventBus {
	constructor(bus: EventBus, owner: AcceptedCallbackOwner) {
		super();
		// Assigned over the base's bound fields: the base's own listener map is never used, every
		// call goes to the shared bus.
		this.emit = bus.emit;
		this.on = (channel, handler) => extensionCallbackScope.run(owner, () => bus.on(channel, handler));
		this.clear = bus.clear;
	}
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
