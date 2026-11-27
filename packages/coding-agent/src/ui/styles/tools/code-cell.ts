/**
 * Code and Markdown cells: a framed preview of source (highlighted, optionally
 * numbered with a hanging wrap) with an `Output` section, the frame headed by
 * the cell's language icon, status, `[i/n]` index and title, tinted by state.
 * Shared by the read and eval looks.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { RenderedText } from "@oh-my-pi/pi-tui/term/text-layout";
import { RowText, sliceText, type TextRows } from "../rendered-text";
import { expandHint, type FrameSection, frameBlock, frameInner, hangingWrap, statusIcon } from "./frame";

/** A cell's state. */
export type CellStatus = "pending" | "running" | "warning" | "complete" | "error";

/** What a cell shows. */
export interface CodeCell {
	readonly code: string;
	readonly language?: string;
	readonly index?: number;
	readonly total?: number;
	/** Styled title (drawn in the tool title color). */
	readonly title?: string;
	readonly status?: CellStatus;
	readonly duration?: number;
	readonly output?: string;
	readonly outputMaxLines?: number;
	readonly codeMaxLines?: number;
	/** Show the last `codeMaxLines` rows (the streaming edge) under an `… N earlier lines` marker. */
	readonly codeTail?: boolean;
	readonly expanded: boolean;
	/** Lead the head with the language icon. */
	readonly showLanguage?: boolean;
	readonly codeStartLine?: number;
	readonly codeLineNumbers?: readonly (number | null)[];
}

/** Lines of terminal text: CRLF split, a CR line keeps its last segment. */
export function terminalLines(text: string): string[] {
	return text.split(/\r?\n/u).map(line => {
		const at = line.lastIndexOf("\r");
		return at < 0 ? line : line.slice(at + 1);
	});
}

/** An output line in the tool output color, unless it carries its own styles. */
export function outputLine(theme: Theme, line: string): string {
	const normalized = replaceTabs(line);
	return normalized.includes("\x1b[") ? normalized : theme.fg("toolOutput", normalized);
}

function moreLines(count: number): string {
	return `… ${count} more ${count === 1 ? "line" : "lines"}`;
}

/** The cell's head: language icon, status (with its word while active), `[i/n]`, title; and the duration meta. */
export function cellHead(cx: PaintContext, cell: Omit<CodeCell, "code" | "expanded">): string {
	const theme = cx.theme;
	const parts: string[] = [];
	if (cell.showLanguage && cell.language) {
		const styled = (theme as { langIconStyled?: (lang: string) => string }).langIconStyled;
		const icon = styled
			? styled.call(theme, cell.language)
			: theme.fg("muted", theme.symbols.langIcon(cell.language));
		if (icon) parts.push(icon);
	}
	if (cell.status) {
		const icon = statusIcon(
			cx,
			cell.status === "complete"
				? "success"
				: cell.status === "error"
					? "error"
					: cell.status === "warning"
						? "warning"
						: cell.status === "running"
							? "running"
							: "pending",
		);
		parts.push(
			cell.status === "pending" || cell.status === "running" ? `${icon} ${theme.fg("muted", cell.status)}` : icon,
		);
	}
	if (cell.index !== undefined && cell.total !== undefined && cell.total > 1)
		parts.push(theme.fg("accent", `[${cell.index + 1}/${cell.total}]`));
	if (cell.title) parts.push(theme.fg("toolTitle", cell.title));
	const head = parts.length > 0 ? parts.join(" ") : theme.fg("toolTitle", "Code");
	if (cell.duration === undefined) return head;
	return `${head}${theme.symbols.symbol("sep.dot")}${theme.fg("dim", `(${formatDuration(cell.duration)})`)}`;
}

/** Frame border and tint of a cell state. */
export function cellFrame(status: CellStatus | undefined): { border: string; bg?: string } {
	switch (status) {
		case "complete":
			return { border: "dim", bg: "toolSuccessBg" };
		case "error":
			return { border: "error", bg: "toolErrorBg" };
		case "warning":
			return { border: "warning", bg: "toolPendingBg" };
		case "running":
		case "pending":
			return { border: "accent", bg: "toolPendingBg" };
		default:
			return { border: "dim" };
	}
}

/** A cell's output section lines: the head `outputMaxLines` lines (all when expanded) and a hidden-line note (decoration). */
export function cellOutputLines(
	theme: Theme,
	output: string | undefined,
	expanded: boolean,
	maxLines: number,
): RowText {
	const out = new RowText();
	if (!output?.trim()) return out;
	const lines = terminalLines(output);
	const shown = expanded || lines.length <= maxLines ? lines : lines.slice(0, Math.max(0, maxLines));
	for (const line of shown) {
		const row = outputLine(theme, line);
		out.wrapped(row, [row]);
	}
	const hidden = lines.length - shown.length;
	if (hidden > 0) out.deco(theme.fg("dim", `${moreLines(hidden)} ${expandHint(theme)}`));
	return out;
}

