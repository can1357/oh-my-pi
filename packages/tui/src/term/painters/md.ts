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
 */
import type { TspMarkdownProps } from "@oh-my-pi/pi-wire";
import { signal } from "../../reactive";
import { renderMarkdownFrame, takeExtensionLinks } from "../../text/markdown";
import { definePainter, EMPTY_BLOCK, type Hit } from "../paint";

const linkSchemes = signal<readonly string[]>([]);

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

const look = signal<{ readonly colorful: boolean; readonly mermaid: boolean }>({ colorful: true, mermaid: true });

/** The host's Markdown look settings (palette hues, mermaid diagrams); `md` blocks repaint on a change. */
export function setMarkdownLook(next: { readonly colorful: boolean; readonly mermaid: boolean }): void {
	const current = look();
	if (current.colorful !== next.colorful || current.mermaid !== next.mermaid) look.set(next);
}

definePainter("md", (node, cx) => {
	const props = node.props() as TspMarkdownProps;
	const text = props.text ?? "";
	if (!text.trim()) return EMPTY_BLOCK;
	const stream = props.stream === true;
	const schemes = linkSchemes();
	const frame = renderMarkdownFrame(text, cx.width, {
		theme: cx.theme,
		stream,
		marks: props.marks,
		hyperlinks: cx.hyperlinks,
		textSizing: cx.textSizing,
		colorful: look().colorful,
		mermaid: look().mermaid,
		linkSchemes: schemes.length > 0 ? schemes : undefined,
	});
	if (frame.rows.length === 0) return EMPTY_BLOCK;
	let rows = frame.rows;
	let hits: Hit[] | undefined;
	if (schemes.length > 0) {
		rows = frame.rows.map((line, row) => {
			const taken = takeExtensionLinks(line);
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
			return taken.row;
		});
	}
	const stable = stream && frame.stable > 0 ? frame.stable : undefined;
	return { rows, ...(stable !== undefined && { stable }), ...(hits && { hits }) };
});
