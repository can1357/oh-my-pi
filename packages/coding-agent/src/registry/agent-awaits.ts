/**
 * Which agents are blocked until other agents finish or message them, or
 * until the user answers, so a `wait` for a reply can tell when none can come
 * soon (the agent it asked is itself blocked on the asker, or on the user),
 * and an agent ending its turn can tell who stays blocked on it. Owned by the
 * {@link AgentRegistry} whose ids it names.
 */

/**
 * Stands in for the user among awaited ids: an agent with a dialog open that
 * waits for the user's answer (`ask`, a tool approval) holds on it. No agent id
 * can take this value.
 */
export const USER_AWAIT_ID = "@user";

interface AwaitHold {
	/** The block ends once any one of these finishes (or, for a {@link message} hold, messages the waiter). */
	awaited: readonly string[];
	since: number;
	/** A message ends this block (a `wait` tool call); otherwise only an awaited agent finishing does. */
	interruptible: boolean;
	/**
	 * The block waits for a message from an awaited agent (a reply, a parent's go), not for one
	 * to finish: an awaited agent ending its turn without messaging the waiter leaves it in place.
	 */
	message: boolean;
}

/** Options of {@link AgentAwaitsApi.hold}. */
export interface AwaitHoldOptions {
	/** A message ends this block (a `wait` tool call); otherwise only an awaited agent finishing does. */
	interruptible: boolean;
	/** The block waits for a message from an awaited agent, not for one to finish (see {@link AgentAwaitsApi.waitersOn}). */
	message?: boolean;
}

/** An agent blocked until a given agent acts; see {@link AgentAwaitsApi.waitersOn}. */
export interface AwaitWaiter {
	/** The blocked agent. */
	waiter: string;
	/** When the block began. */
	since: number;
	/** Agents between the waiter and the awaited agent on the chain of blocks, nearest the waiter first; empty when it waits directly. */
	via: readonly string[];
}

/** Public surface of {@link AgentAwaits}, implemented locally on main and by a proxy in workers. */
export interface AgentAwaitsApi {
	/** Record `waiter` blocked until the first of `awaited` finishes (or messages it); returns the release function. */
	hold(waiter: string, awaited: readonly string[], options: AwaitHoldOptions): () => void;
	/**
	 * Whether `agent` cannot act on a message `target` sent it at `sentAt` until `target` finishes;
	 * with `target` {@link USER_AWAIT_ID}, whether it cannot act on a message sent at `sentAt` until the user answers.
	 */
	blocksOn(agent: string, target: string, sentAt: number): boolean;
	/**
	 * The agents between `agent` and `target` on one chain of blocks when {@link blocksOn} holds
	 * (empty when `agent` waits on `target` directly), undefined when it does not.
	 */
	blockedVia(agent: string, target: string, sentAt: number): readonly string[] | undefined;
	/**
	 * Every agent blocked until `target` acts: one of its blocks waits on a message from `target`
	 * (a reply wait, a subagent's wait for its parent), directly or through agents blocked on it
	 * in turn. A block that waits for `target` to finish is left out: `target` ending its turn ends it.
	 */
	waitersOn(target: string): AwaitWaiter[];
	/** Subscribe to hold changes; returns the unsubscribe function. */
	onChange(listener: () => void): () => void;
}

export class AgentAwaits implements AgentAwaitsApi {
	readonly #holds = new Map<string, Set<AwaitHold>>();
	readonly #listeners = new Set<() => void>();

	/**
	 * Record `waiter` blocked until the first of `awaited` finishes, until the
	 * returned release runs. A block that waits for several agents together
	 * takes one hold per agent.
	 */
	hold(waiter: string, awaited: readonly string[], options: AwaitHoldOptions): () => void {
		if (awaited.length === 0) return () => {};
		const hold: AwaitHold = {
			awaited,
			since: Date.now(),
			interruptible: options.interruptible,
			message: options.message === true,
		};
		let holds = this.#holds.get(waiter);
		if (!holds) {
			holds = new Set();
			this.#holds.set(waiter, holds);
		}
		holds.add(hold);
		this.#emit();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.#holds.get(waiter);
			current?.delete(hold);
			if (current?.size === 0) this.#holds.delete(waiter);
			this.#emit();
		};
	}

	/**
	 * Whether `agent` cannot act on a message `target` sent it at `sentAt`
	 * until `target` finishes: one of its blocks waits only on `target`
	 * (directly, or through agents blocked on it in turn), and the message
	 * cannot end that block (it is not interruptible, or began after the
	 * message arrived).
	 */
	blocksOn(agent: string, target: string, sentAt: number): boolean {
		return this.blockedVia(agent, target, sentAt) !== undefined;
	}

	blockedVia(agent: string, target: string, sentAt: number): readonly string[] | undefined {
		for (const hold of this.#holds.get(agent) ?? []) {
			if (hold.interruptible && hold.since < sentAt) continue;
			const via = this.#chain(hold, target, new Set([agent]), false);
			if (via) return via;
		}
		return undefined;
	}

	waitersOn(target: string): AwaitWaiter[] {
		const waiters: AwaitWaiter[] = [];
		for (const [waiter, holds] of this.#holds) {
			if (waiter === target) continue;
			for (const hold of holds) {
				const via = this.#chain(hold, target, new Set([waiter]), true);
				if (!via) continue;
				waiters.push({ waiter, since: hold.since, via });
				break;
			}
		}
		return waiters;
	}

	/**
	 * The agents between the holder of `hold` and `target` when only `target`
	 * can end `hold`: every agent it awaits is `target` or finishes only after
	 * `target` does. With `messageHop`, a hold that awaits `target` itself must
	 * wait on a message from it. Undefined when another way out exists.
	 */
	#chain(hold: AwaitHold, target: string, path: ReadonlySet<string>, messageHop: boolean): string[] | undefined {
		let first: string[] | undefined;
		for (const id of hold.awaited) {
			const via =
				id === target ? (messageHop && !hold.message ? undefined : []) : this.#via(id, target, path, messageHop);
			if (!via) return undefined;
			first ??= via;
		}
		return first;
	}

	/** `id` and the agents after it on a chain of blocks that only `target` can end, or undefined. */
	#via(id: string, target: string, path: ReadonlySet<string>, messageHop: boolean): string[] | undefined {
		if (path.has(id)) return undefined;
		const next = new Set(path).add(id);
		for (const hold of this.#holds.get(id) ?? []) {
			const rest = this.#chain(hold, target, next, messageHop);
			if (rest) return [id, ...rest];
		}
		return undefined;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
