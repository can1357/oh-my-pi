import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";

/**
 * Locally observed elapsed time for one streamed assistant message. A leading
 * thinking block includes the wait from the observed message start; later blocks
 * start at their first observed thinking event. This does not measure unseen
 * request latency or provider-internal reasoning (including hidden reasoning
 * before a summary). Callers supply a monotonic clock, in milliseconds.
 */
export class ThinkingClock {
	#streamStart: number | undefined;
	#leading = true;
	#active: { index: number; start: number } | undefined;
	#durations: Record<number, number> | undefined;

	/** A new assistant message started streaming. */
	begin(now: number): void {
		this.#streamStart = now;
		this.#leading = true;
		this.#active = undefined;
		this.#durations = undefined;
	}

	/** Completed measurements, safe to retain on immutable partial snapshots. */
	observe(event: AssistantMessageEvent, now: number): Record<number, number> | undefined {
		if (this.#streamStart === undefined) return undefined;
		switch (event.type) {
			case "start":
				// A provider may restart its partial within the same assistant turn.
				this.begin(now);
				break;
			case "thinking_start":
			case "thinking_delta":
				if (this.#active?.index === event.contentIndex || this.#durations?.[event.contentIndex] !== undefined) {
					break;
				}
				this.#close(now);
				this.#active = {
					index: event.contentIndex,
					start: this.#leading && event.contentIndex === 0 ? this.#streamStart : now,
				};
				this.#leading = false;
				break;
			case "thinking_end":
				if (this.#active?.index === event.contentIndex) this.#close(now);
				this.#leading = false;
				break;
			case "text_start":
			case "text_delta":
			case "text_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
			case "image_end":
				this.#close(now);
				this.#leading = false;
				break;
		}
		return this.#durations;
	}

	/** Preserve an open block's observed time on completion or interruption, then reset. */
	finish(now: number): Record<number, number> | undefined {
		this.#close(now);
		const durations = this.#durations;
		this.#streamStart = undefined;
		this.#durations = undefined;
		return durations;
	}

	#close(now: number): void {
		if (!this.#active) return;
		const { index, start } = this.#active;
		this.#durations = { ...this.#durations, [index]: Math.max(0, Math.round(now - start)) };
		this.#active = undefined;
	}
}
