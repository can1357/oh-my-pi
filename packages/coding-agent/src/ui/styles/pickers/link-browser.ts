/**
 * The extension link browser in the terminal (role
 * `omp.overlay.linkBrowser`): a fullscreen frame of rules around a head
 * (`Extension links · pick one anywhere in the transcript`), the replies'
 * prose (indented like the transcript, a scrollbar in the last column when
 * it overflows) and the key hint.
 *
 * Every extension link label drawn in view gets a tag over its first cells:
 * its own first letter when free, then its other letters, then the home row;
 * tags never prefix one another (two letters each once single letters run
 * out). A label keeps its tag while it stays on its row. A row whose tags
 * would not fit side by side draws none and the hint says so.
 *
 * Tags, the scroll range and the page height of the last paint are what the
 * screen's keys act on ({@link linkBrowserMeasure}).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { takeExtensionLinks } from "@oh-my-pi/pi-tui/text/markdown/links";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/render";
import { padTo, pieces, sliceColumns, truncate } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

/** The browser's term facts. */
export type LinkBrowserTerm = {
	readonly role: "omp.overlay.linkBrowser";
	/** Each reply's prose. */
	readonly replies: readonly string[];
	/** Registered extension link schemes (lowercase, without `:`). */
	readonly schemes: readonly string[];
	/** First body row shown (clamped; Infinity: the bottom). */
	readonly offset: number;
	/** Tag letters typed so far: only tags starting with them are drawn. */
	readonly typed: string;
	/** Terminal rows. */
	readonly height: number;
};

/** A drawn tag and the URL of the link it picks. */
export interface LinkTag {
	readonly tag: string;
	readonly url: string;
}

/** What the last paint showed. */
export interface LinkBrowserMeasure {
	/** Last first-row offset the body can scroll to. */
	readonly max: number;
	/** Body rows in view. */
	readonly visible: number;
	/** Some row had more tags than fit: none are drawn or typed. */
	readonly crowded: boolean;
	readonly tags: readonly LinkTag[];
}

/** Rows of chrome: rule, head, rule above the body; hint and rule under it. */
const CHROME_ROWS = 5;
/** The transcript's indent of prose. */
const INDENT = "   ";
/** Columns the prose gives up to the indent and the reply's own padding. */
const PROSE_INSET = 5;
/** Tag letters after a label's own: the home row first. */
const ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
const MAX_TAGS = ALPHABET.length * ALPHABET.length;

const kMeasure = Symbol("linkBrowser.measure");
/** Tags by label position (content row, first cell, link) from the last paint. */
const kKept = Symbol("linkBrowser.kept");

interface MeasuredBrowser extends UiNode {
	[kMeasure]?: LinkBrowserMeasure;
	[kKept]?: Map<string, string>;
}

/** What the last paint of the browser showed (undefined before the first). */
export function linkBrowserMeasure(node: UiNode): LinkBrowserMeasure | undefined {
	return (node as MeasuredBrowser)[kMeasure];
}

/** A label's part on one body row. */
interface LabelPart {
	readonly row: number;
	readonly start: number;
	readonly end: number;
	/** The label's ordinal among the labels drawn. */
	readonly link: number;
	readonly url: string;
	readonly text: string;
	/** The label goes on past the row's end. */
	readonly endsRow: boolean;
}

/** The body rows (extension link labels drawn by Markdown, markers taken out), and every label part. */
function layout(
	theme: Theme,
	replies: readonly string[],
	schemes: readonly string[],
	width: number,
): { rows: string[]; parts: LabelPart[] } {
	const rows: string[] = [];
	const parts: LabelPart[] = [];
	let link = -1;
	const proseWidth = Math.max(1, width - PROSE_INSET);
	for (const reply of replies) {
		let previous: LabelPart | undefined;
		for (const line of renderMarkdown(reply, proseWidth, { theme, linkSchemes: schemes })) {
			const row = rows.length;
			const taken = takeExtensionLinks(line);
			for (const [index, label] of taken.links.entries()) {
				// A label wrapped from the row above repeats its marker at this row's start.
				const continued =
					index === 0 && previous?.endsRow === true && previous.row === row - 1 && previous.url === label.href;
				if (!continued) link++;
				const part: LabelPart = {
					row,
					start: INDENT.length + label.start,
					end: INDENT.length + label.end,
					link,
					url: label.href,
					text: Bun.stripANSI(sliceColumns(taken.row, label.start, label.end)),
					endsRow: label.endsRow,
				};
				parts.push(part);
				previous = part;
			}
			rows.push(`${INDENT}${taken.row}`);
		}
	}
	return { rows, parts };
}

