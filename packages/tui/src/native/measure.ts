/**
 * A rough lower bound on how many terminal rows a described subtree takes,
 * for layout decisions the program must make before the terminal lays the
 * content out (whether a sheet fills a narrow pane). Counts cell lines at the
 * surface width; the terminal's own fonts and padding differ, so callers
 * compare against a fraction of the viewport, not an exact fit.
 */
import type { TspExtent, TspText, TspTreeNode } from "@oh-my-pi/pi-wire";
import type { Component } from "../tui";
import type { NativeChild, NativeNode } from "./node";

/** The last description of a component, or undefined when unknown. */
export type DescribedOf = (component: Component) => NativeNode | undefined;

/** Leaf images, media and charts: a fixed guess, since their height is the terminal's choice. */
const GRAPHIC_ROWS = 8;
/** Nesting deeper than this is not measured (cyclic or runaway descriptions). */
const MAX_DEPTH = 64;

/**
 * Estimated rows of `root` at `cols` cells wide, stopping once `limit` is
 * reached (the result never exceeds it). Component children are measured
 * through `described`.
 */
export function estimateRows(root: NativeChild, cols: number, limit: number, described: DescribedOf): number {
	return new RowEstimator(Math.max(1, cols), described).measure(root, limit, 0);
}

class RowEstimator {
	constructor(
		readonly cols: number,
		readonly described: DescribedOf,
	) {}

	measure(child: NativeChild, cap: number, depth: number): number {
		if (cap <= 0 || depth > MAX_DEPTH) return 0;
		const node = isNode(child) ? child : this.described(child);
		if (!node) return 0;
		if (node.k === "chart") return Math.min(cap, GRAPHIC_ROWS);
		const p = node.p;
		if (p?.hidden) return 0;
		const max = linesExtent(p?.max?.h);
		const own = this.#kindRows(node, max === undefined ? cap : Math.min(cap, max), depth);
		return Math.min(cap, Math.max(own, linesExtent(p?.min?.h) ?? 0));
	}

	#sum(children: readonly NativeChild[] | undefined, cap: number, depth: number): number {
		let rows = 0;
		for (const child of children ?? []) {
			if (rows >= cap) break;
			rows += this.measure(child, cap - rows, depth + 1);
		}
		return rows;
	}

	#tallest(children: readonly NativeChild[] | undefined, cap: number, depth: number): number {
		let rows = 0;
		for (const child of children ?? []) rows = Math.max(rows, this.measure(child, cap, depth + 1));
		return rows;
	}

	/** Rows of `text`, one per line, or wrapped at the surface width. */
	#textRows(text: string | undefined, wrap: boolean, cap: number): number {
		if (!text) return 0;
		let rows = 0;
		let start = 0;
		while (rows < cap) {
			const end = text.indexOf("\n", start);
			const line = end === -1 ? text.slice(start) : text.slice(start, end);
			rows += wrap ? Math.max(1, Math.ceil(Bun.stringWidth(line) / this.cols)) : 1;
			if (end === -1) break;
			start = end + 1;
		}
		return Math.min(rows, cap);
	}

	#kindRows(node: NativeNode, cap: number, depth: number): number {
		switch (node.k) {
			// Scrollers of their own: they take whatever height they get.
			case "picker":
			case "prefs":
				return cap;
			case "row":
				return this.#tallest(node.c, cap, depth);
			case "tabs":
				// One page shows at a time: the tab strip, then the tallest page.
				return 1 + this.#tallest(node.c, cap - 1, depth);
			case "card":
			case "section": {
				const head = node.p?.head === undefined ? 0 : 1;
				const body = this.#sum(node.c, cap - head, depth);
				if (!node.p?.collapsed) return head + body;
				const preview = node.k === "card" && typeof node.p.preview === "object" ? node.p.preview.lines : 0;
				return head + Math.min(preview, body);
			}
			case "text": {
				const p = node.p;
				const text = p?.text ?? p?.spans?.map(run => run.t).join("");
				return this.#textRows(
					text,
					p?.wrap !== "none" && p?.truncate === undefined,
					Math.min(cap, p?.lines ?? cap),
				);
			}
			case "md":
			case "editor":
			case "input":
				return this.#textRows(node.p?.text, true, cap);
			case "code":
			case "diff":
				return this.#textRows(node.p?.text, false, cap);
			case "ansi": {
				if (node.p?.follow) return cap;
				const preview = typeof node.p?.preview === "object" ? node.p.preview.lines : cap;
				return this.#textRows(node.p?.text, false, Math.min(cap, preview));
			}
			case "rows":
				return Math.min(cap, node.p?.lines.length ?? 0);
			case "kv":
				return Math.min(cap, node.p?.items.length ?? 0);
			case "table":
				return Math.min(cap, 1 + (node.p?.rows.length ?? 0));
			case "tree":
				return treeRows(node.p?.nodes, cap);
			case "json":
				return Math.min(cap, jsonRows(node.p?.value, cap));
			case "checklist": {
				let rows = 0;
				for (const phase of node.p?.phases ?? []) rows += 1 + (phase.collapsed ? 0 : phase.items.length);
				return Math.min(cap, rows);
			}
			case "list": {
				const max = node.p?.max;
				return this.#sum(node.c, Math.min(cap, typeof max === "number" ? max : (max?.lines ?? cap)), depth);
			}
			case "item":
				return (hasText(node.p?.detail) ? 2 : 1) + this.#sum(node.c, cap, depth);
			case "image":
			case "media":
				return Math.min(cap, GRAPHIC_ROWS);
			case "tool":
			case "agent":
				return 1 + this.#sum(node.c, cap - 1, depth);
			default:
				// Containers stack their children; leaves (badges, keys, buttons, meters) take a row.
				return node.c && node.c.length > 0 ? this.#sum(node.c, cap, depth) : 1;
		}
	}
}

function isNode(child: NativeChild): child is NativeNode {
	return typeof (child as Partial<NativeNode>).k === "string";
}

function hasText(text: TspText | undefined): boolean {
	return typeof text === "string" ? text.length > 0 : text !== undefined && text.some(run => run.t.length > 0);
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
