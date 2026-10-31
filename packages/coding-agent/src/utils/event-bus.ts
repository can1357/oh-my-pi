import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@oh-my-pi/pi-utils";

/** Wraps a callback a session accepts from an extension: inert once that session retires, owned
 *  while it runs. Structural, to keep this module free of extension types. */
export type AcceptedCallbackOwner = {
	ownCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined;
};

/** The session accepting extension callbacks on this stack. It is what attributes a subscription
 *  made while an extension factory or an owned callback is running: a bus two sessions share
 *  gives each handler to its own registrant. It says nothing about a `pi` reference captured and
 *  used later, which is why `pi.events` is an {@link OwnedEventBus} view of the session's bus
 *  rather than the bus itself. */
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
		// The TRANSPORT, never another view. A host may pass one session's `pi.events` as the
		// next session's bus — the SDK takes an `EventBus` and this is one — and subscribing
		// through the outer view would then call the inner view's `on`, which re-enters the inner
		// session's scope and takes the subscription from the session that is registering it.
		// Both directions of that were observed: the child's credential restriction released
		// while its callback ran, and a live child's handler disabled by the parent's disposal.
		const transport = busTransport(bus);
		// Assigned over the base's bound fields: the base's own listener map is never used, every
		// call goes to the shared transport.
		this.emit = transport.emit;
		this.on = (channel, handler) => extensionCallbackScope.run(owner, () => transport.on(channel, handler));
		this.clear = transport.clear;
		transports.set(this, transport);
	}
}

/** Views to the bus each one speaks for. A view is not registered as its own transport, so
 *  {@link busTransport} resolves any chain of them in one step. */
const transports = new WeakMap<EventBus, EventBus>();

/** The bus a view speaks for, or the bus itself. Two handles onto one transport — a raw bus and
 *  the view an extension was given — carry the same listeners, so anything deciding whether two
 *  buses are the same must compare this rather than the objects. */
export function busTransport(bus: EventBus): EventBus {
	return transports.get(bus) ?? bus;
}

/**
 * Publishes a subagent frame on the session bus and the observability bus.
 * SDK embedders may pass the same EventBus for both slots — or a bus and a view onto it, which
 * delivers to the same listeners; comparing transports skips the aliased re-emit so listeners
 * never see duplicate frames.
 */
export function emitSubagentFrame(
	eventBus: EventBus | undefined,
	subagentEventBus: EventBus | undefined,
	channel: string,
	payload: unknown,
): void {
	eventBus?.emit(channel, payload);
	if (subagentEventBus && (!eventBus || busTransport(subagentEventBus) !== busTransport(eventBus))) {
		subagentEventBus.emit(channel, payload);
	}
}