/** A label's tag letters to try: its own (first first), then the alphabet. */
function tagLetters(text: string): string[] {
	const letters = new Set<string>();
	for (const char of text.toLowerCase()) if (char >= "a" && char <= "z") letters.add(char);
	for (const char of ALPHABET) letters.add(char);
	return [...letters];
}

/** A tag for `text` keeping `used` prefix-free: one letter when one is free, else two. */
function pickTag(text: string, used: ReadonlySet<string>, twoLetters = false): string | undefined {
	const letters = tagLetters(text);
	if (!twoLetters) {
		const firsts = new Set([...used].map(tag => tag[0]!));
		const single = letters.find(letter => !firsts.has(letter));
		if (single !== undefined) return single;
	}
	for (const first of letters) {
		if (used.has(first)) continue;
		for (const second of letters) if (!used.has(`${first}${second}`)) return `${first}${second}`;
	}
	return undefined;
}

interface Target {
	/** Content rows of its parts in view, its first cells, and its text. */
	readonly keys: string[];
	readonly row: number;
	readonly start: number;
	readonly link: number;
	readonly url: string;
	readonly text: string;
}

/**
 * Tag the labels in view: a label keeps its tag while one of its parts sits
 * where it was last painted; new labels get one top to bottom.
 */
function assignTags(node: MeasuredBrowser, targets: readonly Target[]): { tag: string; target: Target }[] {
	const kept = node[kKept] ?? new Map<string, string>();
	const used = new Set<string>();
	const tags = targets.map(target => {
		const tag = target.keys.map(key => kept.get(key)).find(found => found !== undefined && !used.has(found));
		if (tag !== undefined) used.add(tag);
		return tag;
	});
	let out: { tag: string; target: Target }[] = [];
	let exhausted = false;
	for (const [index, target] of targets.entries()) {
		let tag = tags[index];
		if (tag === undefined) {
			if (used.size >= MAX_TAGS) continue;
			tag = pickTag(target.text, used);
			if (tag === undefined) {
				exhausted = true;
				break;
			}
			used.add(tag);
		}
		out.push({ tag, target });
	}
	if (exhausted) {
		used.clear();
		out = targets.slice(0, MAX_TAGS).map(target => {
			const tag = pickTag(target.text, used, true)!;
			used.add(tag);
			return { tag, target };
		});
	}
	const next = new Map<string, string>();
	for (const { tag, target } of out) for (const key of target.keys) next.set(key, tag);
	node[kKept] = next;
	return out;
}

