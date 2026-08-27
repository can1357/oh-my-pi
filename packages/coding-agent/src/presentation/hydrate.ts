import type {
	RetainedDisplay,
	RetainedStreamGap,
	RetainedStreamView,
	ToolDisplayOutput,
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
 * attachments, the ordered displays. So chunk granularity is gone — a run that
 * emitted 400 appends retains one window, and this adapter replays it as one
 * append (or one per declared gap/display boundary, below). The reducer's
 * rendered body is identical either way, because a body is the concatenation of
 * its chunks; only the *number* of live progress frames differs, and a replayed
 * call has no progress to stream. Reconstructing synthetic chunk boundaries
 * would be fabricating byte ranges nothing recorded, which is the
 * degraded-but-honest line this adapter draws for legacy replay and which
 * applies just as much here.
 *
 * Gap placement, on the other hand, *is* recoverable exactly whenever the
 * retained window is complete: `RetainedStreamGap` carries absolute byte ranges,
 * so `retainedBytes + droppedBytes === endByte - startByte` proves the retained
 * text is precisely the delivered bytes of that window and each gap's offset
 * inside it is arithmetic, not inference. The same proof extends to
 * `RetainedDisplay.atByte`: a display's cursor snapshot at
 * fold time is itself a point in that same byte accounting, so
 * {@link splitRetainedTimeline} places gaps and displays together and falls
 * back to "body first, declared discontinuities, then displays in declaration
 * order" only when the record cannot support exact placement (retention elided
 * a middle, so the record already says so with a truncation fact). Neither
 * branch diffs, reconciles, or scans text: the only inputs are declared byte
 * counts. Displays never lose *items* to a degraded placement, only position —
 * a truncated retained window still replays every display it folded, exactly
 * as the truncation fact never drops bytes it can otherwise account for.
 *
 * Coordinates are rebased to 0. The reducer asserts `startByte === cursor` from
 * an initial cursor of 0, so a window that starts mid-stream (`startByte > 0`, a
 * tail-retaining producer) can only be replayed as its own dense stream. When the
 * window does start at 0 and is complete, the rebased offsets are byte-identical
 * to the live ones. Stream *identity* is preserved verbatim either way.
 *
 * One live-only event kind is absent by construction and not by omission:
 * `live_terminal_attached` — a `LiveTerminalBinding` has no serializer, so no
 * record can carry one.
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

	const { stream, facts, attachments, displays = [] } = execution.presentation;
	if (stream !== undefined) {
		events.push(...hydrateRetainedStream(stream, displays));
	} else {
		// No stream ever opened (a display-only call, e.g. an eval run whose first
		// cell produced no process bytes before its first `display()`): every
		// display's `atByte` is necessarily 0, so declaration order alone places
		// them correctly — there is no byte range to rebase against.
		for (const retained of displays) events.push({ type: "display_output", display: retained.display });
	}
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

/** One placed item in the replayed retained-window timeline. */
type RetainedSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "gap"; readonly droppedBytes: number }
	| { readonly kind: "display"; readonly display: ToolDisplayOutput };

/**
 * Replay a retained window and its displays as appends, declared gaps, and
 * `display_output` events over a dense stream that starts at byte 0, keeping
 * the record's own stream identity.
 */
