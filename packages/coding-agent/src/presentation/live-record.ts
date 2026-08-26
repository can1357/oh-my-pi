import type {
	ByteOffset,
	RetainedStreamGap,
	Sequence,
	StreamId,
	ToolAttachment,
	ToolExecutionId,
	ToolFact,
	ToolPresentationEvent,
	ToolPresentationRecord,
} from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf, byteOffset, factId, PRESENTATION_VERSION } from "@oh-my-pi/pi-agent-core/presentation";

/**
 * The live fold of a call's presentation events into its retained
 * {@link ToolPresentationRecord}.
 *
 * This is the exact inverse of `hydrate.ts`: that adapter turns one retained
 * record back into the canonical event sequence, this one turns a live event
 * sequence into the record. Nothing in between infers anything — the fold is
 * append-only and its only inputs are the byte offsets and counts the producer
 * *declared*. There is no overlap search, no snapshot diff, no watermark, and no
 * reconciliation against a previously published body: that class of machinery
 * is structurally excluded here, and must not reappear in accumulator
 * clothing.
 *
 * Byte continuity is asserted, never repaired. The invariants mirror
 * `reduceAcpToolView`'s `assertStreamContinuity` exactly — strictly increasing
 * per-stream `sequence`, and `startByte`/`fromByte` equal to the running cursor
 * — and are enforced the same way it enforces them: by throwing. A violation is
 * always a producer/transport defect, never client data, and a record folded
 * past one would be a fabricated byte range.
 *
 * Deliberately *not* here:
 *
 * - `started`/`settled`. The agent loop alone owns the lifecycle; this
 *   accumulator holds no lifecycle state of its own, so its owner's decision to
 *   create it and to take its {@link finish} snapshot *is* the lifecycle.
 * - `live_terminal_attached` and `display_output`, which no
 *   {@link ToolPresentationRecord} can represent — a `LiveTerminalBinding` has
 *   no serializer and the record retains no display sequence. `hydrate.ts`
 *   documents both losses on the replay side; this is the same two losses on the
 *   write side, and they are absent by construction rather than by omission.
 * - Nothing else. Retention *is* bounded here (final-review-7 P4): `fold`
 *   asserts continuity over every byte the producer declares — `cursor`
 *   always advances by a `terminal_append`/`terminal_gap`'s full length,
 *   whatever this class chooses to keep — but copies at most
 *   {@link LIVE_RECORD_HEAD_WINDOW_BYTES} of `stream.text` into the retained
 *   timeline. `finish()` always reports `endByte` as the live cursor (the
 *   full extent seen, capped or not) and, once the window has filled,
 *   appends a freshly computed `truncation` fact (`direction: "head"`) to
 *   the snapshot's `facts` — rollover is a truncation fact, never a gap.
 */

/**
 * Bound on the bytes {@link LiveToolPresentationRecord} copies into its
 * retained `stream.text` head window.
 *
 * Continuity is asserted over every byte the producer declares regardless of
 * this bound — `stream.cursor` always advances by the full length of each
 * event — so a capped window can never desync the continuity invariants
 * `fold` enforces on every subsequent event. Only what gets copied into
 * `text` (and therefore persisted/replayed) is capped.
 */
export const LIVE_RECORD_HEAD_WINDOW_BYTES = 1024 * 1024; // 1 MiB

/**
 * Longest prefix of `chunk` that fits in `maxBytes` without splitting a UTF-8
 * code point. Module-local copy: the presentation-boundary layering rules out
 * importing this from session code (`streaming-output.ts`'s helper of the
 * same name — unused there since P4 moved feed retention here).
 */
