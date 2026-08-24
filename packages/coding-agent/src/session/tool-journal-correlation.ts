import type { ReplayableToolExecution } from "../presentation/journal";
import type { SessionEntry, ToolExecutionStartedEntry } from "./session-entries";

/**
 * The `reason` a dangling `started` journal record folds to.
 *
 * A {@link PersistedToolExecutionStarted} with no settlement is not a record of
 * *why* the call stopped — nothing wrote a reason, because nothing was running
 * to write one. So this states only what the journal actually proves: the
 * settlement record never landed. `hydrateReplayableToolExecution` turns it into
 * `ToolOutcome`'s `interrupted` arm, which renders `warning` severity and no
 * exit code — the honest shape for "neither succeeded nor a defect".
 */
export const DANGLING_TOOL_EXECUTION_REASON =
	"Interrupted: no settlement record was persisted before the process ended.";

/**
 * Fold one tool call's v4 journal records out of a session branch into the
 * {@link ReplayableToolExecution} `hydrateReplayableToolExecution` consumes,
 * or `undefined` when the branch holds no `started` record for `toolCallId`
 * at or before `upToIndex`.
 *
 * `undefined` is the *common* answer, not an error path: every pre-v4 session
 * and every call still on the `legacy_snapshot` protocol has zero
 * `tool_execution_started` entries (`AgentSession#trackToolPresentation` writes
 * one only for `presentation_events` calls), and the legacy policy for those
 * is that they replay from the settled body alone. A correlation that invented
 * a record for them would be fabricating structure the journal never carried.
 *
 * Scope: `entries` must be a **single branch path** —
 * `SessionManager#getBranch()`, the same leaf→root lineage
 * `buildSessionContext`/`buildTranscriptSessionContext` walk to produce the
 * messages a replay iterates. `SessionManager#getEntries()` is the flat
 * append-only array of *every* entry the file ever received, and
 * `SessionManager#branch()` explicitly never deletes the path it abandons, so a
 * rewound session's flat array holds records from lineages the transcript does
 * not contain. Passing it would let an abandoned branch's execution answer for
 * the active one.
 *
 * Pairing is by `executionId`, never by `toolCallId`: the `settled` arm carries
 * no `call`, and `executionId` is a locally minted `Bun.randomUUIDv7()` (see
 * `AgentSession#trackToolPresentation`), so exactly one `settled` record can
 * ever match a `started` one. `toolCallId`, by contrast, is provider-assigned
 * (`toolCall.id` off the model's response) and providers do recycle ids across
 * requests, so one branch can legitimately hold several *distinct executions*
 * of the same `toolCallId` — each with its own `started`/`settled` pair at a
 * different position in `entries`. A global "last `started` wins" answer would
 * be wrong for every occurrence except the newest: a chronological replay walk
 * asking about the *first* occurrence of a recycled id would get the *second*
 * execution's descriptor, outcome, presentation, and model projection back,
 * and the second execution's record would be replayed twice.
 *
 * `upToIndex` (default: the end of `entries`) is how a caller disambiguates:
 * it bounds the `started` search to `entries` at index `<= upToIndex`, so a
 * chronological walker — the only realistic consumer, since it is the only one
 * that knows *where in the branch* a given occurrence of the id was
 * encountered — passes the index it has reached so far and gets back the most
 * recent `started` record *as of that point*, not the newest one on the whole
 * branch. The `settled` search is never bounded: `executionId` is unique, so
 * finding its settlement anywhere in `entries` (necessarily at a later index,
 * since a call settles after it starts) cannot attach the wrong outcome.
 * Omitting `upToIndex` reproduces the single-occurrence common case (the
 * search covers the whole branch); a caller walking chronologically over a
 * branch that might contain a recycled id must supply it.
 *
 * Pure: two bounded/unbounded scans, no I/O, no clock, no logging, no repair
 * of malformed input.
 */
