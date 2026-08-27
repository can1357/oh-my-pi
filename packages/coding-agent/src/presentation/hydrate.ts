import type {
	RetainedStreamGap,
	RetainedStreamView,
	ToolPresentationEvent,
} from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf, byteOffset, sequence } from "@oh-my-pi/pi-agent-core/presentation";
import type { ReplayableToolExecution } from "./journal";

/**
 * The versioned hydration adapter: one {@link ReplayableToolExecution} in, the
 * canonical {@link ToolPresentationEvent} sequence out.
 *
 * `session/load`, branch, rewind/fork and compaction all replay a persisted call
 * by feeding this sequence through the *same* `reduceAcpToolView` live execution
 * uses. That is the whole point: there is no replay-specific reducer, no
 * replay-specific frame builder, and therefore no second lifecycle to drift.
 * Replay differs from live only in the `AcpRenderContext` phase — which is why
 * this function takes no context: the event sequence is a property of the record,
 * not of the client's capabilities, and a producer that varied its events by
 * render mode is exactly the coupling the redesign removes.
 *
 * What a record can and cannot say
 * --------------------------------
 * `ToolPresentationRecord` is the *reduced* retention of a live run, never its
 * event log: one retained stream window, the ordered facts, the ordered
 * attachments. So chunk granularity is gone — a run that emitted 400 appends
 * retains one window, and this adapter replays it as one append (or one per
 * declared gap boundary, below). The reducer's rendered body is identical either
 * way, because a body is the concatenation of its chunks; only the *number* of
 * live progress frames differs, and a replayed call has no progress to stream.
 * Reconstructing synthetic chunk boundaries would be fabricating byte ranges
 * nothing recorded, which is the degraded-but-honest line this adapter draws for
 * legacy replay and which applies just as much here.
 *
 * Gap placement, on the other hand, *is* recoverable exactly whenever the
 * retained window is complete: `RetainedStreamGap` carries absolute byte ranges,
 * so `retainedBytes + droppedBytes === endByte - startByte` proves the retained
 * text is precisely the delivered bytes of that window and each gap's offset
 * inside it is arithmetic, not inference. {@link splitRetainedRuns} does that
 * arithmetic and falls back to "body first, declared discontinuities after" when
 * the record cannot support it (retention elided a middle, so the record already
 * says so with a truncation fact). Neither branch diffs, reconciles, or scans
 * text: the only inputs are declared byte counts.
 *
 * Coordinates are rebased to 0. The reducer asserts `startByte === cursor` from
 * an initial cursor of 0, so a window that starts mid-stream (`startByte > 0`, a
 * tail-retaining producer) can only be replayed as its own dense stream. When the
 * window does start at 0 and is complete, the rebased offsets are byte-identical
 * to the live ones. Stream *identity* is preserved verbatim either way.
 *
 * Two live-only event kinds are absent by construction and not by omission:
 * `live_terminal_attached` (a `LiveTerminalBinding` has no serializer, so no
 * record can carry one) and `display_output` (the record retains no display
 * sequence — the same thing `renderModelContent` already loses on a persisted
 * record, so replay is no worse than the model history beside it).
 *
 * Record versioning is enforced at the parse boundary, not here:
 * `validateToolJournalEntry` (`../session/session-loader.ts`) safeParses every
 * `tool_execution_started`/`tool_execution_settled` raw entry against
 * `persistedToolJournalSchema` before it becomes a `SessionEntry`, on both
 * loader paths. A future v2 record (top-level `recordVersion` or a nested
 * `presentation`/`modelProjection` version) throws `SessionJournalTooNewError`
 * instead of reaching this function silently misread; a malformed
 * current-version record throws `JournalRecordValidationError`. When a second
 * version exists, this adapter gains an explicit arm per version.
 */
export function hydrateReplayableToolExecution(execution: ReplayableToolExecution): readonly ToolPresentationEvent[] {
	// `started` is first and unconditional: the agent loop alone emits it live, and
	// on replay this adapter stands in for the loop. `ToolCallRecord` is the
	// persisted-safe `ToolCallPresentation` (no `awaitsLiveTerminal`), so the call
	// descriptor crosses without a conversion that could drop a field — and a
	// replayed execute call therefore selects the display-only meta terminal rather
	// than promising a client-owned one nobody can attach.
	const events: ToolPresentationEvent[] = [{ type: "started", call: execution.call }];

	if (execution.state === "interrupted") {
		// A dangling `started`: the process died between the journal's two records.
		// This settles through the reducer's existing machinery — `ToolOutcome`'s
		// `interrupted` arm already means "neither succeeded nor a defect", renders
		// `warning` severity, reports no exit code, and maps to a failed ACP status.
		// No new reducer state, and no card left running forever.
		for (const fact of execution.presentation.facts) events.push({ type: "fact", fact });
		events.push({ type: "settled", outcome: { kind: "interrupted", reason: execution.reason } });
		return events;
	}

	const { stream, facts, attachments } = execution.presentation;
	if (stream !== undefined) events.push(...hydrateRetainedStream(stream));
	// Facts follow the stream because that is where a live run declares them:
	// `OutputSink.dump()` annotations, truncation windows and wall time are all known
	// only once the bytes stopped. The record keeps no fact-to-offset correlation, so
	// a fact that *was* interleaved mid-stream live replays after the body — visible
	// only on a terminal channel, where facts ride as trailing `terminal_output`
	// bytes rather than being composed into the settlement snapshot.
	for (const fact of facts) events.push({ type: "fact", fact });
	for (const attachment of attachments) events.push({ type: "attachment", attachment });
	events.push({ type: "settled", outcome: execution.outcome });
	return events;
}