function utf8PrefixWithin(chunk: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(chunk, "utf8");
	if (buf.length <= maxBytes) return chunk;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

export class LiveToolPresentationRecord {
	#stream: AccumulatingStream | undefined;
	#lastSequence: number | undefined;
	readonly #facts: ToolFact[] = [];
	readonly #attachments: ToolAttachment[] = [];
	/** Bytes already copied into `stream.text`'s retained head window. */
	#retainedTextBytes = 0;
	/**
	 * Latched the first time a `terminal_append` chunk is cut at the head
	 * window. Once set, no further bytes join `stream.text` — a UTF-8
	 * boundary back-off can leave `#retainedTextBytes` just under the cap,
	 * and copying a later chunk's head after an earlier chunk's dropped tail
	 * would break the pure-head-prefix invariant the `truncation` fact
	 * declares.
	 */
	#headWindowExhausted = false;
	readonly #headWindowBytes: number;

	constructor(headWindowBytes: number = LIVE_RECORD_HEAD_WINDOW_BYTES) {
		this.#headWindowBytes = headWindowBytes;
	}

	/**
	 * Fold one event. Total over {@link ToolPresentationEvent} so a future member
	 * of that union fails to compile here until someone decides whether the
	 * retained record can carry it.
	 */
	fold(event: ToolPresentationEvent): void {
		switch (event.type) {
			case "terminal_append": {
				const stream = this.#advanceStream(event.streamId, event.sequence, event.startByte);
				this.#appendRetainedText(stream, event.data);
				stream.cursor = event.startByte + byteLengthOf(event.data);
				return;
			}
			case "terminal_gap": {
				// A non-positive range is not a discontinuity any producer can honestly
				// declare (`ToolPresentationStream.declareGap` already rejects one), and
				// the retained record's own byte accounting — `byteLength(text) + Σ
				// dropped === endByte - startByte`, which is what lets `hydrate.ts` place
				// gaps back without inference — would stop holding.
				if (event.toByte <= event.fromByte) {
					throw new ToolPresentationRecordContinuityError(
						`terminal_gap declared an empty or negative range on ${event.streamId}: [${event.fromByte}, ${event.toByte})`,
					);
				}
				const stream = this.#advanceStream(event.streamId, event.sequence, event.fromByte);
				stream.gaps.push(deepFreeze({ fromByte: event.fromByte, toByte: event.toByte }));
				stream.cursor = event.toByte;
				return;
			}
			case "fact":
				this.#facts.push(deepFreeze(event.fact));
				return;
			case "attachment":
				this.#attachments.push(deepFreeze(event.attachment));
				return;
			// Representable live, unrepresentable in the record (see the class doc).
			case "live_terminal_attached":
			case "display_output":
				return;
			case "started":
			case "settled":
				throw new ToolPresentationRecordContinuityError(
					`Presentation lifecycle event "${event.type}" belongs to the agent loop and its record owner, not to the accumulator`,
				);
			default: {
				const exhaustive: never = event;
				throw new Error(`Unhandled presentation event: ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	/**
	 * Snapshot everything folded so far as an immutable record.
	 *
	 * A pure projection, repeatable and non-terminal: the accumulator has no
	 * settlement state to spend (the agent loop owns `settled`), and the returned
	 * record is frozen and copy-independent, so a later fold cannot mutate a
	 * snapshot a caller already took. Every `ToolFact`/`ToolAttachment`/
	 * `RetainedStreamGap` reachable from the result is itself already
	 * {@link deepFreeze}d at the moment `fold` ingested it (not merely wrapped in
	 * a fresh array here), so a caller cannot reach into a nested value —
	 * `Object.assign(snapshot.facts[0], {...})` or an array push into a
	 * `diagnostics` fact's `entries` — and mutate the live accumulator's own
	 * state through it.
	 *
	 * `stream.endByte` is always the live cursor — the full extent of bytes the
	 * producer has declared, whether or not `stream.text` retained them — so a
	 * mid-flight snapshot's byte range is never narrower than what actually
	 * streamed. When the head window has filled, one fact beyond `#facts` is
	 * appended here: a freshly computed `truncation` fact (`direction:
	 * "head"`), recomputed from the live totals on every call rather than
	 * folded once and left to go stale, so every snapshot — mid-flight or
	 * final — reports the truest totals known at the moment it was taken,
	 * exactly like `endByte` above.
	 */
	finish(): ToolPresentationRecord {
		const stream = this.#stream;
		const truncationFact = this.#retentionTruncationFact(stream);
		return Object.freeze<ToolPresentationRecord>({
			version: PRESENTATION_VERSION,
			...(stream === undefined
				? {}
				: {
						stream: Object.freeze({
							streamId: stream.streamId,
							startByte: byteOffset(stream.startByte),
							endByte: byteOffset(stream.cursor),
							text: stream.text,
							gaps: Object.freeze([...stream.gaps]),
						}),
					}),
			facts: Object.freeze(truncationFact === undefined ? [...this.#facts] : [...this.#facts, truncationFact]),
			attachments: Object.freeze([...this.#attachments]),
		});
	}

	/**
	 * Copy `data` into `stream.text`'s retained head window, up to
	 * `#headWindowBytes`. Byte continuity never depends on this — `fold`'s
	 * `terminal_append` arm always advances `stream.cursor` by `data`'s full
	 * length regardless of what this method retains — so a capped window can
	 * never desync the continuity invariants `#advanceStream` enforces on
	 * every subsequent event.
	 */
	#appendRetainedText(stream: AccumulatingStream, data: string): void {
		if (this.#headWindowExhausted) return;
		const dataBytes = byteLengthOf(data);
		const remaining = this.#headWindowBytes - this.#retainedTextBytes;
		if (dataBytes <= remaining) {
			stream.text += data;
			this.#retainedTextBytes += dataBytes;
			return;
		}
		const piece = utf8PrefixWithin(data, remaining);
		stream.text += piece;
		this.#retainedTextBytes += byteLengthOf(piece);
		this.#headWindowExhausted = true;
	}

	/**
	 * The retention-truncation fact for the current head-window cut, or
	 * `undefined` while the window has never filled. Recomputed from the live
	 * `stream.cursor`/`#retainedTextBytes` totals on every call — see
	 * {@link finish}'s doc comment for why this must stay fresh rather than be
	 * folded into `#facts` once.
	 */
	#retentionTruncationFact(stream: AccumulatingStream | undefined): ToolFact | undefined {
		if (stream === undefined || !this.#headWindowExhausted) return undefined;
		const fact: ToolFact = {
			id: factId(`${stream.streamId}:retention-truncation`),
			kind: "truncation",
			meta: {
				direction: "head",
				totalBytes: stream.cursor,
				retainedBytes: this.#retainedTextBytes,
				truncatedBy: "bytes",
				maxBytes: this.#headWindowBytes,
			},
		};
		return deepFreeze(fact);
	}

	/**
	 * Validate the stream invariants for one `terminal_append`/`terminal_gap`, then
	 * return the accumulating window it advances (opening it on the first such
	 * event). Every check runs before any mutation, so a rejected event leaves the
	 * accumulation exactly as it was.
	 */
	#advanceStream(id: StreamId, seq: Sequence, startByte: ByteOffset): AccumulatingStream {
		if (this.#lastSequence !== undefined && seq <= this.#lastSequence) {
			throw new ToolPresentationRecordContinuityError(
				`Presentation sequence went backwards on ${id}: ${this.#lastSequence} then ${seq}`,
			);
		}
		const stream = this.#stream;
		if (stream !== undefined) {
			// `RetainedStreamView` is singular and a producer handle mints exactly one
			// `StreamId` per call, so a second identity here means two producers were
			// crossed onto one record — not something to merge.
			if (stream.streamId !== id) {
				throw new ToolPresentationRecordContinuityError(
					`Presentation record already retains stream ${stream.streamId}, refusing bytes from ${id}`,
				);
			}
			if (startByte !== stream.cursor) {
				throw new ToolPresentationRecordContinuityError(
					`Presentation byte offset discontinuity on ${id}: expected ${stream.cursor}, got ${startByte}`,
				);
			}
			this.#lastSequence = seq;
			return stream;
		}
		// The accumulator's cursor starts at 0, exactly like the live producer's
		// own `ToolPresentationStream#cursor` and `reduceAcpToolView`'s initial
		// `cursor: 0` — so the first event on a record must start there too.
		// Accepting a nonzero first offset would silently retain an undeclared
		// initial byte range as though it were an intentional window; a live fold
		// has no such window (that story belongs to `hydrate.ts`'s replay-side
		// rebasing, never to this accumulator).
		if (startByte !== 0) {
			throw new ToolPresentationRecordContinuityError(
				`Presentation stream ${id} opened at byte offset ${startByte}, expected 0`,
			);
		}
		const opened: AccumulatingStream = { streamId: id, startByte, text: "", cursor: startByte, gaps: [] };
		this.#lastSequence = seq;
		this.#stream = opened;
		return opened;
	}
}

/** A violated stream invariant. Always a producer/transport defect, never client data. */
export class ToolPresentationRecordContinuityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolPresentationRecordContinuityError";
	}
}

/**
 * One in-flight tool execution's journal identity paired with its live
 * accumulation — the live-side mirror of the persisted record pair
 * (`PersistedToolExecutionStarted` owns the `executionId`,
 * `PersistedToolExecutionSettled` needs the same one plus the record).
 *
 * Holding both together is what keeps settlement from minting a second
 * `ToolExecutionId` for an execution that already has one.
 */
export interface PendingToolExecutionPresentation {
	readonly executionId: ToolExecutionId;
	readonly record: LiveToolPresentationRecord;
}

/**
 * An immutable point-in-time projection of one {@link PendingToolExecutionPresentation}
 * — the same `executionId`, plus a {@link LiveToolPresentationRecord.finish}
 * snapshot instead of the live, mutable builder itself.
 *
 * `finish()` is pure and repeatable (see its own doc comment), so taking one
 * here is side-effect-free and safe to expose to a caller that must not be
 * able to mutate production state — an observer (a test accessor, a future
 * diagnostic) that held the live `record` instead could call its public
 * `fold()` and inject a fact/attachment/append/gap into the real accumulation
 * despite `ReadonlyMap` only preventing `set`/`delete` on the copied map.
 */
export interface PendingToolPresentationSnapshot {
	readonly executionId: ToolExecutionId;
	readonly presentation: ToolPresentationRecord;
}

/** Mutable accumulation state for the one stream a record can retain. */
interface AccumulatingStream {
	readonly streamId: StreamId;
	readonly startByte: number;
	text: string;
	cursor: number;
	readonly gaps: RetainedStreamGap[];
}

/**
 * Recursively freeze a JSON-shaped value in place and return it.
 *
 * `ToolFact`/`ToolAttachment`/`RetainedStreamGap` are all plain, tree-shaped
 * data (strings/numbers/booleans/arrays/nested plain objects — no functions,
 * no cycles, nothing `Object.freeze` can't reach), so a shallow
 * `Object.freeze` on the outer object is not enough: a `diagnostics` fact's
 * `entries` array, or a `diff` attachment's fields, would still be mutable
 * one level down. Applied once at the moment `fold` ingests a value, this is
 * what makes every reachable value permanently safe to hand out — including
 * through {@link LiveToolPresentationRecord.finish}'s snapshot — without a
 * separate clone step, since these values are never mutated after creation
 * by design (`fold` only ever pushes a new one). Never short-circuits on an
 * already-frozen node: a producer can legitimately hand `fact()` a value with
 * a shallow-frozen child (e.g. a pre-frozen `diagnostics.entries` array whose
 * entry objects are themselves still mutable) — stopping recursion there
 * would leave that mutable descendant reachable through an otherwise "fully
 * frozen" tree.
 */
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	// Always traverse, even when `value` is already frozen: a shallow
	// `Object.freeze` upstream (a producer can legitimately hand `fact()` a
	// pre-frozen `diagnostics.entries` array or `truncation.meta` object) froze
	// only that one level — its own children can still be mutable, and skipping
	// the recursion here would silently hand out a shared, still-mutable
	// descendant through this value's otherwise-frozen parent.
	for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
	return Object.isFrozen(value) ? value : Object.freeze(value);
}
