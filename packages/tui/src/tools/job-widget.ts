/**
 * Live widgets for background jobs: the rendered state of what a job is
 * doing (a benchmark's requests/s over time, tests passed per model, CI jobs
 * green so far), shown in the `wait` card, the HUD's jobs pill and the jobs
 * sheet.
 *
 * A widget is data, not code. In coding-agent, a cheap model writes a
 * `JobWidgetSpec` once per job (rules that pull numbers out of the job's
 * output streams, and the blocks to draw them with); the job-widgets runtime
 * then applies those rules to every new line and recomputes a
 * {@link JobWidgetView}. Renderers here draw that view as TSP nodes (Tern) or
 * ANSI lines, and never see a rule or a regex.
 */

import type { TspChartMark, TspChartProps, TspPropNode, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { renderProgressBar } from "../components/progress-bar";
import { fitSparkValues, renderSparkline } from "../components/sparkline";
import { col, compact, elapsed, keyed, node, propNode, row, span, stableKey, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { plainLine } from "../native/spans";
import { toneColor } from "../native/tone";
import type { Theme } from "../theme/theme";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";

/** Where a widget's view stands. */
export type JobWidgetState =
	/** The cheap model is writing the spec; the view holds the model-free fallback meanwhile. */
	| "authoring"
	/** The spec's rules drive the view. */
	| "live"
	/** No spec (no model, authoring failed, nothing to read yet): last line and rates only. */
	| "fallback";

/** A formatted number with the direction it moved, for headlines and stats. */
export interface JobWidgetTrend {
	/** `▲ 15%`, `▼ 3.2 ms`. */
	text: string;
	/** `success` when the move is toward `better`, `error` away from it, `muted` without a direction. */
	tone: "success" | "error" | "muted";
}

/** The headline value: the one number a glance should take away (`186 tok/s`). */
export interface JobWidgetHeadline {
	/** Formatted value with its unit. */
	text: string;
	/** What the value is, when the title does not already say it (`decode`, `p50`). */
	label?: string;
	trend?: JobWidgetTrend;
}

/** A time series drawn as columns, newest right, with optional reference lines. */
export interface JobWidgetSparkBlock {
	kind: "spark";
	/** What the series measures (`tok/s · nvfp4 b1`). */
	label: string;
	/** At most 48 values, oldest first, already downsampled. */
	values: number[];
	/** Domain of the chart; covers the values and every mark. */
	min: number;
	max: number;
	/** Horizontal reference lines in value units (a target, a baseline). */
	marks?: { value: number; label: string; tone?: TspTone }[];
	/** Latest value, formatted (`186 tok/s`). */
	last: string;
	/** Per-point tooltip text, same length as `values` (`12:04:31 · 186 tok/s`). */
	tips?: string[];
	tone?: TspTone;
}

/** One bar per key (a model, a shard): a value against a common maximum. */
export interface JobWidgetBarsBlock {
	kind: "bars";
	label: string;
	items: { label: string; value: number; text: string; tone?: TspTone }[];
	/** The value a full bar stands for. */
	max: number;
}

/** Progress of a countable whole (`7/9 trials`). */
export interface JobWidgetMeterBlock {
	kind: "meter";
	label: string;
	/** 0–1. */
	value: number;
	/** `7/9 trials`. */
	text: string;
	tone?: TspTone;
}

/** A few labelled numbers on one line (`p50 41 ms · p99 212 ms · errors 0`). */
export interface JobWidgetStatBlock {
	kind: "stat";
	items: {
		label: string;
		text: string;
		tone?: TspTone;
		trend?: JobWidgetTrend;
	}[];
}

/** One cell per key with its latest state (CI jobs, shards, workers). */
export interface JobWidgetGridBlock {
	kind: "grid";
	label: string;
	items: { label: string; text: string; tone: TspTone }[];
}

/** The latest line a rule captured (the test now running, the current phase). */
export interface JobWidgetTextBlock {
	kind: "text";
	text: string;
}

export type JobWidgetBlock =
	| JobWidgetSparkBlock
	| JobWidgetBarsBlock
	| JobWidgetMeterBlock
	| JobWidgetStatBlock
	| JobWidgetGridBlock
	| JobWidgetTextBlock;

/**
 * Everything a renderer needs to draw one job's widget. Plain JSON: it rides
 * on `JobSnapshot.widget` through `wait` progress updates and is persisted
 * with the final `wait` result, so a sealed card redraws the last state after
 * a session reload.
 */
export interface JobWidgetView {
	/** Short name of what is being watched (`verb-bench · 3 models`). */
	title: string;
	headline?: JobWidgetHeadline;
	/** What the job is doing now: a subagent's stage, or the last line of output. */
	stage?: string;
	/** Top to bottom; the first block is the primary one, and compact views show only it. */
	blocks: JobWidgetBlock[];
	state: JobWidgetState;
	/** Epoch ms of the newest data the view reflects. */
	updatedAt: number;
}

// =============================================================================
// Glances: the HUD pill, the status line, tooltips
// =============================================================================

/** A running job's widget, as the HUD and the status line list them. */
export interface JobWidgetEntry {
	id: string;
	type: JobTileType;
	view: JobWidgetView;
}

/** What a glance at a widget reads: its headline, else the primary figure of its blocks. */
export interface JobWidgetGlance {
	text: string;
	label?: string;
	trend?: JobWidgetTrend;
}

/** Values the HUD's mini chart keeps from the primary spark. */
const MINI_SPARK_POINTS = 16;
/** Tiles the HUD hover card shows (two rows of two) before it counts the rest. */
const HOVERCARD_JOBS = 4;
/** Keys a tile's bars block lists before it counts the rest. */
const TILE_BARS = 3;
/** Cells of a stage shown as a tile's body: two or three lines of a tile. */
const TILE_LEAD_CELLS = 120;
/** ANSI widgets stop growing here so wide terminals keep bars and labels together. */
const ANSI_MAX_WIDTH = 80;
const ANSI_LABEL_MIN = 4;
const ANSI_LABEL_MAX = 16;
const ANSI_BAR_MAX = 32;
/** Sparkline cells below which the mark labels give way to the series. */
const ANSI_SPARK_MIN = 12;
/** Lines a grid's labelled cells may wrap onto before it falls back to bare cells. */
const GRID_LINES = 3;
const INDENT = "  ";
const GAP = "  ";
const DEFAULT_TONE: TspTone = "accent";

/** The view's headline as a glance; undefined without one. */
function headlineGlance(view: JobWidgetView): JobWidgetGlance | undefined {
	const headline = view.headline;
	const value = headline ? plainLine(headline.text) : "";
	if (!headline || !value) return undefined;
	const label = headline.label ? plainLine(headline.label) : "";
	return {
		text: value,
		...(label ? { label } : {}),
		...(headline.trend ? { trend: headline.trend } : {}),
	};
}

/** What one glance at the widget reads: the headline, else the latest figure of its first spark or meter. */
export function jobWidgetGlance(view: JobWidgetView): JobWidgetGlance | undefined {
	const headline = headlineGlance(view);
	if (headline) return headline;
	for (const block of view.blocks) {
		if (block.kind === "spark" && block.values.length > 0 && plainLine(block.last)) {
			return { text: plainLine(block.last), label: plainLine(block.label) };
		}
		if (block.kind === "meter" && plainLine(block.text))
			return { text: plainLine(block.text), label: plainLine(block.label) };
	}
	return undefined;
}

/** The widget's first spark cut to its newest `points` values (the HUD's mini chart); undefined without data. */
export function jobWidgetSpark(view: JobWidgetView, points = MINI_SPARK_POINTS): JobWidgetSparkBlock | undefined {
	const spark = view.blocks.find((block): block is JobWidgetSparkBlock => block.kind === "spark");
	if (!spark || spark.values.length === 0) return undefined;
	if (spark.values.length <= points) return spark;
	const from = spark.values.length - points;
	return {
		...spark,
		values: spark.values.slice(from),
		...(spark.tips ? { tips: spark.tips.slice(from) } : {}),
	};
}

/** The entry whose live widget (one a spec drives) saw data last. */
export function latestJobWidget<T extends JobWidgetEntry>(entries: readonly T[]): T | undefined {
	let latest: T | undefined;
	for (const entry of entries) {
		if (entry.view.state !== "live") continue;
		if (!latest || entry.view.updatedAt > latest.view.updatedAt) latest = entry;
	}
	return latest;
}

/** The widget as one plain line for tooltips: `verb-bench · 3 models — decode 186 tok/s ▲ 15%`. */
export function jobWidgetSummary(view: JobWidgetView): string {
	const glance = jobWidgetGlance(view);
	const title = plainLine(view.title);
	if (!glance) return title;
	const figure = [glance.label, glance.text, glance.trend && plainLine(glance.trend.text)].filter(Boolean).join(" ");
	return title ? `${title} — ${figure}` : figure;
}

/** Spans of a glance: muted label, strong number, toned trend. */
export function jobWidgetGlanceSpans(glance: JobWidgetGlance): TspSpan[] {
	return compact([
		glance.label ? span(`${glance.label} `, "muted") : undefined,
		span(glance.text, "num strong"),
		glance.trend && span(` ${plainLine(glance.trend.text)}`, toneColor(glance.trend.tone)),
	]);
}

/**
 * A glance for the ANSI status line: the figure with its trend, then a
 * `cells`-wide sparkline of the primary spark when there is one.
 */
export function formatJobWidgetGlance(view: JobWidgetView, theme: Theme, cells = 8): string {
	const glance = jobWidgetGlance(view);
	const parts: string[] = [];
	if (glance) {
		parts.push(
			glance.trend
				? `${theme.bold(glance.text)} ${theme.fg(toneColor(glance.trend.tone), plainLine(glance.trend.text))}`
				: theme.bold(glance.text),
		);
	}
	const spark = jobWidgetSpark(view, cells);
	if (spark && cells > 0) parts.push(ansiSpark(spark, spark.values, theme));
	return parts.join(" ");
}

// =============================================================================
// Native (TSP)
// =============================================================================

/**
 * A job's whole widget as a TSP subtree (role `omp.job.widget`), as the jobs
 * sheet details it: a head row (title, stage, headline) over every block.
 */
export function describeJobWidget(view: JobWidgetView): NativeNode {
	return col(
		[describeHead(view), ...view.blocks.map((block, index) => keyed(describeBlock(block), `${index}-${block.kind}`))],
		{ role: "omp.job.widget", gap: "xs" },
	);
}

/**
 * The HUD jobs pill's hover card: up to four running jobs as tiles, then a
 * count of the rest; undefined without widgets. Its tiles carry no clock:
 * Tern draws the card only once hovered, and a clock drawn then would start
 * from the last time the program wrote.
 */
export function describeJobWidgetsHovercard(entries: readonly JobWidgetEntry[]): TspPropNode | undefined {
	if (entries.length === 0) return undefined;
	const shown = entries.slice(0, HOVERCARD_JOBS);
	const tiles = shown.map((entry): JobTile => ({
		id: entry.id,
		type: entry.type,
		status: "running",
		label: entry.id,
		live: true,
		widget: entry.view,
	}));
	const children = [describeJobTiles(tiles)];
	const rest = entries.length - shown.length;
	if (rest > 0) {
		children.push(
			text([span(`+${rest} more ${rest === 1 ? "job" : "jobs"} · /jobs`, "dim")], {
				role: "omp.jobs.hovercard.more",
				wrap: "none",
			}),
		);
	}
	return propNode(col(children, { role: "omp.jobs.hovercard", gap: "md" }));
}

/** The HUD's mini chart: the newest values of the widget's first spark; undefined without one. */
export function describeJobWidgetMiniSpark(view: JobWidgetView): NativeNode | undefined {
	const spark = jobWidgetSpark(view);
	if (!spark) return undefined;
	return node("chart", {
		role: "omp.hud.spark",
		kind: "spark",
		size: "sm",
		series: spark.values.map(value => ({ value })),
		min: spark.min,
		max: spark.max,
		token: toneColor(spark.tone ?? DEFAULT_TONE),
		summary: `${plainLine(spark.label)} ${plainLine(spark.last)}`,
	});
}

// =============================================================================
// Tiles: the wait card, the HUD hover card
// =============================================================================

/** Where a tiled job stands. */
export type JobTileStatus = "running" | "completed" | "failed" | "cancelled";

/** What kind of job a tile shows: a subagent (`task`) goes by its name, any other job by what it runs. */
export type JobTileType = "bash" | "task" | "eval";

/** One job as a tile draws it: who it is, how long it has run, and its widget when it has one. */
export interface JobTile {
	id: string;
	type: JobTileType;
	status: JobTileStatus;
	/** The job's label (a command): the title of a job that is no subagent, before a widget names it. */
	label: string;
	/** How long the job has run; a tile without it shows no clock. */
	durationMs?: number;
	/** Whether the job is live (its dot pulses, its clock runs); settled and sealed tiles freeze. */
	live: boolean;
	/** The job's widget; only a live one (a spec drives it) draws figures and charts, any lends its stage. */
	widget?: JobWidgetView;
	/** A task's own completion estimate (0–100), drawn as a ring. */
	completionPercent?: number;
	/** What the job is doing now, when its widget names nothing: a task's stage in its own words. */
	stage?: string;
	exitCode?: number;
}

const TILE_GLYPH: Record<JobTileStatus, string> = {
	running: "●",
	completed: "✓",
	failed: "✕",
	cancelled: "■",
};
const TILE_TONE: Record<JobTileStatus, TspTone> = {
	running: "accent",
	completed: "success",
	failed: "error",
	cancelled: "warning",
};
/** A figure's leading number and the unit after it: `1.10k req/s`, `7/9 trials`, `68%`. */
const FIGURE_NUMBER = /^([-+]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)[kKMGT]?%?)(?:\s+|(?=\/)|$)(.*)$/;

/**
 * Jobs as one frame of equal tiles (role `omp.job.tiles`) that wraps onto
 * more rows when the frame runs out of width.
 */
export function describeJobTiles(tiles: readonly JobTile[]): NativeNode {
	return row(
		tiles.map(tile => keyed(describeJobTile(tile), stableKey(tile.id))),
		{ role: "omp.job.tiles", gap: "none", wrap: true },
	);
}

/**
 * One job as a tile (role `omp.job.tile`): a head line (status, name, id,
 * a task's own completion estimate as a ring, clock), then what a live
 * widget shows (the figure a glance takes away, its primary block, quiet
 * lines of stats) and the stage. With nothing to chart, the stage is the
 * tile's body.
 */
export function describeJobTile(tile: JobTile): NativeNode {
	const view = tile.widget?.state === "live" ? tile.widget : undefined;
	const glance = view ? jobWidgetGlance(view) : undefined;
	const title = tileTitle(tile);
	const id = plainLine(tile.id);
	const pulse = tile.live && tile.status === "running";
	const clock = tile.durationMs === undefined ? undefined : elapsed(tile.durationMs, !tile.live);
	const percent = tile.completionPercent === undefined ? undefined : Math.round(tile.completionPercent);
	const figure =
		glance &&
		text(figureSpans(glance), {
			role: "omp.job.tile.figure",
			wrap: "none",
			truncate: "end",
		});
	const head = row(
		compact([
			text([span(TILE_GLYPH[tile.status], toneColor(TILE_TONE[tile.status]), pulse ? { fx: "pulse" } : undefined)], {
				role: "omp.job.tile.dot",
				wrap: "none",
			}),
			text([span(title)], {
				role: "omp.job.tile.title",
				wrap: "none",
				truncate: "end",
				grow: 1,
			}),
			id === title
				? undefined
				: text([span(id, "dim")], {
						role: "omp.job.tile.id",
						wrap: "none",
					}),
			// Tern tints the ring by its value and shows the label on hover.
			percent === undefined
				? undefined
				: keyed(
						node("meter", {
							role: "omp.job.tile.ring",
							style: "ring",
							size: "sm",
							value: fraction(percent, 100),
							label: `${percent}%`,
							title: `The agent's own completion estimate: ${percent}%`,
						}),
						"ring",
					),
			clock && keyed(clock, "clock"),
		]),
		{ role: "omp.job.tile.head", gap: "xs", align: "center" },
	);
	const visual = tileVisual(view?.blocks[0]);
	return col(
		compact([
			keyed(head, "head"),
			figure && keyed(figure, "figure"),
			visual && keyed(visual, "visual"),
			...tileNotes(tile, view, !figure && !visual),
		]),
		{
			role: "omp.job.tile",
			tone: TILE_TONE[tile.status],
			gap: "xs",
		},
	);
}

/** A subagent's name; any other job's widget title, else its label's first line, else its id. */
function tileTitle(tile: JobTile): string {
	if (tile.type === "task") return plainLine(tile.id);
	return plainLine(tile.widget?.title ?? "") || plainLine(tile.label.split(/\r?\n/, 1)[0] ?? "") || plainLine(tile.id);
}

/**
 * `p50 41 ms ▲ 8%`: the number in full between its quiet label and unit, then the toned
 * trend; a label the unit already states (`tok/s 162 tok/s`) is dropped.
 */
function figureSpans(glance: JobWidgetGlance): TspSpan[] {
	const match = FIGURE_NUMBER.exec(glance.text);
	const value = match?.[1] ?? glance.text;
	const unit = (match?.[2] ?? "").replace(/^\/\s*/, "/ ");
	const label = glance.label && !unit.toLowerCase().includes(glance.label.toLowerCase()) ? glance.label : "";
	return compact([
		label ? span(`${label} `, "dim") : undefined,
		span(value),
		unit ? span(` ${unit}`, "dim") : undefined,
		glance.trend && span(` ${plainLine(glance.trend.text)}`, toneColor(glance.trend.tone)),
	]);
}

/** A tile's picture of its primary block; stats and text read as notes instead. */
function tileVisual(block: JobWidgetBlock | undefined): NativeNode | undefined {
	switch (block?.kind) {
		case "spark":
			if (block.values.length === 0) return undefined;
			return node("chart", {
				...sparkChartProps(block),
				role: "omp.job.tile.chart",
				size: "sm",
			});
		case "meter":
			return tileMeter(block.value, block.tone);
		case "bars": {
			const rows = block.items.slice(0, TILE_BARS).map((item, index) =>
				keyed(
					row(
						[
							text([span(plainLine(item.label), "dim")], {
								role: "omp.job.tile.key",
								wrap: "none",
								truncate: "end",
							}),
							tileMeter(fraction(item.value, block.max), item.tone),
							text([span(plainLine(item.text))], {
								role: "omp.job.tile.num",
								wrap: "none",
							}),
						],
						{ role: "omp.job.tile.bar", gap: "sm", align: "center" },
					),
					`${index}`,
				),
			);
			const rest = block.items.length - rows.length;
			if (rest > 0)
				rows.push(
					text([span(`+${rest} more`, "dim")], {
						role: "omp.job.tile.more",
						wrap: "none",
					}),
				);
			return rows.length > 0 ? col(rows, { role: "omp.job.tile.bars", gap: "xs" }) : undefined;
		}
		case "grid": {
			if (block.items.length === 0) return undefined;
			// No-break spaces inside a cell: lines wrap between cells only.
			const spans: TspSpan[] = [];
			for (const item of block.items) {
				if (spans.length > 0) spans.push(span("   "));
				spans.push(
					span("●\u00a0", toneColor(item.tone)),
					span(plainLine(item.label).replaceAll(" ", "\u00a0"), "dim"),
				);
			}
			return text(spans, { role: "omp.job.tile.grid", wrap: "word" });
		}
		default:
			return undefined;
	}
}

function tileMeter(value: number, tone: TspTone = DEFAULT_TONE): NativeNode {
	return node("meter", {
		role: "omp.job.tile.meter",
		value: fraction(value, 1),
		size: "sm",
		tone,
		grow: 1,
	});
}

/**
 * The live widget's stats and text lines (one that repeats the stage is
 * left out), and the stage with a failed exit code ahead of it: a quiet
 * last line, or the tile's body (`lead`, first and up to two lines) when
 * the tile has nothing to chart.
 */
function tileNotes(tile: JobTile, view: JobWidgetView | undefined, lead: boolean): NativeNode[] {
	// The widget's stage is newer than the job's report (a rule reads it live) or the same report.
	const stage = plainLine(tile.widget?.stage ?? tile.stage ?? "");
	const failed = tile.exitCode !== undefined && tile.exitCode !== 0 ? `exit ${tile.exitCode}` : "";
	const notes: NativeNode[] = [];
	for (const block of view?.blocks ?? []) {
		if (block.kind === "stat" && block.items.length > 0) {
			notes.push(
				text(statSpans(block), {
					role: "omp.job.tile.stats",
					wrap: "none",
					truncate: "end",
				}),
			);
		} else if (block.kind === "text" && plainLine(block.text) && plainLine(block.text) !== stage) {
			notes.push(
				text([span(plainLine(block.text), "dim")], {
					role: "omp.job.tile.note",
					wrap: "none",
					truncate: "end",
				}),
			);
		}
	}
	if (stage || failed) {
		const spans = compact([
			failed ? span(failed, "error") : undefined,
			failed && stage ? span(" · ", "dim") : undefined,
			stage
				? lead
					? span(truncateToWidth(stage, TILE_LEAD_CELLS, Ellipsis.Unicode))
					: span(stage, "dim")
				: undefined,
		]);
		if (lead) notes.unshift(text(spans, { role: "omp.job.tile.lead", wrap: "word" }));
		else notes.push(text(spans, { role: "omp.job.tile.stage", wrap: "none", truncate: "end" }));
	}
	return notes.map((note, index) => keyed(note, `note-${index}`));
}

function describeHead(view: JobWidgetView): NativeNode {
	const stage = view.stage ? plainLine(view.stage) : "";
	const headline = headlineGlance(view);
	return row(
		compact([
			text([span(plainLine(view.title), "strong")], {
				role: "omp.job.widget.title",
				wrap: "none",
				truncate: "end",
				...(stage ? {} : { grow: 1 }),
			}),
			stage
				? text([span(stage, "muted")], {
						role: "omp.job.widget.stage",
						wrap: "none",
						truncate: "end",
						grow: 1,
					})
				: undefined,
			headline &&
				text(jobWidgetGlanceSpans(headline), {
					role: "omp.job.widget.headline",
					wrap: "none",
				}),
		]),
		{ role: "omp.job.widget.head", gap: "sm", align: "baseline" },
	);
}

function describeBlock(block: JobWidgetBlock): NativeNode {
	switch (block.kind) {
		case "spark":
			return describeSpark(block);
		case "bars":
			return describeBars(block);
		case "meter":
			return labelled(
				block.label,
				node("meter", {
					value: fraction(block.value, 1),
					label: plainLine(block.text),
					size: "sm",
					grow: 1,
					...(block.tone ? { tone: block.tone } : {}),
				}),
				"omp.job.widget.meter",
			);
		case "stat":
			return text(statSpans(block), {
				role: "omp.job.widget.stat",
				wrap: "none",
				truncate: "end",
			});
		case "grid":
			return col(
				[
					text([span(plainLine(block.label), "dim")], {
						role: "omp.job.widget.caption",
						wrap: "none",
						truncate: "end",
					}),
					block.items.length > 0
						? row(
								block.items.map((item, index) =>
									node(
										"badge",
										{
											text: plainLine(item.label),
											tone: item.tone,
											title: plainLine(item.text),
										},
										undefined,
										`${index}`,
									),
								),
								{ role: "omp.job.widget.cells", gap: "xs", wrap: true },
							)
						: waiting(),
				],
				{ role: "omp.job.widget.grid", gap: "xs" },
			);
		case "text":
			return text([span(plainLine(block.text), "muted")], {
				role: "omp.job.widget.text",
				wrap: "none",
				truncate: "end",
			});
	}
}

/** A column chart with dashed reference lines, the latest value and the mark labels at its side. */
function describeSpark(block: JobWidgetSparkBlock): NativeNode {
	if (block.values.length === 0) return labelled(block.label, waiting(), "omp.job.widget.spark");
	const marks = block.marks ?? [];
	const label = plainLine(block.label);
	const last = plainLine(block.last);
	return row(
		[
			node("chart", { ...sparkChartProps(block), size: "md", grow: 1 }, undefined, "chart"),
			keyed(
				col(
					compact([
						text([span(last, "num strong")], { wrap: "none" }),
						label && !last.endsWith(label)
							? text([span(label, "muted")], { wrap: "none", truncate: "end" })
							: undefined,
						...marks.map(mark =>
							text([span("┄ ", toneColor(mark.tone ?? "muted")), span(plainLine(mark.label), "dim")], {
								wrap: "none",
								truncate: "end",
							}),
						),
					]),
					{ role: "omp.job.widget.side", gap: "none" },
				),
				"side",
			),
		],
		{ role: "omp.job.widget.spark", gap: "sm", align: "center" },
	);
}

/** A spark as chart props: columns over the block's domain, its toned reference lines and per-point tooltips. */
function sparkChartProps(block: JobWidgetSparkBlock): TspChartProps {
	const series = block.values.map((value, index) => {
		const tip = block.tips?.[index];
		return tip ? { value, title: plainLine(tip) } : { value };
	});
	const marks = (block.marks ?? []).map((mark): TspChartMark => {
		const title = plainLine(mark.label);
		return {
			value: mark.value,
			...(mark.tone ? { tone: mark.tone } : {}),
			...(title ? { title } : {}),
		};
	});
	return {
		kind: "bars",
		series,
		min: block.min,
		max: block.max,
		...(marks.length > 0 ? { marks } : {}),
		token: toneColor(block.tone ?? DEFAULT_TONE),
		summary: `${plainLine(block.label)} ${plainLine(block.last)}`,
	};
}

/** One meter row per key under the block's caption. */
function describeBars(block: JobWidgetBarsBlock): NativeNode {
	const rows: NativeNode[] = block.items.map((item, index) =>
		keyed(
			labelled(
				item.label,
				node("meter", {
					value: fraction(item.value, block.max),
					label: plainLine(item.text),
					size: "sm",
					grow: 1,
					...(item.tone ? { tone: item.tone } : {}),
				}),
				"omp.job.widget.bar",
			),
			`${index}`,
		),
	);
	const caption = text([span(plainLine(block.label), "dim")], {
		role: "omp.job.widget.caption",
		wrap: "none",
		truncate: "end",
	});
	return col([caption, ...(rows.length > 0 ? rows : [waiting()])], {
		role: "omp.job.widget.bars",
		gap: "xs",
	});
}

/** A label column (≈12 cells, muted) before `content`. */
function labelled(label: string, content: NativeNode, role: string): NativeNode {
	return row(
		[
			text([span(plainLine(label), "muted")], {
				wrap: "none",
				truncate: "end",
				min: { w: "12ch" },
				max: { w: "12ch" },
			}),
			content,
		],
		{ role, gap: "sm", align: "center" },
	);
}

function waiting(): NativeNode {
	return text([span("waiting for data", "dim")], { wrap: "none" });
}

/** `p50 41 ms ▼ 12% · errors 0`: dim labels, values in their tone, toned trends. */
function statSpans(block: JobWidgetStatBlock): TspSpan[] {
	const spans: TspSpan[] = [];
	for (const [index, item] of block.items.entries()) {
		if (index > 0) spans.push(span(" · ", "dim"));
		spans.push(span(`${plainLine(item.label)} `, "dim"));
		spans.push(item.tone ? span(plainLine(item.text), toneColor(item.tone)) : span(plainLine(item.text)));
		if (item.trend) spans.push(span(` ${plainLine(item.trend.text)}`, toneColor(item.trend.tone)));
	}
	return spans;
}

/** `value / max` clamped to 0–1 (0 for an empty or broken scale). */
function fraction(value: number, max: number): number {
	if (!(max > 0) || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value / max));
}

