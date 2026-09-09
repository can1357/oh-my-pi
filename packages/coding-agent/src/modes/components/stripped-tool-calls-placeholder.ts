import { Text } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";

/**
 * Dim transcript marker for tool calls stripped from the resolved branch
 * (failed/retried turns, results on sibling branches). It is tool activity,
 * so it hides and reappears with the `display.hideToolActivity` toggle.
 */
export class StrippedToolCallsPlaceholder extends Text {
	#toolActivityVisible: boolean;

	constructor(strippedToolCalls: number, toolActivityVisible: boolean) {
		super(
			theme.fg(
				"dim",
				theme.italic(
					`${strippedToolCalls} tool call${strippedToolCalls === 1 ? "" : "s"} elided — no result on this branch`,
				),
			),
			1,
			0,
		);
		this.#toolActivityVisible = toolActivityVisible;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}
}
