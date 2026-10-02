import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { node, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { theme } from "../theme";
import { Container } from "../tui";

/**
 * The idle recap (`recap.*`): where the session stands, written while the user
 * was away. Stays in the transcript like a thought: a dim italic `※ recap:`
 * line in ANSI, a history icon beside the italic thought-coloured text in a
 * native terminal (`omp.recap`).
 */
export class RecapNotice extends Container {
	readonly #recap: string;

	constructor(recap: string) {
		super();
		this.#recap = recap;
		this.addChild(new Spacer(1));
		this.addChild(new Text(`※ recap: ${recap}`, 1, 0).setStyleFn(line => theme.fg("dim", theme.italic(line))));
	}

	override describe(): NativeNode {
		return node("row", { gap: "sm", align: "start", role: "omp.recap", title: "Recap while you were away" }, [
			node("icon", { name: "history" }, undefined, "icon"),
			text(this.#recap, { wrap: "word" }),
		]);
	}
}
