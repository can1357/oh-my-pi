/**
 * Terminal rows of grouped file output (ast-grep, ast-edit): file rows as a
 * path with a dim directory (and a dim `(note)`), code-frame rows with the
 * source highlighted in its file's language, and fitting file groups into a
 * row budget with a `… N more` summary.
 */
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import { replaceTabs, truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import {
	type GroupedLinks,
	type GroupedRow,
	groupedLinkTarget,
	NUMBERED_ROW,
	PARSE_ERRORS_LIMIT,
} from "../../tools/grouped-output";
import { fileLink, uriLink } from "./file-common";
import { statusIcon } from "./frame";
import { pathText } from "./search";

/** `… 3 more matches`. */
export function moreText(count: number, noun: string): string {
	return `… ${count} more ${count === 1 ? noun : `${noun}${noun.endsWith("h") ? "es" : "s"}`}`;
}

/**
 * File groups fit to `budget` rows, the summary row included: whole groups,
 * then the next one cut when it still shows a row under its file row (the
 * first always shows). The summary counts the units (`isUnit` rows) left out
 * (of `total` when known), else the hidden rows. `gap` rows separate groups.
 */
export function fitGroupsToBudget(
	groups: readonly (readonly number[])[],
	budget: number,
	options: {
		readonly isUnit: (index: number) => boolean;
		readonly unit: string;
		readonly total?: number;
		readonly gap?: number;
	},
): { shown: (readonly number[])[]; summary: string } {
	const gap = options.gap ?? 0;
	let totalRows = Math.max(groups.length - 1, 0) * gap;
	for (const group of groups) totalRows += group.length;
	if (totalRows <= budget) return { shown: [...groups], summary: "" };
	if (budget <= 0) return { shown: [], summary: "" };
	const room = budget - 1;
	const shown: (readonly number[])[] = [];
	let used = 0;
	let units = 0;
	for (const group of groups) {
		const lead = shown.length > 0 ? gap : 0;
		const take = Math.min(group.length, room - used - lead);
		if (take <= 0 || (take < Math.min(group.length, 2) && shown.length > 0)) break;
		const part = take === group.length ? group : group.slice(0, take);
		shown.push(part);
		used += lead + take;
		for (const index of part) if (options.isUnit(index)) units++;
		if (part !== group) break;
	}
	let all = options.total ?? 0;
	if (!all) for (const group of groups) for (const index of group) if (options.isUnit(index)) all++;
	if (all - units > 0) return { shown, summary: moreText(all - units, options.unit) };
	const hidden = totalRows - used;
	return { shown, summary: hidden > 0 ? moreText(hidden, "line") : "" };
}

/**
 * `text` linked to where `owner` (a row's display path) leads: its file, at
 * `line` for a numbered row; a file row of an unresolved URL to the URL.
 */
export function groupedLink(
	cx: PaintContext,
	links: GroupedLinks | undefined,
	owner: string | undefined,
	text: string,
	line?: number,
): string {
	if (!cx.hyperlinks || !links || owner === undefined) return text;
	const target = groupedLinkTarget(links, owner);
	if (target.file) return fileLink(cx, text, target.file, line);
	return line === undefined ? uriLink(cx, text, target.url) : text;
}

/** The line number of a numbered code-frame row (`*12│…`), else undefined. */
export function numberedRowLine(line: string): number | undefined {
	const match = NUMBERED_ROW.exec(line);
	return match ? Number(match[2]) : undefined;
}

/** A file header row: its path (dim directory, passed through `link`) and dim note; a URL whole in the file color. */
export function fileRowText(theme: Theme, row: GroupedRow, link: (label: string) => string = label => label): string {
	const path = replaceTabs(row.path ?? "");
	const label = link(row.url ? theme.fg("customMessageLabel", path) : pathText(theme, path));
	return row.suffix ? `${label} ${theme.fg("dim", replaceTabs(row.suffix))}` : label;
}

/**
 * Styled code-frame rows, highlighted in each owning file's language (`lang`
 * overrides it when known): a run of consecutive line numbers in one file
 * highlights together. Other rows return undefined.
 */
export function codeFrameStyler(
	lines: readonly string[],
	rows: readonly GroupedRow[],
	color: string,
	theme: Theme,
	lang?: string,
): (index: number) => string | undefined {
	const override = lang && supportsLanguage(lang) ? lang : undefined;
	const langs: (string | undefined)[] = [];
	let headerLang: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const row = rows[index]!;
		if (row.kind === "content") {
			langs.push(override ?? headerLang);
			continue;
		}
		headerLang = row.kind === "file" ? languageFromPath(row.path ?? "") : undefined;
		langs.push(undefined);
	}
	const frames = lines.map((line, index) => {
		if (rows[index]!.kind !== "content") return undefined;
		const match = NUMBERED_ROW.exec(line);
		if (!match) return undefined;
		const source = match[3]!;
		return {
			gutter: line.slice(0, line.length - source.length),
			source,
			n: Number(match[2]),
		};
	});
	const styled: (string | undefined)[] = [];
	let index = 0;
	while (index < lines.length) {
		if (!frames[index]) {
			index++;
			continue;
		}
		let end = index + 1;
		while (
			end < lines.length &&
			frames[end] &&
			langs[end] === langs[index] &&
			frames[end]!.n === frames[end - 1]!.n + 1
		)
			end++;
		const run = frames.slice(index, end).map(frame => replaceTabs(frame!.source));
		const runLang = langs[index];
		const code = runLang && supportsLanguage(runLang) ? highlightCode(run.join("\n"), runLang, theme) : undefined;
		for (let i = index; i < end; i++)
			styled[i] = `${theme.fg(color, frames[i]!.gutter)}${code?.[i - index] ?? theme.fg(color, run[i - index]!)}`;
		index = end;
	}
	return i => styled[i];
}

