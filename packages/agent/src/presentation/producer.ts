/**
 * The scoped producer handle.
 *
 * A tool never receives a raw `emit(ToolPresentationEvent)`. It receives a
 * {@link ToolPresentationProducer}, which can append bytes, declare facts, attach
 * non-text output, and register a flusher — and nothing else. In particular it
 * cannot:
 *
 * - emit `started`/`settled` (the agent loop owns settlement, including every
 *   synthetic path: validation failure, permission denial, throw, abort, hook
 *   failure);
 * - choose a sequence number or a byte offset (this class owns both counters);
 * - declare a `terminal_gap` (only {@link ToolPresentationStream.declareGap},
 *   which is off the interface, can — and only an explicitly bounded queue
 *   adapter is supposed to call it);
 * - append after `freeze()`.
 *
 * `freeze()` is the flush-before-settlement barrier the agent loop calls in
 * `finally` for *every* settlement. `OutputSink` registers its pending
 * coalesced-chunk flush with it, so a throttled chunk still reaches the client
 * when the executor throws or the run is aborted. `dispose()` is not a
 * substitute: it clears the throttle timer without emitting.
 */

import type { ByteOffset, FactId, Sequence, StreamId } from "./brands";
import { byteLengthOf, byteOffset, endsOnStringBoundary, factId, sequence } from "./brands";
import type { LiveTerminalBinding, ToolAttachment, ToolDisplayOutput, ToolPresentationEmitter } from "./events";
import type { ToolFact, ToolFactBody } from "./facts";

/**
 * What a registered flusher may do with the append authority it holds for the
 * duration of its own call.
 *
 * Handed fresh to each flusher invocation and revoked the moment that call
 * settles (return, or throw) — in `finally`, so a throwing flusher still loses
 * the capability. A flusher that stashes the scope and calls it later gets a
 * rejection, exactly like any other post-freeze append: authority is carried by
 * the object a caller holds, not by ambient "are we inside some flush" state,
 * so it cannot be exercised by an unrelated holder of the producer handle.
 */
export interface PresentationFlusherScope {
	/** Append on behalf of the flusher that owns this scope. */
	appendTerminal(data: string): void;
}

/** A registered flush callback, invoked once by {@link ToolPresentationProducer.freeze}. */
export type PresentationFlusher = (scope: PresentationFlusherScope) => void | Promise<void>;

/** A callback the agent loop invokes after it emitted the call's settled event. */
export type PresentationAfterSettlement = () => void;

/** The three-phase lifecycle of a {@link ToolPresentationProducer}'s append barrier. */
export type PresentationPhase = "open" | "flushing" | "frozen";

/** What a tool is allowed to do to its own presentation stream. */
export interface ToolPresentationProducer {
	/** Identity of this call's byte stream. */
	readonly streamId: StreamId;
	/**
	 * Where this stream sits in its append barrier's lifecycle.
	 *
	 * `"open"`: ordinary mutations succeed. `"flushing"`/`"frozen"`: every ordinary
	 * mutation (an append included) is rejected — `"flushing"` only admits appends
	 * through the scoped {@link PresentationFlusherScope} handed to a registered
	 * flusher for the duration of its own call. A caller distinguishes "the barrier
	 * has started closing" from "the barrier's own machinery failed" by checking
	 * this field *before* calling a mutator: once `phase !== "open"`, a resulting
	 * throw is a genuine producer/emitter defect (a split surrogate pair, a byte-
	 * accounting invariant violation), never the barrier itself, so it must never be
	 * caught and treated as the same "arrived too late" case.
	 */
	readonly phase: PresentationPhase;
	/**
	 * True once {@link freeze} has closed the stream.
	 *
	 * Every mutation on this handle — appends included — is rejected from the moment
	 * the barrier starts, not just once it finishes: `frozen` reports the barrier's
	 * own completion, not "is it now safe to append here", which is a different
	 * question a registered flusher answers through the scoped capability it is
	 * handed instead. Equivalent to `phase === "frozen"`; kept as a convenience for
	 * callers that only care about final closure, not the flushing window.
	 */
	readonly frozen: boolean;
	/** Absolute offset the next appended byte will occupy. */
	readonly nextByte: ByteOffset;
	/** Append newly produced bytes. Empty strings are a no-op, not an event. */
	appendTerminal(data: string): void;
	/** Declare a fact and get its stable id back. Audience is *not* a producer choice. */
	fact(body: ToolFactBody): FactId;
	/** Attach non-text output (image, resource link, diff). */
	attachment(attachment: ToolAttachment): void;
	/**
	 * Declare structured display output (e.g. `display()` JSON values, image
	 * dimension notes). Distinct from `appendTerminal` (process bytes): the
	 * reducer projects this into the appropriate channel, and downstream can
	 * distinguish process stdout from display output. The `text` field is the
	 * rendered projection the model-facing text also contains.
	 */
	declareDisplay(display: ToolDisplayOutput): void;
	/** Report that a live client-owned terminal now backs this call. */
	attachLiveTerminal(binding: LiveTerminalBinding): void;
	/** Register a pending-data flusher run by {@link freeze}. Returns an unregister function. */
	registerFlusher(flush: PresentationFlusher): () => void;
	/**
	 * Idempotent async barrier: run every registered flusher, then close the stream
	 * irrevocably.
	 *
	 * Ends frozen even when a flusher throws (the failure is rethrown for the caller
	 * to log), so a settled call can never still be appended to.
	 */
	freeze(): Promise<void>;
}

