import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { JsDisplayOutput } from "../../eval/js/shared/types";

/**
 * Accumulates a browser run's result entries: explicit `display()` payloads,
 * screenshot captions/images, and buffered stream text (`console.*`, `print`,
 * `display()` of strings/primitives — `JsRuntime.displayValue` emits those via
 * `onText`). Stream text is buffered and flushed as one entry before the next
 * display/screenshot (and on `finish()`) so it reaches the tool result in
 * order instead of vanishing into the debug log.
 */
export class RunOutput {
	readonly #displays: Array<TextContent | ImageContent> = [];
	#textBuffer = "";

	/** Buffer a stream-text chunk; it joins the entries at the next push or on finish(). */
	pushText(chunk: string): void {
		this.#textBuffer += chunk;
	}

	/** Append a `display()` payload (image/json/status), flushing buffered text first. */
	pushDisplay(output: JsDisplayOutput): void {
		if (output.type === "image") {
			this.push({ type: "image", data: output.data, mimeType: output.mimeType });
			return;
		}
		if (output.type === "json") {
			this.push({ type: "text", text: safeJsonStringify(output.data) });
			return;
		}
		// status — surface as compact JSON so helper side effects (read/write/env) appear in
		// the cell result alongside explicit display() output.
		this.push({ type: "text", text: safeJsonStringify(output.event) });
	}

	/** Append a pre-built entry (e.g. a screenshot caption/image), flushing buffered text first. */
	push(entry: TextContent | ImageContent): void {
		this.#flush();
		this.#displays.push(entry);
	}

	/** Flush any remaining stream text and return the ordered entries. */
	finish(): Array<TextContent | ImageContent> {
		this.#flush();
		return this.#displays;
	}

	#flush(): void {
		if (!this.#textBuffer) return;
		// Entries are newline-joined at render; drop the stream's trailing newline.
		this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
		this.#textBuffer = "";
	}
}

/** JSON.stringify that never throws (cycles/BigInt → String(value)). */
export function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Pass a return value across the run boundary: structured-cloneable as-is, else JSON round-trip, else String. */
export function cloneSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		structuredClone(value);
		return value;
	} catch {}
	try {
		return JSON.parse(JSON.stringify(value)) as unknown;
	} catch {}
	return String(value);
}
