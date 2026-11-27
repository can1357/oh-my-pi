/**
 * Shared pieces of the `omp.tool.*` terminal looks: the rounded frame with a
 * head in its top edge, labelled section dividers and a footer in its bottom
 * edge; status glyphs (spinner while running); the expand hints collapsed
 * bodies end with.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { expandKeyLabel } from "../../keys/hints";
import { type ToolProps, toolProps } from "./look";
import type { RenderedText } from "@oh-my-pi/pi-tui/term/text-layout";
import { RowText, sliceText } from "../rendered-text";

/** The run of rule glyphs before a head, a section label or a footer. */
const LEAD = 3;

/** Cells a framed row gives its content (`│ ` … ` │`). */
export function frameInner(width: number): number {
	return Math.max(0, width - 4);
}

/** One part of a frame: a divider (with `label`, or plain when `separator`) above its lines. */
export interface FrameSection {
	readonly label?: string;
	/** Draw a plain divider above an unlabelled section (never above the first). */
	readonly separator?: boolean;
	readonly lines: readonly string[];
	/** A tag per line (in step with `lines`): the rows it draws carry it (see {@link frameRows}). */
	readonly tags?: readonly (string | undefined)[];
	/**
	 * The logical text of `lines` when they are rows already wrapped to the inner width (one row
	 * each, in step with `lines`); absent, each line copies as its own logical line.
	 */
	readonly text?: () => RenderedText;
}

/** What a frame draws (all styled strings). */
export interface FrameSpec {
	/** Text in the top edge. */
	readonly head?: string;
	readonly sections: readonly FrameSection[];
	/** Text in the bottom edge (wrapped above it when it does not fit). */
	readonly foot?: string;
	/** Border color key (default `dim`). */
	readonly border?: string;
	/** Background key filling every row. */
	readonly bg?: string;
	/** The tag whose rows draw on the hover band (`selectedBg`) instead of `bg`. */
	readonly band?: string;
}

/** An edge row: `left───` + ` text ` (cut to fit) + rule fill + `right`. */
export function edgeRow(
	theme: Theme,
	width: number,
	left: string,
	right: string,
	text: string | undefined,
	border = "dim",
): string {
	const line = theme.symbols.box.horizontal;
	const lead = `${left}${line.repeat(LEAD)}`;
	const leadWidth = visibleWidth(lead);
	const rightWidth = visibleWidth(right);
	if (!text) {
		return `${theme.fg(border, lead)}${theme.fg(border, line.repeat(Math.max(0, width - leadWidth - rightWidth)))}${theme.fg(border, right)}`;
	}
	const label = truncate(` ${text} `, Math.max(0, width - leadWidth - rightWidth));
	const fill = Math.max(0, width - leadWidth - visibleWidth(label) - rightWidth);
	return `${theme.fg(border, lead)}${label}${theme.fg(border, line.repeat(fill))}${theme.fg(border, right)}`;
}

/** A content row: `│ ` + row padded to the inner width + ` │`. */
export function frameRow(theme: Theme, width: number, row: string, border = "dim"): string {
	const v = theme.fg(border, theme.symbols.box.vertical);
	return `${v} ${padTo(row, frameInner(width))} ${v}`;
}

/** A row filled with a background that survives the row's own resets. */
function fillRow(theme: Theme, key: string | undefined, row: string, width: number): string {
	const padded = padTo(row, width);
	if (!key) return padded;
	const fill = (theme as { bgFill?: (color: string, text: string) => string }).bgFill;
	return fill ? fill.call(theme, key, padded) : theme.bg(key, padded);
}

/** The rows of a rounded frame: lines wrap at the inner width. */
export function frameRows(theme: Theme, width: number, spec: FrameSpec, rowTags?: (string | undefined)[]): string[] {
	return frameBlock(theme, width, spec, rowTags).rows;
}

/**
 * A rounded frame's rows and their logical text: edges and dividers are
 * decoration; a line copies as one logical line (its wrapped rows joined)
 * unless its section reports its own text.
 */
