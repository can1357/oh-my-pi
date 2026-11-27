/**
 * A rough lower bound on how many terminal rows a described subtree takes,
 * for layout decisions the program must make before the terminal lays the
 * content out (whether a sheet fills a narrow pane). Counts cell lines at the
 * surface width; the terminal's own fonts and padding differ, so callers
 * compare against a fraction of the viewport, not an exact fit.
 */
import type { TspExtent, TspText, TspTreeNode } from "@oh-my-pi/pi-wire";

/** A described node as the estimator reads it: its kind, the props last sent and its wire children. */
export interface Measured {
	readonly kind: string;
	readonly props: Readonly<Record<string, unknown>> | null;
	readonly kids: readonly Measured[];
}

/** Leaf images, media and charts: a fixed guess, since their height is the terminal's choice. */
const GRAPHIC_ROWS = 8;
/** Nesting deeper than this is not measured (runaway descriptions). */
const MAX_DEPTH = 64;

/** Estimated rows of `root` at `cols` cells wide, stopping once `limit` is reached (the result never exceeds it). */
export function estimateRows(root: Measured, cols: number, limit: number): number {
	return measure(root, Math.max(1, cols), limit, 0);
}

function measure(node: Measured, cols: number, cap: number, depth: number): number {
	if (cap <= 0 || depth > MAX_DEPTH) return 0;
	if (node.kind === "chart") return Math.min(cap, GRAPHIC_ROWS);
	const p = node.props ?? {};
	if (p.hidden) return 0;
	const max = linesExtent(extentOf(p.max));
	const own = kindRows(node, p, cols, max === undefined ? cap : Math.min(cap, max), depth);
	return Math.min(cap, Math.max(own, linesExtent(extentOf(p.min)) ?? 0));
}

function sum(children: readonly Measured[], cols: number, cap: number, depth: number): number {
	let rows = 0;
	for (const child of children) {
		if (rows >= cap) break;
		rows += measure(child, cols, cap - rows, depth + 1);
	}
	return rows;
}

function tallest(children: readonly Measured[], cols: number, cap: number, depth: number): number {
	let rows = 0;
	for (const child of children) rows = Math.max(rows, measure(child, cols, cap, depth + 1));
	return rows;
}

/** Rows of `text`, one per line, or wrapped at the surface width. */
function textRows(text: unknown, wrap: boolean, cols: number, cap: number): number {
	if (typeof text !== "string" || text === "") return 0;
	let rows = 0;
	let start = 0;
	while (rows < cap) {
		const end = text.indexOf("\n", start);
		const line = end === -1 ? text.slice(start) : text.slice(start, end);
		rows += wrap ? Math.max(1, Math.ceil(Bun.stringWidth(line) / cols)) : 1;
		if (end === -1) break;
		start = end + 1;
	}
	return Math.min(rows, cap);
}

function kindRows(
	node: Measured,
	p: Readonly<Record<string, unknown>>,
	cols: number,
	cap: number,
	depth: number,
): number {
	switch (node.kind) {
		// Scrollers of their own: they take whatever height they get.
		case "picker":
		case "prefs":
			return cap;
		case "row":
			return tallest(node.kids, cols, cap, depth);
		case "tabs":
			// One page shows at a time: the tab strip, then the tallest page.
			return 1 + tallest(node.kids, cols, cap - 1, depth);
		case "card":
		case "section": {
			const head = p.head === undefined ? 0 : 1;
			const body = sum(node.kids, cols, cap - head, depth);
			if (!p.collapsed) return head + body;
			const preview = node.kind === "card" ? linesOf(p.preview) : undefined;
			return head + Math.min(preview ?? 0, body);
		}
		case "text": {
			const text = typeof p.text === "string" ? p.text : spansText(p.spans);
			const lines = typeof p.lines === "number" ? p.lines : cap;
			return textRows(text, p.wrap !== "none" && p.truncate === undefined, cols, Math.min(cap, lines));
		}
		case "md":
		case "editor":
		case "input":
			return textRows(p.text, true, cols, cap);
		case "code":
		case "diff":
			return textRows(p.text, false, cols, cap);
		case "ansi":
			if (p.follow) return cap;
			return textRows(p.text, false, cols, Math.min(cap, linesOf(p.preview) ?? cap));
		case "rows":
			return Math.min(cap, lengthOf(p.lines));
		case "kv":
			return Math.min(cap, lengthOf(p.items));
		case "table":
			return Math.min(cap, 1 + lengthOf(p.rows));
		case "tree":
			return treeRows(p.nodes as readonly TspTreeNode[] | undefined, cap);
		case "json":
			return Math.min(cap, jsonRows(p.value, cap));
		case "checklist": {
			let rows = 0;
			for (const phase of (p.phases as readonly { collapsed?: boolean; items: readonly unknown[] }[] | undefined) ??
				[])
				rows += 1 + (phase.collapsed ? 0 : phase.items.length);
			return Math.min(cap, rows);
		}
		case "list": {
			const max = typeof p.max === "number" ? p.max : linesOf(p.max);
			return sum(node.kids, cols, Math.min(cap, max ?? cap), depth);
		}
		case "item":
			return (hasText(p.detail as TspText | undefined) ? 2 : 1) + sum(node.kids, cols, cap, depth);
		case "image":
		case "media":
		case "web":
			return Math.min(cap, GRAPHIC_ROWS);
		case "tool":
		case "agent":
			return 1 + sum(node.kids, cols, cap - 1, depth);
		default:
			// Containers stack their children; leaves (badges, keys, buttons, meters) take a row.
			return node.kids.length > 0 ? sum(node.kids, cols, cap, depth) : 1;
	}
}

function spansText(spans: unknown): string | undefined {
	if (!Array.isArray(spans)) return undefined;
	let text = "";
	for (const run of spans)
		if (run && typeof run === "object" && "t" in run && typeof run.t === "string") text += run.t;
	return text;
}

function hasText(text: TspText | undefined): boolean {
	return typeof text === "string" ? text.length > 0 : text !== undefined && text.some(run => run.t.length > 0);
}

function lengthOf(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/** The `lines` of a `{ lines }` preview or cap, when it is one. */
function linesOf(value: unknown): number | undefined {
	if (value && typeof value === "object" && "lines" in value && typeof value.lines === "number") return value.lines;
	return undefined;
}

/** The height of a `{ h }` extent pair, when it has one. */
function extentOf(value: unknown): TspExtent | undefined {
	if (value && typeof value === "object" && "h" in value) return value.h as TspExtent | undefined;
	return undefined;
}

/** A `Nlines` extent as a row count; fractions and widths say nothing about rows. */
function linesExtent(extent: TspExtent | undefined): number | undefined {
	if (typeof extent !== "string" || !extent.endsWith("lines")) return undefined;
	const lines = Number.parseFloat(extent);
	return Number.isFinite(lines) ? lines : undefined;
}

function treeRows(nodes: readonly TspTreeNode[] | undefined, cap: number): number {
	let rows = 0;
	for (const node of nodes ?? []) {
		if (rows >= cap) break;
		rows += 1;
		if (node.open && node.children) rows += treeRows(node.children, cap - rows);
	}
	return Math.min(rows, cap);
}

/** Rows of `value` pretty-printed one entry per line. */
function jsonRows(value: unknown, cap: number): number {
	if (value === null || typeof value !== "object") return 1;
	let rows = 2;
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		if (rows >= cap) break;
		rows += jsonRows(entry, cap - rows);
	}
	return rows;
}
