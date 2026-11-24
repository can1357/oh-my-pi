/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The attachment band: one card per chip in the draft (`row` with role
 * `omp.composer.chips`, hidden while there is none). A card is titled with
 * the chip's token (`📄 #1`); a text attachment shows its first lines and a
 * `+N lines` / `N chars` caption, an image or video its picture (when the
 * app gives one) and its size. The terminal draws each card as a small
 * rounded box in the chip's color, above the composer.
 */
import { For, type JSXNode } from "@oh-my-pi/pi-tui";
import type { ChipCardTerm } from "../styles/composer/chips";
import type { Atom } from "./attachments";
import { chipColor } from "./attachments";
import type { Composer } from "./composer";

/** Lines of a text chip's preview. */
const PREVIEW_LINES = 4;

/** Caption of a text attachment: its line count, or its length when it is one line. */
export function textCaption(content: string): string {
	const lines = content.split("\n").length;
	return lines > 1 ? `+${lines} lines` : `${content.length} chars`;
}

function card(
	atom: Atom & { kind: "paste" | "image" | "video" },
	size?: string,
	link?: () => string | undefined,
): JSXNode {
	const term: ChipCardTerm = { color: chipColor(atom.kind, atom.n), kind: atom.kind };
	const content = atom.content ?? atom.expansion ?? "";
	return (
		<card
			key={`${atom.kind}:${atom.n}`}
			role="omp.composer.chip"
			tone="accent"
			head={() => {
				// An image's title links to its file (the terminal draws it as an OSC 8 link).
				const href = link?.();
				return [href ? { s: "strong", t: atom.label, href } : { s: "strong", t: atom.label }];
			}}
			term={term}
		>
			{atom.kind === "paste" ? (
				<text
					spans={[{ s: "muted", t: content.split("\n", PREVIEW_LINES).join("\n") }]}
					wrap="none"
					lines={PREVIEW_LINES}
				/>
			) : null}
			{atom.kind === "paste" ? (
				<text spans={[{ s: "dim", t: textCaption(content) }]} wrap="none" />
			) : size ? (
				<text spans={[{ s: "dim", t: size }]} wrap="none" />
			) : null}
		</card>
	);
}

/** The band of `composer`'s chips; `imageSize` gives an image's `WxH` caption. */
export function ComposerChips(props: { composer: Composer; imageSize?: (atom: Atom) => string | undefined }): JSXNode {
	const chips = () =>
		props.composer
			.chips()
			.filter(
				(atom): atom is Atom & { kind: "paste" | "image" | "video" } =>
					atom.kind !== "marker" && atom.kind !== "token",
			);
	return (
		<row role="omp.composer.chips" gap="sm" wrap={true} hidden={() => chips().length === 0}>
			<For each={chips}>
				{atom =>
					atom.kind === "paste"
						? card(atom)
						: card(atom, props.imageSize?.(atom), () => props.composer.imageLink(atom))
				}
			</For>
		</row>
	);
}