/** One delivered text run and the declared discontinuity that follows it. */
interface RetainedRun {
	readonly text: string;
	readonly droppedBytes: number;
}

/**
 * Replay a retained window as appends and declared gaps over a dense stream that
 * starts at byte 0, keeping the record's own stream identity.
 */
function hydrateRetainedStream(stream: RetainedStreamView): readonly ToolPresentationEvent[] {
	const events: ToolPresentationEvent[] = [];
	let cursor = 0;
	let nextSequence = 0;
	for (const run of splitRetainedRuns(stream)) {
		if (run.text.length > 0) {
			events.push({
				type: "terminal_append",
				streamId: stream.streamId,
				sequence: sequence(nextSequence++),
				startByte: byteOffset(cursor),
				data: run.text,
			});
			cursor += byteLengthOf(run.text);
		}
		if (run.droppedBytes > 0) {
			const fromByte = byteOffset(cursor);
			cursor += run.droppedBytes;
			events.push({
				type: "terminal_gap",
				streamId: stream.streamId,
				sequence: sequence(nextSequence++),
				fromByte,
				toByte: byteOffset(cursor),
			});
		}
	}
	return events;
}

/**
 * Cut the retained text at the declared gap boundaries, when the record proves
 * where they are.
 *
 * The proof is `byteLength(text) + Σ dropped === endByte - startByte`: the window
 * accounts for every one of its bytes as either retained or explicitly dropped,
 * so the retained text *is* the delivered bytes in order and each gap sits at a
 * computable offset in it. Anything else — a middle-elided window, an out-of-
 * order or non-positive range, a boundary that would split a UTF-8 sequence —
 * yields the degraded shape: the whole body, then each declared discontinuity in
 * order. Their byte counts stay exact (that is what the notice reports); only
 * their position is lost, on a record that already declares itself incomplete.
 */
function splitRetainedRuns(stream: RetainedStreamView): readonly RetainedRun[] {
	const gaps = [...stream.gaps].sort((left, right) => left.fromByte - right.fromByte);
	if (gaps.length === 0) return [{ text: stream.text, droppedBytes: 0 }];

	const bytes = Buffer.from(stream.text, "utf-8");
	if (bytes.length + totalDropped(gaps) !== stream.endByte - stream.startByte) return degradedRuns(stream.text, gaps);

	const runs: RetainedRun[] = [];
	let cut = 0;
	let droppedSoFar = 0;
	for (const gap of gaps) {
		const droppedBytes = gap.toByte - gap.fromByte;
		if (droppedBytes <= 0) return degradedRuns(stream.text, gaps);
		const boundary = gap.fromByte - stream.startByte - droppedSoFar;
		if (boundary < cut || boundary > bytes.length) return degradedRuns(stream.text, gaps);
		const text = bytes.subarray(cut, boundary).toString("utf-8");
		// A cut through a multi-byte sequence decodes to U+FFFD and changes length.
		// Refusing it keeps replay from inventing replacement characters the live
		// stream never carried.
		if (byteLengthOf(text) !== boundary - cut) return degradedRuns(stream.text, gaps);
		runs.push({ text, droppedBytes });
		cut = boundary;
		droppedSoFar += droppedBytes;
	}
	const tail = bytes.subarray(cut).toString("utf-8");
	if (byteLengthOf(tail) !== bytes.length - cut) return degradedRuns(stream.text, gaps);
	if (tail.length > 0) runs.push({ text: tail, droppedBytes: 0 });
	return runs;
}

/** Total bytes the record says were produced but never delivered. */
function totalDropped(gaps: readonly RetainedStreamGap[]): number {
	let total = 0;
	for (const gap of gaps) total += gap.toByte - gap.fromByte;
	return total;
}

/**
 * The body, then each declared discontinuity, positions unrecoverable.
 *
 * Each gap stays its own run rather than being summed: the record declares *k*
 * discontinuities of known size, and collapsing them into one would assert a
 * single larger drop that never happened.
 */
function degradedRuns(text: string, gaps: readonly RetainedStreamGap[]): readonly RetainedRun[] {
	return [{ text, droppedBytes: 0 }, ...gaps.map(gap => ({ text: "", droppedBytes: gap.toByte - gap.fromByte }))];
}
