/**
 * The autoresearch dashboard in the terminal: text dashboards painted from
 * the runtime (the `term` facts of the widget and sheet nodes).
 *
 * - `omp.widget.autoresearch` (row, card or text): the collapsed line
 *   (`autoresearch 5 runs 2 kept … | ⌃X expand`), the running line, or the
 *   expanded dashboard (a ruled title, the summary lines, a fixed-column run
 *   table of the latest eight runs), laid out for `term.columns` (default:
 *   the width) and word-wrapped to the width.
 * - `omp.app.autoresearch` (col): the sheet: the ruled title, every run of
 *   the segment (plus the running benchmark) in a viewport `term.viewport`
 *   rows tall scrolled to `term.offset` with a scrollbar while it overflows,
 *   and the key-hint rule.
 */
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { SPINNER_INTERVAL_MS } from "@oh-my-pi/pi-tui/term/painters/spinner";
import { padTo, replaceTabs, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import {
	currentResults,
	findBaselineMetric,
	findBaselineRunNumber,
	findBaselineSecondary,
	formatElapsed,
} from "../../../../autoresearch/results-data";
import { type ExperimentResult, formatNum } from "../../../../autoresearch/tool-details";
import {
	type AutoresearchDashboardRuntime,
	findBestResult,
	modeStatus,
	secondaryCell,
	secondarySummary,
	statusCounts,
} from "../../../apps/autoresearch/model";

/** Terminal facts of the widget and sheet nodes. */
export type AutoresearchTerm = {
	readonly runtime: AutoresearchDashboardRuntime;
	/** Widget: columns the expanded dashboard is laid out for. */
	readonly columns?: number;
	/** Sheet: body viewport rows and the first body row shown. */
	readonly viewport?: number;
	readonly offset?: number;
};

/** Body rows of a sheet on a screen `terminalRows` tall (the rest is head, foot and margin). */
export function overlayViewportRows(terminalRows: number): number {
	return Math.max(4, terminalRows - 4);
}

/** Body rows of the sheet (independent of the width). */
export function overlayBodyLineCount(runtime: AutoresearchDashboardRuntime): number {
	return dashboardLines(runtime, 80, PLAIN_THEME, 0).length + (runtime.runningExperiment ? 1 : 0);
}

// ─── Lines ──────────────────────────────────────────────────────────────────

/** `↑/↓`-style key glyphs the hints show. */
const KEYS = { collapse: "⌃X", overlay: "⌃⇧X", expand: "⌃X" } as const;

function expandedHeader(runtime: AutoresearchDashboardRuntime, width: number, theme: Theme): string {
	const name = runtime.state.name;
	const status = modeStatus(runtime);
	const label = name ? ` autoresearch: ${replaceTabs(name)} ` : " autoresearch ";
	const hint = theme.fg("dim", ` ${KEYS.collapse} collapse  ${KEYS.overlay} overlay${status ? `  ${status}` : ""} `);
	const fill = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncate(`${theme.fg("accent", label)}${theme.fg("borderMuted", "-".repeat(fill))}${hint}`, width);
}

function runningOnlyLine(runtime: AutoresearchDashboardRuntime, theme: Theme): string {
	const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", " running...")];
	if (runtime.state.name) parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.state.name)}`));
	if (runtime.runningExperiment) parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.runningExperiment.command)}`));
	return parts.join("");
}

function collapsedLine(runtime: AutoresearchDashboardRuntime, theme: Theme, now: number): string {
	const state = runtime.state;
	const pending = runtime.lastRunSummary;
	if (pending) {
		const parts = [
			theme.fg("accent", "autoresearch"),
			theme.fg("warning", ` pending run #${pending.runNumber}`),
			theme.fg("dim", pending.passed ? " pass" : " fail"),
		];
		if (pending.parsedPrimary !== null) {
			parts.push(theme.fg("muted", ` | ${state.metricName}=${formatNum(pending.parsedPrimary, state.metricUnit)}`));
		}
		parts.push(theme.fg("warning", " | log_experiment required"));
		if (!runtime.autoresearchMode) parts.push(theme.fg("dim", " | mode off"));
		return parts.join("");
	}
	if (state.results.length === 0) {
		const parts = [
			theme.fg("accent", "autoresearch"),
			theme.fg("warning", ` ${runtime.autoresearchMode ? "baseline pending" : "mode off"}`),
		];
		if (state.name) parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
		if (runtime.autoresearchMode) parts.push(theme.fg("dim", " | run the baseline"));
		return parts.join("");
	}
	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const best = findBestResult(state);
	const archived = state.results.length - current.length;
	const parts = [
		theme.fg("accent", "autoresearch"),
		theme.fg("muted", ` ${current.length} runs`),
		theme.fg("success", ` ${counts.keep} kept`),
	];
	if (archived > 0) parts.push(theme.fg("dim", ` +${archived} archived`));
	if (counts.crash > 0) parts.push(theme.fg("error", ` ${counts.crash} crash`));
	if (counts.checks_failed > 0) parts.push(theme.fg("error", ` ${counts.checks_failed} checks_failed`));
	parts.push(theme.fg("dim", " | "));
	if (best && state.bestMetric !== null && best.result.metric !== state.bestMetric) {
		parts.push(theme.fg("warning", `best ${formatNum(best.result.metric, state.metricUnit)}`));
		parts.push(theme.fg("dim", ` baseline ${formatNum(state.bestMetric, state.metricUnit)}`));
	} else if (state.bestMetric !== null) {
		parts.push(theme.fg("warning", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`));
	} else {
		parts.push(theme.fg("warning", "no kept runs yet"));
	}
	if (state.confidence !== null) {
		const color = state.confidence >= 2 ? "success" : state.confidence >= 1 ? "warning" : "error";
		parts.push(theme.fg("dim", " | "), theme.fg(color, `conf ${state.confidence.toFixed(1)}x`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | running ${formatElapsed(now - runtime.runningExperiment.startedAt)}`));
	} else if (!runtime.autoresearchMode) {
		parts.push(theme.fg("dim", ` | ${modeStatus(runtime)}`));
	}
	parts.push(theme.fg("dim", ` | ${KEYS.expand} expand`));
	return parts.join("");
}