/** The head glyph. */
export type HeadGlyph = "pending" | "search" | "success" | "warning" | "error";

/**
 * A status head: glyph, accent title, then `: subject in scope` (muted, `in`
 * dim) and the dim ` · `-joined meta.
 */
export function scopedHead(
	cx: PaintContext,
	head: {
		readonly glyph: HeadGlyph;
		readonly title: string;
		readonly subject?: string;
		readonly scope?: string;
		readonly meta?: readonly string[];
	},
): string {
	const theme = cx.theme;
	const glyph =
		head.glyph === "search" ? theme.fg("accent", theme.symbols.symbol("icon.search")) : statusIcon(cx, head.glyph);
	let out = `${glyph} ${theme.fg("accent", head.title)}`;
	const subject = head.subject?.replace(/\r\n?|\n/g, " ");
	if (subject || head.scope) {
		out += ": ";
		if (subject) out += theme.fg("muted", replaceTabs(subject));
		if (head.scope)
			out += `${theme.fg("muted", subject ? " " : "")}${theme.fg("dim", "in")}${theme.fg("muted", ` ${replaceTabs(head.scope)}`)}`;
	}
	const meta = (head.meta ?? []).filter(part => part.length > 0);
	if (meta.length > 0) out += ` ${theme.fg("dim", meta.join(theme.symbols.symbol("sep.dot")))}`;
	return out;
}

/** The issue list under a head: `  - issue` in the warning color, `  … N more` past the cap. */
export function parseIssueRows(theme: Theme, errors: readonly string[] | undefined, total?: number): string[] {
	if (!errors || errors.length === 0) return [];
	const count = total ?? errors.length;
	const shown = errors.slice(0, PARSE_ERRORS_LIMIT);
	const rows = shown.map(error => theme.fg("warning", `  - ${error}`));
	if (count > shown.length) rows.push(theme.fg("dim", `  … ${count - shown.length} more`));
	return rows;
}

/** An error message as the head's detail row: indented, in the error color, `Error:` dropped, cut to 110 cells. */
export function errorDetail(theme: Theme, message: string): string {
	const clean = stripControl(message)
		.replace(/^Error:\s*/, "")
		.trim();
	return `  ${theme.fg("error", clean ? replaceTabs(truncate(clean, 110)) : "Unknown error")}`;
}