// =============================================================================
// ANSI
// =============================================================================

/**
 * A job's whole widget as terminal lines, each within `width` (capped at 80
 * so bars stay next to their labels): the head line (title, stage, headline
 * at the right), then every block under a shared label column.
 */
export function renderJobWidgetLines(view: JobWidgetView, width: number, theme: Theme): string[] {
	const w = Math.min(Math.max(0, Math.floor(width)), ANSI_MAX_WIDTH);
	if (w === 0) return [];
	const labelWidth = ansiLabelWidth(view.blocks, w);
	const stage = view.stage ? plainLine(view.stage) : "";
	const title = theme.bold(plainLine(view.title));
	const headline = headlineGlance(view);
	const lines = [
		ansiHeadRow(
			stage ? `${title}${GAP}${theme.fg("muted", stage)}` : title,
			headline && ansiGlance(headline, theme),
			w,
		),
	];
	for (const block of view.blocks) lines.push(...renderBlock(block, w, labelWidth, theme));
	return lines.map(line => truncateToWidth(line, w, Ellipsis.Unicode));
}

/** How the ANSI wait card draws a tile. */
export interface JobTileLineOptions {
	/** Opens the title line: the caller's status icon and type badge. */
	lead: string;
	/** Closes the title line at the right, after the figure: the duration. */
	meta: string;
	/** Every block rather than the primary one alone (an expanded card). */
	full?: boolean;
}

