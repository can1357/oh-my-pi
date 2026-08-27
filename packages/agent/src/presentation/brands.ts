/**
 * Branded transport identities for the presentation event stream.
 *
 * Every brand symbol below is module-private, so the *only* way to obtain a
 * `StreamId`/`Sequence`/`ByteOffset`/`FactId`/`NonZeroExitCode`/
 * `ToolExecutionId` is the constructor in this file. A tool cannot forge an
 * offset, invent a sequence number, or claim a duplicate fact id: those values
 * are minted by the scoped producer handle (`ToolPresentationStream`) which owns
 * the counters. `ToolExecutionId` is minted one level up — by whoever appends the
 * persisted journal record pair — for the same reason.
 *
 * The offset unit is **UTF-8 bytes**, matching `OutputSink`'s own accounting and
 * ACP's terminal-byte semantics. `byteLengthOf` is the single definition of that
 * unit for the whole boundary.
 */

declare const streamIdBrand: unique symbol;
declare const sequenceBrand: unique symbol;
declare const byteOffsetBrand: unique symbol;
declare const factIdBrand: unique symbol;
declare const toolExecutionIdBrand: unique symbol;
declare const nonZeroExitCodeBrand: unique symbol;

/** Identity of one append-only presentation byte stream. */
export type StreamId = string & { readonly [streamIdBrand]: true };
/** Monotonic per-stream event counter. Gaps and duplicates are reducer errors. */
export type Sequence = number & { readonly [sequenceBrand]: true };
/** Absolute UTF-8 byte offset inside a `StreamId`. */
export type ByteOffset = number & { readonly [byteOffsetBrand]: true };
/** Stable identity of one declared fact, used by delivery receipts. */
export type FactId = string & { readonly [factIdBrand]: true };
/**
 * Identity of one tool call's *execution*, joining a persisted
 * `tool_execution_started` record to its `tool_execution_settled` one.
 *
 * Deliberately not the provider-issued `toolCallId`: that string is chosen by
 * whoever emitted the call and is only unique within the turn that emitted it,
 * while the journal has to fold a dangling `started` into an `interrupted`
 * execution across a resumed, branched or forked session file without trusting a
 * provider id to be unique in it.
 */
export type ToolExecutionId = string & { readonly [toolExecutionIdBrand]: true };
/** A process exit code that is definitely not zero. */
export type NonZeroExitCode = number & { readonly [nonZeroExitCodeBrand]: true };

/** Version tag of the retained presentation record schema. */
export type PresentationVersion = 1;
/** Current {@link PresentationVersion}. */
export const PRESENTATION_VERSION: PresentationVersion = 1;

/** UTF-8 byte length of `text` — the offset unit for the whole boundary. */
export function byteLengthOf(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Mint a stream identity. Called by the dispatcher when it opens a producer
 * handle, never by a tool.
 */
export function streamId(value: string): StreamId {
	if (value.length === 0) throw new Error("StreamId must not be empty");
	return value as StreamId;
}

/** Mint a sequence number. Rejects non-integers and negatives. */
export function sequence(value: number): Sequence {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`Sequence must be a non-negative safe integer, got ${value}`);
	}
	return value as Sequence;
}

/** Mint a byte offset. Rejects non-integers and negatives. */
export function byteOffset(value: number): ByteOffset {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`ByteOffset must be a non-negative safe integer, got ${value}`);
	}
	return value as ByteOffset;
}

/** Mint a fact id. */
export function factId(value: string): FactId {
	if (value.length === 0) throw new Error("FactId must not be empty");
	return value as FactId;
}

/** Mint a tool-execution identity. */
export function toolExecutionId(value: string): ToolExecutionId {
	if (value.length === 0) throw new Error("ToolExecutionId must not be empty");
	return value as ToolExecutionId;
}

/**
 * Mint a definitely-nonzero exit code.
 *
 * This is what makes plan invariant #3 ("`status: completed` paired with a
 * nonzero `terminal_exit.exit_code`") a theorem rather than a runtime check: a
 * successful termination can only carry the literal `0`, and a failed one can
 * only carry a value this constructor accepted.
 */
export function nonZeroExitCode(value: number): NonZeroExitCode {
	if (!Number.isSafeInteger(value)) throw new Error(`Exit code must be a safe integer, got ${value}`);
	if (value === 0) throw new Error("nonZeroExitCode rejects 0; use a successful termination instead");
	return value as NonZeroExitCode;
}

/**
 * Whether `text` ends inside a UTF-16 surrogate pair (an unpaired high
 * surrogate) or opens with an orphan low surrogate.
 *
 * A chunk that ends mid-pair cannot be measured in UTF-8 bytes without either
 * over-counting the replacement character or silently shifting every later
 * offset. The presentation producer buffers/encodes ill-formed input itself
 * (see `ToolPresentationStream`'s append path — it holds a trailing high
 * surrogate and rejoins it with the next chunk); this helper remains for
 * consumers that cut an already well-formed string and must not leave a
 * dangling surrogate at the cut (see `projections.ts`'s bounded settlement
 * reason).
 */
export function endsOnStringBoundary(text: string): boolean {
	if (text.length === 0) return true;
	const last = text.charCodeAt(text.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) return false;
	const first = text.charCodeAt(0);
	if (first >= 0xdc00 && first <= 0xdfff) return false;
	return true;
}
