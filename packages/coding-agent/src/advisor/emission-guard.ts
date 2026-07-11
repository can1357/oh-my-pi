/**
 * Per-session policy gate for advisor `advise()` calls.
 *
 * The advisor system prompt tells the watcher model:
 *
 * > at most one `advise` per update
 * > NEVER repeat advice you already gave, and NEVER send the same advice twice
 *
 * Real advisor models violate this. Issue #3520 captured a session where
 * `__advisor.jsonl` recorded 309 `advise` calls covering 92 unique notes —
 * 114× `Stop.`, 52× `No issue; continue.`, 41× `Done.` — flooding the primary
 * transcript with `<advisory severity="blocker">Stop.</advisory>` after the
 * task was already complete. The fix is to make the rules load-bearing in code
 * instead of prose: silently drop duplicates, content-free self-talk, and
 * over-budget calls at the `enqueueAdvice` boundary so the primary stays
 * clean even when the advisor misbehaves.
 *
 * The gate is intentionally invisible to the advisor model — `AdviseTool`
 * still returns `Recorded.` for a suppressed call. Surfacing "suppressed"
 * back into advisor context risks the model rephrasing the same useless note
 * to bypass the dedupe ("Stop.", then "Halt." then "Stop now.").
 */

/**
 * Case-insensitive, punctuation-folded normalization. Collapses every run of
 * non-letter / non-digit characters into a single space and trims, so
 * `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`, while
 * `"No issue; continue."` keys to `no issue continue`.
 *
 * Exported for tests.
 */
export function normalizeAdvisorNote(note: string): string {
	return note
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Normalized phrases the advisor occasionally emits that carry no concrete
 * actionable content. Each must be the output of {@link normalizeAdvisorNote}
 * so a single membership check covers every punctuation/casing variant
 * (`"Stop."`, `"stop"`, `"STOP!"`).
 *
 * The list is conservative — only short, content-free filler the reporter
 * observed driving primary-transcript pollution. A genuine `blocker` like
 * `"Stop: 'await' missing on writeStream.end() will lose buffered writes."`
 * does not match.
 */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	// Self-stop noise — telling the agent to "stop" without a reason is useless.
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	// Completion self-talk — the agent already finished the task.
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	// "Nothing to flag" — silence is the correct expression of "no concerns".
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	// Endorsements — equivalent to silence.
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

/**
 * Bounds the dedupe history. Sessions with very long advisor activity could
 * otherwise grow the set without bound. The reporter's pathological session
 * had 92 unique notes; 4096 leaves headroom while staying tiny (≤ ~256 KB of
 * normalized strings even at long max).
 */
const DEFAULT_HISTORY_CAPACITY = 4096;

/**
 * Decides whether an advisor `advise()` call should reach the primary agent.
 *
 * Enforces — in this order — the noise filter, session-scoped exact-text
 * dedupe (FIFO-evicted at {@link DEFAULT_HISTORY_CAPACITY}), and a per-update
 * rate limit of one accepted note per advisor model prompt. Suppressed calls
 * never consume the per-update budget — a noise call doesn't burn the slot
 * for a real concern that follows in the same update.
 *
 * Reset on advisor reset (compaction, session switch, `/new`) via
 * {@link reset}. Per-update gate is cleared at the start of every advisor
 * `agent.prompt()` cycle via {@link beginUpdate}.
 */
export class AdvisorEmissionGuard {
	#seen = new Set<string>();
	/** Insertion-order log to drive FIFO eviction without an extra Map. */
	#seenOrder: string[] = [];
	#consumedThisUpdate = false;
	readonly #capacity: number;

	constructor(opts: { capacity?: number } = {}) {
		this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
	}

	/**
	 * Drop all dedupe and per-update state. Called from
	 * `AgentSession#resetAdvisorSessionState()` whenever the advisor runtime is
	 * reset — same boundary as `yieldQueue.clear("advisor")`, so a re-primed
	 * advisor can re-raise old issues (the primary transcript was rewritten).
	 */
	reset(): void {
		this.#seen.clear();
		this.#seenOrder.length = 0;
		this.#consumedThisUpdate = false;
	}

	/**
	 * Clear the per-update rate-limit gate. Called by `AdvisorRuntime` right
	 * before each `agent.prompt(batch)` invocation so the next advisor model
	 * cycle starts with a fresh budget of one advise.
	 */
	beginUpdate(): void {
		this.#consumedThisUpdate = false;
	}

	/**
	 * Whether the proposed note should reach the primary. On `true` the gate
	 * has already recorded the note (consumed the per-update budget and added
	 * it to the dedupe history) — caller delivers the note. On `false` the
	 * caller drops it.
	 *
	 * Empty / whitespace-only notes are suppressed; the model's
	 * tool-args contract still requires a non-empty string but defense-in-depth.
	 */
	accept(note: string): boolean {
		const key = normalizeAdvisorNote(note);
		if (!key) return false;
		if (SUPPRESSED_NORMALIZED_PHRASES[key]) return false;
		if (this.#seen.has(key)) return false;
		if (this.#consumedThisUpdate) return false;
		this.#consumedThisUpdate = true;
		this.#seen.add(key);
		this.#seenOrder.push(key);
		if (this.#seenOrder.length > this.#capacity) {
			const stale = this.#seenOrder.shift();
			if (stale !== undefined) this.#seen.delete(stale);
		}
		return true;
	}
}
