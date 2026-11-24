/**
 * The `find` look: a head line (`🔍 Find: "query" 12 hits · 2 files read ·
 * τ 0.20 · …`), then a branch tree of hits (a six-cell score bar, the score,
 * the path, how much was judged) with their passages on nested branches
 * (`:10-20 0.90 code`). Collapsed ends in `… N more hits`; expanded adds the
 * keywords and failures.
 */
import * as path from "node:path";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { TspProgressProps, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { splitUrlScheme } from "../../../internal-urls/url-scheme";
import type { FindTerm } from "../../tools/find";
import { fileLink, uriLink } from "./file-common";
import { defineToolLook, toolProps } from "./look";
import { moreItem, pathText, searchGlyph, searchHeadRows, type TreeItem, treeRows } from "./search";

/** Cells of a hit's score bar. */
const BAR_CELLS = 6;

function bar(theme: Theme, value: number, tone: string): string {
	const filled = Math.round(Math.min(1, Math.max(0, value)) * BAR_CELLS);
	return `${theme.style(tone, "━".repeat(filled))}${theme.fg("dim", "─".repeat(BAR_CELLS - filled))}`;
}

function snippet(theme: Theme, text: string, file: string): string {
	const line = replaceTabs(text.split("\n")[0]!.trimStart());
	const lang = languageFromPath(file);
	return lang && supportsLanguage(lang) ? highlightCode(line, lang, theme)[0]! : theme.fg("muted", line);
}

/** A hit (`omp.tool.find.hit` col) as a tree item; its path and passages link to the file under `cwd`. */
function hitItem(cx: PaintContext, hit: UiNode, cwd: string | undefined): TreeItem {
	const theme = cx.theme;
	const [row, ...ranges] = hit.children();
	const [gauge, file, facts] = row?.children() ?? [];
	const progress = (gauge?.props() ?? { value: 0 }) as TspProgressProps & {
		tone?: TspTone;
	};
	const rel = (file?.props() as { title?: string } | undefined)?.title ?? "";
	const spans = ((facts?.props() as { spans?: readonly TspSpan[] } | undefined)?.spans ?? []) as readonly TspSpan[];
	const score = spans[0]?.t ?? "";
	const judged = (spans[1]?.t ?? "").replace(/^ · /, "");
	const tone = progress.tone ?? "muted";
	// `scheme://` hits (virtual documents) link the URL itself, not a file under the cwd.
	const isUrl = splitUrlScheme(rel) !== undefined;
	const filePath = !isUrl && cwd !== undefined ? path.join(cwd, rel) : undefined;
	const link = (text: string, line?: number): string =>
		isUrl ? uriLink(cx, text, line === undefined ? rel : `${rel}:${line}`) : fileLink(cx, text, filePath, line);
	const rows = [
		`${bar(theme, progress.value ?? 0, tone)} ${theme.style(tone, score)} ${link(pathText(theme, rel))} ${theme.fg("dim", judged)}`,
	];
	for (let i = 0; i < ranges.length; i++) {
		const code = ranges[i]!.props() as {
			start?: number;
			title?: string;
			text?: string;
			path?: string;
		};
		const key = ranges[i]!.key() ?? "";
		const branch = theme.fg("dim", theme.symbols.symbol(i === ranges.length - 1 ? "tree.last" : "tree.branch"));
		rows.push(
			`  ${branch} ${link(theme.fg("muted", `:${key}`), code.start)} ${theme.fg("dim", code.title ?? "")} ${snippet(theme, code.text ?? "", code.path ?? rel)}`,
		);
	}
	return rows;
}

function paintFind(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? { look: "find" }) as FindTerm;
	const theme = cx.theme;
	if (term.error !== undefined)
		return {
			rows: wrap(`${searchGlyph(theme, "error")} ${theme.fg("error", `Error: ${term.error}`)}`, cx.width),
		};
	const target = term.query ? `"${term.query}"` : undefined;
	const meta = [...(term.facts ?? [])];
	if (!term.result) {
		for (const fact of props.meta ?? [])
			if (typeof fact !== "string") for (const span of fact) if (span.fx === "shimmer") meta.push(span.t);
		return {
			rows: searchHeadRows(cx, {
				glyph: "pending",
				title: props.title,
				target,
				meta,
			}),
		};
	}
	for (const warning of term.warnings ?? []) meta.push(theme.fg("warning", warning));
	const rows = searchHeadRows(cx, {
		glyph: props.tone === "warning" ? "warning" : "search",
		title: props.title,
		target,
		meta,
	});
	const failures = (term.failures ?? []).map(failure => truncate(theme.fg("warning", failure), cx.width, ""));
	if (term.empty !== undefined) {
		rows.push(...wrap(`${searchGlyph(theme, "warning")} ${theme.fg("muted", term.empty)}`, cx.width));
		for (const match of term.lexical ?? [])
			rows.push(
				truncate(
					`  ${theme.fg("customMessageLabel", match.label)} ${theme.fg("muted", replaceTabs(match.text))}`,
					cx.width,
					"",
				),
			);
		return { rows: [...rows, ...failures] };
	}
	const items = node
		.children()
		.filter(child => (child.props() as { role?: string }).role === "omp.tool.find.hit")
		.map(hit => hitItem(cx, hit, term.cwd));
	if (term.more) items.push(moreItem(theme, term.more, "hits"));
	rows.push(...treeRows(theme, items, cx.width));
	if (props.collapsed === false) {
		if (term.keywords) rows.push(truncate(theme.fg("dim", term.keywords), cx.width, ""));
		rows.push(...failures);
	}
	return { rows };
}

defineToolLook("find", { paint: paintFind, margin: true, inset: true, animated: true });