export function correlateReplayableToolExecution(
	entries: readonly SessionEntry[],
	toolCallId: string,
	upToIndex: number = entries.length - 1,
): ReplayableToolExecution | undefined {
	let started: ToolExecutionStartedEntry | undefined;
	for (let index = 0; index <= upToIndex && index < entries.length; index++) {
		const entry = entries[index];
		if (entry !== undefined && entry.type === "tool_execution_started" && entry.call.toolCallId === toolCallId) {
			started = entry;
		}
	}
	if (started === undefined) return undefined;

	const { executionId } = started;
	for (const entry of entries) {
		if (entry.type !== "tool_execution_settled" || entry.executionId !== executionId) continue;
		// `call` comes from the `started` record and `outcome`/`presentation`/
		// `modelProjection` from the `settled` one: that split is the journal's own
		// design ("start owns the call descriptor"), so the fold copies fields
		// rather than merging two descriptors that could disagree.
		return {
			state: "settled",
			call: started.call,
			outcome: entry.outcome,
			presentation: entry.presentation,
			modelProjection: entry.modelProjection,
		};
	}
	// A `started` record whose settlement never landed: the process died between
	// the journal's two writes, or the settlement was dropped for want of a frozen
	// model projection. Either way the branch ends mid-execution, and the explicit
	// `interrupted` state is what keeps every consumer from reconstructing that
	// dangling case on its own.
	return {
		state: "interrupted",
		call: started.call,
		reason: DANGLING_TOOL_EXECUTION_REASON,
		presentation: started.presentation,
	};
}

/**
 * A chronological message walk's position in one branch's v4 tool journal.
 *
 * {@link correlateReplayableToolExecution}'s `upToIndex` wants a *branch
 * position* per occurrence, but every consumer that has to supply one walks
 * `SessionContext.messages` (`buildTranscriptSessionContext`) rather than
 * `SessionEntry[]`, and an `AgentMessage` carries no back-reference to the entry
 * it was pushed from. This cursor bridges that without inventing one: the walk
 * meets a given `toolCallId`'s executions in exactly the order the branch
 * recorded their `tool_execution_started` entries, so the *k*-th encounter
 * resolves against the *k*-th recorded start. Chronology is the correspondence;
 * no timestamps are compared, no message content is matched, nothing is
 * reconciled.
 *
 * That correspondence is only sound when it is **total**: the branch must hold
 * exactly as many `started` records for an id as the replayed transcript holds
 * occurrences of it. A provider may recycle a `toolCallId` across turns, and if
 * only *some* of an id's occurrences were journaled (a session straddling the
 * v4 producer, or one occurrence on `legacy_snapshot` and another on
 * `presentation_events`) then nothing persisted says *which* occurrence a lone
 * record belongs to — neither the journal nor the message list records that.
 * Guessing is not a tie-break but data corruption: assigning a known-later
 * record to the first encounter renders the later call's title and output at the
 * earlier call's position and erases the earlier call's real history. So a
 * short (or over-long) pairing disqualifies the id entirely and **every** one of
 * its occurrences replays from its settled body through the legacy path, which
 * is the degraded-but-honest policy for records that cannot carry the
 * structure a consumer needs.
 */
export interface ReplayToolJournalCursor {
	/** The branch this cursor reads, lineage-scoped exactly as {@link correlateReplayableToolExecution} requires. */
	readonly branch: readonly SessionEntry[];
	/** Branch indices of every `tool_execution_started` entry, grouped by `call.toolCallId`, in branch order. */
	readonly startsByToolCallId: ReadonlyMap<string, readonly number[]>;
	/** How many times each `toolCallId` occurs as a tool call in the replayed transcript. */
	readonly transcriptOccurrences: ReadonlyMap<string, number>;
	/** How many encounters of each `toolCallId` the walk has consumed so far. */
	readonly consumed: Map<string, number>;
}

/**
 * Index one branch's `tool_execution_started` entries for a replay walk.
 *
 * `branch` MUST be `SessionManager#getBranch()` — see
 * {@link correlateReplayableToolExecution}'s scope note; the flat
 * `getEntries()` array carries abandoned lineages whose executions would
 * answer for the active one.
 *
 * `transcriptOccurrences` counts each `toolCallId`'s tool-call occurrences in
 * the *same* transcript the caller is about to walk, so the totality check in
 * {@link nextReplayableToolExecution} compares like with like. A caller that
 * derived it from a different message list than it walks would defeat the
 * check.
 */
