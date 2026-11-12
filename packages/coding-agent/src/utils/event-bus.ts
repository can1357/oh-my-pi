import { logger } from "@oh-my-pi/pi-utils";

/**
 * Methods are bound arrow fields: upstream Pi's `createEventBus()` returns
 * closures, so extensions (e.g. `pi-gemini-acp`) detach `pi.events.on` and
 * `pi.events.emit` and call them without a receiver.
 */
export class EventBus {
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
	readonly #presenceWatchers = new Map<string, Set<(present: boolean) => void>>();

	#notifyPresence(channel: string, present: boolean): void {
		const watchers = this.#presenceWatchers.get(channel);
		if (!watchers) return;
		for (const watcher of watchers) {
			try {
				watcher(present);
			} catch (err) {
				logger.error("Event listener presence watcher error", { channel, error: String(err) });
			}
		}
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
		let handlers = this.#listeners.get(channel);
		if (!handlers) {
			handlers = new Set();
			this.#listeners.set(channel, handlers);
		}
		const safeHandler = async (data: unknown) => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		handlers.add(safeHandler);
		if (handlers.size === 1) this.#notifyPresence(channel, true);
		return () => {
			const current = this.#listeners.get(channel);
			const removed = current?.delete(safeHandler) === true;
			if (removed && current?.size === 0) this.#notifyPresence(channel, false);
			return removed;
		};
	};

	/** Whether `channel` has at least one listener. */
	hasListeners = (channel: string): boolean => (this.#listeners.get(channel)?.size ?? 0) > 0;

	/**
	 * Calls `onChange` whenever `channel` gains its first listener (`true`) or loses its last
	 * (`false`), so a forwarding emitter on another thread can drop frames nobody reads.
	 * Returns the unsubscribe.
	 */
	watchListeners = (channel: string, onChange: (present: boolean) => void): (() => void) => {
		let watchers = this.#presenceWatchers.get(channel);
		if (!watchers) {
			watchers = new Set();
			this.#presenceWatchers.set(channel, watchers);
		}
		watchers.add(onChange);
		return () => {
			const current = this.#presenceWatchers.get(channel);
			current?.delete(onChange);
			if (current?.size === 0) this.#presenceWatchers.delete(channel);
		};
	};

	clear = (): void => {
		const channels = Array.from(this.#listeners.keys()).filter(channel => this.hasListeners(channel));
		this.#listeners.clear();
		for (const channel of channels) this.#notifyPresence(channel, false);
	};
}

/**
 * A view of a parent bus that remembers what its owner subscribed to, so the owner can be
 * retired (an extension reloaded or removed) without leaving its listeners behind. Emitting and
 * subscribing reach the parent bus; {@link disposeAll} unsubscribes only what this view added.
 */
export class ScopedEventBus extends EventBus {
	readonly #subscriptions = new Set<() => void>();

	constructor(parent: EventBus) {
		super();
		this.emit = parent.emit;
		this.clear = parent.clear;
		this.on = (channel, handler) => {
			const unsubscribe = parent.on(channel, handler);
			const tracked = () => {
				this.#subscriptions.delete(tracked);
				unsubscribe();
			};
			this.#subscriptions.add(tracked);
			return tracked;
		};
	}

	/** Unsubscribes every listener this view added and has not already removed. */
	disposeAll(): void {
		// Each unsubscribe removes itself from the set mid-iteration, which Set iteration tolerates.
		for (const unsubscribe of this.#subscriptions) unsubscribe();
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
