/**
 * Job widgets and tiles as terminal rows (the wait card, the jobs sheet).
 *
 * Rows stay within 80 cells so bars keep beside their labels: a head line
 * (title or lead, the figure and meta flush right), then blocks under a
 * shared label column: `▁▃▆` sparklines with the latest value and `┄ target`
 * marks, `█░` bars, stats joined by ` · `, `● name` grid cells (`◌` while in
 * progress) and dim text lines.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type {
	JobWidgetBlock,
	JobWidgetGridBlock,
	JobWidgetSparkBlock,
	JobWidgetView,
} from "../../../../tools/details/job-widget";
import {
	fraction,
	type JobTile,
	type JobWidgetGlance,
	jobWidgetGlance,
	plainLine,
	tileTitle,
	toneColor,
} from "../../../tools/jobs/widget";

/** Widgets stop growing here so wide terminals keep bars and labels together. */
const MAX_WIDTH = 80;
const LABEL_MIN = 4;
const LABEL_MAX = 16;
const BAR_MAX = 32;
/** Sparkline cells below which the mark labels give way. */
const SPARK_MIN = 12;
/** Lines a grid's labelled cells may wrap onto before bare cells. */
const GRID_LINES = 3;
const INDENT = "  ";
const GAP = "  ";
const DEFAULT_TONE: TspTone = "accent";
const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** `values` squeezed into at most `cells` bucket means, newest last. */
function fitSpark(values: readonly number[], cells: number): readonly number[] {
	const count = Math.max(0, Math.floor(cells));
	if (values.length <= count) return values;
	const out: number[] = [];
	for (let bucket = 0; bucket < count; bucket++) {
		const from = Math.floor((bucket * values.length) / count);
		const to = Math.max(from + 1, Math.floor(((bucket + 1) * values.length) / count));
		let sum = 0;
		for (let i = from; i < to; i++) sum += values[i]!;
		out.push(sum / (to - from));
	}
	return out;
}

function sparkline(theme: Theme, block: JobWidgetSparkBlock, values: readonly number[]): string {
	const color = toneColor(block.tone ?? DEFAULT_TONE);
	const span = block.max - block.min;
	let out = "";
	for (const value of values) {
		const level = span > 0 ? (value - block.min) / span : value > block.min ? 1 : 0;
		const clamped = Number.isFinite(level) ? Math.min(Math.max(level, 0), 1) : 0;
		out += SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.floor(clamped * SPARK_LEVELS.length))];
	}
	return theme.fg(color, out);
}

/** A `█░` bar at most `room` (≤ 32) cells wide, filled in the tone. */
function bar(theme: Theme, value: number, room: number, tone: TspTone | undefined): string {
	const width = Math.max(0, Math.min(BAR_MAX, room));
	const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
	const color = toneColor(tone ?? DEFAULT_TONE);
	return `${filled > 0 ? theme.fg(color, "█".repeat(filled)) : ""}${width - filled > 0 ? theme.fg("dim", "░".repeat(width - filled)) : ""}`;
}

/** One label column for every block: the widest label within 4–16 cells and a third of the width. */
function labelWidth(blocks: readonly JobWidgetBlock[], width: number): number {
	let widest = 0;
	for (const block of blocks) {
		if (block.kind === "spark" || block.kind === "meter" || block.kind === "grid")
			widest = Math.max(widest, visibleWidth(plainLine(block.label)));
		else if (block.kind === "bars")
			for (const item of block.items) widest = Math.max(widest, visibleWidth(plainLine(item.label)));
	}
	if (widest === 0) return 0;
	const cap = Math.min(LABEL_MAX, Math.floor((width - INDENT.length) / 3));
	return Math.max(0, Math.min(Math.max(widest, LABEL_MIN), cap));
}

/** `left` cut to fit with `right` flush right; `right` gives way when `left` would keep under 8 cells. */
function headRow(left: string, right: string | undefined, width: number): string {
	if (!right) return truncate(left, width);
	const room = width - visibleWidth(right) - GAP.length;
	if (room < Math.min(visibleWidth(left), 8)) return truncate(left, width);
	const head = truncate(left, room);
	return `${head}${" ".repeat(Math.max(GAP.length, width - visibleWidth(head) - visibleWidth(right)))}${right}`;
}

