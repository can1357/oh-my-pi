/**
 * Which agents are blocked until other agents finish, so a `wait` for a
 * reply can tell when none can come: the agent it asked is itself blocked
 * on the asker. Owned by the {@link AgentRegistry} whose ids it names.
 */

interface AwaitHold {
	/** The block ends once any one of these finishes. */
	awaited: readonly string[];
	since: number;
	/** A message ends this block (a `wait` tool call); otherwise only an awaited agent finishing does. */
	interruptible: boolean;
}

export class AgentAwaits {
	readonly #holds = new Map<string, Set<AwaitHold>>();
	readonly #listeners = new Set<() => void>();

	/**
	 * Record `waiter` blocked until the first of `awaited` finishes, until the
	 * returned release runs. A block that waits for several agents together
	 * takes one hold per agent.
	 */
	hold(waiter: string, awaited: readonly string[], options: { interruptible: boolean }): () => void {
		if (awaited.length === 0) return () => {};
		const hold: AwaitHold = { awaited, since: Date.now(), interruptible: options.interruptible };
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
		for (const hold of this.#holds.get(agent) ?? []) {
			if (hold.interruptible && hold.since < sentAt) continue;
			if (hold.awaited.every(id => this.#reaches(id, target, new Set([agent])))) return true;
		}
		return false;
	}

	/** Whether `id` finishes only after `target` does. */
	#reaches(id: string, target: string, path: ReadonlySet<string>): boolean {
		if (id === target) return true;
		if (path.has(id)) return false;
		const next = new Set(path).add(id);
		for (const hold of this.#holds.get(id) ?? []) {
			if (hold.awaited.every(awaited => this.#reaches(awaited, target, next))) return true;
		}
		return false;
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
