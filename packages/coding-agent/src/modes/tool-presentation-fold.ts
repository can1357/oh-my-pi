/**
 * Consumer-side fold of `tool_presentation` events for non-ACP display
 * consumers (the TUI's EventController and the embedded-host RpcClient).
 *
 * Scope guard (final-review-7 P8): synthesis lives ONLY inside display
 * consumers. The ACP-bound subscriber consumes `tool_presentation` natively
 * and must never observe a re-synthesized update, so nothing that feeds the
 * ACP path may touch this module.
 *
 * Each call gets one accumulator: process text under an explicit head-window
 * cap, declared displays in arrival order, and human-audience facts.
 * `snapshotText()` composes `[stream.text, …displays, …facts]`, approximating
 * `renderTuiPresentation`'s body-then-facts ordering; outcome/status rendering
 * deliberately stays with each consumer's end-of-call path (`settled` events
 * are not folded).
 */
import type { ToolDisplayOutput, ToolFact, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf } from "@oh-my-pi/pi-agent-core/presentation";
import {
	factsFor,
	outputSegmentSeparator,
	renderFact,
	renderToolOutputSegments,
	type ToolOutputSegment,
} from "../presentation/projections";

/**
 * Explicit head-window cap on folded process text, per final-review-7 P8
 * change 2: carried here from day one so the display fold can never grow with
 * an unbounded stream (P4 removes the incidental feed-side cap separately).
 * Matches the retention budget `presentation/live-record.ts`'s
 * `LiveToolPresentationRecord` bounds its own retained head window to (P4).
 */
export const PRESENTATION_FOLD_HEAD_WINDOW_BYTES = 1024 * 1024;

/**
 * Longest prefix of `chunk` that fits in `maxBytes` without splitting a UTF-8
 * code point. Module-local copy of the same helper `presentation/live-record.ts`
 * and the ACP reducer each keep privately: the fold lives beside the display
 * consumers, and the presentation project's boundary rules out importing it
 * from session code.
 */
function utf8PrefixWithin(chunk: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(chunk, "utf8");
	if (buf.length <= maxBytes) return chunk;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/** Per-call accumulator folding one call's `tool_presentation` deltas into cumulative snapshot text. */
export class ToolPresentationDisplayFold {
	readonly #headWindowBytes: number;
	#text = "";
	#textBytes = 0;
	// Bytes dropped once the head window filled; latched on the FIRST dropped
	// byte so the retained head stays a contiguous prefix of the stream.
	#elidedBytes = 0;
	readonly #displays: ToolDisplayOutput[] = [];
	readonly #facts: ToolFact[] = [];

	constructor(headWindowBytes = PRESENTATION_FOLD_HEAD_WINDOW_BYTES) {
		this.#headWindowBytes = headWindowBytes;
	}

	/** Fold one presentation delta. Lifecycle/attachment arms are deliberate no-ops. */
	append(event: ToolPresentationEvent): void {
		switch (event.type) {
			case "terminal_append":
				this.#appendProcessText(event.data);
				break;
			case "terminal_gap":
				this.#appendProcessText(`\n[…${event.toByte - event.fromByte} bytes unavailable…]\n`);
				break;
			case "fact":
				this.#facts.push(event.fact);
				break;
			case "display_output":
				this.#displays.push(event.display);
				break;
			case "started":
			case "settled":
			case "attachment":
			case "live_terminal_attached":
				// Settlement/status belongs to the end-of-call path, attachments
				// are not text, and a client-owned terminal streams no appends.
				break;
		}
	}

	/** Whether nothing observable has been folded yet (no snapshot worth pushing). */
	isEmpty(): boolean {
		return (
			this.#text.length === 0 && this.#elidedBytes === 0 && this.#displays.length === 0 && this.#facts.length === 0
		);
	}

	/**
	 * Compose the complete cumulative snapshot: `[stream.text, …displays,
	 * …facts]`, human-audience facts only — mirroring `renderTuiPresentation`.
	 */
	snapshotText(): string {
		const segments: ToolOutputSegment[] = [];
		if (this.#text.length > 0) segments.push({ kind: "process", text: this.#text });
		for (const display of this.#displays) segments.push({ kind: "display", display });
		let rendered = renderToolOutputSegments(segments);
		const factLines = factsFor(this.#facts, "human")
			.map(fact => renderFact(fact).text)
			.filter(text => text.length > 0);
		if (this.#elidedBytes > 0) {
			factLines.push(
				`[…output truncated at the ${this.#headWindowBytes}-byte head window: ${this.#elidedBytes} bytes not shown…]`,
			);
		}
		if (factLines.length > 0) {
			const factsBlock = factLines.join("\n");
			rendered = rendered.length === 0 ? factsBlock : `${rendered}${outputSegmentSeparator(rendered)}${factsBlock}`;
		}
		return rendered;
	}

	#appendProcessText(chunk: string): void {
		if (chunk.length === 0) return;
		if (this.#elidedBytes > 0) {
			this.#elidedBytes += byteLengthOf(chunk);
			return;
		}
		const chunkBytes = byteLengthOf(chunk);
		const remaining = this.#headWindowBytes - this.#textBytes;
		if (chunkBytes <= remaining) {
			this.#text += chunk;
			this.#textBytes += chunkBytes;
			return;
		}
		const piece = utf8PrefixWithin(chunk, remaining);
		this.#text += piece;
		this.#textBytes += byteLengthOf(piece);
		this.#elidedBytes = chunkBytes - byteLengthOf(piece);
	}
}
