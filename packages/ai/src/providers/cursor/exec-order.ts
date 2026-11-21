/**
 * Tool-batch ordering for Cursor exec frames.
 *
 * Cursor dispatches every exec frame of a step without waiting for earlier
 * results, and the provider answers them concurrently. omp's agent loop runs a
 * file mutation alone: it waits for the calls issued before it, and the calls
 * issued after it wait for it. {@link CursorExecOrder} applies that rule to
 * exec frames in arrival order. A native StrReplace or Write spans two frames
 * under one call id — a read, then a write once the server applied the edit —
 * so it holds its place from the read until its write lands or the server
 * completes it; otherwise a call issued after it runs against the old file.
 *
 * @example
 * ```ts ignore
 * if (!(await order.enter(callId, exclusive))) return; // the run ended while waiting
 * try {
 * 	await runFrame();
 * } finally {
 * 	order.leave(callId);
 * }
 * ```
 */

interface OrderedCall {
	readonly exclusive: boolean;
	readonly done: Promise<void>;
	readonly release: () => void;
}

/** Orders one Cursor run's exec frames like a local tool batch. */
export class CursorExecOrder {
	readonly #calls = new Map<string, OrderedCall>();
	readonly #closed = Promise.withResolvers<false>();

	/**
	 * Takes the call's place behind every unfinished call it must follow, and
	 * resolves once they are done. Must be called in frame arrival order. A call
	 * that already holds a place (a StrReplace's write frame) proceeds at once.
	 * Resolves `false` when the run closes first.
	 */
	enter(callId: string, exclusive: boolean): Promise<boolean> {
		if (this.#calls.has(callId)) return Promise.resolve(true);
		const blockers: Promise<void>[] = [];
		for (const call of this.#calls.values()) {
			if (exclusive || call.exclusive) blockers.push(call.done);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#calls.set(callId, { exclusive, done: promise, release: resolve });
		if (blockers.length === 0) return Promise.resolve(true);
		return Promise.race([Promise.all(blockers).then(() => true), this.#closed.promise]);
	}

	/** Gives up the call's place; calls waiting on it proceed. */
	leave(callId: string): void {
		const call = this.#calls.get(callId);
		if (!call) return;
		this.#calls.delete(callId);
		call.release();
	}

	/** Ends the run: every call still waiting resolves `false`. Call once no frame can arrive. */
	close(): void {
		this.#closed.resolve(false);
	}
}