/** The source rows of a code cell at the frame's inner width: each source line copies whole, without its number. */
export function codeCellLines(cx: PaintContext, cell: CodeCell, width: number): RowText {
	const theme = cx.theme;
	const codeMax = cell.codeMaxLines ?? 12;
	const raw = terminalLines(replaceTabs(cell.code ?? ""));
	const shownCount = cell.expanded ? raw.length : Math.min(raw.length, codeMax);
	const hidden = raw.length - shownCount;
	const tail = cell.codeTail === true && !cell.expanded && hidden > 0;
	const start = tail ? raw.length - shownCount : 0;
	const code = highlightCode(raw.slice(start, start + shownCount).join("\n"), cell.language, theme);
	let numbers: readonly (number | null)[] | undefined;
	if (cell.codeLineNumbers) numbers = cell.codeLineNumbers.slice(start, start + shownCount);
	else if (cell.codeStartLine !== undefined)
		numbers = Array.from({ length: shownCount }, (_, i) => cell.codeStartLine! + start + i);
	let gutter = 0;
	if (numbers) {
		let max = 0;
		for (const n of numbers) if (n !== null && n !== undefined && n > max) max = n;
		if (max > 0) gutter = Math.max(2, String(max).length);
	}
	const lines = new RowText();
	const pad = gutter > 0 ? " ".repeat(gutter + 1) : "";
	const hint = cell.expanded ? "" : ` ${expandHint(theme)}`;
	if (hidden > 0 && tail)
		lines.deco(theme.fg("dim", `${pad}… ${hidden} earlier ${hidden === 1 ? "line" : "lines"}${hint}`));
	if (gutter > 0 && numbers) {
		for (let i = 0; i < code.length; i++) {
			const n = numbers[i];
			const label = n !== null && n !== undefined ? String(n).padStart(gutter, " ") : " ".repeat(gutter);
			const rows = hangingWrap(theme.fg("dim", `${label} `), pad, code[i]!, frameInner(width));
			lines.prefixed(raw[start + i] ?? "", rows, `${label} `, pad);
		}
	} else for (let i = 0; i < code.length; i++) lines.wrapped(raw[start + i] ?? "", [code[i]!]);
	if (hidden > 0 && !tail) lines.deco(theme.fg("dim", `${pad}${moreLines(hidden)}${hint}`));
	return lines;
}

/** A framed code cell at `width`. */
export function codeCellRows(
	cx: PaintContext,
	cell: CodeCell,
	width: number,
): { rows: string[]; text: () => RenderedText } {
	const theme = cx.theme;
	const code = codeCellLines(cx, cell, width);
	const output = cellOutputLines(theme, cell.output, cell.expanded, cell.outputMaxLines ?? 6);
	const sections: FrameSection[] = [{ lines: code.rows, text: code.text() }];
	if (output.length > 0)
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: output.rows, text: output.text() });
	return frameBlock(theme, width, { head: cellHead(cx, cell), sections, ...cellFrame(cell.status) });
}

/** A framed Markdown cell at `width`: the rendered rows (cut to `contentMaxLines` collapsed) and the output. */
export function markdownCellRows(
	cx: PaintContext,
	cell: Omit<CodeCell, "code" | "language"> & {
		/** The rendered Markdown at the frame's inner width, with its text when known. */
		readonly rendered: TextRows;
		readonly contentMaxLines?: number;
	},
	width: number,
): { rows: string[]; text: () => RenderedText } {
	const theme = cx.theme;
	const max = cell.contentMaxLines ?? 12;
	const total = cell.rendered.rows.length;
	const content = new RowText().block(cell.expanded ? cell.rendered : sliceText(cell.rendered, 0, max));
	const hidden = total - content.length;
	if (hidden > 0) content.deco(theme.fg("dim", `${moreLines(hidden)}${cell.expanded ? "" : ` ${expandHint(theme)}`}`));
	const output = cellOutputLines(theme, cell.output, cell.expanded, cell.outputMaxLines ?? 6);
	const sections: FrameSection[] = [{ lines: content.rows, text: content.text() }];
	if (output.length > 0)
		sections.push({ label: theme.fg("toolTitle", "Output"), lines: output.rows, text: output.text() });
	return frameBlock(theme, width, { head: cellHead(cx, cell), sections, ...cellFrame(cell.status) });
}
