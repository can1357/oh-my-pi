/**
 * The yield-queue shorthand (`->` / `=>`, see `parseQueueShorthand`) in the
 * composer. In the terminal, completing a bare prefix opens the body on the
 * next line and the prefix's line draws as a dim `Queueing ➤` header; a Tern
 * terminal keeps the body on the prefix's line and dims the prefix. Each
 * marker of a sequential list body (`1.`, `b)`) takes the accent, so the
 * separate follow-ups it queues stay visible while composing.
 */
import { nativeRendering } from "@oh-my-pi/pi-tui";
import { isBareQueuePrefix, queueShorthandMarks } from "../../modes/view-model/prompt/queue-input";
import type { Composer, ComposerDecoration } from "./composer";

/** Show `composer`'s queue shorthand, `icon` closing the header (`nav.selected`); returns the detach. */
export function attachQueueShorthand(composer: Composer, icon: () => string): () => void {
	const removals = [
		composer.addDecorator(text => {
			const marks = queueShorthandMarks(text);
			if (!marks) return [];
			return [
				{ ...marks.prefix, s: "dim", label: `Queueing ${icon()}` },
				...marks.markers.map((marker): ComposerDecoration => ({ ...marker, s: "accent" })),
			];
		}),
		// An edit leaving just the prefix (typing its second character, deleting the body's line
		// break) opens the body beneath it, keeping the header's line to the prefix.
		composer.addEditListener((_edit, field) => {
			if (nativeRendering() || field.cursor() !== 2 || !isBareQueuePrefix(field.text())) return;
			field.insertText("\n");
		}),
	];
	return () => {
		for (const remove of removals) remove();
	};
}