function glanceText(theme: Theme, glance: JobWidgetGlance): string {
	let out = theme.style("strong", glance.text);
	if (glance.label) out = `${theme.fg("muted", glance.label)} ${out}`;
	if (glance.trend) out += ` ${theme.fg(toneColor(glance.trend.tone), plainLine(glance.trend.text))}`;
	return out;
}

/** The indent and the padded label column opening a block row. */
function lead(theme: Theme, label: string, width: number): string {
	if (width === 0) return INDENT;
	return `${INDENT}${theme.fg("muted", truncate(plainLine(label), width, "…", true))}${GAP}`;
}

function sparkRow(theme: Theme, block: JobWidgetSparkBlock, width: number, labels: number): string {
	const opening = lead(theme, block.label, labels);
	if (block.values.length === 0) return `${opening}${theme.fg("dim", "waiting for data")}`;
	const last = theme.style("strong", plainLine(block.last));
	const marks = (block.marks ?? []).map(
		mark => `${theme.fg(toneColor(mark.tone ?? "muted"), "┄")} ${theme.fg("dim", plainLine(mark.label))}`,
	);
	const room = width - visibleWidth(opening) - GAP.length;
	let tail = [last, ...marks].join(GAP);
	if (marks.length > 0 && room - visibleWidth(tail) < Math.min(SPARK_MIN, block.values.length)) tail = last;
	const cells = Math.max(1, room - visibleWidth(tail));
	return `${opening}${sparkline(theme, block, fitSpark(block.values, cells))}${GAP}${tail}`;
}

/** `● label` cells wrapped under the label column within three lines, else one line of bare `●`/`◌` cells. */
function gridRows(theme: Theme, block: JobWidgetGridBlock, width: number, labels: number): string[] {
	const opening = lead(theme, block.label, labels);
	if (block.items.length === 0) return [`${opening}${theme.fg("dim", "waiting for data")}`];
	const leadWidth = visibleWidth(opening);
	const room = width - leadWidth;
	// Pending, muted and neutral cells are still in progress.
	const glyph = (tone: TspTone): string =>
		theme.fg(toneColor(tone), tone === "pending" || tone === "muted" || tone === "neutral" ? "◌" : "●");
	const rows: string[][] = [[]];
	let used = 0;
	for (const item of block.items) {
		const name = plainLine(item.label);
		const cell = 2 + visibleWidth(name);
		const current = rows[rows.length - 1]!;
		const needed = current.length === 0 ? cell : used + GAP.length + cell;
		if (current.length > 0 && needed > room) {
			rows.push([]);
			used = cell;
		} else used = needed;
		rows[rows.length - 1]!.push(`${glyph(item.tone)} ${theme.fg("toolOutput", name)}`);
	}
	if (rows.length <= GRID_LINES && rows.every(cells => visibleWidth(cells.join(GAP)) <= room)) {
		const pad = " ".repeat(leadWidth);
		return rows.map((cells, index) => `${index === 0 ? opening : pad}${cells.join(GAP)}`);
	}
	return [`${opening}${block.items.map(item => glyph(item.tone)).join(" ")}`];
}