/**
 * A tile as terminal lines within `width`: the lead, name and id with the
 * figure and meta at the right, then a live widget's primary block (every
 * block when `full`) and dim lines of stats and stage, capped at 80 cells.
 */
export function renderJobTileLines(tile: JobTile, width: number, theme: Theme, options: JobTileLineOptions): string[] {
	const w = Math.min(Math.max(0, Math.floor(width)), ANSI_MAX_WIDTH);
	if (w === 0) return [];
	const view = tile.widget?.state === "live" ? tile.widget : undefined;
	const glance = view ? jobWidgetGlance(view) : undefined;
	const title = tileTitle(tile);
	const id = plainLine(tile.id);
	const left = `${options.lead}${theme.bold(title)}${id === title ? "" : ` ${theme.fg("dim", id)}`}`;
	const right = [glance && ansiGlance(glance, theme), options.meta].filter(Boolean).join(GAP);
	const lines = [ansiHeadRow(left, right, w)];
	const shown = (options.full ? view?.blocks : view?.blocks.slice(0, 1)) ?? [];
	const blocks = shown.filter(block => block.kind !== "stat" && block.kind !== "text");
	const labelWidth = ansiLabelWidth(blocks, w);
	for (const block of blocks) lines.push(...renderBlock(block, w, labelWidth, theme));
	const stage = plainLine(tile.widget?.stage ?? tile.stage ?? "");
	for (const block of view?.blocks ?? []) {
		if (block.kind === "stat" || (block.kind === "text" && plainLine(block.text) !== stage)) {
			lines.push(...renderBlock(block, w, 0, theme));
		}
	}
	if (stage) lines.push(`${INDENT}${theme.fg("muted", stage)}`);
	return lines.map(line => truncateToWidth(line, w, Ellipsis.Unicode));
}

