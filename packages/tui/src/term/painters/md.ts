/**
 * `md`: Markdown prose at the block's width. A streaming node (`stream`)
 * renders its growing source the way the finished text will look: open links
 * and math close speculatively and a table's row being written keeps the
 * table's layout. Its finished blocks are reported as the block's stable
 * head, so the main surface can move them into history early.
 *
 * Links of a scheme the host routes itself ({@link setLinkSchemes}, an
 * extension's `pi.registerLinkScheme`) draw their label alone, underlined in
 * `mdExtensionLink`. Each label's cells are a mouse hit whose item is the
 * href: a left click bubbles `select` with the href from the `md` node. The
 * rows never carry the label's marker, so the terminal gets no hyperlink it
 * would open itself.
 *
 * When `props.codeCopy` is true, each fenced code block header draws a
 * clickable `[Copy]` button whose cells are a mouse hit with
 * `act = "code-copy:<hash>"`. Calling {@link markCodeCopied} briefly flips
 * that block's label to `[Copied]` without invalidating the Markdown block
 * cache.
 */
import type { TspMarkdownProps } from "@oh-my-pi/pi-wire";
import { signal } from "../../reactive";
import {
	CODE_COPY_ACT_PREFIX,
	renderMarkdownFrame,
	replaceCodeCopyLabel,
	takeCodeCopyMarkers,
	takeExtensionLinks,
} from "../../text/markdown";
import { definePainter, EMPTY_BLOCK, type Hit } from "../paint";

const linkSchemes = signal<readonly string[]>([]);
const copiedCode = signal<string | undefined>(undefined);
let copiedCodeTimer: Timer | undefined;

/** The link schemes the host routes (reactive): painters drawing Markdown of their own take them too. */
export function routedLinkSchemes(): readonly string[] {
	return linkSchemes();
}

/** Set the link schemes the host routes (lowercase, without `:`); `md` blocks repaint on a change. */
export function setLinkSchemes(schemes: Iterable<string>): void {
	const next = [...new Set(schemes)].sort();
	const current = linkSchemes();
	if (next.length !== current.length || next.some((scheme, i) => scheme !== current[i])) linkSchemes.set(next);
}

/** The content hash of the code block most recently copied (reactive), for brief `[Copied]` feedback. */
export function copiedCodeHash(): string | undefined {
	return copiedCode();
}

/** Show brief `[Copied]` feedback on the code block matching `hash`, clearing after `durationMs`. */
export function markCodeCopied(hash: string, durationMs = 1500): void {
	if (copiedCodeTimer !== undefined) {
		clearTimeout(copiedCodeTimer);
		copiedCodeTimer = undefined;
	}
	copiedCode.set(hash);
	if (durationMs > 0) {
		copiedCodeTimer = setTimeout(() => {
			copiedCodeTimer = undefined;
			if (copiedCode.peek() === hash) copiedCode.set(undefined);
		}, durationMs);
		copiedCodeTimer.unref?.();
	}
}

/** Clear any active `[Copied]` visual feedback state immediately. */
export function clearCopiedCode(): void {
	if (copiedCodeTimer !== undefined) {
		clearTimeout(copiedCodeTimer);
		copiedCodeTimer = undefined;
	}
	if (copiedCode.peek() !== undefined) copiedCode.set(undefined);
}

definePainter("md", (node, cx) => {
	const props = node.props() as TspMarkdownProps;
	const text = props.text ?? "";
	if (!text.trim()) return EMPTY_BLOCK;
	const stream = props.stream === true;
	const schemes = linkSchemes();
	const codeCopy = props.codeCopy === true;
	const frame = renderMarkdownFrame(text, cx.width, {
		theme: cx.theme,
		stream,
		marks: props.marks,
		hyperlinks: cx.hyperlinks,
		textSizing: cx.textSizing,
		linkSchemes: schemes.length > 0 ? schemes : undefined,
		codeCopy,
	});
	if (frame.rows.length === 0) return EMPTY_BLOCK;
	let rows = frame.rows;
	let hits: Hit[] | undefined;
	if (schemes.length > 0 || codeCopy) {
		let copiedHash: string | undefined;
		let readCopied = false;
		rows = frame.rows.map((line, row) => {
			let out = line;
			if (schemes.length > 0) {
				const taken = takeExtensionLinks(out);
				for (const link of taken.links) {
					(hits ??= []).push({
						row,
						col: link.start,
						width: link.end - link.start,
						height: 1,
						node,
						item: link.href,
					});
				}
				out = taken.row;
			}
			if (codeCopy) {
				const taken = takeCodeCopyMarkers(out);
				out = taken.row;
				if (taken.buttons.length > 0) {
					if (!readCopied) {
						copiedHash = copiedCode();
						readCopied = true;
					}
					for (const button of taken.buttons) {
						let start = button.start;
						let end = button.end;
						if (copiedHash === button.hash) {
							const swapped = replaceCodeCopyLabel(out, start, end, cx.theme.fg("success", "[Copied]"));
							out = swapped.row;
							start = swapped.start;
							end = swapped.end;
						}
						(hits ??= []).push({
							row,
							col: start,
							width: end - start,
							height: 1,
							node,
							act: `${CODE_COPY_ACT_PREFIX}${button.hash}`,
						});
					}
				}
			}
			return out;
		});
	}
	const stable = stream && frame.stable > 0 ? frame.stable : undefined;
	return { rows, ...(stable !== undefined && { stable }), ...(hits && { hits }) };
});
