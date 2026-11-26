/**
 * What the search looks (grep, glob, find) share: the status-glyph head line
 * (`🔍 Grep: needle in src 2 matches · 2 files`), branch trees of items with
 * a trailing `… N more` summary, and file paths with a dim directory.
 */
import type { TspText } from "@oh-my-pi/pi-wire";
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { replaceTabs, truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { fileLink } from "./file-common";

/** The head's leading glyph. */
export type SearchGlyph = "pending" | "search" | "warning" | "error";

/** The glyph, colored. */
export function searchGlyph(theme: Theme, glyph: SearchGlyph): string {
	switch (glyph) {
		case "pending":
			return theme.fg("muted", theme.symbols.symbol("status.pending"));
		case "warning":
			return theme.fg("warning", theme.symbols.symbol("status.warning"));
		case "error":
			return theme.fg("error", theme.symbols.symbol("status.error"));
		default:
			return theme.fg("toolTitle", theme.symbols.icon("search"));
	}
}

/** A head target: plain text muted, styled spans in their own style. */
export function mutedText(theme: Theme, text: TspText | undefined): string {
	if (text === undefined) return "";
	if (typeof text === "string") return theme.fg("muted", replaceTabs(text));
	let out = "";
	for (const span of text)
		out += span.s ? theme.style(span.s, replaceTabs(span.t)) : theme.fg("muted", replaceTabs(span.t));
	return out;
}

/** Parts of a search head line. */
export interface SearchHead {
	readonly glyph: SearchGlyph;
	readonly title: TspText;
	/** Shown after `Title: `; absent → no colon. */
	readonly target?: TspText;
	/** ` in <scope>` after the target. */
	readonly scope?: string;
	/** The searched path the scope links to. */
	readonly scopeLink?: string;
	/** Facts after the target, joined by ` · ` (each pre-styled or plain). */
	readonly meta?: readonly string[];
}

/** The head line as styled text (unwrapped); the scope linked to its path when `cx` draws links. */
export function searchHeadText(theme: Theme, head: SearchHead, cx?: PaintContext): string {
	let out = `${searchGlyph(theme, head.glyph)} ${theme.fg("toolTitle", styledText(theme, head.title))}`;
	if (head.target !== undefined) out += `: ${mutedText(theme, head.target)}`;
	if (head.scope) {
		const scope = replaceTabs(head.scope);
		const shown =
			cx?.hyperlinks && head.scopeLink
				? `${theme.fg("muted", " ")}${fileLink(cx, theme.fg("muted", scope), head.scopeLink)}`
				: theme.fg("muted", ` ${scope}`);
		out += `${theme.fg("muted", " ")}${theme.fg("dim", "in")}${shown}`;
	}
	if (head.meta && head.meta.length > 0) out += ` ${theme.fg("dim", head.meta.join(" · "))}`;
	return out;
}

/** The head line wrapped to the width. */
export function searchHeadRows(cx: PaintContext, head: SearchHead): string[] {
	return wrap(searchHeadText(cx.theme, head, cx), cx.width);
}

/** One tree item: its rows (the first gets the branch, the rest the trunk). */
export type TreeItem = readonly string[];

/**
 * Items on branches: `├─ ` / `└─ ` before each item's first row, `│  ` /
 * `   ` before the rest; every row cut to the width (ending in `ellipsis`).
 */
export function treeRows(theme: Theme, items: readonly TreeItem[], width: number, ellipsis = ""): string[] {
	const rows: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const last = i === items.length - 1;
		const branch = theme.fg("dim", theme.symbols.symbol(last ? "tree.last" : "tree.branch"));
		const trunk = last ? "   " : `${theme.fg("dim", theme.symbols.symbol("tree.vertical"))}  `;
		const item = items[i]!;
		for (let r = 0; r < item.length; r++)
			rows.push(truncate(`${r === 0 ? branch : trunk}${r === 0 ? " " : ""}${item[r]}`, width, ellipsis));
	}
	return rows;
}

/** `… N more <noun>` as a muted tree item. */
export function moreItem(theme: Theme, count: number, noun: string): TreeItem {
	return [theme.fg("muted", `${theme.symbols.ellipsis} ${count} more ${noun}`)];
}

/** A path with a dim directory and the name in the file color. */
export function pathText(theme: Theme, path: string): string {
	const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
	const cut = trimmed.lastIndexOf("/");
	const dir = cut < 0 ? "" : path.slice(0, cut + 1);
	const name = cut < 0 ? path : path.slice(cut + 1);
	return `${dir ? theme.fg("dim", replaceTabs(dir)) : ""}${theme.fg("customMessageLabel", replaceTabs(name))}`;
}
