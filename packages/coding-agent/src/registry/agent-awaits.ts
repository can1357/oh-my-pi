/**
 * Which agents are blocked until other agents finish, or until the user
 * answers, so a `wait` for a reply can tell when none can come soon (the
 * agent it asked is itself blocked on the asker, or on the user), and an
 * idle `wait` can tell that an agent is blocked on the caller's result.
 * Owned by the {@link AgentRegistry} whose ids it names.
 *
 * A background job that is not one agent's run (a workpool's aggregate job,
 * a bash job) is a node of its own, named by {@link awaitNodeOfJob}: the
 * agents it waits on are recorded as its holds, so blocking on such a job
 * blocks on them too. Such nodes are never reported as waiters.
 */

/**
 * Stands in for the user among awaited ids: an agent with a dialog open that
 * waits for the user's answer (`ask`, a tool approval) holds on it. No agent id
 * can take this value.
 */
export const USER_AWAIT_ID = "@user";

const JOB_NODE_PREFIX = "\0job\0";

/** The node a waiter blocks on for `job`: the agent it runs, or the job's own node. */
export function awaitNodeOfJob(job: { id: string; ownerId?: string; agentId?: string }): string {
	return job.agentId ?? `${JOB_NODE_PREFIX}${job.ownerId ?? ""}\0${job.id}`;
}

interface AwaitHold {
	/** The block ends once any one of these finishes. */
	awaited: readonly string[];
	since: number;
	/** A message ends this block (a `wait` tool call); otherwise only an awaited agent finishing does. */
	interruptible: boolean;
}

/** Public surface of {@link AgentAwaits}, implemented locally on main and by a proxy in workers. */
export interface AgentAwaitsApi {
	/** Record `waiter` blocked until the first of `awaited` finishes; returns the release function. */
	hold(waiter: string, awaited: readonly string[], options: { interruptible: boolean }): () => void;
	/**
	 * Whether `agent` cannot act on a message `target` sent it at `sentAt` until `target` finishes;
	 * with `target` {@link USER_AWAIT_ID}, whether it cannot act on a message sent at `sentAt` until the user answers.
	 */
	blocksOn(agent: string, target: string, sentAt: number): boolean;
	/** Agents blocked until `target` finishes; only a message from `target` could end an interruptible block sooner. */
	waitersOn(target: string): string[];
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

	/**
	 * Agents that cannot finish until `target` does: one of their blocks waits
	 * only on `target` (directly, or through agents blocked on it in turn).
	 * Unlike {@link blocksOn}, an interruptible block counts too: a message
	 * could end it, but the caller idling for a message sends none.
	 */
	waitersOn(target: string): string[] {
		const waiters: string[] = [];
		for (const [agent, holds] of this.#holds) {
			if (agent === target || agent.startsWith(JOB_NODE_PREFIX)) continue;
			for (const hold of holds) {
				if (hold.awaited.every(id => this.#reaches(id, target, new Set([agent])))) {
					waiters.push(agent);
					break;
				}
			}
		}
		return waiters;
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

/** The job-manager surface {@link holdOwnedJobs} reads. */
interface OwnedJobSource {
	getRunningJobs(filter: { ownerId: string }): ReadonlyArray<{ id: string; ownerId?: string; agentId?: string }>;
	isDeliverySuppressed(jobId: string): boolean;
	onJobSettled(listener: () => void): () => void;
}

/** The registry surface {@link holdOwnedJobs} reads. */
interface AwaitRegistry {
	readonly awaits: AgentAwaitsApi;
	onChange(listener: () => void): () => void;
}

/**
 * Record agent `ownerId` blocked until each of its running background jobs
 * settles, until the returned release runs: for a run that cannot go on
 * before they do. One hold per job, kept current as jobs settle and as
 * agents register (a spawned job's agent registers with it). Jobs whose
 * delivery is suppressed are skipped, as `waitForOwnerJobs` skips them. The
 * holds are interruptible: a message still reaches the owner.
 *
 * Setting this up takes several holds and two subscriptions, and a worker's
 * registry answers each over a proxy. A failure part-way through releases
 * what it already took and throws: no caller holds the release function yet,
 * so a hold left behind could never be released and would go on telling other
 * agents that `ownerId` waits on a job it no longer does.
 */
export function holdOwnedJobs(registry: AwaitRegistry, manager: OwnedJobSource, ownerId: string): () => void {
	const holds = new Map<string, () => void>();
	const unsubscribers: Array<() => void> = [];
	const release = (): void => {
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		for (const releaseHold of holds.values()) releaseHold();
		holds.clear();
	};
	const sync = (): void => {
		const running = new Set<string>();
		for (const job of manager.getRunningJobs({ ownerId })) {
			if (manager.isDeliverySuppressed(job.id)) continue;
			running.add(job.id);
			if (!holds.has(job.id))
				holds.set(job.id, registry.awaits.hold(ownerId, [awaitNodeOfJob(job)], { interruptible: true }));
		}
		for (const [id, releaseHold] of holds) {
			if (running.has(id)) continue;
			releaseHold();
			holds.delete(id);
		}
	};
	try {
		sync();
		// One `push` per subscription: taking both in one expression evaluates
		// them before either is stored, so a second subscription that throws
		// leaves the first listener installed and unreachable, and it goes on
		// taking holds after this call ended.
		unsubscribers.push(manager.onJobSettled(sync));
		unsubscribers.push(registry.onChange(sync));
	} catch (error) {
		release();
		throw error;
	}
	return release;
}