interface Column {
	readonly width: number;
	readonly min: number;
}

interface Cell {
	readonly text: string;
	readonly color?: string;
}

/** Column widths fitted into `width`: rightmost columns give way first, down to their minimum. */
function fitColumns(columns: readonly Column[], width: number): number[] {
	const widths = columns.map(column => column.width);
	let overflow = widths.reduce((sum, w) => sum + w, 0) - width;
	for (let i = widths.length - 1; i >= 0 && overflow > 0; i--) {
		const shrink = Math.min(overflow, widths[i]! - Math.min(widths[i]!, columns[i]!.min));
		widths[i]! -= shrink;
		overflow -= shrink;
	}
	return widths;
}

/** One table row: cells cut with an ellipsis and padded to their column, colored, the row cut to the width. */
function tableRow(theme: Theme, cells: readonly Cell[], widths: readonly number[], width: number): string {
	const row = cells
		.map((cell, i) => {
			const fitted = padTo(truncate(cell.text.replace(/[\r\n]+/g, " "), widths[i]!), widths[i]!);
			return cell.color ? theme.fg(cell.color, fitted) : fitted;
		})
		.join("");
	return truncate(row, width);
}

/** The summary lines and the run table (the latest `maxRows` runs; 0 shows all). */
export function dashboardLines(
	runtime: AutoresearchDashboardRuntime,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const state = runtime.state;
	const cut = (text: string) => truncate(text, width);
	const pending = runtime.lastRunSummary;
	if (state.results.length === 0) {
		if (pending) {
			const primary =
				pending.parsedPrimary !== null
					? `  ${state.metricName} ${formatNum(pending.parsedPrimary, state.metricUnit)}`
					: "";
			const lines = [
				cut(`Pending run: #${pending.runNumber}`),
				cut(`Result: ${pending.passed ? "passed" : "failed"}${primary}`),
				cut("Next action: finish log_experiment before starting another run."),
			];
			if (!runtime.autoresearchMode) lines.push(cut("Mode: off"));
			return lines;
		}
		if (runtime.autoresearchMode) {
			return [
				cut("Current segment: 0 runs"),
				cut("Baseline: pending"),
				cut("Next action: run and log the baseline experiment."),
			];
		}
		return [theme.fg("dim", "No experiments logged yet.")];
	}

	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRun = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const lines = [
		cut(
			`Current segment: ${current.length} runs  ${counts.keep} kept  ${counts.discard} discarded  ${counts.crash} crashed  ${counts.checks_failed} checks_failed`,
		),
		cut(`Baseline: ${formatNum(baseline, state.metricUnit)}${baselineRun ? ` (#${baselineRun})` : ""}`),
	];
	if (state.results.length > current.length) {
		lines.push(cut(`Archived from earlier segments: ${state.results.length - current.length} runs`));
	}
	if (pending) {
		lines.push(
			cut(`Pending run: #${pending.runNumber} (${pending.passed ? "passed" : "failed"}) — log_experiment required`),
		);
	}
	if (!runtime.autoresearchMode) lines.push(cut(`Mode: ${modeStatus(runtime)}`));
	if (best) {
		let progress = `Best: ${formatNum(best.result.metric, state.metricUnit)} (#${best.result.runNumber ?? best.index + 1})`;
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			progress += ` ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
		}
		if (state.confidence !== null) progress += `  conf ${state.confidence.toFixed(1)}x`;
		lines.push(cut(progress));
		const details = state.secondaryMetrics
			.map(metric =>
				secondarySummary(
					metric.name,
					best.result.metrics[metric.name],
					baselineSecondary[metric.name],
					metric.unit,
				),
			)
			.filter(detail => detail !== null);
		if (details.length > 0) lines.push(cut(`Secondary: ${details.join("  ")}`));
	}

	const secondary = state.secondaryMetrics.length;
	const fixed = 4 + 10 + 12 + 11 * secondary + 14;
	const widths = fitColumns(
		[
			{ width: 4, min: 1 },
			{ width: 10, min: 1 },
			{ width: 12, min: 1 },
			...state.secondaryMetrics.map(() => ({ width: 11, min: 1 })),
			{ width: 14, min: 1 },
			{ width: Math.max(8, width - fixed), min: 8 },
		],
		width,
	);
	lines.push("");
	lines.push(
		tableRow(
			theme,
			[
				{ text: "#", color: "muted" },
				{ text: "commit", color: "muted" },
				{ text: state.metricName, color: "warning" },
				...state.secondaryMetrics.map(metric => ({ text: truncate(metric.name, 10), color: "muted" })),
				{ text: "status", color: "muted" },
				{ text: "description", color: "muted" },
			],
			widths,
			width,
		),
	);
	lines.push(theme.fg("borderMuted", "-".repeat(Math.max(0, width - 1))));
	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	if (visible.length < current.length) {
		lines.push(theme.fg("dim", `... ${current.length - visible.length} earlier runs hidden ...`));
	}
	for (const result of visible) lines.push(resultRow(theme, runtime, result, baselineSecondary, widths, width));
	return lines;
}

function resultRow(
	theme: Theme,
	runtime: AutoresearchDashboardRuntime,
	result: ExperimentResult,
	baselineSecondary: Readonly<Record<string, number>>,
	widths: readonly number[],
	width: number,
): string {
	const state = runtime.state;
	const color = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
	const cells: Cell[] = [
		{ text: String(result.runNumber ?? state.results.indexOf(result) + 1), color: "dim" },
		{ text: result.commit || "-", color: "accent" },
		{ text: formatNum(result.metric, state.metricUnit), color },
		...state.secondaryMetrics.map(metric => ({
			text: truncate(secondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]), 10),
		})),
		{ text: result.status, color },
		{ text: replaceTabs(result.description), color: "muted" },
	];
	return tableRow(theme, cells, widths, width);
}

// ─── Widget ─────────────────────────────────────────────────────────────────

function widgetPainter(node: { props(): unknown }, cx: PaintContext): Block {
	const facts = (node.props() as { term?: AutoresearchTerm }).term;
	if (!facts) return { rows: [] };
	const runtime = facts.runtime;
	const theme = cx.theme;
	const columns = facts.columns ?? cx.width;
	let lines: string[];
	if (runtime.state.results.length === 0 && runtime.runningExperiment) lines = [runningOnlyLine(runtime, theme)];
	else if (runtime.dashboardExpanded) {
		lines = [expandedHeader(runtime, columns, theme), ...dashboardLines(runtime, columns, theme, 8)];
	} else lines = [collapsedLine(runtime, theme, cx.now())];
	return { rows: lines.flatMap(line => (line === "" ? [""] : wrap(line, cx.width))) };
}

for (const kind of ["row", "card", "text"] as const) defineRolePainter(kind, "omp.widget.autoresearch", widgetPainter);

// ─── Sheet ──────────────────────────────────────────────────────────────────

/** Scrollbar cells for a viewport of `height` rows over `total` rows scrolled to `offset`. */
function scrollbar(theme: Theme, height: number, total: number, offset: number): string[] {
	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const max = Math.max(0, total - height);
	const start = max === 0 ? 0 : Math.round((offset / max) * (height - size));
	return Array.from({ length: height }, (_, i) =>
		i >= start && i < start + size ? theme.fg("accent", "█") : theme.fg("dim", "│"),
	);
}

defineRolePainter("col", "omp.app.autoresearch", (node, cx): Block => {
	const facts = (node.props() as { term?: AutoresearchTerm }).term;
	if (!facts) return { rows: [] };
	const runtime = facts.runtime;
	const theme = cx.theme;
	const width = cx.width;
	const body = dashboardLines(runtime, width, theme, 0);
	const running = runtime.runningExperiment;
	if (running) {
		const frames = theme.symbols.spinnerFrames;
		const spinner = frames.length > 0 ? frames[Math.floor(cx.now() / SPINNER_INTERVAL_MS) % frames.length] : "*";
		body.push(
			truncate(
				theme.fg(
					"warning",
					`${spinner} running ${formatElapsed(cx.now() - running.startedAt)} ${replaceTabs(running.command)}`,
				),
				width,
			),
		);
	}
	const height = facts.viewport ?? overlayViewportRows(40);
	const offset = Math.max(0, Math.min(facts.offset ?? 0, body.length - height));
	const rows = [expandedHeader(runtime, width, theme)];
	if (body.length > height) {
		const bar = scrollbar(theme, height, body.length, offset);
		for (let i = 0; i < height; i++)
			rows.push(`${padTo(truncate(body[offset + i]!, width - 1), width - 1)}${bar[i]}`);
	} else {
		for (let i = 0; i < height; i++) rows.push(truncate(body[i] ?? "", width));
	}
	const hint = theme.fg("dim", " ↑/↓ j/k PgUp PgDn g ⇧G ⎋ ");
	rows.push(`${theme.fg("borderMuted", "-".repeat(Math.max(0, width - visibleWidth(hint))))}${hint}`);
	return { rows };
});