/** One label column for every block: the widest label, within 4–16 cells and a third of the width. */
function ansiLabelWidth(blocks: readonly JobWidgetBlock[], width: number): number {
	let widest = 0;
	const measure = (label: string): void => {
		widest = Math.max(widest, visibleWidth(plainLine(label)));
	};
	for (const block of blocks) {
		if (block.kind === "spark" || block.kind === "meter" || block.kind === "grid") measure(block.label);
		else if (block.kind === "bars") for (const item of block.items) measure(item.label);
	}
	if (widest === 0) return 0;
	const cap = Math.min(ANSI_LABEL_MAX, Math.floor((width - INDENT.length) / 3));
	return Math.max(0, Math.min(Math.max(widest, ANSI_LABEL_MIN), cap));
}

/** `left` cut to fit with `right` flush at the right edge; `right` gives way when `left` would keep under 8 cells. */
function ansiHeadRow(left: string, right: string | undefined, width: number): string {
	if (!right) return truncateToWidth(left, width, Ellipsis.Unicode);
	const room = width - visibleWidth(right) - GAP.length;
	if (room < Math.min(visibleWidth(left), 8)) return truncateToWidth(left, width, Ellipsis.Unicode);
	const head = truncateToWidth(left, room, Ellipsis.Unicode);
	return `${head}${" ".repeat(Math.max(GAP.length, width - visibleWidth(head) - visibleWidth(right)))}${right}`;
}