function blockRows(theme: Theme, block: JobWidgetBlock, width: number, labels: number): string[] {
	switch (block.kind) {
		case "spark":
			return [sparkRow(theme, block, width, labels)];
		case "bars": {
			const rows = [`${INDENT}${theme.fg("dim", plainLine(block.label))}`];
			if (block.items.length === 0) rows.push(`${INDENT}${theme.fg("dim", "waiting for data")}`);
			const texts = block.items.map(item => plainLine(item.text));
			const textWidth = Math.max(0, ...texts.map(text => visibleWidth(text)));
			block.items.forEach((item, index) => {
				const opening = lead(theme, item.label, labels);
				const value = texts[index]!;
				const filled = bar(
					theme,
					fraction(item.value, block.max),
					width - visibleWidth(opening) - GAP.length - textWidth,
					item.tone,
				);
				rows.push(`${opening}${filled}${GAP}${" ".repeat(textWidth - visibleWidth(value))}${value}`);
			});
			return rows;
		}
		case "meter": {
			const opening = lead(theme, block.label, labels);
			const value = plainLine(block.text);
			const filled = bar(
				theme,
				fraction(block.value, 1),
				width - visibleWidth(opening) - GAP.length - visibleWidth(value),
				block.tone,
			);
			return [`${opening}${filled}${GAP}${theme.style("strong", value)}`];
		}
		case "stat":
			return [
				`${INDENT}${block.items
					.map(item => {
						const color = item.tone ? toneColor(item.tone) : "toolOutput";
						const trend = item.trend
							? ` ${theme.fg(toneColor(item.trend.tone), plainLine(item.trend.text))}`
							: "";
						return `${theme.fg("dim", plainLine(item.label))} ${theme.fg(color, plainLine(item.text))}${trend}`;
					})
					.join(theme.fg("dim", " · "))}`,
			];
		case "grid":
			return gridRows(theme, block, width, labels);
		case "text":
			return [`${INDENT}${theme.fg("dim", plainLine(block.text))}`];
	}
}

/**
 * A job's whole widget as rows within `width` (capped at 80): the head line
 * (title, stage, headline at the right), then every block under a shared
 * label column.
 */
export function jobWidgetRows(theme: Theme, view: JobWidgetView, width: number): string[] {
	const w = Math.min(Math.max(0, Math.floor(width)), MAX_WIDTH);
	if (w === 0) return [];
	const labels = labelWidth(view.blocks, w);
	const stage = view.stage ? plainLine(view.stage) : "";
	const title = theme.style("strong", plainLine(view.title));
	const glance = jobWidgetGlance({ ...view, blocks: [] });
	const rows = [
		headRow(stage ? `${title}${GAP}${theme.fg("muted", stage)}` : title, glance && glanceText(theme, glance), w),
	];
	for (const block of view.blocks) rows.push(...blockRows(theme, block, w, labels));
	return rows.map(row => truncate(row, w));
}

/** How a wait card draws a tile's head. */
export interface JobTileRowOptions {
	/** Opens the head line: the caller's status icon and type badge. */
	readonly lead: string;
	/** Closes the head line at the right, after the figure (the duration). */
	readonly meta: string;
	/** Every block rather than the primary one (an expanded card). */
	readonly full?: boolean;
}

/**
 * A tile as rows within `width` (capped at 80): the lead, name and id with
 * the figure and meta flush right, then a live widget's primary block (every
 * block when `full`), stats and text lines, and the stage.
 */
export function jobTileRows(theme: Theme, tile: JobTile, width: number, options: JobTileRowOptions): string[] {
	const w = Math.min(Math.max(0, Math.floor(width)), MAX_WIDTH);
	if (w === 0) return [];
	const view = tile.widget?.state === "live" ? tile.widget : undefined;
	const glance = view ? jobWidgetGlance(view) : undefined;
	const title = tileTitle(tile);
	const id = plainLine(tile.id);
	const left = `${options.lead}${theme.style("strong", title)}${id === title ? "" : ` ${theme.fg("dim", id)}`}`;
	const right = [glance && glanceText(theme, glance), options.meta].filter(Boolean).join(GAP);
	const rows = [headRow(left, right, w)];
	const shown = (options.full ? view?.blocks : view?.blocks.slice(0, 1)) ?? [];
	const blocks = shown.filter(block => block.kind !== "stat" && block.kind !== "text");
	const labels = labelWidth(blocks, w);
	for (const block of blocks) rows.push(...blockRows(theme, block, w, labels));
	const stage = plainLine(tile.widget?.stage ?? tile.stage ?? "");
	for (const block of view?.blocks ?? [])
		if (block.kind === "stat" || (block.kind === "text" && plainLine(block.text) !== stage))
			rows.push(...blockRows(theme, block, w, 0));
	if (stage) rows.push(`${INDENT}${theme.fg("muted", stage)}`);
	return rows.map(row => truncate(row, w));
}
