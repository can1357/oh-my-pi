import { Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { WidthAwareText } from "../../tui";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import { formatErrorBlock } from "./error-block";

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
 */
export class ErrorBannerComponent extends Container {
	constructor(message: string) {
		super();
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
}
