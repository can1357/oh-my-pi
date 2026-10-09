import { Text } from "../components/text";
import { span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { theme } from "../theme";

/** Dim first row of a redrawn transcript that starts after older history. */
export class HiddenHistoryNotice extends Text {
	readonly #label: string;
	#native: NativeNode | undefined;

	/** `hiddenMessages`: transcript messages above the first drawn one. */
	constructor(readonly hiddenMessages: number) {
		const label = `${hiddenMessages} earlier message${hiddenMessages === 1 ? "" : "s"} not shown · /tree to browse`;
		super(label, 1, 0);
		// Styled lazily so a theme switch repaints the row in the new palette.
		this.setStyleFn(text => theme.fg("dim", theme.italic(text)));
		this.#label = label;
	}

	override describe(): NativeNode {
		this.#native ??= text([span(this.#label, "dim em")], { wrap: "word", role: "omp.transcript.hidden" });
		return this.#native;
	}
}
