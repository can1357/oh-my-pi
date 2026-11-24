/**
 * `ast_grep`: a head line (`🔍 AST Grep: foo($A) in src 2 matches · 2 files ·
 * searched 9`) over a branch tree of the matched files, each its path and
 * its code-frame rows (highlighted in the file's language; `meta:` capture
 * rows dim, dropped while collapsed). Collapsed fits the tree to 6 rows
 * ending in `… N more matches`; limit and parse-issue notes follow. No
 * matches: a warning head and, with parse issues, a mis-scoped hint and the
 * issue list. Reads {@link AstGrepTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { AST_GREP_PREVIEW_ROWS, type AstGrepTerm, astGrepLimitAdvice } from "../../tools/ast-grep";
import {
	classifyGroupedLines,
	groupedRowOwners,
	groupLineIndicesByBlank,
	groupsByFile,
	isMatchRow,
	parseIssuesLabel,
} from "../../tools/grouped-output";
import { countText } from "../../tools/search-common";
import {
	codeFrameStyler,
	errorDetail,
	fileRowText,
	fitGroupsToBudget,
	groupedLink,
	type HeadGlyph,
	numberedRowLine,
	parseIssueRows,
	scopedHead,
} from "./grouped-output";
import { defineToolLook, isExpanded, toolProps } from "./look";
import { treeRows } from "./search";

function head(cx: PaintContext, term: AstGrepTerm, glyph: HeadGlyph, meta?: readonly string[]): string {
	return scopedHead(cx, {
		glyph,
		title: "AST Grep",
		...(term.pattern !== undefined ? { subject: term.pattern } : {}),
		...(term.scope ? { scope: term.scope } : {}),
		...(meta ? { meta } : {}),
	});
}

function paintAstGrep(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as unknown as AstGrepTerm;
	const theme = cx.theme;
	const width = cx.width;
	if (term.phase === "call")
		return {
			rows: wrap(head(cx, term, "pending", term.skip ? [`skip:${term.skip}`] : undefined), width),
		};
	if (term.phase === "error")
		return {
			rows: wrap(`${head(cx, term, "error")}\n${errorDetail(theme, term.error ?? "")}`, width),
		};
	const matchCount = term.matchCount ?? 0;
	if (matchCount === 0) {
		const meta = [theme.fg("warning", "0 matches")];
		if (term.filesSearched) meta.push(`searched ${term.filesSearched}`);
		const lines = [head(cx, term, "warning", meta)];
		if (term.parseErrors?.length) {
			lines.push(theme.fg("warning", "Query may be mis-scoped; narrow `path` before concluding absence"));
			lines.push(...parseIssueRows(theme, term.parseErrors, term.parseErrorsTotal));
		}
		return { rows: wrap(lines.join("\n"), width) };
	}
	const meta = [
		countText(matchCount, "match"),
		countText(term.fileCount ?? 0, "file"),
		`searched ${term.filesSearched ?? 0}`,
	];
	if (term.limitReached) meta.push(theme.fg("warning", "limit reached"));
	const header = head(cx, term, term.limitReached ? "warning" : "search", meta);
	const lines = (term.output ?? "").split("\n");
	const rows = classifyGroupedLines(lines);
	const codeFrame = codeFrameStyler(lines, rows, "toolOutput", theme, term.lang);
	const owners = groupedRowOwners(rows, term.links?.scope);
	const style = (index: number): string => {
		const row = rows[index]!;
		if (row.kind === "file")
			return fileRowText(theme, row, label => groupedLink(cx, term.links, owners[index], label));
		const line = lines[index]!;
		const styled = replaceTabs(codeFrame(index) ?? theme.fg(line.startsWith("  meta:") ? "dim" : "toolOutput", line));
		const number = numberedRowLine(line);
		return number === undefined ? styled : groupedLink(cx, term.links, owners[index], styled, number);
	};
	const groups = groupsByFile(groupLineIndicesByBlank(lines), rows).filter(indices => {
		const first = lines[indices[0]!]!;
		return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
	});
	const expanded = isExpanded(props);
	const fitted = fitGroupsToBudget(
		expanded ? groups : groups.map(group => group.filter(index => !lines[index]!.startsWith("  meta:"))),
		expanded ? Number.POSITIVE_INFINITY : AST_GREP_PREVIEW_ROWS,
		{
			isUnit: index => isMatchRow(lines[index]!),
			unit: "match",
			total: matchCount,
		},
	);
	const items = fitted.shown.map(group => group.map(style));
	if (fitted.summary) items.push([theme.fg("muted", fitted.summary)]);
	const extra: string[] = [];
	if (term.limitReached) extra.push(theme.fg("warning", astGrepLimitAdvice(term.nextSkip)));
	if (term.parseErrors?.length)
		extra.push(theme.fg("warning", parseIssuesLabel(term.parseErrors, term.parseErrorsTotal)));
	return {
		rows: [...wrap(header, width), ...treeRows(theme, items, width), ...extra.map(row => truncate(row, width, ""))],
	};
}

defineToolLook("ast_grep", { paint: paintAstGrep, margin: true });