function hydrateRetainedStream(
	stream: RetainedStreamView,
	displays: readonly RetainedDisplay[],
): readonly ToolPresentationEvent[] {
	const events: ToolPresentationEvent[] = [];
	let cursor = 0;
	let nextSequence = 0;
	for (const segment of splitRetainedTimeline(stream, displays) ?? degradedSegments(stream, displays)) {
		switch (segment.kind) {
			case "text": {
				if (segment.text.length === 0) break;
				events.push({
					type: "terminal_append",
					streamId: stream.streamId,
					sequence: sequence(nextSequence++),
					startByte: byteOffset(cursor),
					data: segment.text,
				});
				cursor += byteLengthOf(segment.text);
				break;
			}
			case "gap": {
				const fromByte = byteOffset(cursor);
				cursor += segment.droppedBytes;
				events.push({
					type: "terminal_gap",
					streamId: stream.streamId,
					sequence: sequence(nextSequence++),
					fromByte,
					toByte: byteOffset(cursor),
				});
				break;
			}
			case "display":
				events.push({ type: "display_output", display: segment.display });
				break;
			default: {
				const exhaustive: never = segment;
				throw new Error(`Unhandled retained segment: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	return events;
}

/**
 * Cut the retained text at the declared gap boundaries and each display's
 * `atByte`, when the record proves where they all are — the same proof
 * `splitRetainedRuns` used before displays existed, extended to a second kind
 * of declared offset.
 *
 * The proof is `byteLength(text) + Σ dropped === endByte - startByte`: the
 * window accounts for every one of its bytes as either retained or explicitly
 * dropped, so the retained text *is* the delivered bytes in order and each
 * declared offset inside it is arithmetic. A display's `atByte` is always a
 * cursor snapshot the live fold took — 0, an append's post-cursor, or a gap's
 * `toByte` — never a point strictly inside an append run or a gap's dropped
 * range; failing to land on a computable cut (out of bounds, or inside a
 * drop) means the same thing an inconsistent gap does: the window cannot
 * honestly place it, and the caller degrades everything. A middle-elided
 * window, an out-of-order or non-positive gap range, or a boundary that would
 * split a UTF-8 sequence all yield `undefined` for the same reason.
 *
 * Ties between a display and a gap that start at the same absolute byte sort
 * the display first: the live fold captured the display's cursor snapshot
 * strictly before whatever event next advanced the cursor to that value.
 */
function splitRetainedTimeline(
	stream: RetainedStreamView,
	displays: readonly RetainedDisplay[],
): readonly RetainedSegment[] | undefined {
	const gaps = [...stream.gaps].sort((left, right) => left.fromByte - right.fromByte);
	const bytes = Buffer.from(stream.text, "utf-8");
	if (bytes.length + totalDropped(gaps) !== stream.endByte - stream.startByte) return undefined;

	type Marker =
		| { readonly at: number; readonly kind: "gap"; readonly gap: RetainedStreamGap }
		| { readonly at: number; readonly kind: "display"; readonly display: ToolDisplayOutput };
	// Displays first in the unsorted array: `Array.prototype.sort` is stable, so an
	// exact tie on `at` keeps the display ahead of the gap (see the doc comment).
	const markers: Marker[] = [
		...displays.map((retained): Marker => ({ at: retained.atByte, kind: "display", display: retained.display })),
		...gaps.map((gap): Marker => ({ at: gap.fromByte, kind: "gap", gap })),
	];
	markers.sort((left, right) => left.at - right.at);

	const segments: RetainedSegment[] = [];
	let cut = 0;
	let droppedSoFar = 0;
	for (const marker of markers) {
		const boundary = marker.at - stream.startByte - droppedSoFar;
		if (boundary < cut || boundary > bytes.length) return undefined;
		const text = bytes.subarray(cut, boundary).toString("utf-8");
		// A cut through a multi-byte sequence decodes to U+FFFD and changes length.
		// Refusing it keeps replay from inventing replacement characters the live
		// stream never carried.
		if (byteLengthOf(text) !== boundary - cut) return undefined;
		if (text.length > 0) segments.push({ kind: "text", text });
		if (marker.kind === "gap") {
			const droppedBytes = marker.gap.toByte - marker.gap.fromByte;
			if (droppedBytes <= 0) return undefined;
			segments.push({ kind: "gap", droppedBytes });
			droppedSoFar += droppedBytes;
		} else {
			segments.push({ kind: "display", display: marker.display });
		}
		cut = boundary;
	}
	const tail = bytes.subarray(cut).toString("utf-8");
	if (byteLengthOf(tail) !== bytes.length - cut) return undefined;
	if (tail.length > 0) segments.push({ kind: "text", text: tail });
	return segments;
}

/** Total bytes the record says were produced but never delivered. */
function totalDropped(gaps: readonly RetainedStreamGap[]): number {
	let total = 0;
	for (const gap of gaps) total += gap.toByte - gap.fromByte;
	return total;
}

/**
 * The body, then each declared discontinuity, then every display in
 * declaration order — positions unrecoverable, but no display is ever
 * dropped: displays are items, not bytes, so a window that cannot prove
 * where they went still replays every one it folded.
 *
 * Each gap stays its own segment rather than being summed: the record
 * declares *k* discontinuities of known size, and collapsing them into one
 * would assert a single larger drop that never happened.
 */
function degradedSegments(
	stream: RetainedStreamView,
	displays: readonly RetainedDisplay[],
): readonly RetainedSegment[] {
	const segments: RetainedSegment[] = [{ kind: "text", text: stream.text }];
	for (const gap of [...stream.gaps].sort((left, right) => left.fromByte - right.fromByte)) {
		segments.push({ kind: "gap", droppedBytes: gap.toByte - gap.fromByte });
	}
	for (const retained of displays) segments.push({ kind: "display", display: retained.display });
	return segments;
}
