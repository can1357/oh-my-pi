/**
 * The retained presentation record.
 *
 * Transient events and retained presentation are deliberately *different types*.
 * Events drive live rendering; this compact record drives persistence, replay and
 * the final projections. It references the **same stream identity** and a
 * retained byte range as the partials did — it never contains the full live chunk
 * history, and it never carries a live terminal binding (that type has no
 * serializer and is structurally excluded here).
 *
 * A differently-rendered display view (column truncation, middle elision) is a
 * *fact* on this record, never a second body for someone to diff against the
 * first.
 */

import type { ByteOffset, PresentationVersion, StreamId } from "./brands";
import type { ToolAttachment, ToolPresentationKind, ToolPresentationLocation } from "./events";
import type { ToolFact } from "./facts";
import type { JsonValue } from "./json";

/** A range of stream bytes that was declared missing by a bounded queue. */
export interface RetainedStreamGap {
	readonly fromByte: ByteOffset;
	readonly toByte: ByteOffset;
}

/**
 * The retained window of a presentation stream.
 *
 * `text` is what the retained record kept; `startByte`/`endByte` say *where* in
 * the stream it came from. When retention elided a middle, that shows up as a
 * `truncation` fact plus `startByte === 0 && endByte === totalBytes` with a
 * shorter `text` — the honest description of a head+tail window — never as a gap.
 */
export interface RetainedStreamView {
	readonly streamId: StreamId;
	readonly startByte: ByteOffset;
	readonly endByte: ByteOffset;
	readonly text: string;
	readonly gaps: readonly RetainedStreamGap[];
}

/** The compact, replayable presentation of one settled (or interrupted) call. */
export interface ToolPresentationRecord {
	readonly version: PresentationVersion;
	readonly stream?: RetainedStreamView;
	readonly facts: readonly ToolFact[];
	readonly attachments: readonly ToolAttachment[];
}

/** The presentation of a call that has started but not settled. */
export interface StartedPresentationRecord {
	readonly version: PresentationVersion;
	readonly facts: readonly ToolFact[];
}

/**
 * The persisted-safe counterpart of {@link ToolCallPresentation}.
 *
 * `awaitsLiveTerminal` is dropped: it is a live-routing hint ("a client-owned
 * terminal attaches after `started`"), and a replayed session has no client
 * terminal to attach — the field would be meaningless on every persisted record.
 * `rawInput` narrows `{ [key: string]: unknown }` to `JsonValue` because
 * persisted arguments must round-trip through the session JSONL; an `unknown`
 * value coming out of a parser is never actually guaranteed to be JSON-safe on
 * the way in.
 */
export interface ToolCallRecord {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly title: string;
	readonly kind: ToolPresentationKind;
	readonly locations?: readonly ToolPresentationLocation[];
	readonly sourceEcho?: string;
	readonly cwd?: string;
	readonly rawInput?: { readonly [key: string]: JsonValue };
}

/**
 * The presentation folded from a `started` journal record that never reached a
 * `settled` one (the process died between the two).
 *
 * Structurally identical to {@link StartedPresentationRecord} today — there is
 * no settlement data to add — but kept as its own type because the two states
 * are not interchangeable: `started` means the call may still be running
 * somewhere, `interrupted` is the terminal folding a loader applies once it
 * knows no `settled` record follows. A future hydration adapter can add
 * interruption-only fields (e.g. a partially retained stream window) without
 * disturbing the live `started` shape.
 */
export interface InterruptedPresentationRecord {
	readonly version: PresentationVersion;
	readonly facts: readonly ToolFact[];
}
