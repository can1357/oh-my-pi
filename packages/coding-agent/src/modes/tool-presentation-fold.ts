/**
 * Consumer-side fold of `tool_presentation` events for non-ACP display
 * consumers (the TUI's EventController and the embedded-host RpcClient).
 *
 * Scope guard: synthesis lives ONLY inside display
 * consumers. The ACP-bound subscriber consumes `tool_presentation` natively
 * and must never observe a re-synthesized update, so nothing that feeds the
 * ACP path may touch this module.
 *
 * Each call gets one accumulator: process text under an explicit head-window
 * cap, displays pre-rendered at fold time in arrival order under the journal's
 * centralized item/byte budgets, and human-audience facts.
 * `snapshotText()` composes `[stream.text, …displays, …facts]`, approximating
 * `renderTuiPresentation`'s body-then-facts ordering; outcome/status rendering
 * deliberately stays with each consumer's end-of-call path (`settled` events
 * are not folded).
 */
import type { ToolFact, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { byteLengthOf } from "@oh-my-pi/pi-agent-core/presentation";
import { LIVE_RECORD_DISPLAY_BUDGET_BYTES, LIVE_RECORD_DISPLAY_ITEM_LIMIT } from "../presentation/live-record";
import { factsFor, outputSegmentSeparator, renderDisplayOutput, renderFact } from "../presentation/projections";
import { utf8PrefixWithin } from "../presentation/utf8";

/**
 * Explicit head-window cap on folded process text: carried here from day
 * one so the display fold can never grow with an unbounded stream (the
 * feed-side cap is bounded separately). A live-display bound like the ACP
 * view reducer's `PROCESS_TEXT_HEAD_WINDOW_BYTES` — deliberately larger than
 * `presentation/live-record.ts`'s persistence-safe retention budget, which is
 * sized to the session-persistence string cap instead.
 */
export const PRESENTATION_FOLD_HEAD_WINDOW_BYTES = 1024 * 1024;

/** Per-call accumulator folding one call's `tool_presentation` deltas into cumulative snapshot text. */
export class ToolPresentationDisplayFold {
	readonly #headWindowBytes: number;
	#text = "";
	#textBytes = 0;
	// Bytes dropped once the head window filled; latched on the FIRST dropped
	// byte so the retained head stays a contiguous prefix of the stream.
	#elidedBytes = 0;
	// Displays are pre-rendered at fold time and bounded by the journal's
	// centralized display budgets: the projection caps each JSON value, and
	// the item/byte budgets cap the call. Retaining raw `ToolDisplayOutput`
	// trees instead would grow without bound on a runaway eval `display()`
	// and make every later snapshotText() re-serialize all of them again.
	readonly #displayTexts: string[] = [];
	#displayTextBytes = 0;
	#droppedDisplays = 0;
	readonly #displayItemLimit: number;
	readonly #displayBudgetBytes: number;
	readonly #facts: ToolFact[] = [];

	constructor(
		headWindowBytes = PRESENTATION_FOLD_HEAD_WINDOW_BYTES,
		displayBudget?: { readonly itemLimit?: number; readonly maxBytes?: number },
	) {
		this.#headWindowBytes = headWindowBytes;
		this.#displayItemLimit = displayBudget?.itemLimit ?? LIVE_RECORD_DISPLAY_ITEM_LIMIT;
		this.#displayBudgetBytes = displayBudget?.maxBytes ?? LIVE_RECORD_DISPLAY_BUDGET_BYTES;
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
			case "display_output": {
				const text = renderDisplayOutput(event.display);
				const textBytes = byteLengthOf(text);
				const overCount = this.#displayTexts.length >= this.#displayItemLimit;
				const overBytes = this.#displayTextBytes + textBytes > this.#displayBudgetBytes;
				if (overCount || overBytes) {
					this.#droppedDisplays++;
					break;
				}
				this.#displayTexts.push(text);
				this.#displayTextBytes += textBytes;
				break;
			}
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
			this.#text.length === 0 &&
			this.#elidedBytes === 0 &&
			this.#displayTexts.length === 0 &&
			this.#droppedDisplays === 0 &&
			this.#facts.length === 0
		);
	}

	/**
	 * Compose the complete cumulative snapshot: `[stream.text, …displays,
	 * …facts]`, human-audience facts only — mirroring `renderTuiPresentation`.
	 */
	snapshotText(): string {
		let rendered = "";
		const pushSegment = (text: string): void => {
			if (text.length === 0) return;
			if (rendered.length > 0) rendered += outputSegmentSeparator(rendered);
			rendered += text;
		};
		pushSegment(this.#text);
		for (const text of this.#displayTexts) pushSegment(text);
		const factLines = factsFor(this.#facts, "human")
			.map(fact => renderFact(fact).text)
			.filter(text => text.length > 0);
		if (this.#elidedBytes > 0) {
			factLines.push(
				`[…output truncated at the ${this.#headWindowBytes}-byte head window: ${this.#elidedBytes} bytes not shown…]`,
			);
		}
		if (this.#droppedDisplays > 0) {
			factLines.push(
				`[…${this.#droppedDisplays} display output${this.#droppedDisplays === 1 ? "" : "s"} over the display budget not shown…]`,
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
