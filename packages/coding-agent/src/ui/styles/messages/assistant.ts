/**
 * `omp.assistant` / `omp.assistant.rewound` columns: the assistant's reply
 * as transcript rows.
 *
 * - Text: Markdown one cell in, code fences drawn literally at column 0;
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
 *   at 8 rows with a `… +N more lines (⌃O to expand)` hint while collapsed
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
import { renderMarkdownFrame, takeExtensionLinks } from "@oh-my-pi/pi-tui/text/markdown/index";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { EXPAND_KEY, hexFg, paddedText, propsOf, termOf } from "./fill";
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
export function errorRows(theme: Theme, message: string, width: number, maxRows: number): string[] {
	const lines = replaceTabs(message)
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	if (lines.length === 0) lines.push("Unknown error");
	const wrapWidth = Math.max(1, width - 4);
	const rows: string[] = [];
	lines.forEach((line, index) => {
		wrap(theme.fg("error", index === 0 ? `Error: ${line}` : line), wrapWidth).forEach((row, part) => {
			if (rows.length === 0) rows.push(` ${row}`);
			// A wrapped continuation keeps the line's color through its hang; a new line's hang is plain.
			else rows.push(part === 0 ? `   ${row}` : ` ${theme.fg("error", "  ")}${row}`);
		});
	});
	if (rows.length <= maxRows) return rows;
	const hidden = rows.length - maxRows;
	return [
		...rows.slice(0, maxRows),
		` ${theme.fg("dim", `  … +${hidden} more line${hidden === 1 ? "" : "s"} (${EXPAND_KEY} to expand)`)}`,
	];
}

/**
 * The reply's prose. Links of a scheme the host routes (an extension's) draw their label alone,
 * each label a mouse hit on the `md` node whose item is the href, as the stock `md` painter does.
 */
function proseRows(
	child: UiNode,
	cx: PaintContext,
): { rows: readonly string[]; stable: number; hits?: readonly Hit[] } {
	const props = propsOf<{ text: string; stream: boolean; tone: string }>(child);
	const term = termOf<ProseTerm>(child);
	const links = term.links;
	const schemes = routedLinkSchemes();
	const frame = renderMarkdownFrame(term.source ?? props.text ?? "", cx.width, {
		theme: cx.theme,
		paddingX: 1,
		codeIndent: 0,
		textStyle: props.tone ?? (cx.theme.has("assistantMessageText") ? "assistantMessageText" : undefined),
		stream: props.stream === true,
		hyperlinks: cx.hyperlinks,
		hyperlinksDetected: cx.hyperlinksDetected,
		linkTarget: links && links.size > 0 ? href => links.get(href) : undefined,
		linkSchemes: schemes.length > 0 ? schemes : undefined,
	});
	if (schemes.length === 0) return frame;
	const hits: Hit[] = [];
	const rows = frame.rows.map((line, row) => {
		const taken = takeExtensionLinks(line);
		for (const link of taken.links)
			hits.push({ row, col: link.start, width: link.end - link.start, height: 1, node: child, item: link.href });
		return taken.row;
	});
	return { rows, stable: frame.stable, ...(hits.length > 0 ? { hits } : {}) };
}

function thinkingRows(section: UiNode, cx: PaintContext): { rows: readonly string[]; stable: number } {
	const body = section.children().find(child => child.kind === "md");
	if (!body) return { rows: [], stable: 0 };
	const props = propsOf<{ text: string; stream: boolean }>(body);
	return renderMarkdownFrame(termOf<ProseTerm>(body).source ?? props.text ?? "", cx.width, {
		theme: cx.theme,
		paddingX: 1,
		textStyle: "thinkingText em",
		stream: props.stream === true,
		hyperlinks: cx.hyperlinks,
		hyperlinksDetected: cx.hyperlinksDetected,
	});
}

