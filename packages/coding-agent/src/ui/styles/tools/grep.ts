/**
 * The `grep` look: a head line (`🔍 Grep: needle in src 2 matches · 2 files`)
 * and a branch tree of the matched files, each its path and its match rows
 * (`*12│code`, highlighted by the file's language). Collapsed drops context
 * rows and fits the tree to a few rows, ending in `… N more matches`;
 * missing/binary notes follow in the warning color.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { highlightCode, supportsLanguage } from "@oh-my-pi/pi-tui/text/highlight";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { replaceTabs, wrap } from "@oh-my-pi/pi-tui/text/width";
import { type GrepGroup, type GrepTerm, parseGrepOutput } from "../../tools/grep";
import type { GroupedLinks } from "../../tools/grouped-output";
import { hangingWrap } from "./frame";
import { groupedLink } from "./grouped-output";
import { defineToolLook, toolProps } from "./look";
import { moreItem, pathText, type SearchHead, searchHeadRows, type TreeItem, treeRows } from "./search";

/** Rows of output (tree rows, notes, the summary) shown collapsed / expanded. */
const COLLAPSED_ROWS = 6;
const EXPANDED_ROWS = 24;

/** A group's rows: its path, then `*N│` / ` N│` rows. */
function groupItem(
	cx: PaintContext,
	links: GroupedLinks | undefined,
	group: GrepGroup,
	compact: boolean,
	marked: boolean,
): { readonly rows: string[]; readonly matches: number } {
	const theme = cx.theme;
	// A headerless group is the single searched file's.
	const owner = group.path ?? links?.scope;
	const lines = compact && marked ? group.lines.filter(line => line.match) : group.lines;
	const lang = group.path ? languageFromPath(group.path) : undefined;
	const code =
		lang && supportsLanguage(lang)
			? highlightCode(lines.map(line => replaceTabs(line.text)).join("\n"), lang, theme)
			: undefined;
	const rows: string[] = group.path ? [groupedLink(cx, links, owner, pathText(theme, group.path))] : [];
	let matches = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.match || !marked) matches++;
		const prefix = theme.fg("muted", line.prefix);
		rows.push(
			groupedLink(
				cx,
				links,
				owner,
				`${prefix}${code ? code[i]! : theme.fg("muted", replaceTabs(line.text))}`,
				line.line,
			),
		);
	}
	return { rows, matches };
}

function paintGrep(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? { look: "grep" }) as GrepTerm;
	const theme = cx.theme;
	const expanded = props.collapsed === false;
	if (term.empty)
		return {
			rows: wrap(
				`${theme.fg("warning", theme.symbols.symbol("status.warning"))} ${theme.fg("muted", term.empty)}`,
				cx.width,
			),
		};
	const isResult = term.error !== undefined || term.output !== undefined || term.detailed === true;
	const truncated = props.badges?.some(badge => badge.text === "truncated") ?? false;
	const meta: string[] = [];
	if (term.detailed && term.matchCount === 0) meta.push(theme.fg("warning", "0 matches"));
	else if (term.output !== undefined && !term.detailed)
		meta.push(`${term.output.split("\n").filter(line => line.trim() !== "").length} items`);
	else if (term.detailed)
		for (const fact of props.meta ?? []) if (typeof fact === "string" && !fact.startsWith("in ")) meta.push(fact);
	if (truncated) meta.push(theme.fg("warning", "truncated"));
	const head: SearchHead = {
		glyph:
			term.error !== undefined
				? "error"
				: props.tone === "warning" || truncated
					? "warning"
					: isResult
						? "search"
						: "pending",
		title: props.title,
		target: props.target,
		scope: term.scope,
		...(term.scopeLink ? { scopeLink: term.scopeLink } : {}),
		meta,
	};
	const rows = searchHeadRows(cx, head);
	if (term.error !== undefined) {
		rows.push(...hangingWrap("  ", "  ", theme.fg("error", term.error), cx.width));
		return { rows };
	}
	const notes = term.notes ?? [];
	const noteRows = notes.flatMap(note => wrap(theme.fg("warning", note), cx.width));
	if (term.output === undefined) return { rows: [...rows, ...noteRows] };
	if (!term.detailed) {
		const lines = term.output.split("\n").filter(line => line.trim() !== "");
		const items: TreeItem[] = lines.map(line => [theme.fg("muted", replaceTabs(line))]);
		const shown =
			!expanded && items.length > COLLAPSED_ROWS
				? [...items.slice(0, COLLAPSED_ROWS - 1), moreItem(theme, items.length - (COLLAPSED_ROWS - 1), "items")]
				: items;
		return { rows: [...rows, ...treeRows(theme, shown, cx.width)] };
	}
	const groups = parseGrepOutput(term.output);
	const marked = groups.some(group => group.lines.some(line => line.match));
	const budget = Math.max(0, (expanded ? EXPANDED_ROWS : COLLAPSED_ROWS) - notes.length);
	const total = term.matchCount ?? 0;
	const items: TreeItem[] = [];
	let used = 0;
	let shownMatches = 0;
	for (let i = 0; i < groups.length; i++) {
		const item = groupItem(cx, term.links, groups[i]!, !expanded, marked);
		const more = i < groups.length - 1 || shownMatches + item.matches < total;
		if (used + item.rows.length + (more ? 1 : 0) > budget) break;
		items.push(item.rows);
		used += item.rows.length;
		shownMatches += item.matches;
	}
	if (shownMatches < total)
		items.push(moreItem(theme, total - shownMatches, total - shownMatches === 1 ? "match" : "matches"));
	return { rows: [...rows, ...treeRows(theme, items, cx.width), ...noteRows] };
}

defineToolLook("grep", { paint: paintGrep, margin: true, inset: true });
