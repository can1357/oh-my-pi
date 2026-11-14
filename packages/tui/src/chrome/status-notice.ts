import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { EMPTY_NODE, node } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { styledSpans } from "../native/spans";
import { Container } from "../tui";

/** How long a native status toast stays up (ms). */
const TOAST_TTL = 2400;

/** A button on a notice's native toast (the Undo after a rewind). */
export interface StatusNoticeAction {
	/** The toast's action name (`undo`). */
	readonly act: string;
	/** The button's text. */
	readonly label: string;
	/** Runs when the button is clicked. */
	readonly run: () => void;
}

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
	/**
	 * A button on the native toast, which then stays up as long as the terminal keeps an action toast (6 s in
	 * Tern) instead of {@link TOAST_TTL}; the ANSI line has none.
	 */
	action?: StatusNoticeAction;
}

/**
 * A transient status notice (`showStatus`: "Thinking blocks: hidden", "Copied
 * to clipboard"). The ANSI render appends a blank row and the dim line to the
 * transcript; a native terminal shows it as a toast instead, so notices never
 * pile up in the history. Updating the text re-shows the toast; a notice
 * with `toast: false` describes nothing natively. An `action` puts a button
 * on the toast (Undo) whose click runs it.
 */
export class StatusNotice extends Container {
	readonly #text: Text;
	#message: string;
	#toast: boolean;
	#action: StatusNoticeAction | undefined;
	#native: NativeNode | undefined;

	constructor(message: string, options: StatusNoticeOptions = {}) {
		super();
		this.#message = message;
		this.#toast = options.toast ?? true;
		this.#action = options.action;
		this.#text = new Text(message, 1, 0).setStyleFn(options.styleFn);
		this.addChild(new Spacer(1));
		this.addChild(this.#text);
	}

	/** The text the notice currently shows. */
	get message(): string {
		return this.#message;
	}

	setMessage(message: string, options: StatusNoticeOptions = {}): void {
		const toast = options.toast ?? true;
		this.#text.setStyleFn(options.styleFn);
		this.#text.setText(message);
		if (message !== this.#message || toast !== this.#toast || options.action !== this.#action)
			this.#native = undefined;
		this.#message = message;
		this.#toast = toast;
		this.#action = options.action;
	}

	override describe(): NativeNode {
		if (!this.#toast) return EMPTY_NODE;
		if (this.#native) return this.#native;
		// Callers may pass pre-styled text; a toast takes plain text.
		const plain = styledSpans(this.#message)
			.map(run => run.t)
			.join("");
		const action = this.#action;
		this.#native = node(
			"toast",
			action
				? { text: plain, action: action.act, label: action.label, role: "omp.toast.status" }
				: { text: plain, ttl: TOAST_TTL, role: "omp.toast.status" },
		);
		return this.#native;
	}

	/** The toast's button. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && this.#action && event.act === this.#action.act) this.#action.run();
	}
}
