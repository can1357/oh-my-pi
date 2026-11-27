/**
 * `omp.assistant` / `omp.assistant.rewound` columns: the assistant's reply
 * as transcript rows.
 *
 * - Text: Markdown with the standard inset, code fences drawn literally at column 0;
 *   prose in the block's `tone` when set (`/live`'s spoken reply), else in
 *   `assistantMessageText` when the theme sets it.
 * - Thinking: italic Markdown in `thinkingText`, set off from what follows
 *   by a blank row. Hidden thinking draws nothing; while it streams, a
 *   pulsing `✻ Thinking` line (with tokens and speed when known) follows
 *   the reply.
 * - Images: drawn one cell in where the terminal draws images, else
 *   `[Image: mime]` in `toolOutput`; after a blank row (tool-result images
 *   share one).
 * - The turn-ending error: `Error: …` wrapped under a hanging indent, capped
 *   at 8 rows with a `… +N more lines` expansion hint while collapsed
 *   (hidden while the same error is pinned and collapsed); the abort label;
 *   or the recovered-retry note, each after a blank row.
 * - Markers draw as dividers; the rewound tag and usage line are native-only.
 * - While a block streams, the rows before it and its finished head are
 *   reported stable.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { paintImage } from "@oh-my-pi/pi-tui/term/painters/image";
import { routedLinkSchemes } from "@oh-my-pi/pi-tui/term/painters/md";
import {
	type MarkdownLook,
	markdownLook,
	renderMarkdownFrame,
	takeExtensionLinks,
} from "@oh-my-pi/pi-tui/text/markdown/index";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { terminalPaddingX } from "../terminal-padding";
import { expandKeyLabel } from "../../keys/hints";
import { hexFg, paddedText, propsOf, termOf } from "./fill";
import { RowText, sliceText, type TextRows } from "../rendered-text";
import { imageLink } from "../tools/file-common";

/** Facets of the hidden-thinking pulse. */
const PULSE_FRAMES = ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"] as const;
/** Mean dwell of a pulse frame (ms). */
const PULSE_FRAME_MS = 150;
/** Speed (tok/s) at which the speed badge reaches the full accent. */
const SPEED_MAX = 200;

interface AssistantTerm {
	thinkingDots?: { tokens: number; rate: number };
}

interface ProseTerm {
	source?: string;
	links?: ReadonlyMap<string, string>;
	deferFigures?: boolean;
}

interface SectionTerm {
	hidden?: boolean;
	spaceAfter?: boolean;
}

interface ErrorTerm {
	preview?: string;
	hidden?: boolean;
}

/** Rows of a failed turn's message: `Error: ` + first line, every later row under a 2-cell hang. */
export function errorRows(theme: Theme, message: string, width: number, maxRows: number): RowText {
	const lines = replaceTabs(message)
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	if (lines.length === 0) lines.push("Unknown error");
	const paddingX = terminalPaddingX();
	const pad = " ".repeat(paddingX);
	const wrapWidth = Math.max(1, width - 2 * paddingX - 2);
	// Each message line copies whole (its hang is indentation).
	const all = new RowText();
	lines.forEach((line, index) => {
		const source = index === 0 ? `Error: ${line}` : line;
		const parts = wrap(theme.fg("error", source), wrapWidth);
		const rows = parts.map((row, part) =>
			all.length === 0 && part === 0
				? `${pad}${row}`
				: // A wrapped continuation keeps the line's color through its hang; a new line's hang is plain.
					`${pad}${part === 0 ? "  " : theme.fg("error", "  ")}${row}`,
		);
		all.wrapped(source, rows);
	});
	if (all.length <= maxRows) return all;
	const hidden = all.length - maxRows;
	return new RowText()
		.block(sliceText(all.done(), 0, maxRows))
		.deco(
			`${pad}${theme.fg("dim", `  … +${hidden} more line${hidden === 1 ? "" : "s"} (${expandKeyLabel(theme)} to expand)`)}`,
		);
}

interface ReplyFrame extends TextRows {
	readonly stable: number;
	readonly hits?: readonly Hit[];
}

// The markdown renderer already reuses the settled paragraphs of the open block. Earlier message
// blocks (often the entire thinking trace) are *not* streams: keep their final render with the node.
const kCompleted = Symbol("omp.assistant.completed-markdown");

interface MarkdownNode extends UiNode {
	[kCompleted]?: {
		source: string;
		width: number;
		theme: Theme;
		paddingX: number;
		hyperlinks: boolean;
		textStyle: string | undefined;
		schemes: readonly string[] | undefined;
		look: MarkdownLook;
		frame: ReplyFrame;
	};
}

