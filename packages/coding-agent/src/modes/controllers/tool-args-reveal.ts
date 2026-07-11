import { parseStreamingJson } from "@pk-nerdsaver-ai/pi-utils";
import { nextStep, STREAMING_REVEAL_FRAME_MS } from "./streaming-reveal";

/** Minimal component surface the reveal pushes frames into. */
type ToolArgsRevealComponent = {
	updateArgs(args: unknown, toolCallId?: string): void;
};

type ToolArgsRevealControllerOptions = {
	getSmoothStreaming(): boolean;
	requestRender(): void;
};

type RevealEntry = {
	component: ToolArgsRevealComponent | undefined;
	/** Latest raw streamed argument text (JSON for function tools, raw text for custom tools). */
	target: string;
	/** Revealed UTF-16 code units of `target`. */
	revealed: number;
	/** Custom-tool raw input: display args are `{ input: prefix }`, never parsed as JSON. */
	rawInput: boolean;
};

/** Clamp a slice end into `text`, never splitting a surrogate pair: a prefix
 *  ending on a high surrogate would feed a lone surrogate into the parsed
 *  preview args (providers decode UTF-8 incrementally, so the raw stream
 *  itself never contains one). */
function clampSliceEnd(text: string, end: number): number {
	if (end <= 0) return 0;
	if (end >= text.length) return text.length;
	const code = text.charCodeAt(end - 1);
	return code >= 0xd800 && code <= 0xdbff ? end + 1 : end;
}

/** Display args for a revealed raw-stream prefix. Function-tool prefixes are
 *  re-parsed with the same streaming-tolerant parser providers use, so every
 *  frame is a state the provider itself could have produced; custom tools
 *  mirror the provider's `{ input }` shape. `__partialJson` carries the
 *  matching raw prefix for renderers that read it directly (bash env preview,
 *  edit strategies). */
function buildDisplayArgs(prefix: string, rawInput: boolean): Record<string, unknown> {
	const base: Record<string, unknown> = rawInput ? { input: prefix } : parseStreamingJson(prefix);
	return { ...base, __partialJson: prefix };
}

/**
 * Paces streamed tool-call arguments the same way StreamingRevealController
 * paces assistant text: providers that deliver `partialJson` in large batches
 * (or throttle their partial parses) would otherwise make write/edit/bash
 * streaming previews jump in chunks. Each pending tool call reveals its raw
 * argument stream at the shared 30fps cadence with the same adaptive
 * catch-up step, re-parsing the revealed prefix per frame.
 *
 * Reveal units are UTF-16 code units of the raw stream, not graphemes —
 * the prefix goes through a JSON parser rather than straight to the screen,
 * so only surrogate-pair integrity matters (see {@link clampSliceEnd}).
 */
export class ToolArgsRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #requestRender: () => void;
	readonly #entries = new Map<string, RevealEntry>();
	#timer: NodeJS.Timeout | undefined;

	constructor(options: ToolArgsRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#requestRender = options.requestRender;
	}

	/**
	 * Record the latest streamed argument text for a tool call and return the
	 * args to render right now. With smoothing disabled the full target passes
	 * through in the caller's legacy shape (`{ ...args, __partialJson }`).
	 */
	setTarget(
		id: string,
		partialJson: string,
		rawInput: boolean,
		fullArgs: Record<string, unknown>,
	): Record<string, unknown> {
		if (!this.#getSmoothStreaming()) {
			// Toggle may flip mid-call: drop any live entry so ticks stop.
			this.#entries.delete(id);
			return { ...fullArgs, __partialJson: partialJson };
		}
		let entry = this.#entries.get(id);
		if (!entry) {
			entry = { component: undefined, target: partialJson, revealed: 0, rawInput };
			this.#entries.set(id, entry);
		} else {
			// Streams only append; a non-prefix target means a rewind — snap into range.
			if (!partialJson.startsWith(entry.target)) {
				entry.revealed = Math.min(entry.revealed, partialJson.length);
			}
			entry.target = partialJson;
		}
		entry.revealed = clampSliceEnd(entry.target, entry.revealed);
		this.#syncTimer();
		return buildDisplayArgs(entry.target.slice(0, entry.revealed), entry.rawInput);
	}

	/** Attach the component future ticks push frames into. */
	bind(id: string, component: ToolArgsRevealComponent): void {
		const entry = this.#entries.get(id);
		if (entry) entry.component = component;
	}

	/** Final arguments arrived (the JSON closed): drop the reveal so the
	 *  caller's final-args render wins immediately, mirroring how assistant
	 *  text snaps to the full message at message_end. */
	finish(id: string): void {
		this.#entries.delete(id);
		if (this.#entries.size === 0) this.#stopTimer();
	}

	/** Snap every live entry to its full received stream and clear. Used at
	 *  message_end (abort/error mid-stream) so sealed components freeze showing
	 *  everything that arrived rather than a mid-reveal prefix. */
	flushAll(): void {
		for (const [id, entry] of this.#entries) {
			if (entry.component && entry.revealed < entry.target.length) {
				entry.component.updateArgs(buildDisplayArgs(entry.target, entry.rawInput), id);
			}
		}
		this.#entries.clear();
		this.#stopTimer();
	}

	/** Clear without pushing (teardown). */
	stop(): void {
		this.#entries.clear();
		this.#stopTimer();
	}

	#syncTimer(): void {
		for (const entry of this.#entries.values()) {
			if (entry.revealed < entry.target.length) {
				this.#startTimer();
				return;
			}
		}
		this.#stopTimer();
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick();
		}, STREAMING_REVEAL_FRAME_MS);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#tick(): void {
		let advanced = false;
		for (const [id, entry] of this.#entries) {
			const backlog = entry.target.length - entry.revealed;
			if (backlog <= 0 || !entry.component) continue;
			entry.revealed = clampSliceEnd(entry.target, entry.revealed + nextStep(backlog));
			entry.component.updateArgs(buildDisplayArgs(entry.target.slice(0, entry.revealed), entry.rawInput), id);
			advanced = true;
		}
		if (advanced) {
			this.#requestRender();
		} else {
			// Every entry caught up (or unbound); setTarget restarts on growth.
			this.#stopTimer();
		}
	}
}
