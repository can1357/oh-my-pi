import type { TextContent } from "@oh-my-pi/pi-ai";
import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import type { CollabPromptDetails } from "../../collab/protocol";
import type { CustomMessage } from "../../session/messages";
import { getMarkdownTheme, theme } from "../theme/theme";

/**
 * Renders a collab guest prompt on every participant's transcript: a
 * user-message-styled bubble prefixed with the author's name.
 */
export class CollabPromptMessageComponent extends Container {
	constructor(message: CustomMessage<CollabPromptDetails>) {
		super();
		const from = message.details?.from?.trim() || "guest";
		const authorText = new Text(theme.fg("accent", `\x1b[1m«${from}»\x1b[22m ›`), 1, 0);
		authorText.setIgnoreTight(true);
		this.addChild(authorText);
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((content): content is TextContent => content.type === "text")
						.map(content => content.text)
						.join("");
		const md = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: (value: string) => theme.fgOnBg("userMessageText", "userMessageBg", value),
		});
		md.setIgnoreTight(true);
		this.addChild(md);
	}
}
