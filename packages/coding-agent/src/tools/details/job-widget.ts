import type { TspTone } from "@oh-my-pi/pi-wire";

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
	/** Short name of what is being watched (`loadtest · 3 models`). */
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

/** The entry whose live widget (one a spec drives) saw data last. */
export function latestJobWidget<T extends JobWidgetEntry>(entries: readonly T[]): T | undefined {
	let latest: T | undefined;
	for (const entry of entries) {
		if (entry.view.state !== "live") continue;
		if (!latest || entry.view.updatedAt > latest.view.updatedAt) latest = entry;
	}
	return latest;
}

/** What kind of job a tile shows: a subagent (`task`) goes by its name, any other job by what it runs. */
export type JobTileType = "bash" | "task" | "eval" | "extension";