function markdownRows(child: MarkdownNode, cx: PaintContext, thinking: boolean): ReplyFrame {
	const props = propsOf<{ text: string; stream: boolean; tone: string }>(child);
	const term = termOf<ProseTerm>(child);
	const source = term.source ?? props.text ?? "";
	const { width, theme, hyperlinks } = cx;
	const paddingX = terminalPaddingX();
	const textStyle = thinking
		? "thinkingText em"
		: (props.tone ?? (theme.has("assistantMessageText") ? "assistantMessageText" : undefined));
	const schemes = thinking ? undefined : routedLinkSchemes();
	const look = markdownLook();
	const links = thinking ? undefined : term.links;
	// A host link resolver can change its targets in place.
	const cacheable = !props.stream && !links?.size;
	if (cacheable) {
		const last = child[kCompleted];
		if (
			last &&
			last.source === source &&
			last.width === width &&
			last.theme === theme &&
			last.paddingX === paddingX &&
			last.hyperlinks === hyperlinks &&
			last.textStyle === textStyle &&
			last.schemes === schemes &&
			last.look === look
		)
			return last.frame;
	}
	let frame: ReplyFrame = renderMarkdownFrame(source, width, {
		theme,
		paddingX,
		codeIndent: thinking ? undefined : 0,
		textStyle,
		stream: props.stream === true,
		hyperlinks,
		linkTarget: links?.size ? href => links.get(href) : undefined,
		linkSchemes: schemes?.length ? schemes : undefined,
	});
	if (schemes?.length) {
		const hits: Hit[] = [];
		const rows = frame.rows.map((line, row) => {
			const taken = takeExtensionLinks(line);
			for (const link of taken.links)
				hits.push({
					row,
					col: link.start,
					width: link.end - link.start,
					height: 1,
					node: child,
					item: link.href,
					optionalTarget: "main",
				});
			return taken.row;
		});
		// Removing link markers changes no cells, so the frame's logical text still describes its rows.
		frame = { ...frame, rows, ...(hits.length > 0 ? { hits } : {}) };
	}
	if (cacheable) child[kCompleted] = { source, width, theme, paddingX, hyperlinks, textStyle, schemes, look, frame };
	return frame;
}

function pulseRow(cx: PaintContext, dots: { tokens: number; rate: number }): string {
	const theme = cx.theme;
	const frame = cx.reduceMotion ? 0 : Math.floor(cx.now() / PULSE_FRAME_MS) % PULSE_FRAMES.length;
	let row = `${" ".repeat(terminalPaddingX())}${theme.fg("thinkingText", PULSE_FRAMES[frame]!)}${theme.fg("muted", " Thinking")}`;
	if (dots.rate >= 0.05) {
		const rate = Math.min(SPEED_MAX, dots.rate);
		if (dots.tokens > 0) row += theme.fg("dim", ` · ${formatNumber(dots.tokens)}`);
		const text = ` · ${rate.toFixed(1)} toks/s`;
		// Dim at rest, brightening toward the accent as the stream speeds up (eased so mid speeds already tint).
		row +=
			theme.depth === "truecolor"
				? hexFg(mixHex(theme.hex("dim"), theme.hex("accent"), Math.sqrt(rate / SPEED_MAX)), text)
				: theme.fg("muted", text);
	}
	return row;
}

/** `from` moved `share` of the way to `to` (both `#rrggbb`). */
function mixHex(from: string, to: string, share: number): string {
	const a = Number.parseInt(from.slice(1), 16);
	const b = Number.parseInt(to.slice(1), 16);
	let out = 0;
	for (const shift of [16, 8, 0]) {
		const x = (a >> shift) & 255;
		const y = (b >> shift) & 255;
		out |= Math.round(x + (y - x) * share) << shift;
	}
	return `#${out.toString(16).padStart(6, "0")}`;
}

function imageRows(cx: PaintContext, image: UiNode): TextRows {
	const mime = termOf<{ mime: string }>(image).mime ?? propsOf<{ alt: string }>(image).alt ?? "image";
	const label = cx.theme.fg("toolOutput", `[Image: ${mime}]`);
	// The placeholder links to the image's file (a blob copy of its bytes).
	if (!cx.images)
		return {
			rows: [`${" ".repeat(terminalPaddingX())}${imageLink(cx, label, propsOf<{ blob?: string }>(image).blob)}`],
		};
	const inner = Object.create(cx, { width: { value: Math.max(1, cx.width - 1), enumerable: true } }) as PaintContext;
	const picture = paintImage(image, inner, label);
	return new RowText()
		.block(
			picture,
			1,
			picture.rows.map(row => ` ${row}`),
		)
		.done();
}

