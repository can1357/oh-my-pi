/**
 * Small pieces the runtime thread services share: callback and unsubscribe
 * shapes as they cross a link, quiet settling of fire-and-forget calls, and
 * per-worker cleanup of registrations workers made on main objects.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ThreadId } from "../identity";
import { rpcSync } from "../rpc";

/** Fire-and-forget callback the other thread may implement asynchronously. */
export type WireCallback<A extends unknown[]> = (...args: A) => void | Promise<void>;

/** Unsubscribe handed back across the link; may return a promise on the receiving side. */
export type WireUnsubscribe = () => void | Promise<void>;

/** Swallow a rejection of a fire-and-forget cross-thread call (closed link, dead receiver). */
export function ignoreSettle(result: unknown): void {
	if (result instanceof Promise) result.catch(() => {});
}

/** Wrap an unsubscribe received from main as a plain sync one. */
export function localUnsubscribe(unsubscribe: WireUnsubscribe): () => void {
	return () => ignoreSettle(unsubscribe());
}

/**
 * `off` as a run-once function that forgets `off` after it ran. A worker that subscribed
 * keeps its proxy of the returned function for as long as its own listener's scope
 * lives, while `off` usually holds main's proxy of that listener: each thread's export
 * would keep the other's alive forever (neither GC sees the cycle) unless main lets go
 * of `off` once the subscription ended.
 */
export function releasingOnce(off: () => void): () => void {
	let pending: (() => void) | undefined = off;
	return () => {
		const run = pending;
		pending = undefined;
		run?.();
	};
}

/**
 * Track a subscription a worker holds on a main object in `subscriptions` (released when
 * the worker exits); returns its unsubscribe, run-once and synchronous for the worker.
 */
export function trackWorkerSubscription(subscriptions: Set<() => void>, off: () => void): () => void {
	const unsubscribe = releasingOnce(() => {
		subscriptions.delete(unsubscribe);
		off();
	});
	subscriptions.add(unsubscribe);
	return rpcSync(unsubscribe);
}

/**
 * Undo functions of one service's worker registrations (listeners, sinks,
 * subscriptions), by worker; released when the worker exits so main never
 * calls into a closed link forever.
 */
export class PeerCleanups {
	readonly #name: string;
	readonly #byPeer = new Map<ThreadId, Set<() => void>>();

	constructor(name: string) {
		this.#name = name;
	}

	/** Track `off` for `threadId`'s lifetime; the returned function runs it at most once. */
	track(threadId: ThreadId, off: () => void): () => void {
		let cleanups = this.#byPeer.get(threadId);
		if (!cleanups) {
			cleanups = new Set();
			this.#byPeer.set(threadId, cleanups);
		}
		const owner = cleanups;
		const stop = releasingOnce(() => {
			owner.delete(stop);
			off();
		});
		owner.add(stop);
		return stop;
	}

	/** Run and forget every cleanup tracked for `threadId`. */
	release(threadId: ThreadId): void {
		const cleanups = this.#byPeer.get(threadId);
		this.#byPeer.delete(threadId);
		for (const stop of Array.from(cleanups ?? [])) {
			try {
				stop();
			} catch (error) {
				logger.warn("Thread service cleanup failed", { service: this.#name, threadId, error: String(error) });
			}
		}
	}
}
