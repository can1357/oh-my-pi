import { Container, Spacer, Text } from "../index";
import { WidthAwareText } from "../render/index";
import { theme } from "../theme/theme";
import { DynamicBorder } from "../chrome/dynamic-border";
import { formatErrorBlock } from "../chrome/error-block";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { node, span, text } from "../native/describe";
import { actionButton } from "../native/overlay";
import { plainText } from "../native/spans";

/** Max wrapped rows of the error message shown in the pinned banner. */
const MAX_BANNER_ROWS = 4;

/**
 * A persistent error banner pinned above the editor. Unlike the transcript
 * "Error: …" line (which scrolls away as the conversation grows), this stays in
 * the fixed region directly above the input so a turn that ended on a provider
 * error — e.g. Anthropic's "Output blocked by content filtering policy" — cannot
 * be missed. It is cleared when the next turn starts. The message wraps to the
 * render width and keeps {@link MAX_BANNER_ROWS} rows; the expand hint on the
 * overflow row reveals the full body inline in the transcript.
 *
 * Natively the transcript's error frame always shows the full message, so the
 * strip is only a reminder and offers a Dismiss button that calls `onDismiss`.
 */
export class ErrorBannerComponent extends Container {
	readonly #message: string;
	readonly #onDismiss: (() => void) | undefined;
	/** Natively the strip shows the headline; Details unfolds the whole message in place. */
	#expanded = false;
	#native: NativeNode | undefined;

	constructor(message: string, onDismiss?: () => void) {
		super();
		this.#message = plainText(message).trim();
		this.#onDismiss = onDismiss;
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(str => theme.fg("error", str)));
		this.addChild(
			new WidthAwareText(
				contentWidth =>
					formatErrorBlock(message, contentWidth, MAX_BANNER_ROWS, (line, index) =>
						index === 0
							? theme.bold(theme.fg("error", `${theme.status.error} ${line}`))
							: theme.fg("error", line),
					),
				1,
				0,
			),
		);
		this.addChild(new Text(theme.fg("dim", "Dismissed when you send your next message."), 1, 0));
		this.addChild(new DynamicBorder(str => theme.fg("error", str)));
	}

	/**
	 * An error-tinted strip pinned above the composer: the message's first line
	 * (the transcript's error frame keeps the full message and its actions)
	 * and a Details button that unfolds the rest here, then Dismiss.
	 */
	override describe(): NativeNode {
		if (this.#native) return this.#native;
		const headline =
			this.#message
				.split("\n")
				.find(line => line.trim() !== "")
				?.trim() || "Error";
		const multiline = this.#message !== headline;
		const message = this.#expanded
			? text([span(this.#message, "error")], { wrap: "word", grow: 1 })
			: text([span(headline, "error")], { truncate: "end", lines: 1, grow: 1, title: this.#message });
		const children: NativeNode[] = [message];
		if (multiline || headline.length > 80) {
			children.push(actionButton(this.#expanded ? "Less" : "Details", "details"));
		}
		if (this.#onDismiss) children.push(actionButton("Dismiss", "dismiss"));
		this.#native = node(
			"row",
			{ role: "omp.errorBanner", tone: "error", gap: "sm", align: this.#expanded ? "start" : "center" },
			children,
		);
		return this.#native;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "dismiss") {
			this.#onDismiss?.();
			return;
		}
		if (event.act !== "details") return;
		this.#expanded = !this.#expanded;
		this.#native = undefined;
	}
}
