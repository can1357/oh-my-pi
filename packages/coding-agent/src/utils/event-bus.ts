import { logger } from "@oh-my-pi/pi-utils";

type EventHandler = (data: unknown) => void | Promise<void>;
type SafeEventHandler = (data: unknown) => Promise<void>;

interface LatestDelivery {
	active: boolean;
	subscribed: boolean;
	hasPending: boolean;
	pending: unknown;
}

export class EventBus {
	readonly #listeners = new Map<string, Set<SafeEventHandler>>();
	readonly #latestDeliveries = new WeakMap<SafeEventHandler, LatestDelivery>();

	emit(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (!handlers) return;
		for (const handler of handlers) void handler(data);
	}

	/**
	 * Deliver state snapshots serially per observer.
	 *
	 * While an observer is busy, newer snapshots replace its single pending
	 * snapshot so slow observers cannot accumulate stale concurrent work.
	 */
	emitLatest(channel: string, data: unknown): void {
		const handlers = this.#listeners.get(channel);
		if (!handlers) return;
		for (const handler of handlers) {
			let delivery = this.#latestDeliveries.get(handler);
			if (!delivery) {
				delivery = { active: false, subscribed: true, hasPending: false, pending: undefined };
				this.#latestDeliveries.set(handler, delivery);
			}
			delivery.pending = data;
			delivery.hasPending = true;
			if (delivery.active) continue;
			delivery.active = true;
			void this.#drainLatest(handler, delivery);
		}
	}

	on(channel: string, handler: EventHandler): () => void {
		let handlers = this.#listeners.get(channel);
		if (!handlers) {
			handlers = new Set();
			this.#listeners.set(channel, handlers);
		}
		const safeHandler: SafeEventHandler = async data => {
			try {
				await handler(data);
			} catch (err) {
				logger.error("Event handler error", { channel, error: String(err) });
			}
		};
		handlers.add(safeHandler);
		return () => {
			handlers.delete(safeHandler);
			const delivery = this.#latestDeliveries.get(safeHandler);
			if (delivery) {
				delivery.subscribed = false;
				delivery.hasPending = false;
				delivery.pending = undefined;
			}
			if (handlers.size === 0) this.#listeners.delete(channel);
		};
	}

	clear(): void {
		for (const handlers of this.#listeners.values()) {
			for (const handler of handlers) {
				const delivery = this.#latestDeliveries.get(handler);
				if (!delivery) continue;
				delivery.subscribed = false;
				delivery.hasPending = false;
				delivery.pending = undefined;
			}
		}
		this.#listeners.clear();
	}

	async #drainLatest(handler: SafeEventHandler, delivery: LatestDelivery): Promise<void> {
		try {
			while (delivery.subscribed && delivery.hasPending) {
				const data = delivery.pending;
				delivery.pending = undefined;
				delivery.hasPending = false;
				await handler(data);
			}
		} finally {
			delivery.active = false;
		}
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
