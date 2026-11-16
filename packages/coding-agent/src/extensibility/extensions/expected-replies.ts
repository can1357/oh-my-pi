/**
 * Replies a session's agent awaits from peers its own tools cannot see, recorded by extensions
 * through `pi.replies.expect` (a bridge to agents in other processes). The `wait` tool counts them
 * as replies the caller is owed, alongside unanswered IRC questions.
 */

interface ExpectedReply {
	readonly peerId: string;
	readonly promised: boolean;
	/** The run it was recorded in ({@link ExpectedReplies.beginRun}); an unpromised one counts only there. */
	readonly run: number;
	/** Recording order in this store; {@link ExpectedReplies.mark} bounds a {@link ExpectedReplies.clear}. */
	readonly sequence: number;
	/** The recording extension load is suspended: the expectation owes nothing until it resumes. */
	suspended: boolean;
	readonly onDrop: (() => void) | undefined;
}

/** Options for {@link ExpectedReplies.expect}. */
export interface ExpectedReplyOptions {
	/** The peer promised a later answer: the expectation outlives the run it was recorded in. */
	promised?: boolean;
	/** Record it suspended, as for an extension load that is suspended now. */
	suspended?: boolean;
	/** Called when the store drops the expectation itself ({@link ExpectedReplies.clear}); not on release. */
	onDrop?: () => void;
}

/**
 * One recorded expectation. Shaped as an extension registration, so the recording load's
 * lifecycle can drive it: `release` drops it for good (idempotent; true only if this call dropped
 * a recorded expectation); `suspend(true)` stops it counting until `suspend(false)`.
 */
export interface ExpectedReplyHandle {
	release(): boolean;
	suspend(suspended: boolean): void;
}

/**
 * Marks ({@link ExpectedReplies.mark}) bounding the expectations {@link ExpectedReplies.clear}
 * drops: those recorded from `recordedFrom` and before `recordedBefore`; unbounded sides by default.
 */
export interface ExpectedRepliesRange {
	recordedFrom?: number;
	recordedBefore?: number;
}

/**
 * One session's expected replies. Owned by the session's extension runtime, so expectations of
 * one session never reach another session's `wait`, whatever agent ids the two carry.
 */
export class ExpectedReplies {
	readonly #entries = new Set<ExpectedReply>();
	readonly #listeners = new Set<() => void>();
	#sequence = 0;
	#run = 0;

	/**
	 * A point in recording order: expectations recorded before it compare below it, those recorded
	 * from it on at or above. Exact where a clock is not (two expectations, or an expectation and a
	 * checkpoint, can share a millisecond).
	 */
	mark(): number {
		return this.#sequence;
	}

	/** Record that the agent awaits a reply from `peerId`. Each call is its own expectation. */
	expect(peerId: string, options?: ExpectedReplyOptions): ExpectedReplyHandle {
		const entry: ExpectedReply = {
			peerId,
			promised: options?.promised === true,
			run: this.#run,
			sequence: this.#sequence++,
			suspended: options?.suspended === true,
			onDrop: options?.onDrop,
		};
		this.#entries.add(entry);
		if (!entry.suspended) this.#notify();
		return {
			release: () => {
				if (!this.#entries.delete(entry)) return false;
				if (!entry.suspended) this.#notify();
				return true;
			},
			suspend: suspended => {
				if (entry.suspended === suspended || !this.#entries.has(entry)) return;
				entry.suspended = suspended;
				this.#notify();
			},
		};
	}

	/**
	 * The session's agent started a run (it went from idle to running). Unpromised expectations
	 * recorded before it owe this run nothing; a token rather than a clock reading, which can tie.
	 */
	beginRun(): void {
		this.#run++;
	}

	/**
	 * Peers still awaited, each once, by the current run: an unpromised expectation recorded in an
	 * earlier run owes this one nothing, and a suspended one owes nothing until it resumes.
	 */
	pending(): string[] {
		const peers = new Set<string>();
		for (const entry of this.#entries) {
			if (!entry.suspended && (entry.promised || entry.run === this.#run)) peers.add(entry.peerId);
		}
		return [...peers];
	}

	/**
	 * Drop the expectations recorded in `range` (marks; every one by default): the session's
	 * conversation was replaced (`/new`, a resume, a branch, `/clear`, …) or cut back to before they
	 * were asked (a rewind), so its agent no longer asked those peers. Each dropped expectation's
	 * `onDrop` runs, and its handle becomes a no-op whose release returns false.
	 */
	clear(range?: ExpectedRepliesRange): void {
		const from = range?.recordedFrom ?? 0;
		const before = range?.recordedBefore ?? Number.POSITIVE_INFINITY;
		const dropped = [...this.#entries].filter(entry => entry.sequence >= from && entry.sequence < before);
		for (const entry of dropped) this.#entries.delete(entry);
		for (const entry of dropped) entry.onDrop?.();
		if (dropped.some(entry => !entry.suspended)) this.#notify();
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
