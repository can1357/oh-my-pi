/**
 * Generic replaying event channel: every subscriber independently receives all
 * events pushed so far plus future ones. The capture variant of the overlay's
 * TaskEventChannel, kept generic so runner and orchestrator streams can share it.
 */
export class ReplayChannel<T> {
	readonly #events: T[] = [];
	readonly #waiters = new Set<() => void>();
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	push(event: T): void {
		if (this.#closed) return;
		this.#events.push(event);
		this.#wakeWaiters();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wakeWaiters();
	}

	subscribe(signal?: AbortSignal): AsyncIterable<T> {
		const channel = this;
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<T> {
				let cursor = 0;
				while (!signal?.aborted) {
					if (cursor < channel.#events.length) {
						yield channel.#events[cursor++];
						continue;
					}
					if (channel.#closed) return;
					await channel.#waitForEvent(signal);
				}
			},
		};
	}

	#waitForEvent(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => {
			this.#waiters.delete(wake);
			signal?.removeEventListener("abort", wake);
			resolve();
		};
		this.#waiters.add(wake);
		signal?.addEventListener("abort", wake, { once: true });
		if (signal?.aborted) wake();
		return promise;
	}

	#wakeWaiters(): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const wake of waiters) wake();
	}
}
