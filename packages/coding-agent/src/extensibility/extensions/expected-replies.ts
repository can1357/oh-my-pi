/**
 * Replies a session's agent awaits from peers its own tools cannot see, recorded by extensions
 * through `pi.replies.expect` (a bridge to agents in other processes). The `wait` tool counts them
 * as replies the caller is owed, alongside unanswered IRC questions.
 */

interface ExpectedReply {
	readonly peerId: string;
	readonly promised: boolean;
	/** Epoch ms the expectation was recorded; an unpromised one counts only in the run it was recorded in. */
	readonly since: number;
	/** The recording extension load is suspended: the expectation owes nothing until it resumes. */
	suspended: boolean;
}

/** Options for {@link ExpectedReplies.expect}. */
export interface ExpectedReplyOptions {
	/** The peer promised a later answer: the expectation outlives the run it was recorded in. */
	promised?: boolean;
	/** Record it suspended, as for an extension load that is suspended now. */
	suspended?: boolean;
}

/**
 * One recorded expectation. Shaped as an extension registration, so the recording load's
 * lifecycle can drive it: `release` drops it for good (idempotent); `suspend(true)` stops it
 * counting until `suspend(false)`.
 */
export interface ExpectedReplyHandle {
	release(): void;
	suspend(suspended: boolean): void;
}

/**
 * One session's expected replies. Owned by the session's extension runtime, so expectations of
 * one session never reach another session's `wait`, whatever agent ids the two carry.
 */
export class ExpectedReplies {
	readonly #entries = new Set<ExpectedReply>();
	readonly #listeners = new Set<() => void>();

	/** Record that the agent awaits a reply from `peerId`. Each call is its own expectation. */
	expect(peerId: string, options?: ExpectedReplyOptions): ExpectedReplyHandle {
		const entry: ExpectedReply = {
			peerId,
			promised: options?.promised === true,
			since: Date.now(),
			suspended: options?.suspended === true,
		};
		this.#entries.add(entry);
		if (!entry.suspended) this.#notify();
		return {
			release: () => {
				if (this.#entries.delete(entry) && !entry.suspended) this.#notify();
			},
			suspend: suspended => {
				if (entry.suspended === suspended || !this.#entries.has(entry)) return;
				entry.suspended = suspended;
				this.#notify();
			},
		};
	}

	/**
	 * Peers still awaited, each once, by a run that started at `runStartedAt` (0 when unknown):
	 * an unpromised expectation recorded before the run started owes the run nothing, and a
	 * suspended one owes nothing until it resumes.
	 */
	pending(runStartedAt: number): string[] {
		const peers = new Set<string>();
		for (const entry of this.#entries) {
			if (!entry.suspended && (entry.promised || entry.since >= runStartedAt)) peers.add(entry.peerId);
		}
		return [...peers];
	}

	/** Subscribe to expectations starting or stopping to count; returns the unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
