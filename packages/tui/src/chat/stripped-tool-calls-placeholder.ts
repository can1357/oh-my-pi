import { Text } from "../components/text";
import { theme } from "../theme";
import { span, text } from "../native/describe";
import type { NativeNode } from "../native/node";

/**
 * Dim transcript marker for tool calls stripped from the resolved branch
 * (failed/retried turns, results on sibling branches). It is tool activity,
 * so it hides and reappears with the `display.hideToolActivity` toggle.
 */
export class StrippedToolCallsPlaceholder extends Text {
	#toolActivityVisible: boolean;
	readonly #label: string;
	#native: NativeNode | undefined;

	constructor(strippedToolCalls: number, toolActivityVisible: boolean) {
		const label = `${strippedToolCalls} tool call${strippedToolCalls === 1 ? "" : "s"} elided — no result on this branch`;
		super(theme.fg("dim", theme.italic(label)), 1, 0);
		this.#label = label;
		this.#toolActivityVisible = toolActivityVisible;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		this.#native = undefined;
		this.invalidate();
	}

	/** A dim italic note, mounted but hidden while tool activity is hidden. */
	override describe(): NativeNode {
		this.#native ??= text([span(this.#label, "dim em")], {
			wrap: "word",
			role: "omp.tool.elided",
			hidden: this.#toolActivityVisible ? undefined : true,
		});
		return this.#native;
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}
}
