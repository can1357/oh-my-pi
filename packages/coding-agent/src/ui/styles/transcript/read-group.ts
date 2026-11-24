/**
 * `read-group`: a run of reads. No read yet: ` • Read`. One row: ` ✔ Read
 * src/a.ts:1-20` (status glyph, accent path) with its usage indented under
 * it. Several: ` • Read (2)` over a branch tree of rows (dim directory, file
 * name in the file color, muted selectors, a status glyph unless it
 * succeeded) with each request's usage under its last row. Content previews
 * are framed code (or Markdown) cells titled `Read <path>`, three rows while
 * folded, each followed by its read's usage. A presenter's compact read is
 * its glyph and label over its rows. Reads {@link ReadGroupTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { terminalPaddingX } from "../terminal-padding";
import {
	READ_PREVIEW_LINES,
	type ReadGroupTerm,
	type ReadStatus,
	type ReadTermPreview,
	type ReadTermRow,
} from "../../transcript/read-group";
import { codeCellRows, markdownCellRows } from "../tools/code-cell";
import { fileLink, webLink } from "../tools/file-common";
import { frameInner, hangingWrap, statusIcon } from "../tools/frame";
import { defineToolLook, toolProps } from "../tools/look";
import { pathText } from "../tools/search";

function bold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

function glyph(cx: PaintContext, status: ReadStatus): string {
	return statusIcon(cx, status === "success" ? "success" : status);
}

/** A row's path linked to its file (at its first selected line) or web URL. */
function link(cx: PaintContext, row: ReadTermRow, text: string): string {
	if (row.link?.file) return fileLink(cx, text, row.link.file, row.link.line);
	return webLink(cx, text, row.link?.url);
}

/** A head path: accent path and selectors, then the dim correction and the conflict warning. */
function headPath(cx: PaintContext, row: ReadTermRow): string {
	const theme = cx.theme;
	let out = row.path ? link(cx, row, theme.fg("accent", row.path)) : theme.fg("toolOutput", "…");
	if (row.selectors) out += theme.fg("accent", row.selectors);
	return out + notes(cx, row);
}

/** A tree row's path: dim directory, the name in the file color (a URL whole), muted selectors. */
function rowPath(cx: PaintContext, row: ReadTermRow): string {
	const theme = cx.theme;
	let out = row.path
		? link(cx, row, row.url ? theme.fg("customMessageLabel", row.path) : pathText(theme, row.path))
		: theme.fg("toolOutput", "…");
	if (row.selectors) out += theme.fg("muted", row.selectors);
	return out + notes(cx, row);
}

function notes(cx: PaintContext, row: ReadTermRow): string {
	const theme = cx.theme;
	let out = "";
	if (row.correctedFrom) out += theme.fg("dim", ` (corrected from ${row.correctedFrom})`);
	if (row.conflicts)
		out += ` ${theme.fg("warning", `(⚠ ${row.conflicts} conflict${row.conflicts === 1 ? "" : "s"})`)}`;
	return out;
}

function title(cx: PaintContext): string {
	return cx.theme.fg("toolTitle", bold("Read"));
}

function previewRows(cx: PaintContext, preview: ReadTermPreview, width: number): string[] {
	const theme = cx.theme;
	const head = preview.head.path ? `Read ${headPath(cx, preview.head)}` : "Read";
	const status = preview.status === "success" ? "complete" : preview.status;
	const rows = preview.markdown
		? markdownCellRows(
				cx,
				{
					rendered: preview.text.trim() ? renderMarkdown(preview.text, frameInner(width), { theme }) : [],
					title: head,
					status,
					expanded: preview.expanded,
					contentMaxLines: READ_PREVIEW_LINES,
				},
				width,
			)
		: codeCellRows(
				cx,
				{
					code: preview.text,
					language: languageFromPath(preview.path),
					title: head,
					status,
					expanded: preview.expanded,
					...(preview.expanded ? {} : { codeMaxLines: READ_PREVIEW_LINES }),
					...(preview.startLine !== undefined ? { codeStartLine: preview.startLine } : {}),
					...(preview.lineNumbers ? { codeLineNumbers: preview.lineNumbers } : {}),
				},
				width,
			);
	if (preview.usage) {
		const paddingX = terminalPaddingX(3);
		const pad = " ".repeat(paddingX);
		rows.push(...wrap(theme.fg("dim", preview.usage), Math.max(1, width - 2 * paddingX)).map(row => pad + row));
	}
	return rows;
}

function paintReadGroup(node: UiNode, cx: PaintContext): Block {
	const term = toolProps(node).term as unknown as ReadGroupTerm;
	const theme = cx.theme;
	const width = cx.width;
	if (term.presented) {
		const compact = term.presented;
		const mark = compact.status === "success" ? theme.fg("dim", "•") : glyph(cx, compact.status);
		const label = compact.label ?? `${title(cx)}${compact.path ? theme.fg("muted", ` ${compact.path}`) : ""}`;
		return {
			rows: [truncate(`${mark} ${label}`, width), ...compact.rows.map(row => truncate(`  ${row}`, width))],
		};
	}
	const bullet = theme.symbols.symbol("format.bullet");
	const previews = (term.previews ?? []).flatMap(preview => previewRows(cx, preview, width));
	if (!term.count) return { rows: wrap(` ${bullet} ${title(cx)}`, width) };
	if (term.count === 1) {
		const rows: string[] = [];
		const single = term.single;
		if (single) {
			rows.push(...wrap(` ${glyph(cx, single.status)} ${title(cx)} ${headPath(cx, single)}`.trimEnd(), width));
			for (const usage of single.usage) rows.push(...wrap(theme.fg("dim", `   ${usage}`), width));
		}
		return { rows: [...rows, ...previews] };
	}
	const rows = wrap(` ${bullet} ${title(cx)}${theme.fg("dim", ` (${term.count})`)}`, width);
	const tree = term.tree ?? [];
	const branch = theme.symbols.symbol("tree.branch");
	const last = theme.symbols.symbol("tree.last");
	const vertical = theme.symbols.symbol("tree.vertical");
	tree.forEach((row, index) => {
		const end = index === tree.length - 1;
		const connector = end ? last : branch;
		const continuation = end
			? " ".repeat(visibleWidth(connector))
			: `${vertical}${" ".repeat(Math.max(0, visibleWidth(connector) - visibleWidth(vertical)))}`;
		const status = row.status === "success" ? "" : `${glyph(cx, row.status)} `;
		rows.push(
			...hangingWrap(
				`   ${theme.fg("dim", connector)} `,
				`   ${continuation} `,
				`${status}${rowPath(cx, row)}`,
				width,
			),
		);
		for (const usage of row.usage) rows.push(...wrap(theme.fg("dim", `   ${continuation} ${usage}`), width));
	});
	return { rows: [...rows, ...previews] };
}

defineToolLook("read-group", { paint: paintReadGroup, animated: true });