function paintAssistant(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const out = new RowText();
	const hits: Hit[] = [];
	let stable = 0;
	let rendered = false;
	let toolImages = false;
	let pulsed = false;
	let afterFigure = false;
	let deferredAt = Number.POSITIVE_INFINITY;
	const dots = termOf<AssistantTerm>(node).thinkingDots;
	const pulse = (): void => {
		if (pulsed) return;
		pulsed = true;
		if (!dots) return;
		if (out.length > 0) out.deco("");
		out.deco(pulseRow(cx, dots));
	};
	const streamed = (frame: ReplyFrame, streaming: boolean): void => {
		if (streaming) stable = out.length + frame.stable;
		out.block(frame);
	};
	// Blank rows between parts copy as paragraph breaks.
	const gap = (): void => {
		out.literal("");
	};
	for (const child of node.children()) {
		const role = propsOf<{ role: string }>(child).role ?? "";
		const key = child.key() ?? "";
		if (role === "omp.embed" || role === "omp.figure.svg" || role === "omp.figure.code") {
			const figure = cx.paint(child, cx.width);
			if (figure.rows.length > 0) {
				if (rendered) gap();
				out.block(figure);
				rendered = true;
				afterFigure = true;
			}
		} else if (child.kind === "md") {
			const frame = markdownRows(child, cx, false);
			if (afterFigure && frame.rows.length) gap();
			afterFigure = false;
			// The streaming source is replaced by its figure, so its rows cannot retire yet.
			if (termOf<ProseTerm>(child).deferFigures) deferredAt = Math.min(deferredAt, out.length);
			for (const hit of frame.hits ?? []) hits.push({ ...hit, row: out.length + hit.row });
			streamed(frame, propsOf<{ stream: boolean }>(child).stream === true);
			rendered ||= frame.rows.length > 0;
		} else if (child.kind === "section" && role.startsWith("omp.thinking")) {
			const term = termOf<SectionTerm>(child);
			if (term.hidden) continue;
			const body = child.children().find(c => c.kind === "md");
			if (body) {
				const frame = markdownRows(body, cx, true);
				streamed(frame, propsOf<{ stream: boolean }>(body).stream === true);
				rendered ||= frame.rows.length > 0;
			}
			if (term.spaceAfter) gap();
		} else if (role === "omp.thinking.extension") {
			// Extension thinking renderers draw under their thinking block.
			const extension = cx.paint(child, cx.width);
			out.block(extension);
			rendered ||= extension.rows.length > 0;
		} else if (child.kind === "image" && key.startsWith("i")) {
			if (rendered) gap();
			out.block(imageRows(cx, child));
			rendered = true;
		} else if (child.kind === "image") {
			pulse();
			if (!toolImages) gap();
			toolImages = true;
			out.block(imageRows(cx, child));
		} else if (role === "omp.assistant.abort") {
			pulse();
			const text =
				propsOf<{ spans: readonly { t: string }[] }>(child)
					.spans?.map(span => span.t)
					.join("") ?? "";
			gap();
			out.block(paddedText(theme.fg("error", text), cx.width).done());
		} else if (role === "omp.assistant.recovered") {
			pulse();
			gap();
			out.block(paddedText(theme.fg("dim", termOf<{ note: string }>(child).note ?? ""), cx.width).done());
		} else if (role === "omp.error") {
			pulse();
			const term = termOf<ErrorTerm>(child);
			if (term.hidden) continue;
			const message = child.children().find(c => propsOf<{ role: string }>(c).role === "omp.error.message");
			const lines = message ? propsOf<{ lines: number }>(message).lines : undefined;
			gap();
			out.block(errorRows(theme, term.preview ?? "", cx.width, lines ?? Number.POSITIVE_INFINITY).done());
		} else if (role.startsWith("omp.marker.")) {
			pulse();
			out.block(cx.paint(child, cx.width));
		}
	}
	pulse();
	stable = Math.min(stable, deferredAt);
	return { ...out.done(), ...(stable > 0 ? { stable } : {}), ...(hits.length > 0 ? { hits } : {}) };
}

defineRolePainter("col", "omp.assistant", paintAssistant);
defineRolePainter("col", "omp.assistant.rewound", paintAssistant);
