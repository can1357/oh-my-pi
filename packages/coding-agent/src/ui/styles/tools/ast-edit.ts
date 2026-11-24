/**
 * `ast_edit`: a pending call is its head line (`⏳ AST Edit: foo($A) in
 * src`). A result is a framed card: the head in the top edge, each touched
 * file's path over its `-12 old` / `+12 new` rows (files apart by a blank
 * row; collapsed fits 6 rows ending in `… N more files`), limit and
 * parse-issue notes, and the counts (led by `proposed` when unapplied) in the
 * bottom edge. No replacements: a warning head line, or a card listing the
 * parse issues. Reads {@link AstEditTerm}.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import { AST_EDIT_PREVIEW_ROWS, type AstEditTerm } from "../../tools/ast-edit";
import {
	classifyGroupedLines,
	groupedRowOwners,
	groupLineIndicesByBlank,
	groupsByFile,
	parseIssuesLabel,
} from "../../tools/grouped-output";
import { countText } from "../../tools/search-common";
import { frameInner, frameRows, outcomeBg } from "./frame";
import {
	errorDetail,
	fileRowText,
	fitGroupsToBudget,
	groupedLink,
	type HeadGlyph,
	parseIssueRows,
	scopedHead,
} from "./grouped-output";
import { defineToolLook, isExpanded, toolProps } from "./look";

function head(cx: PaintContext, term: AstEditTerm, glyph: HeadGlyph, meta?: readonly string[]): string {
	return scopedHead(cx, {
		glyph,
		title: "AST Edit",
		...(term.subject !== undefined ? { subject: term.subject } : {}),
		...(term.scope ? { scope: term.scope } : {}),
		...(meta ? { meta } : {}),
	});
}

function paintAstEdit(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as unknown as AstEditTerm;
	const theme = cx.theme;
	const width = cx.width;
	if (term.phase === "call") return { rows: wrap(head(cx, term, "pending"), width) };
	if (term.phase === "error")
		return {
			rows: frameRows(theme, width, {
				head: head(cx, term, "error"),
				sections: [{ lines: [errorDetail(theme, term.error ?? "")] }],
				border: "error",
				bg: outcomeBg("error"),
			}),
		};
	const searched = term.filesSearched ?? 0;
	if ((term.replacements ?? 0) === 0) {
		const meta = ["0 replacements"];
		if (searched > 0) meta.push(`searched ${searched}`);
		const issues = parseIssueRows(theme, term.parseErrors, term.parseErrorsTotal);
		if (issues.length === 0) return { rows: wrap(head(cx, term, "warning", meta), width) };
		return {
			rows: frameRows(theme, width, {
				head: head(cx, term, "warning"),
				sections: [{ lines: issues }],
				foot: theme.fg("dim", meta.join(theme.symbols.symbol("sep.dot"))),
				border: "borderMuted",
				bg: outcomeBg("warning"),
			}),
		};
	}
	const dot = theme.fg("dim", theme.symbols.symbol("sep.dot"));
	const facts = [
		countText(term.replacements ?? 0, "replacement"),
		countText(term.filesTouched ?? 0, "file"),
		`searched ${searched}`,
	].map(part => theme.fg("dim", part));
	if (!term.applied) facts.unshift(theme.fg("warning", "proposed"));
	const lines = (term.output ?? "").split("\n");
	const rows = classifyGroupedLines(lines);
	const owners = groupedRowOwners(rows, term.links?.scope);
	const style = (index: number): string => {
		const row = rows[index]!;
		if (row.kind === "file")
			return fileRowText(theme, row, label => groupedLink(cx, term.links, owners[index], label));
		const line = lines[index]!.replace("│", " ");
		const color = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolOutput";
		return replaceTabs(theme.fg(color, line));
	};
	const groups = groupsByFile(groupLineIndicesByBlank(lines), rows).filter(indices => {
		const first = lines[indices[0]!]!;
		return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
	});
	const fitted = fitGroupsToBudget(groups, isExpanded(props) ? Number.POSITIVE_INFINITY : AST_EDIT_PREVIEW_ROWS, {
		isUnit: index => rows[index]!.kind === "file",
		unit: "file",
		gap: 1,
	});
	const body: string[] = [];
	for (const group of fitted.shown) {
		if (body.length > 0) body.push("");
		for (const index of group) body.push(style(index));
	}
	if (fitted.summary) body.push(theme.fg("muted", fitted.summary));
	if (term.limitReached) body.push(theme.fg("warning", "limit reached; narrow path"));
	if (term.parseErrors?.length)
		body.push(theme.fg("warning", parseIssuesLabel(term.parseErrors, term.parseErrorsTotal)));
	const inner = frameInner(width);
	const content = body.map(line => truncate(line, inner, ""));
	while (content.length > 0 && content[0]!.trim() === "") content.shift();
	return {
		rows: frameRows(theme, width, {
			head: head(cx, term, term.limitReached ? "warning" : "success"),
			sections: content.length > 0 ? [{ lines: content }] : [],
			foot: facts.join(dot),
			border: "borderMuted",
			bg: outcomeBg(term.partial ? "pending" : "success"),
		}),
	};
}

defineToolLook("ast_edit", { paint: paintAstEdit, margin: true });
