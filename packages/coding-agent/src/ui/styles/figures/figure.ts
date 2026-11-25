/**
 * Figures.
 *
 * - `image` `omp.figure` (an SVG figure, a fenced SVG): the raster, at most
 *   two cells short of the width; its `[Image: …]` label where it cannot be
 *   drawn.
 * - `image` `omp.figure.svg` (an SVG fence inside a reply): the raster, else
 *   the fence's code as the reply's Markdown draws it.
 * - `image` `omp.figure.chart`: a table's chart under a blank row (inside a
 *   reply: no blank row, and nothing where images cannot be drawn).
 * - `md` `omp.figure.code`: a fence's Markdown with the standard inset.
 * - `text` `omp.figure.pending`: `Drawing SVG…`, one cell in.
 * - `image`/`web` `omp.embed`: the picture (a frame's captured still), else
 *   ` ▣ <name>` dim, with why it is not shown where images can be drawn.
 * - `col` `omp.figures` (a reply with figures): its runs set off by blank
 *   rows, prose Markdown with the standard inset.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { paintImage, paintPicture } from "@oh-my-pi/pi-tui/term/painters/image";
import { stack, styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { terminalPaddingX } from "../terminal-padding";
import type { EmbedTerm } from "../../transcript/figures/embed";
import type { FigureTerm } from "../../transcript/figures/svg-figure";
import type { ChartTerm } from "../../transcript/figures/table-chart";
import { propsOf, termOf } from "../messages/fill";
import { fileLink, uriLink } from "../tools/file-common";

/** `cx` at `width` cells (its getters keep reading the paint environment). */
function narrowed(cx: PaintContext, width: number): PaintContext {
	return Object.create(cx, { width: { value: Math.max(1, width), enumerable: true } }) as PaintContext;
}

/** A figure's room: two cells short of the width. */
function figureRoom(cx: PaintContext): PaintContext {
	return narrowed(cx, cx.width - 2);
}

/** Markdown with the standard horizontal padding. */
function paddedMarkdown(cx: PaintContext, text: string): readonly string[] {
	return renderMarkdownFrame(text, cx.width, {
		theme: cx.theme,
		paddingX: terminalPaddingX(),
		hyperlinks: cx.hyperlinks,
	}).rows;
}

function drawable(node: UiNode, cx: PaintContext): boolean {
	return cx.images !== undefined && propsOf<{ blob: string }>(node).blob !== undefined;
}

defineRolePainter("image", "omp.figure", (node, cx) => paintImage(node, figureRoom(cx)));

defineRolePainter("image", "omp.figure.svg", (node, cx): Block => {
	if (drawable(node, cx)) return paintImage(node, figureRoom(cx));
	const code = termOf<FigureTerm>(node).code;
	return code ? { rows: paddedMarkdown(cx, code) } : EMPTY_BLOCK;
});

defineRolePainter("image", "omp.figure.chart", (node, cx): Block => {
	const inline = termOf<ChartTerm>(node).inline === true;
	if (inline) return drawable(node, cx) ? paintImage(node, figureRoom(cx)) : EMPTY_BLOCK;
	return { rows: ["", ...paintImage(node, figureRoom(cx)).rows] };
});

defineRolePainter("md", "omp.figure.code", (node, cx) => {
	const text = propsOf<{ text: string }>(node).text ?? "";
	return text.trim() ? { rows: paddedMarkdown(cx, text) } : EMPTY_BLOCK;
});

defineRolePainter("text", "omp.figure.pending", (node, cx) => {
	const spans = propsOf<{ spans: readonly TspSpan[] }>(node).spans ?? [];
	return { rows: [truncate(` ${styledText(cx.theme, spans)}`, cx.width)] };
});

/** A frame's `[Visit]` link to its page (a local page by its `file:` URL), drawn where the terminal draws links. */
const VISIT = "[Visit]";

function pageUrl(link: EmbedTerm["link"]): string | undefined {
	if (!link) return undefined;
	if ("url" in link) return link.url;
	try {
		return Bun.pathToFileURL(link.file).href;
	} catch {
		return undefined;
	}
}

function paintEmbed(node: UiNode, cx: PaintContext): Block {
	const term = termOf<EmbedTerm>(node);
	const picture = node.kind === "image" ? propsOf<{ blob: string; w: number; h: number }>(node) : term.still;
	const label = sanitizeText(term.label ?? "").replace(/\s+/g, " ");
	const page = term.page === true;
	const visit = page && cx.hyperlinks ? pageUrl(term.link) : undefined;
	const visitRow = (text: string): string => {
		const room = Math.max(1, cx.width - 2 - VISIT.length);
		return ` ${cx.theme.fg("dim", truncate(text, room))} ${uriLink(cx, cx.theme.fg("accent", VISIT), visit)}`;
	};
	if (cx.images && picture?.blob) {
		const drawn = paintPicture(picture, figureRoom(cx), cx.theme.fg("dim", `▣ ${label}`));
		const room = cx.height === undefined || drawn.rows.length < cx.height;
		return visit && room ? { rows: [...drawn.rows, visitRow(`▣ ${label}`)] } : drawn;
	}
	const why = cx.images && term.error ? ` — ${sanitizeText(term.error).replace(/\s+/g, " ")}` : "";
	if (visit) return { rows: [visitRow(`▣ ${label}${why}`)] };
	const row = cx.theme.fg("dim", truncate(`▣ ${label}${why}`, Math.max(1, cx.width - 1)));
	// A picture's note links to its file or address.
	const linked =
		!page && term.link
			? "file" in term.link
				? fileLink(cx, row, term.link.file)
				: uriLink(cx, row, term.link.url)
			: row;
	return { rows: [` ${linked}`] };
}

defineRolePainter("image", "omp.embed", paintEmbed);
defineRolePainter("web", "omp.embed", paintEmbed);
defineRolePainter("text", "omp.embed", paintEmbed);

defineRolePainter("col", "omp.figures", (node, cx) => {
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const blocks = node.children().map((child): Block => {
		if (paddingX === 0 || child.kind !== "md" || propsOf<{ role: string }>(child).role !== undefined)
			return cx.paint(child, cx.width);
		return { rows: cx.paint(child, Math.max(1, cx.width - 2 * paddingX)).rows.map(row => pad + row) };
	});
	return stack(blocks, 1);
});