const RESET_PATTERN = /^\x1b\[0?m$/;

/**
 * `row` with each tag drawn over the cells from its column (reverse bold
 * accent); the styles in effect resume after it.
 */
function overlayTags(row: string, tags: readonly { tag: string; col: number }[], theme: Theme): string {
	let out = "";
	let col = 0;
	let skip = 0;
	let next = 0;
	let active: string[] = [];
	const place = (): void => {
		while (next < tags.length && tags[next]!.col <= col && skip === 0) {
			const { tag } = tags[next++]!;
			out += `\x1b[0m\x1b[1;7m${theme.style("accent", tag)}\x1b[22;27m\x1b[0m${active.join("")}`;
			skip = tag.length;
		}
	};
	for (const piece of pieces(row)) {
		if (piece.escape) {
			out += piece.text;
			if (RESET_PATTERN.test(piece.text)) active = [];
			else active.push(piece.text);
			continue;
		}
		place();
		if (skip > 0) skip = Math.max(0, skip - piece.width);
		else out += piece.text;
		col += piece.width;
	}
	place();
	return `${out}\x1b[0m`;
}

/** The scrollbar column: a dim track with an accent thumb. */
function scrollbar(theme: Theme, total: number, start: number, visible: number): string[] {
	const thumb = Math.max(1, Math.min(visible, Math.floor((visible * visible) / Math.max(1, total))));
	const travel = visible - thumb;
	const top = Math.min(travel, Math.round((start * travel) / Math.max(1, total - visible)));
	return Array.from({ length: visible }, (_, i) =>
		i >= top && i < top + thumb ? theme.style("accent", "█") : theme.style("dim", "│"),
	);
}

defineRolePainter("card", "omp.overlay.linkBrowser", (node, cx): Block => {
	const term = (node.props() as { term?: LinkBrowserTerm }).term;
	const width = cx.width;
	if (!term || width < 2) return { rows: [] };
	const theme = cx.theme;
	const contentWidth = width - 1;
	const visible = Math.max(1, term.height - CHROME_ROWS);
	const { rows: body, parts } = layout(theme, term.replies, term.schemes, contentWidth);
	const max = Math.max(0, body.length - visible);
	const top = Math.min(term.offset, max);
	const shown = body.slice(top, top + visible);

	// Labels in view, a label wrapped from the row above counted once.
	const targets: Target[] = [];
	let previous: LabelPart | undefined;
	for (const part of parts) {
		if (part.row < top || part.row >= top + shown.length) continue;
		const key = `${part.row}\0${part.start}\0${part.link}`;
		const last = targets.at(-1);
		if (last && previous?.endsRow && previous.link === part.link && previous.row === part.row - 1 && part.row > top) {
			last.keys.push(key);
			(last as { text: string }).text += part.text;
		} else
			targets.push({
				keys: [key],
				row: part.row - top,
				start: part.start,
				link: part.link,
				url: part.url,
				text: part.text,
			});
		previous = part;
	}
	const tagged = assignTags(node as MeasuredBrowser, targets);
	const cells = new Map<number, number>();
	for (const { tag, target } of tagged) cells.set(target.row, (cells.get(target.row) ?? 0) + tag.length);
	const crowded = [...cells.values()].some(count => count > contentWidth);
	(node as MeasuredBrowser)[kMeasure] = {
		max,
		visible,
		crowded,
		tags: tagged.map(({ tag, target }) => ({ tag, url: target.url })),
	};

	const lines = [...shown];
	if (!crowded) {
		const byRow = new Map<number, { tag: string; col: number }[]>();
		for (const { tag, target } of tagged) {
			if (!tag.startsWith(term.typed)) continue;
			let row = byRow.get(target.row);
			if (!row) byRow.set(target.row, (row = []));
			row.push({ tag, col: target.start });
		}
		for (const [index, tags] of byRow) {
			tags.sort((a, b) => a.col - b.col);
			let free = 0;
			for (const placed of tags) {
				placed.col = Math.max(placed.col, free);
				free = placed.col + placed.tag.length;
			}
			let limit = contentWidth;
			for (let i = tags.length - 1; i >= 0; i--) {
				const placed = tags[i]!;
				placed.col = Math.max(0, Math.min(placed.col, limit - placed.tag.length));
				limit = placed.col;
			}
			lines[index] = overlayTags(lines[index]!, tags, theme);
		}
	}
	const hits: Hit[] = [{ row: 0, col: 0, width, height: term.height, node }];
	for (const part of parts) {
		if (part.row < top || part.row >= top + shown.length) continue;
		hits.push({
			row: 3 + part.row - top,
			col: part.start,
			width: part.end - part.start,
			height: 1,
			node,
			item: part.url,
		});
	}
	const bar = body.length > visible ? scrollbar(theme, body.length, top, visible) : undefined;
	const rule = theme.style("border", "─".repeat(width));
	const hint = crowded
		? theme.style("warning", "Too many links on one row to tag; widen the terminal · PgUp/PgDn scroll · Esc close")
		: theme.style("dim", "Type a tag or click a link · PgUp/PgDn scroll · Esc close");
	const rows = [
		rule,
		truncate(
			` ${theme.style("strong", "Extension links")} · ${theme.style("dim", "pick one anywhere in the transcript")}`,
			width,
		),
		rule,
	];
	for (let i = 0; i < visible; i++) {
		const line = lines[i] ?? "";
		rows.push(bar ? `${padTo(truncate(line, contentWidth), contentWidth)}${bar[i]}` : truncate(line, width));
	}
	rows.push(truncate(` ${hint}`, width), rule);
	return { rows, hits };
});

/** The pointer: the wheel scrolls three rows, a click on a label picks its link. */
defineRoleWidget("card", "omp.overlay.linkBrowser", {
	mouse(_node, mouse, _at, cx, hit) {
		if (mouse.action !== "press") return true;
		if (mouse.button === "wheel-up" || mouse.button === "wheel-down") {
			cx.emit({
				type: "action",
				key: cx.keypath,
				act: "scroll",
				value: mouse.button === "wheel-up" ? "-3" : "3",
				mods: [],
			});
			return true;
		}
		if (mouse.button === "left" && hit.item !== undefined)
			cx.emit({ type: "action", key: cx.keypath, act: "pick", value: hit.item, mods: [] });
		return true;
	},
});
