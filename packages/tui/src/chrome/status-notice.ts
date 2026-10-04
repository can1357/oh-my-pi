import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { node } from "../native/describe";
import type { NativeNode } from "../native/node";
import { styledSpans } from "../native/spans";
import { Container } from "../tui";

/** How long a native status toast stays up (ms). */
const TOAST_TTL = 2400;

/**
 * A transient status notice (`showStatus`: "Thinking blocks: hidden", "Copied
 * to clipboard"). The ANSI render appends a blank row and the dim line to the
 * transcript; a native terminal shows it as a toast instead, so notices never
 * pile up in the history. Updating the text re-shows the toast.
 */
export class StatusNotice extends Container {
	readonly #text: Text;
	#message: string;
	#native: NativeNode | undefined;

	constructor(message: string, styleFn?: (text: string) => string) {
		super();
		this.#message = message;
		this.#text = new Text(message, 1, 0).setStyleFn(styleFn);
		this.addChild(new Spacer(1));
		this.addChild(this.#text);
	}

	setMessage(message: string, styleFn?: (text: string) => string): void {
		this.#text.setStyleFn(styleFn);
		this.#text.setText(message);
		if (message !== this.#message) this.#native = undefined;
		this.#message = message;
	}

	override describe(): NativeNode {
		if (this.#native) return this.#native;
		// Callers may pass pre-styled text; a toast takes plain text.
		const plain = styledSpans(this.#message)
			.map(run => run.t)
			.join("");
		this.#native = node("toast", { text: plain, ttl: TOAST_TTL, role: "omp.toast.status" });
		return this.#native;
	}
}
