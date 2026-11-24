/**
 * `tabs`: a strip of tab buttons, the active one raised on the selection
 * band. When the full labels do not fit one row, tabs farthest from the
 * active one shrink to their short form (an icon) first; wrapping onto more
 * rows is the last resort. `tabBar` is the strip itself, for kinds that draw
 * one in their chrome (settings pages).
 */
import type { TspTabsProps } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import type { Theme } from "../../theme/contract";
import { truncate, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import "../widgets/tabs";
import { styledText } from "./layout";

/** One tab of a strip. */
export interface TabStripItem {
	readonly id: string;
	/** Styled-free label (`🎨 Appearance`). */
	readonly label: string;
	/** The shrunk form (`🎨`); tabs without one never shrink. */
	readonly short?: string;
	/** Dimmed and skipped by navigation (search misses). */
	readonly muted?: boolean;
}

/** Where a tab landed: row and the columns `[start, end)` of its button. */
export interface TabZone {
	readonly id: string;
	readonly row: number;
	readonly start: number;
	readonly end: number;
}

/** A painted strip. */
export interface TabStrip {
	readonly rows: string[];
	readonly zones: TabZone[];
}

/** Paint a strip of `tabs` at `width`; `hover` lights a non-active tab under the pointer. */
export function tabBar(
	theme: Theme,
	tabs: readonly TabStripItem[],
	active: string | undefined,
	width: number,
	hover?: string,
): TabStrip {
	const max = Math.max(1, width);
	const activeIndex = tabs.findIndex(tab => tab.id === active);
	const style = (tab: TabStripItem, index: number, text: string): string => {
		if (tab.muted) return theme.fg("dim", text);
		if (index === activeIndex) return theme.style("strong", theme.bg("selectedBg", theme.fg("text", text)));
		if (tab.id === hover) return theme.bg("selectedBg", theme.fg("text", text));
		return theme.fg("muted", text);
	};
	const chunksFor = (labels: readonly string[]): { text: string; tab?: number }[] => {
		const chunks: { text: string; tab?: number }[] = [];
		for (let i = 0; i < tabs.length; i++) {
			chunks.push({ text: style(tabs[i]!, i, ` ${labels[i]} `), tab: i });
			if (i < tabs.length - 1) chunks.push({ text: "  " });
		}
		return chunks;
	};
	const total = (chunks: readonly { text: string }[]): number =>
		chunks.reduce((sum, chunk) => sum + visibleWidth(chunk.text), 0);

	const labels = tabs.map(tab => tab.label);
	let chunks = chunksFor(labels);
	if (total(chunks) > max) {
		const order = tabs
			.map((_, index) => index)
			.filter(index => index !== activeIndex && tabs[index]!.short !== undefined)
			.sort((a, b) => Math.abs(b - activeIndex) - Math.abs(a - activeIndex));
		for (const index of order) {
			labels[index] = tabs[index]!.short!;
			chunks = chunksFor(labels);
			if (total(chunks) <= max) break;
		}
	}

	const rows: string[] = [];
	const zones: TabZone[] = [];
	let line = "";
	let used = 0;
	for (const chunk of chunks) {
		const cells = visibleWidth(chunk.text);
		if (cells <= 0) continue;
		if (cells > max) {
			if (line) {
				rows.push(line);
				line = "";
				used = 0;
			}
			if (chunk.tab !== undefined) zones.push({ id: tabs[chunk.tab]!.id, row: rows.length, start: 0, end: max });
			rows.push(truncate(chunk.text, max));
			continue;
		}
		if (used > 0 && used + cells > max) {
			rows.push(line);
			line = "";
			used = 0;
		}
		if (chunk.tab !== undefined)
			zones.push({ id: tabs[chunk.tab]!.id, row: rows.length, start: used, end: used + cells });
		line += chunk.text;
		used += cells;
	}
	if (line) rows.push(line);
	if (rows.length === 0) rows.push("");
	return { rows, zones };
}

/** The tab id under a cell of a painted strip. */
export function tabAt(strip: TabStrip, row: number, col: number): string | undefined {
	return strip.zones.find(zone => zone.row === row && col >= zone.start && col < zone.end)?.id;
}

definePainter("tabs", (node, cx): Block => {
	if (cx.width <= 0) return EMPTY_BLOCK;
	const props = node.props() as TspTabsProps;
	const theme = cx.theme;
	const items: TabStripItem[] = props.items.map(item => {
		if (typeof item.label === "string") return { id: item.id, label: item.label };
		// A `muted` span marks a tab without matches: it is drawn dim as a whole.
		const muted = item.label.some(span => span.s?.split(" ").includes("muted"));
		return {
			id: item.id,
			label: muted ? item.label.map(span => span.t).join("") : styledText(theme, item.label),
			muted,
		};
	});
	const strip = tabBar(theme, items, props.active, cx.width);
	return {
		rows: strip.rows,
		hits: strip.zones.map(zone => ({
			row: zone.row,
			col: zone.start,
			width: zone.end - zone.start,
			height: 1,
			node: node as UiNode,
			item: zone.id,
		})),
	};
});