/**
 * The one implementation of {@link ToolPresentationProducer}.
 *
 * Constructed by the dispatcher per tool call; the emitter it writes to is the
 * agent loop's event stream, so the tool has no way to reach the wire directly.
 */
export class ToolPresentationStream implements ToolPresentationProducer {
	readonly streamId: StreamId;
	readonly #emit: ToolPresentationEmitter;
	#sequence = 0;
	#cursor = 0;
	#factCounter = 0;
	/**
	 * Freeze is a three-phase lifecycle, not a boolean.
	 *
	 * `flushing` exists because the barrier's whole purpose is to let registered
	 * flushers emit their pending bytes — but that authority is scoped to each
	 * flusher's own {@link PresentationFlusherScope}, not tracked on this field: the
	 * public handle's `appendTerminal` rejects unconditionally once `#phase` leaves
	 * `"open"`, exactly like every other mutation (a fact, attachment, live-terminal
	 * binding, flusher registration, or gap declared once the barrier has started
	 * would land after the reducer has already been told the call settled).
	 */
	#phase: PresentationPhase = "open";
	#freezing: Promise<void> | undefined;
	readonly #flushers = new Set<PresentationFlusher>();
	readonly #afterSettlement = new Set<PresentationAfterSettlement>();
	readonly #facts: ToolFact[] = [];

	constructor(id: StreamId, emit: ToolPresentationEmitter) {
		this.streamId = id;
		this.#emit = emit;
	}

	/** Where this stream sits in its append barrier's lifecycle. */
	get phase(): PresentationPhase {
		return this.#phase;
	}

	/**
	 * True once the barrier has closed the stream.
	 *
	 * Deliberately *false* while flushing: a registered flusher checks this before
	 * emitting its pending buffer (`OutputSink` does), and reporting `true` mid-barrier
	 * would make the flush a no-op — dropping exactly the bytes the barrier exists to
	 * deliver.
	 */
	get frozen(): boolean {
		return this.#phase === "frozen";
	}