function pulseRow(cx: PaintContext, dots: { tokens: number; rate: number }): string {
	const theme = cx.theme;
	const frame = cx.reduceMotion ? 0 : Math.floor(cx.now() / PULSE_FRAME_MS) % PULSE_FRAMES.length;
	let row = ` ${theme.fg("thinkingText", PULSE_FRAMES[frame]!)}${theme.fg("muted", " Thinking")}`;
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

function imageRows(cx: PaintContext, image: UiNode): readonly string[] {
	const mime = termOf<{ mime: string }>(image).mime ?? propsOf<{ alt: string }>(image).alt ?? "image";
	const label = cx.theme.fg("toolOutput", `[Image: ${mime}]`);
	// The placeholder links to the image's file (a blob copy of its bytes).
	if (!cx.images) return [` ${imageLink(cx, label, propsOf<{ blob?: string }>(image).blob)}`];
	const inner = Object.create(cx, { width: { value: Math.max(1, cx.width - 1), enumerable: true } }) as PaintContext;
	return paintImage(image, inner, label).rows.map(row => ` ${row}`);
}

function paintAssistant(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const rows: string[] = [];
	const hits: Hit[] = [];
	let stable = 0;
	let rendered = false;
	let toolImages = false;
	let pulsed = false;
	const dots = termOf<AssistantTerm>(node).thinkingDots;
	const pulse = (): void => {
		if (pulsed) return;
		pulsed = true;
		if (!dots) return;
		if (rows.length > 0) rows.push("");
		rows.push(pulseRow(cx, dots));
	};
	const streamed = (frame: { rows: readonly string[]; stable: number }, streaming: boolean): void => {
		if (streaming) stable = rows.length + frame.stable;
		rows.push(...frame.rows);
	};
	for (const child of node.children()) {
		const role = propsOf<{ role: string }>(child).role ?? "";
		const key = child.key() ?? "";
		if (child.kind === "md") {
			const frame = proseRows(child, cx);
			for (const hit of frame.hits ?? []) hits.push({ ...hit, row: rows.length + hit.row });
			streamed(frame, propsOf<{ stream: boolean }>(child).stream === true);
			rendered ||= frame.rows.length > 0;
		} else if (child.kind === "section" && role.startsWith("omp.thinking")) {
			const term = termOf<SectionTerm>(child);
			if (term.hidden) continue;
			const body = child.children().find(c => c.kind === "md");
			const frame = thinkingRows(child, cx);
			streamed(frame, body !== undefined && propsOf<{ stream: boolean }>(body).stream === true);
			rendered ||= frame.rows.length > 0;
			if (term.spaceAfter) rows.push("");
		} else if (role === "omp.thinking.extension") {
			// Extension thinking renderers draw under their thinking block.
			const extension = cx.paint(child, cx.width).rows;
			rows.push(...extension);
			rendered ||= extension.length > 0;
		} else if (child.kind === "image" && key.startsWith("i")) {
			if (rendered) rows.push("");
			rows.push(...imageRows(cx, child));
			rendered = true;
		} else if (child.kind === "image") {
			pulse();
			if (!toolImages) rows.push("");
			toolImages = true;
			rows.push(...imageRows(cx, child));
		} else if (role === "omp.assistant.abort") {
			pulse();
			const text =
				propsOf<{ spans: readonly { t: string }[] }>(child)
					.spans?.map(span => span.t)
					.join("") ?? "";
			rows.push("", ...paddedText(theme.fg("error", text), cx.width));
		} else if (role === "omp.assistant.recovered") {
			pulse();
			rows.push("", ...paddedText(theme.fg("dim", termOf<{ note: string }>(child).note ?? ""), cx.width));
		} else if (role === "omp.error") {
			pulse();
			const term = termOf<ErrorTerm>(child);
			if (term.hidden) continue;
			const message = child.children().find(c => propsOf<{ role: string }>(c).role === "omp.error.message");
			const lines = message ? propsOf<{ lines: number }>(message).lines : undefined;
			rows.push("", ...errorRows(theme, term.preview ?? "", cx.width, lines ?? Number.POSITIVE_INFINITY));
		} else if (role.startsWith("omp.marker.")) {
			pulse();
			rows.push(...cx.paint(child, cx.width).rows);
		}
	}
	pulse();
	return { rows, ...(stable > 0 ? { stable } : {}), ...(hits.length > 0 ? { hits } : {}) };
}

defineRolePainter("col", "omp.assistant", paintAssistant);
defineRolePainter("col", "omp.assistant.rewound", paintAssistant);