export function frameBlock(
	theme: Theme,
	width: number,
	spec: FrameSpec,
	rowTags?: (string | undefined)[],
): { rows: string[]; text: () => RenderedText } {
	const box = theme.symbols.box;
	const border = spec.border ?? "dim";
	const inner = frameInner(width);
	const out = new RowText().deco(edgeRow(theme, width, box.topLeft, box.topRight, spec.head, border));
	// Each row's section-line tag (filled into `rowTags` when given).
	const tags: (string | undefined)[] = [undefined];
	let tag: string | undefined;
	const divider = (row: string): void => {
		out.deco(row);
		tags.push(tag);
	};
	/** One line's rows; `known` is its text when its section reports it (used while the line draws one row). */
	const content = (line: string, known?: () => RenderedText): void => {
		const wrapped = wrap(line.trimEnd(), Math.max(1, inner));
		const parts = wrapped.length > 0 ? wrapped : [""];
		const shown = parts.map(part => frameRow(theme, width, part, border));
		if (known && parts.length === 1) out.block({ rows: parts, text: known }, 2, shown);
		else out.wrapped(line, parts, 2, shown);
		for (let i = 0; i < shown.length; i++) tags.push(tag);
	};
	spec.sections.forEach((section, index) => {
		tag = undefined;
		if (section.label) divider(edgeRow(theme, width, box.teeRight, box.teeLeft, section.label, border));
		else if (section.separator && index > 0)
			divider(edgeRow(theme, width, box.teeRight, box.teeLeft, undefined, border));
		const text = section.text;
		section.lines.forEach((line, at) => {
			tag = section.tags?.[at];
			const parts = line.split("\n");
			const known = text && parts.length === 1 ? () => [text()[at]] : undefined;
			for (const part of parts) content(part, known);
		});
		tag = undefined;
	});
	const foot = spec.foot;
	const footFits =
		foot === undefined ||
		visibleWidth(` ${foot} `) <= width - visibleWidth(`${box.bottomLeft}${box.horizontal.repeat(LEAD)}`) - 1;
	if (foot !== undefined && !footFits) content(foot);
	divider(edgeRow(theme, width, box.bottomLeft, box.bottomRight, footFits ? foot : undefined, border));
	if (rowTags) rowTags.push(...tags);
	return {
		rows: out.rows.map((row, index) =>
			fillRow(
				theme,
				spec.band !== undefined && tags[index] === spec.band ? "selectedBg" : spec.bg,
				truncate(row, width, ""),
				width,
			),
		),
		text: out.text(),
	};
}

/** The bracketed hint to expand tool output, dim. */
export function expandHint(theme: Theme): string {
	return theme.fg("dim", bracketed(theme, `${expandKeyLabel(theme)}: Expand`));
}

/** A hidden line count followed by the tool expansion hint, dim. */
export function moreLinesHint(theme: Theme, hidden: number): string {
	return `${theme.fg("dim", `… ${hidden} more lines `)}${expandHint(theme)}`;
}

/** A standalone failure with an error glyph and exactly one `Error:` prefix. */
export function standaloneError(cx: PaintContext, message: string): { rows: string[]; text: () => RenderedText } {
	const theme = cx.theme;
	const cleaned =
		replaceTabs(sanitizeText(message))
			.trim()
			.replace(/^(?:Error:\s*)+/, "") || "Unknown error";
	const glyph = theme.symbols.symbol("status.error");
	const text = `Error: ${cleaned}`;
	const rows = wrap(`${theme.fg("error", glyph)} ${theme.fg("error", text)}`, cx.width);
	return new RowText().prefixed(text, rows, `${glyph} `, "").done();
}

/** The status spinner frame at the terminal clock; reduced motion draws the pending glyph. */
export function spinnerGlyph(cx: PaintContext): string {
	const theme = cx.theme;
	const frames = theme.symbols.spinnerFrames;
	if (cx.reduceMotion || frames.length === 0) return theme.fg("muted", theme.symbols.symbol("status.pending"));
	return frames[Math.floor(cx.now() / SPINNER_INTERVAL_MS) % frames.length]!;
}

/** Whether the tool is still working (its head animates). */
export function isActive(props: ToolProps): boolean {
	return props.status === "pending" || props.status === "running";
}

/** The head glyph of a tool: spinner while active, else a status glyph in its color. */
export function statusGlyph(node: UiNode, cx: PaintContext): string {
	const props = toolProps(node);
	const theme = cx.theme;
	if (isActive(props)) return spinnerGlyph(cx);
	if (props.tone === "info") return theme.fg("accent", theme.symbols.symbol("status.info"));
	switch (props.status) {
		case "error":
			return theme.fg("error", theme.symbols.symbol("status.error"));
		case "cancelled":
			return theme.fg("muted", theme.symbols.symbol("status.pending"));
		default:
			return theme.fg("success", theme.symbols.symbol("status.success"));
	}
}

/** Ms a running tool has been running at the terminal clock (its `age` when no start time is known). */
export function runningMs(props: ToolProps, cx: PaintContext): number {
	const startedAt = props.term?.startedAt;
	return startedAt === undefined ? (props.age ?? 0) : Math.max(0, cx.now() - startedAt);
}

/** A one-row status header: glyph, title, `: description`, `⟦badge⟧`, dim ` · `-joined meta. */
export interface StatusLine {
	readonly glyph?: string;
	readonly title: string;
	/** Title color (default `accent`). */
	readonly titleColor?: string;
	readonly description?: string;
	readonly badge?: { readonly label: string; readonly color: string };
	readonly meta?: readonly string[];
}