	get nextByte(): ByteOffset {
		return byteOffset(this.#cursor);
	}

	/** Facts declared so far, in declaration order. Used to build the retained record. */
	get declaredFacts(): readonly ToolFact[] {
		return this.#facts;
	}

	appendTerminal(data: string): void {
		this.#assertMutable("appended");
		this.#appendTerminalCore(data);
	}

	/**
	 * The actual byte-accounting append, shared by the public handle and every
	 * flusher's scoped capability. Callers gate access; this only accounts.
	 *
	 * The `startByte + byteLength(data)` contract itself is asserted downstream,
	 * where it is load-bearing: `reduceAcpToolView`'s and
	 * `LiveToolPresentationRecord`'s continuity checks throw on any offset the
	 * running cursor does not predict.
	 */
	#appendTerminalCore(data: string): void {
		if (data.length === 0) return;
		if (!endsOnStringBoundary(data)) {
			throw new Error(`Presentation stream ${this.streamId} appended a chunk that splits a surrogate pair`);
		}
		const startByte = byteOffset(this.#cursor);
		const length = byteLengthOf(data);
		this.#cursor = startByte + length;
		this.#emit({
			type: "terminal_append",
			streamId: this.streamId,
			sequence: this.#nextSequence(),
			startByte,
			data,
		});
	}

	/**
	 * Declare that `[fromByte, toByte)` was produced but dropped before delivery.
	 *
	 * Off {@link ToolPresentationProducer} on purpose: the only legitimate caller
	 * is an explicitly bounded presentation queue that knows it discarded
	 * undelivered live bytes. Retention rollover must **not** call this — those
	 * bytes were already appended.
	 */
	declareGap(droppedBytes: number): void {
		if (!Number.isSafeInteger(droppedBytes) || droppedBytes <= 0) {
			throw new Error(`declareGap requires a positive integer byte count, got ${droppedBytes}`);
		}
		this.#assertMutable("declared a gap");
		const fromByte = byteOffset(this.#cursor);
		this.#cursor = fromByte + droppedBytes;
		this.#emit({
			type: "terminal_gap",
			streamId: this.streamId,
			sequence: this.#nextSequence(),
			fromByte,
			toByte: byteOffset(this.#cursor),
		});
	}

	fact(body: ToolFactBody): FactId {
		this.#assertMutable("declared a fact");
		const id = factId(`${this.streamId}:f${this.#factCounter++}`);
		const fact = { id, ...body } as ToolFact;
		this.#facts.push(fact);
		this.#emit({ type: "fact", fact });
		return id;
	}

	attachment(attachment: ToolAttachment): void {
		this.#assertMutable("attached output");
		this.#emit({ type: "attachment", attachment });
	}

	declareDisplay(display: ToolDisplayOutput): void {
		this.#assertMutable("declared display output");
		this.#emit({ type: "display_output", display });
	}

	attachLiveTerminal(binding: LiveTerminalBinding): void {
		this.#assertMutable("attached a live terminal");
		this.#emit({ type: "live_terminal_attached", binding });
	}

	registerFlusher(flush: PresentationFlusher): () => void {
		this.#assertMutable("registered a flusher");
		this.#flushers.add(flush);
		return () => {
			this.#flushers.delete(flush);
		};
	}

	registerAfterSettlement(callback: PresentationAfterSettlement): () => void {
		this.#assertMutable("registered an after-settlement callback");
		this.#afterSettlement.add(callback);
		return () => {
			this.#afterSettlement.delete(callback);
		};
	}

	/** Run post-settlement work after the loop emitted this stream's terminal event. */
	runAfterSettlementCallbacks(): void {
		const callbacks = Array.from(this.#afterSettlement);
		this.#afterSettlement.clear();
		let failure: unknown;
		for (const callback of callbacks) {
			try {
				callback();
			} catch (error) {
				if (failure === undefined) failure = error;
			}
		}
		if (failure !== undefined) throw failure;
	}

	freeze(): Promise<void> {
		const inFlight = this.#freezing;
		if (inFlight) return inFlight;
		const running = this.#runFreeze();
		this.#freezing = running;
		return running;
	}

	/**
	 * Run every registered flusher, then close the stream irrevocably.
	 *
	 * **Decision: a failing flusher does not cancel the others.** Each flusher owns a
	 * distinct pending buffer, so stopping at the first failure would discard bytes
	 * that were still deliverable. The first failure is rethrown so the caller can log
	 * it (the agent loop does), and the phase moves to `frozen` in `finally` — the
	 * earlier version set `#frozen` only on the success path, which left the stream
	 * accepting appends *after* the loop had already emitted `settled`.
	 *
	 * **Append authority is scoped per invocation, not tracked by a depth counter.**
	 * A depth counter is ambient: it stays positive for the whole `await flush()`,
	 * so anything else holding the producer handle — not just the suspended flusher
	 * itself — could call `appendTerminal()` and succeed while that flusher is
	 * suspended on an unrelated await. Each flusher instead receives a fresh
	 * {@link PresentationFlusherScope} whose `appendTerminal` is live only for that
	 * one call and is revoked in `finally`, so a throw, an early return, or a stashed
	 * reference used after the call returns all lose the capability the same way.
	 */
	async #runFreeze(): Promise<void> {
		const flushers = Array.from(this.#flushers);
		this.#flushers.clear();
		this.#phase = "flushing";
		let failure: unknown;
		try {
			for (const flush of flushers) {
				let active = true;
				const scope: PresentationFlusherScope = {
					appendTerminal: (data: string): void => {
						if (!active) {
							throw new Error(`Presentation stream ${this.streamId} appended after its flusher returned`);
						}
						this.#appendTerminalCore(data);
					},
				};
				try {
					await flush(scope);
				} catch (error) {
					if (failure === undefined) failure = error;
				} finally {
					active = false;
				}
			}
		} finally {
			this.#phase = "frozen";
		}
		if (failure !== undefined) throw failure;
	}

	/** Every mutation — appends included — is closed the moment the barrier starts. */
	#assertMutable(action: string): void {
		if (this.#phase !== "open") {
			throw new Error(`Presentation stream ${this.streamId} ${action} after freeze`);
		}
	}

	#nextSequence(): Sequence {
		return sequence(this.#sequence++);
	}
}

/**
 * Schedule work after the agent loop emitted a stream's settled event without
 * widening the producer capability surface tools receive.
 */
export function afterPresentationSettlement(
	producer: ToolPresentationProducer,
	callback: PresentationAfterSettlement,
): () => void {
	if (!(producer instanceof ToolPresentationStream)) {
		throw new Error("Presentation producer does not support post-settlement work");
	}
	return producer.registerAfterSettlement(callback);
}
