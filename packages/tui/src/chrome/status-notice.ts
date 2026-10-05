import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { EMPTY_NODE, node } from "../native/describe";
import type { NativeNode } from "../native/node";
import { styledSpans } from "../native/spans";
import { Container } from "../tui";

/** How long a native status toast stays up (ms). */
const TOAST_TTL = 2400;

/** How a {@link StatusNotice} shows. */
export interface StatusNoticeOptions {
	/** Styles the ANSI line; resolved at render so a theme change re-shapes it. */
	styleFn?: (text: string) => string;
	/**
	 * Whether a native terminal toasts it (default). False keeps the notice to
	 * the ANSI transcript: background chatter such as MCP connection progress,
	 * which would otherwise re-toast on every server that connects or fails.
	 */
	toast?: boolean;
}

/**
 * A transient status notice (`showStatus`: "Thinking blocks: hidden", "Copied
 * to clipboard"). The ANSI render appends a blank row and the dim line to the
 * transcript; a native terminal shows it as a toast instead, so notices never
 * pile up in the history. Updating the text re-shows the toast; a notice
 * with `toast: false` describes nothing natively.
 */
export class StatusNotice extends Container {
	readonly #text: Text;
	#message: string;
	#toast: boolean;
	#native: NativeNode | undefined;

	constructor(message: string, options: StatusNoticeOptions = {}) {
		super();
		this.#message = message;
		this.#toast = options.toast ?? true;
		this.#text = new Text(message, 1, 0).setStyleFn(options.styleFn);
		this.addChild(new Spacer(1));
		this.addChild(this.#text);
	}

	setMessage(message: string, options: StatusNoticeOptions = {}): void {
		const toast = options.toast ?? true;
		this.#text.setStyleFn(options.styleFn);
		this.#text.setText(message);
		if (message !== this.#message || toast !== this.#toast) this.#native = undefined;
		this.#message = message;
		this.#toast = toast;
	}

	override describe(): NativeNode {
		if (!this.#toast) return EMPTY_NODE;
		if (this.#native) return this.#native;
		// Callers may pass pre-styled text; a toast takes plain text.
		const plain = styledSpans(this.#message)
			.map(run => run.t)
			.join("");
		this.#native = node("toast", { text: plain, ttl: TOAST_TTL, role: "omp.toast.status" });
		return this.#native;
	}
}