/** Newlines flattened so a header stays one row. */
function headerText(text: string): string {
	return text.replace(/\r\n?|\n/g, " ");
}

/** The styled status header row. */
export function statusLine(theme: Theme, line: StatusLine): string {
	const title = theme.fg(line.titleColor ?? "accent", headerText(line.title));
	let out = line.glyph ? `${line.glyph} ${title}` : title;
	if (line.description) out += `: ${theme.fg("muted", headerText(line.description))}`;
	if (line.badge) out += ` ${theme.fg(line.badge.color, bracketed(theme, headerText(line.badge.label)))}`;
	const meta = (line.meta ?? []).map(headerText).filter(part => part.trim().length > 0);
	if (meta.length > 0) out += ` ${theme.fg("dim", meta.join(theme.symbols.symbol("sep.dot")))}`;
	return out;
}

/** A status glyph by name, styled as tool headers draw it (`running` is the spinner). */
export function statusIcon(
	cx: PaintContext,
	icon: "success" | "error" | "warning" | "info" | "pending" | "running" | "aborted",
): string {
	const theme = cx.theme;
	const symbol = (key: string, color: string): string => theme.fg(color, theme.symbols.symbol(key));
	switch (icon) {
		case "success":
			return symbol("status.success", "success");
		case "error":
			return symbol("status.error", "error");
		case "warning":
			return symbol("status.warning", "warning");
		case "info":
			return symbol("status.info", "accent");
		case "pending":
			return symbol("status.pending", "muted");
		case "aborted":
			return symbol("status.aborted", "error");
		case "running":
			// Reduced motion stills the spinner to the running glyph.
			return cx.reduceMotion ? symbol("status.running", "accent") : spinnerGlyph(cx);
	}
}

/**
 * A collapsed command preview: at most `max` rows, the end kept behind a dim
 * marker for how many rows were clipped and how to expand them.
 */
export function capLines(theme: Theme, lines: readonly string[], max: number): string[] {
	if (lines.length <= max) return [...lines];
	const visible = max <= 1 ? [] : lines.slice(lines.length - (max - 1));
	const hidden = lines.length - visible.length;
	const marker = theme.fg("dim", `… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}`);
	return [`${marker} ${expandHint(theme)}`, ...visible];
}

/**
 * The tail of an output pane at `width`: lines wrapped, the last `limit`
 * rows kept below the hidden line count and the tool expansion hint. Each
 * line copies as one logical line; the marker is decoration.
 */
export function tailBlock(theme: Theme, lines: readonly string[], limit: number, width: number): RowText {
	const all = new RowText();
	for (const line of lines) {
		const wrapped = wrap(line, Math.max(1, width));
		all.wrapped(line, wrapped.length > 0 ? wrapped : [""]);
	}
	const total = all.length;
	if (total <= limit) return all;
	const start = limit <= 0 ? total : total - limit;
	const marker = theme.fg("dim", `… (${start} earlier lines, showing ${total - start} of ${total})`);
	return new RowText().deco(`${marker} ${expandHint(theme)}`).block(sliceText(all.done(), start));
}

/** `⟦text⟧` with the theme's brackets. */
export function bracketed(theme: Theme, text: string): string {
	return `${theme.symbols.symbol("format.bracketLeft")}${text}${theme.symbols.symbol("format.bracketRight")}`;
}

/** Collapsed command/code previews show at most this many rows (the viewport tail window). */
export const PREVIEW_WINDOW_ROWS = 20;

/** `content` wrapped beside `prefix` (first row) and `continuation` (later rows). */
export function hangingWrap(prefix: string, continuation: string, content: string, width: number): string[] {
	const lead = Math.max(visibleWidth(prefix), visibleWidth(continuation));
	if (width <= lead) return wrap(prefix + content, width);
	return wrap(content, width - lead).map((row, index) => `${index === 0 ? prefix : continuation}${row}`);
}

/** `lines` capped at `limit` under a dim `… N more lines` row (indented). */
export function capMoreLines(theme: Theme, lines: readonly string[], limit: number, indent: string): string[] {
	if (lines.length <= limit) return [...lines];
	const hidden = lines.length - limit;
	return [
		...lines.slice(0, limit),
		`${indent}${theme.fg("dim", `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`,
	];
}

/** Background of a framed card's tint by outcome. */
export function outcomeBg(outcome: "pending" | "running" | "success" | "warning" | "error"): string {
	return outcome === "success" ? "toolSuccessBg" : outcome === "error" ? "toolErrorBg" : "toolPendingBg";
}
