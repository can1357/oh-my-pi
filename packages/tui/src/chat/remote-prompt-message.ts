import type { TextContent } from "@oh-my-pi/pi-ai";
import { Container } from "../tui";
import { Markdown } from "../components/markdown";
import { Text } from "../components/text";
import { TELEGRAM_PROMPT_MESSAGE_TYPE, type CustomMessage } from "./messages";
import { card, md, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { sanitizeDisplayLineField } from "../overlays/extensions/display-text";
import { TRUNCATE_LENGTHS } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme";
import { truncateToWidth } from "../utils";

/**
 * Details shared by every remote prompt bubble (`collab-prompt`,
 * `telegram-prompt`): the display name of whoever sent the prompt.
 */
export interface RemotePromptDetails {
	from?: string;
}

export interface RemotePromptMessageOptions {
	/** Author shown when `details.from` is blank. Defaults to "guest". */
	fallbackFrom?: string;
	/** Sender attribution rendered after the author, e.g. "via Telegram". */
	via?: string;
}

/**
 * Renders a remote sender's prompt on the local transcript: a
 * user-message-styled bubble prefixed with the author's name (and, for a
 * bridged chat, how the prompt reached this session).
 */
export class RemotePromptMessageComponent extends Container {
	readonly #native: NativeNode;

	constructor(message: CustomMessage<RemotePromptDetails>, options: RemotePromptMessageOptions = {}) {
		super();
		// The sender name comes from the remote side (a collab guest, a Telegram
		// profile): strip controls and newlines before theming, and bound it.
		const from = truncateToWidth(
			sanitizeDisplayLineField(message.details?.from) ?? options.fallbackFrom ?? "guest",
			TRUNCATE_LENGTHS.SHORT,
		);
		const attribution = options.via ? theme.fg("muted", ` ${options.via}`) : "";
		const authorText = new Text(`${theme.fg("accent", `\x1b[1m«${from}»\x1b[22m`)}${attribution} ›`, 1, 0);
		authorText.setIgnoreTight(true);
		this.addChild(authorText);
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");
		const markdown = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: (value: string) => theme.fgOnBg("userMessageText", "userMessageBg", value),
		});
		markdown.setIgnoreTight(true);
		this.addChild(markdown);
		const head = options.via
			? [span(`«${from}»`, "accent strong"), span(` ${options.via}`, "muted"), span(" ›", "accent strong")]
			: [span(`«${from}» ›`, "accent strong")];
		this.#native = card(
			{
				role: message.customType === TELEGRAM_PROMPT_MESSAGE_TYPE ? "omp.user.telegram" : "omp.user.collab",
				tone: "user",
				head,
			},
			[md(text)],
		);
	}

	/** A user-toned card with sender attribution and the prompt as markdown. */
	override describe(): NativeNode {
		return this.#native;
	}
}