function ansiGlance(glance: JobWidgetGlance, theme: Theme): string {
	let out = theme.bold(glance.text);
	if (glance.label) out = `${theme.fg("muted", glance.label)} ${out}`;
	if (glance.trend) out += ` ${theme.fg(toneColor(glance.trend.tone), plainLine(glance.trend.text))}`;
	return out;
}

/** The indent and the padded label column that open a block row. */
function ansiLead(label: string, labelWidth: number, theme: Theme): string {
	if (labelWidth === 0) return INDENT;
	return `${INDENT}${theme.fg("muted", truncateToWidth(plainLine(label), labelWidth, Ellipsis.Unicode, true))}${GAP}`;
}

function renderBlock(block: JobWidgetBlock, width: number, labelWidth: number, theme: Theme): string[] {
	switch (block.kind) {
		case "spark":
			return [renderSpark(block, width, labelWidth, theme)];
		case "bars": {
			const lines = [`${INDENT}${theme.fg("dim", plainLine(block.label))}`];
			if (block.items.length === 0) lines.push(`${INDENT}${theme.fg("dim", "waiting for data")}`);
			const texts = block.items.map(item => plainLine(item.text));
			const textWidth = Math.max(0, ...texts.map(value => visibleWidth(value)));
			for (const [index, item] of block.items.entries()) {
				const lead = ansiLead(item.label, labelWidth, theme);
				const value = texts[index]!;
				const bar = ansiBar(
					fraction(item.value, block.max),
					width - visibleWidth(lead) - GAP.length - textWidth,
					item.tone,
					theme,
				);
				lines.push(`${lead}${bar}${GAP}${" ".repeat(textWidth - visibleWidth(value))}${value}`);
			}
			return lines;
		}
		case "meter": {
			const lead = ansiLead(block.label, labelWidth, theme);
			const value = plainLine(block.text);
			const bar = ansiBar(
				fraction(block.value, 1),
				width - visibleWidth(lead) - GAP.length - visibleWidth(value),
				block.tone,
				theme,
			);
			return [`${lead}${bar}${GAP}${theme.bold(value)}`];
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
			return renderGrid(block, width, labelWidth, theme);
		case "text":
			return [`${INDENT}${theme.fg("dim", plainLine(block.text))}`];
	}
}

/** Sparkline, latest value, then `┄ target` labels while the series keeps enough cells. */
function renderSpark(block: JobWidgetSparkBlock, width: number, labelWidth: number, theme: Theme): string {
	const lead = ansiLead(block.label, labelWidth, theme);
	if (block.values.length === 0) return `${lead}${theme.fg("dim", "waiting for data")}`;
	const last = theme.bold(plainLine(block.last));
	const marks = (block.marks ?? []).map(
		mark => `${theme.fg(toneColor(mark.tone ?? "muted"), "┄")} ${theme.fg("dim", plainLine(mark.label))}`,
	);
	const room = width - visibleWidth(lead) - GAP.length;
	let tail = [last, ...marks].join(GAP);
	if (marks.length > 0 && room - visibleWidth(tail) < Math.min(ANSI_SPARK_MIN, block.values.length)) tail = last;
	const cells = Math.max(1, room - visibleWidth(tail));
	return `${lead}${ansiSpark(block, fitSparkValues(block.values, cells), theme)}${GAP}${tail}`;
}

function ansiSpark(block: JobWidgetSparkBlock, values: readonly number[], theme: Theme): string {
	const color = toneColor(block.tone ?? DEFAULT_TONE);
	return renderSparkline(values, {
		min: block.min,
		max: block.max,
		style: glyph => theme.fg(color, glyph),
	});
}

/** A `█…░` bar `room` cells wide at most (capped at 32), filled in the item's tone. */
function ansiBar(value: number, room: number, tone: TspTone | undefined, theme: Theme): string {
	const color = toneColor(tone ?? DEFAULT_TONE);
	return renderProgressBar(value, Math.max(0, Math.min(ANSI_BAR_MAX, room)), {
		style: {
			filled: "█",
			empty: "░",
			styleFilled: cells => theme.fg(color, cells),
			styleEmpty: cells => theme.fg("dim", cells),
		},
	});
}

/**
 * Tone-coloured cells: `● label` cells wrapped under the label column while
 * they fit in three lines, else one line of bare `●`/`◌` cells.
 */
function renderGrid(block: JobWidgetGridBlock, width: number, labelWidth: number, theme: Theme): string[] {
	const lead = ansiLead(block.label, labelWidth, theme);
	if (block.items.length === 0) return [`${lead}${theme.fg("dim", "waiting for data")}`];
	const leadWidth = visibleWidth(lead);
	const room = width - leadWidth;
	// Pending, muted and neutral cells are still in progress (a hollow dot); every other tone is a settled state.
	const glyph = (tone: TspTone): string =>
		theme.fg(toneColor(tone), tone === "pending" || tone === "muted" || tone === "neutral" ? "◌" : "●");
	const rows: string[][] = [[]];
	let used = 0;
	for (const item of block.items) {
		const name = plainLine(item.label);
		const cellWidth = 2 + visibleWidth(name);
		const current = rows[rows.length - 1]!;
		const needed = current.length === 0 ? cellWidth : used + GAP.length + cellWidth;
		if (current.length > 0 && needed > room) {
			rows.push([]);
			used = cellWidth;
		} else {
			used = needed;
		}
		rows[rows.length - 1]!.push(`${glyph(item.tone)} ${theme.fg("toolOutput", name)}`);
	}
	if (rows.length <= GRID_LINES && rows.every(cells => visibleWidth(cells.join(GAP)) <= room)) {
		const pad = " ".repeat(leadWidth);
		return rows.map((cells, index) => `${index === 0 ? lead : pad}${cells.join(GAP)}`);
	}
	return [`${lead}${block.items.map(item => glyph(item.tone)).join(" ")}`];
}