export function createReplayToolJournalCursor(
	branch: readonly SessionEntry[],
	transcriptOccurrences: ReadonlyMap<string, number>,
): ReplayToolJournalCursor {
	const startsByToolCallId = new Map<string, number[]>();
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry === undefined || entry.type !== "tool_execution_started") continue;
		const starts = startsByToolCallId.get(entry.call.toolCallId);
		if (starts === undefined) startsByToolCallId.set(entry.call.toolCallId, [index]);
		else starts.push(index);
	}
	return { branch, startsByToolCallId, transcriptOccurrences, consumed: new Map() };
}

/**
 * Fold the journal records for the walk's *next* encounter of `toolCallId`, or
 * `undefined` when the branch cannot unambiguously back that encounter.
 *
 * `undefined` is the common answer: all pre-v4 history and every
 * `legacy_snapshot` call replay from their settled body alone, and so does
 * every occurrence of a recycled id whose journal coverage is partial
 * (see {@link ReplayToolJournalCursor}). When the pairing *is* total, the
 * encounter is counted and resolved against its own recorded start, so a
 * recycled id walks through its own executions in order instead of re-reading
 * one.
 */
export function nextReplayableToolExecution(
	cursor: ReplayToolJournalCursor,
	toolCallId: string,
): ReplayableToolExecution | undefined {
	const starts = cursor.startsByToolCallId.get(toolCallId);
	if (starts === undefined) return undefined;
	// Totality gate: one record per transcript occurrence, or nothing. Checked
	// before consuming an encounter, so a disqualified id resolves the same way
	// for every one of its occurrences no matter which is asked about first.
	if (starts.length !== cursor.transcriptOccurrences.get(toolCallId)) return undefined;
	const occurrence = cursor.consumed.get(toolCallId) ?? 0;
	cursor.consumed.set(toolCallId, occurrence + 1);
	const upToIndex = starts[occurrence];
	if (upToIndex === undefined) return undefined;
	return correlateReplayableToolExecution(cursor.branch, toolCallId, upToIndex);
}

/**
 * Pre-v4 replay lifecycle bookkeeping for one `#replaySessionHistory` walk.
 *
 * Every v4-journaled call's execution state comes exclusively from
 * `nextReplayableToolExecution` → `hydrateReplayableToolExecution` →
 * `reduceAcpToolView`; hydrated ids are deliberately *excluded* from the
 * announced set so the dangling-cleanup pass can never double-settle one.
 * These Sets therefore track only pre-v4 legacy `toolResult` messages, which
 * have no journal records to normalize — the "Legacy-history policy" of the
 * refactor plan (§3.8) mandates settled-body-only rendering for exactly those
 * sessions, forever.
 *
 * - `replayed`: ids dispatched at their assistant-turn occurrence (hydrated
 *   *or* legacy-announced), so the message walk's `toolResult` branch never
 *   re-attempts a start through its own args reconstruction.
 * - `announced`: ids that actually got a `tool_call` notification sent on the
 *   legacy path. Deliberately excludes hydrated ids — they carry their own
 *   reducer-owned settlement, so they must never enter the dangling cleanup.
 * - `resolved`: ids that reached a persisted `toolResult` message or a
 *   hydrated settlement/interruption during replay.
 */
export class ReplayToolCallBookkeeping {
	readonly #replayed = new Set<string>();
	readonly #announced = new Set<string>();
	readonly #resolved = new Set<string>();

	/** Record that this id was dispatched at its assistant-turn occurrence. */
	markReplayed(toolCallId: string): void {
		this.#replayed.add(toolCallId);
	}

	/** Whether this id was already dispatched at an earlier occurrence. */
	wasReplayed(toolCallId: string): boolean {
		return this.#replayed.has(toolCallId);
	}

	/** Record that a legacy `tool_call` notification actually went out for this id. */
	markAnnounced(toolCallId: string): void {
		this.#announced.add(toolCallId);
	}

	/** Whether a legacy announcement went out for this id. */
	wasAnnounced(toolCallId: string): boolean {
		return this.#announced.has(toolCallId);
	}

	/** Record that this id reached a settlement/interruption during replay. */
	markResolved(toolCallId: string): void {
		this.#resolved.add(toolCallId);
	}

	/**
	 * Announced ids with no resolution observed anywhere in the walk, in
	 * announcement order — the inputs for the synthetic-`failed` dangling
	 * cleanup. Hydrated ids are never announced, hence never appear here.
	 */
	danglingAnnouncedIds(): readonly string[] {
		return [...this.#announced].filter(toolCallId => !this.#resolved.has(toolCallId));
	}
}
