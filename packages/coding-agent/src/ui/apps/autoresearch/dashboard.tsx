/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The autoresearch dashboard: a widget above the composer (one line of run
 * counts, the running baseline, or the expanded summary with the latest runs)
 * and a sheet (`ctrl+shift+x`) with the goal, the headline numbers, the
 * metric per run and every run of the segment.
 *
 * The terminal shows both as text dashboards painted from the runtime (the
 * `omp.widget.autoresearch` and `omp.app.autoresearch` looks); the sheet
 * scrolls with ↑/↓ j/k PgUp PgDn g G and closes with Esc or q.
 */
import { type JSXNode, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { TspScrollBy, TspSpan, TspTableColumn, TspText } from "@oh-my-pi/pi-wire";
import {
	currentResults,
	findBaselineMetric,
	findBaselineResult,
	findBaselineRunNumber,
	findBaselineSecondary,
	isBetter,
} from "../../../autoresearch/results-data";
import { type ExperimentResult, fmtNum, formatNum } from "../../../autoresearch/tool-details";
import { ActionButton, Hints } from "../../overlays/panels/common";
import type { SheetAttributes } from "../../overlays/sheet";
import { type AutoresearchTerm, overlayBodyLineCount, overlayViewportRows } from "../../styles/apps/autoresearch/look";
import {
	type AutoresearchDashboardRuntime,
	confidenceToken,
	findBestResult,
	fractionDigits,
	type IndexedResult,
	modeStatus,
	percentChange,
	runNumberOf,
	secondaryCell,
	secondarySummary,
	segmentRuns,
	statusCounts,
} from "./model";

const WIDGET_ROLE = "omp.widget.autoresearch";

const STATUS_LABEL: Record<ExperimentResult["status"], string> = {
	keep: "kept",
	discard: "discarded",
	crash: "crashed",
	checks_failed: "checks failed",
};

const STATUS_TOKEN: Record<ExperimentResult["status"], string> = {
	keep: "success",
	discard: "dim",
	crash: "error",
	checks_failed: "error",
};

/** A span, unstyled when `s` is undefined. */
function span(t: string, s?: string): TspSpan {
	return s ? { s, t } : { t };
}

export interface AutoresearchWidgetProps {
	readonly runtime: AutoresearchDashboardRuntime;
	/** Clock for elapsed times (default `Date.now`). */
	readonly now?: () => number;
	/** Columns the terminal lays the expanded dashboard out for (default: the width it gets). */
	readonly columns?: number;
}

/** The widget above the composer (see the module docs). */
export function AutoresearchWidget(props: AutoresearchWidgetProps): JSXNode {
	const runtime = props.runtime;
	const state = runtime.state;
	const now = props.now ?? Date.now;
	const term: AutoresearchTerm = { runtime, columns: props.columns };
	const running = runtime.runningExperiment;
	if (state.results.length === 0 && running) {
		const details: TspSpan[] = [];
		if (state.name) details.push(span(`| ${replaceTabs(state.name)}`, "dim"));
		details.push(span(` | ${replaceTabs(running.command)}`, "dim"));
		return (
			<row gap="sm" role={WIDGET_ROLE} term={term}>
				<spinner label={[span("autoresearch", "accent"), span(" running", "warning")]} tone="warning" />
				<elapsed age={now() - running.startedAt} format="short" />
				<text spans={details} truncate="end" />
			</row>
		);
	}
	if (runtime.dashboardExpanded) {
		return (
			<card role={WIDGET_ROLE} head={widgetTitle(runtime)} term={term}>
				{widgetDashboard(runtime, 8)}
				<Hints
					hints={[
						{ keys: ["ctrl", "x"], label: "collapse" },
						{ keys: ["ctrl", "shift", "x"], label: "overlay" },
					]}
				/>
			</card>
		);
	}
	return collapsedWidget(runtime, now, term);
}

/** Card head: the experiment name plus its mode status. */
function widgetTitle(runtime: AutoresearchDashboardRuntime): TspSpan[] {
	const name = runtime.state.name;
	const spans = [span(name ? `autoresearch: ${replaceTabs(name)}` : "autoresearch", "accent")];
	const status = modeStatus(runtime);
	if (status) spans.push(span(` · ${status}`, "muted"));
	return spans;
}

/** The one-line widget: run counts, best/baseline, confidence and mode. */
function collapsedWidget(runtime: AutoresearchDashboardRuntime, now: () => number, term: AutoresearchTerm): JSXNode {
	const state = runtime.state;
	const pending = runtime.lastRunSummary;
	if (pending) {
		const spans = [
			span("autoresearch", "accent"),
			span(` pending run #${pending.runNumber}`, "warning"),
			span(pending.passed ? " pass" : " fail", "dim"),
		];
		if (pending.parsedPrimary !== null) {
			spans.push(span(` | ${state.metricName}=${formatNum(pending.parsedPrimary, state.metricUnit)}`, "muted"));
		}
		spans.push(span(" | log_experiment required", "warning"));
		if (!runtime.autoresearchMode) spans.push(span(" | mode off", "dim"));
		return <text spans={spans} truncate="end" role={WIDGET_ROLE} term={term} />;
	}
	if (state.results.length === 0) {
		const spans = [
			span("autoresearch", "accent"),
			span(` ${runtime.autoresearchMode ? "baseline pending" : "mode off"}`, "warning"),
		];
		if (state.name) spans.push(span(` | ${replaceTabs(state.name)}`, "dim"));
		if (runtime.autoresearchMode) spans.push(span(" | run the baseline", "dim"));
		return <text spans={spans} truncate="end" role={WIDGET_ROLE} term={term} />;
	}
	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const best = findBestResult(state);
	const archived = state.results.length - current.length;
	const spans = [
		span("autoresearch", "accent"),
		span(` ${current.length} runs`, "muted"),
		span(` ${counts.keep} kept`, "success"),
	];
	if (archived > 0) spans.push(span(` +${archived} archived`, "dim"));
	if (counts.crash > 0) spans.push(span(` ${counts.crash} crash`, "error"));
	if (counts.checks_failed > 0) spans.push(span(` ${counts.checks_failed} checks_failed`, "error"));
	spans.push(span(" | ", "dim"));
	if (best && state.bestMetric !== null && best.result.metric !== state.bestMetric) {
		spans.push(span(`best ${formatNum(best.result.metric, state.metricUnit)}`, "warning"));
		spans.push(span(` baseline ${formatNum(state.bestMetric, state.metricUnit)}`, "dim"));
	} else if (state.bestMetric !== null) {
		spans.push(span(`baseline ${formatNum(state.bestMetric, state.metricUnit)}`, "warning"));
	} else {
		spans.push(span("no kept runs yet", "warning"));
	}
	if (state.confidence !== null) {
		spans.push(span(" | ", "dim"), span(`conf ${state.confidence.toFixed(1)}x`, confidenceToken(state.confidence)));
	}
	const running = runtime.runningExperiment;
	return (
		<row gap="sm" role={WIDGET_ROLE} term={term}>
			<text spans={spans} truncate="end" />
			{running
				? [<text spans={[span("| running", "dim")]} />, <elapsed age={now() - running.startedAt} format="short" />]
				: !runtime.autoresearchMode && <text spans={[span(`| ${modeStatus(runtime)}`, "dim")]} />}
			<Hints hints={[{ keys: ["ctrl", "x"], label: "expand" }]} />
		</row>
	);
}

/** The expanded widget's summary, metric chart and the latest `maxRows` runs. */
function widgetDashboard(runtime: AutoresearchDashboardRuntime, maxRows: number): JSXNode {
	const state = runtime.state;
	if (state.results.length === 0) {
		const pending = runtime.lastRunSummary;
		if (pending) {
			const result = `${pending.passed ? "passed" : "failed"}${pending.parsedPrimary !== null ? `  ${state.metricName} ${formatNum(pending.parsedPrimary, state.metricUnit)}` : ""}`;
			const items: { k: string; v: TspText }[] = [
				{ k: "Pending run", v: `#${pending.runNumber}` },
				{ k: "Result", v: result },
				{ k: "Next action", v: "finish log_experiment before starting another run." },
			];
			if (!runtime.autoresearchMode) items.push({ k: "Mode", v: "off" });
			return <kv key="summary" items={items} layout="grid" />;
		}
		if (runtime.autoresearchMode) {
			const items = [
				{ k: "Current segment", v: "0 runs" },
				{ k: "Baseline", v: "pending" },
				{ k: "Next action", v: "run and log the baseline experiment." },
			];
			return <kv key="summary" items={items} layout="grid" />;
		}
		return <text key="summary" spans={[span("No experiments logged yet.", "dim")]} />;
	}

	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRun = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const items: { k: string; v: TspText }[] = [
		{
			k: "Current segment",
			v: [
				span(`${current.length} runs  `),
				span(`${counts.keep} kept`, "success"),
				span(`  ${counts.discard} discarded`, "warning"),
				span(`  ${counts.crash} crashed`, counts.crash > 0 ? "error" : undefined),
				span(`  ${counts.checks_failed} checks_failed`, counts.checks_failed > 0 ? "error" : undefined),
			],
		},
		{ k: "Baseline", v: `${formatNum(baseline, state.metricUnit)}${baselineRun ? ` (#${baselineRun})` : ""}` },
	];
	if (state.results.length > current.length) {
		items.push({ k: "Archived", v: `${state.results.length - current.length} runs from earlier segments` });
	}
	const pending = runtime.lastRunSummary;
	if (pending) {
		items.push({
			k: "Pending run",
			v: [
				span(`#${pending.runNumber} (${pending.passed ? "passed" : "failed"})`),
				span(" — log_experiment required", "warning"),
			],
		});
	}
	if (!runtime.autoresearchMode) items.push({ k: "Mode", v: modeStatus(runtime) });
	if (best) {
		const value = [span(`${formatNum(best.result.metric, state.metricUnit)} (#${runNumberOf(best)})`, "strong")];
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			value.push(span(` ${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`, "num"));
		}
		if (state.confidence !== null) {
			value.push(span(`  conf ${state.confidence.toFixed(1)}x`, confidenceToken(state.confidence)));
		}
		items.push({ k: "Best", v: value });
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
		if (details.length > 0) items.push({ k: "Secondary", v: details.join("  ") });
	}

	const cols: TspTableColumn[] = [
		{ id: "run", head: [span("#", "muted")], align: "end", priority: 3 },
		{ id: "commit", head: [span("commit", "muted")], truncate: "end", priority: 2 },
		{ id: "metric", head: [span(state.metricName, "warning")], align: "end", priority: 5 },
		...state.secondaryMetrics.map((metric, index): TspTableColumn => ({
			id: `secondary${index}`,
			head: [span(metric.name, "muted")],
			align: "end",
			truncate: "end",
			priority: 1,
		})),
		{ id: "status", head: [span("status", "muted")], priority: 4 },
		{ id: "description", head: [span("description", "muted")], truncate: "end", grow: 1, priority: 2 },
	];
	const indexed = segmentRuns(state);
	const visible = maxRows > 0 ? indexed.slice(-maxRows) : indexed;
	const rows = visible.map(({ result, index }) => {
		const token = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
		const cells: Record<string, TspText> = {
			run: [span(String(result.runNumber ?? index + 1), "dim")],
			commit: [span(result.commit || "-", "accent")],
			metric: [span(formatNum(result.metric, state.metricUnit), token)],
			status: [span(result.status, token)],
			description: [span(replaceTabs(result.description), "muted")],
		};
		state.secondaryMetrics.forEach((metric, metricIndex) => {
			cells[`secondary${metricIndex}`] = secondaryCell(
				result.metrics[metric.name],
				metric.unit,
				baselineSecondary[metric.name],
			);
		});
		return { id: String(index), cells };
	});
	const summary = [span(`${state.metricName} per run`, "muted")];
	if (best) summary.push(span(` · best ${formatNum(best.result.metric, state.metricUnit)}`, "success"));
	return (
		<col key="dashboard" gap="sm">
			<kv key="summary" items={items} layout="grid" />
			{visible.length >= 2 && (
				<chart
					key="trend"
					kind="bars"
					series={visible.map(entry => ({
						label: `#${runNumberOf(entry)}`,
						value: entry.result.metric,
						title: `#${runNumberOf(entry)} ${entry.result.status} · ${formatNum(entry.result.metric, state.metricUnit)} · ${replaceTabs(entry.result.description)}`,
					}))}
					token="accent"
					summary={summary}
					size="md"
					role="omp.autoresearch.trend"
				/>
			)}
			{visible.length < indexed.length && (
				<text key="hidden" spans={[span(`… ${indexed.length - visible.length} earlier runs hidden`, "dim")]} />
			)}
			<table key="runs" cols={cols} rows={rows} role="omp.autoresearch.runs" />
		</col>
	);
}

// ─── Sheet ──────────────────────────────────────────────────────────────────

/** Tern's sheet: a large one titled by the experiment's name, then what the sheet is. */
export function autoresearchSheet(runtime: AutoresearchDashboardRuntime, revision: () => number): SheetAttributes {
	return {
		role: "omp.overlay.autoresearch",
		anchor: "bottom",
		size: "lg",
		head: (): TspSpan[] => {
			revision();
			const name = runtime.state.name?.trim();
			return name ? [{ t: replaceTabs(name) }, { s: "muted", t: " · Autoresearch" }] : [{ t: "Autoresearch" }];
		},
	};
}

export interface AutoresearchSheetProps {
	readonly runtime: AutoresearchDashboardRuntime;
	readonly onClose: () => void;
	/** Clock for elapsed times (default `Date.now`). */
	readonly now?: () => number;
	/** Screen rows the terminal sheet fills (its body scrolls in the rows left by the head and foot). */
	readonly terminalRows?: number;
	/** Bumped when `runtime` changed in place; the sheet redraws its body. */
	readonly revision?: () => number;
}

const SCROLL_KEYS: Readonly<Record<string, TspScrollBy>> = {
	up: "line-up",
	k: "line-up",
	down: "line-down",
	j: "line-down",
	pageUp: "page-up",
	pageDown: "page-down",
	g: "start",
	"shift+g": "end",
};

/** The dashboard sheet (see the module docs). */
export function AutoresearchSheet(props: AutoresearchSheetProps): JSXNode {
	const runtime = props.runtime;
	const now = props.now ?? Date.now;
	const viewport = overlayViewportRows(props.terminalRows ?? 40);
	const scroll = signal<{ by: TspScrollBy; n: number } | undefined>(undefined);
	const offset = signal(0);
	const onKey = (key: KeyEvent): boolean => {
		if (key.id === "escape" || key.id === "q") {
			props.onClose();
			return true;
		}
		const by = SCROLL_KEYS[key.id];
		if (!by) return false;
		const max = Math.max(0, overlayBodyLineCount(runtime) - viewport);
		const step = by === "page-up" || by === "page-down" ? Math.max(1, viewport - 1) : 1;
		const next =
			by === "start"
				? 0
				: by === "end"
					? max
					: offset.peek() + (by === "line-up" || by === "page-up" ? -step : step);
		offset.set(Math.max(0, Math.min(max, next)));
		scroll.set({ by, n: (scroll.peek()?.n ?? 0) + 1 });
		return true;
	};
	const revision = props.revision ?? (() => 0);
	const term = (): AutoresearchTerm => (revision(), { runtime, viewport, offset: offset() });
	return (
		<col
			gap="md"
			role="omp.app.autoresearch"
			scroll={scroll}
			term={term}
			onKey={onKey}
			onAction={act => {
				if (act === "close") props.onClose();
			}}
		>
			{() => (revision(), sheetBody(runtime, now))}
			<row key="actions" role="omp.actions" gap="sm" align="center">
				<spacer grow={1} />
				<ActionButton id="close" label="Close" title="Close  esc" keys={["escape"]} />
			</row>
		</col>
	);
}

/** What the sheet's mode says, with the span token it reads in. */
function modeLabel(runtime: AutoresearchDashboardRuntime): [label: string, token: string] {
	switch (modeStatus(runtime)) {
		case "mode on":
			return ["Mode on", "success"];
		case "baseline pending":
			return ["Baseline pending", "warning"];
		case "segment complete":
			return ["Segment complete", "muted"];
		default:
			return ["Mode off", "muted"];
	}
}

/** A metric split into its number and unit, so the unit can sit a step quieter. */
function metricSpans(value: number, unit: string, digits: number, numberStyle?: string): TspSpan[] {
	const spans = [span(fmtNum(value, digits), numberStyle)];
	if (unit) spans.push(span(unit, "muted"));
	return spans;
}

const archivedNote = (archived: number): string =>
	`${archived} ${archived === 1 ? "run" : "runs"} archived from earlier segments`;

/**
 * The goal and setup, what is happening now, the headline numbers, the metric
 * per run and the runs newest first; an empty segment explains what comes next.
 */
function sheetBody(runtime: AutoresearchDashboardRuntime, now: () => number): JSXNode[] {
	const state = runtime.state;
	const current = currentResults(state.results, state.currentSegment);
	const archived = state.results.length - current.length;
	const children: JSXNode[] = [sheetIntro(runtime, archived > 0)];
	const happening = sheetNow(runtime, now);
	if (happening) children.push(happening);
	if (current.length === 0) {
		children.push(sheetEmpty(runtime, archived));
		return children;
	}
	children.push(sheetStats(runtime, current));
	const indexed = segmentRuns(state);
	if (indexed.length >= 2) {
		children.push(
			<chart
				key="trend"
				kind="bars"
				series={indexed.map(entry => ({
					label: `#${runNumberOf(entry)}`,
					value: entry.result.metric,
					title: `#${runNumberOf(entry)} ${STATUS_LABEL[entry.result.status]} · ${formatNum(entry.result.metric, state.metricUnit)} · ${replaceTabs(entry.result.description)}`,
				}))}
				token="accent"
				summary={[span(`${state.metricName} per run, ${state.bestDirection} is better`)]}
				size="md"
				role="omp.autoresearch.trend"
			/>,
		);
	}
	children.push(sheetRuns(runtime, indexed));
	if (archived > 0) {
		children.push(<text key="archived" spans={[span(archivedNote(archived))]} role="omp.autoresearch.note" />);
	}
	return children;
}

function sheetIntro(runtime: AutoresearchDashboardRuntime, segmented: boolean): JSXNode {
	const state = runtime.state;
	const goal = state.goal?.trim();
	const [mode, modeToken] = modeLabel(runtime);
	const meta: TspSpan[] = [
		span("● ", modeToken),
		span(mode),
		span("  ·  "),
		span(state.metricName, "mono"),
		span(`, ${state.bestDirection} is better`),
	];
	if (segmented) meta.push(span("  ·  "), span(`Segment ${state.currentSegment + 1}`));
	if (state.maxExperiments !== null) meta.push(span("  ·  "), span(`${state.maxExperiments} runs per segment`));
	if (state.branch) meta.push(span("  ·  "), span(replaceTabs(state.branch), "mono"));
	return (
		<col key="intro" gap="xs" role="omp.autoresearch.intro">
			{goal && <text key="goal" text={replaceTabs(goal)} wrap="word" role="omp.autoresearch.goal" />}
			<text key="meta" spans={meta} truncate="end" role="omp.autoresearch.meta" />
		</col>
	);
}

/** A benchmark running, or a finished run waiting to be logged. */
function sheetNow(runtime: AutoresearchDashboardRuntime, now: () => number): JSXNode | undefined {
	const state = runtime.state;
	const running = runtime.runningExperiment;
	if (running) {
		return (
			<row key="now" gap="sm" align="center" role="omp.autoresearch.running" tone="pending">
				<spinner label={[span("Running")]} tone="pending" />
				<elapsed age={now() - running.startedAt} format="short" />
				<text spans={[span(replaceTabs(running.command), "mono")]} truncate="end" role="omp.autoresearch.command" />
			</row>
		);
	}
	const pending = runtime.lastRunSummary;
	if (!pending) return undefined;
	const result = [span(`Run #${pending.runNumber} ${pending.passed ? "passed" : "failed"}`, "strong")];
	if (pending.parsedPrimary !== null) {
		result.push(
			span(`  ·  ${state.metricName} `),
			...metricSpans(pending.parsedPrimary, state.metricUnit, fractionDigits([pending.parsedPrimary]), "mono"),
		);
	}
	return (
		<row key="now" gap="md" align="center" role="omp.autoresearch.pending" tone="warning">
			<text spans={result} truncate="end" />
			<text
				spans={[span("Log it with "), span("log_experiment", "mono"), span(" before the next run")]}
				truncate="end"
				role="omp.autoresearch.next"
			/>
		</row>
	);
}

function sheetEmpty(runtime: AutoresearchDashboardRuntime, archived: number): JSXNode {
	const [title, detail] = runtime.lastRunSummary
		? ["Waiting for the first log", "Log the finished run to set this segment's baseline."]
		: runtime.runningExperiment
			? ["Measuring the baseline", "Every later run is compared with this first one."]
			: runtime.autoresearchMode
				? [
						"No baseline yet",
						"Run the benchmark once and log it as the baseline. Every later run is compared with it.",
					]
				: ["No experiments logged yet", "Turn autoresearch mode on to start measuring."];
	return (
		<col key="empty" gap="xs" align="center" role="omp.autoresearch.empty">
			<text spans={[span(title)]} role="omp.autoresearch.empty.title" />
			<text spans={[span(detail)]} wrap="word" role="omp.autoresearch.empty.detail" />
			{archived > 0 && <text spans={[span(archivedNote(archived))]} role="omp.autoresearch.note" />}
		</col>
	);
}

/** One headline number: a label, the value, and what it means. */
function Stat(props: {
	readonly id: string;
	readonly label: string;
	readonly value: TspSpan[];
	readonly children: JSXNode;
}) {
	return (
		<col key={props.id} role="omp.autoresearch.stat">
			<text text={props.label} role="omp.autoresearch.stat.k" />
			<text spans={props.value} wrap="none" truncate="end" role="omp.autoresearch.stat.v" />
			{props.children}
		</col>
	);
}

const statDetail = (spans: TspSpan[]): JSXNode => (
	<text spans={spans} truncate="end" role="omp.autoresearch.stat.sub" />
);

/** Best, baseline, confidence and the run tally, then the secondary metrics at the best run. */
function sheetStats(runtime: AutoresearchDashboardRuntime, current: readonly ExperimentResult[]): JSXNode {
	const state = runtime.state;
	const unit = state.metricUnit;
	const best = findBestResult(state);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRun = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineResult = current.find(result => result.status === "keep" && !result.flagged);
	const counts = statusCounts(current);
	const digits = fractionDigits(
		[best?.result.metric, baseline].filter(value => value !== undefined && value !== null),
	);

	let bestTile: JSXNode;
	if (best) {
		const run = runNumberOf(best);
		const change = percentChange(best.result.metric, baseline);
		const better = baseline !== null && isBetter(best.result.metric, baseline, state.bestDirection);
		bestTile = (
			<Stat id="best" label="Best" value={metricSpans(best.result.metric, unit, digits)}>
				{statDetail(
					change
						? [span(change, better ? "success" : "error"), span(` vs baseline · run #${run}`)]
						: [span(`The baseline · run #${run}`)],
				)}
			</Stat>
		);
	} else {
		bestTile = (
			<Stat id="best" label="Best" value={[span("—", "muted")]}>
				{statDetail([span("No kept run yet")])}
			</Stat>
		);
	}

	const baselineDetail: TspSpan[] = [];
	if (baselineRun !== null) baselineDetail.push(span(`Run #${baselineRun}`));
	if (baselineResult?.commit) baselineDetail.push(span(" · "), span(baselineResult.commit.slice(0, 7), "mono"));

	const confidence = state.confidence;
	const confidenceText =
		confidence === null
			? "Needs three runs and a gain"
			: confidence >= 2
				? "Gain is clear of run noise"
				: confidence >= 1
					? "Gain is near run noise"
					: "Gain is within run noise";

	const total = Math.max(state.maxExperiments ?? 0, current.length);
	const failed = counts.crash + counts.checks_failed;
	const tally = [span(`${counts.keep} kept · ${counts.discard} discarded`)];
	if (failed > 0) tally.push(span(" · "), span(`${failed} failed`, "error"));

	const secondary: TspSpan[] = [];
	if (best) {
		const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
		for (const metric of state.secondaryMetrics) {
			const value = best.result.metrics[metric.name];
			if (value === undefined) continue;
			secondary.push(span(secondary.length === 0 ? "At best  " : "   ·   "));
			secondary.push(
				span(`${metric.name} `, "mono muted"),
				...metricSpans(value, metric.unit, fractionDigits([value]), "mono"),
			);
			const change = percentChange(value, baselineSecondary[metric.name]);
			if (change) secondary.push(span(` ${change}`, "mono"));
		}
	}

	return (
		<col key="summary" role="omp.autoresearch.summary">
			<row role="omp.autoresearch.stats">
				{bestTile}
				<Stat
					id="baseline"
					label="Baseline"
					value={baseline === null ? [span("—", "muted")] : metricSpans(baseline, unit, digits)}
				>
					{statDetail(baselineDetail.length > 0 ? baselineDetail : [span("Not logged yet")])}
				</Stat>
				<Stat
					id="confidence"
					label="Confidence"
					value={
						confidence === null
							? [span("—", "muted")]
							: [span(confidence.toFixed(1), confidenceToken(confidence)), span("×", "muted")]
					}
				>
					{statDetail([span(confidenceText)])}
				</Stat>
				<Stat
					id="runs"
					label="Runs"
					value={
						state.maxExperiments !== null
							? [span(String(current.length)), span(` / ${state.maxExperiments}`, "muted")]
							: [span(String(current.length))]
					}
				>
					<meter
						value={current.length / total}
						parts={[
							{ value: counts.keep / total, token: "success", label: `${counts.keep} kept` },
							{ value: counts.discard / total, token: "muted", label: `${counts.discard} discarded` },
							{
								value: failed / total,
								token: "error",
								label: `${counts.crash} crashed · ${counts.checks_failed} checks failed`,
							},
						]}
						size="sm"
						role="omp.autoresearch.tally"
					/>
					{statDetail(tally)}
				</Stat>
			</row>
			{secondary.length > 0 && (
				<text key="secondary" spans={secondary} truncate="end" role="omp.autoresearch.secondary" />
			)}
		</col>
	);
}

/** Every run of the segment, newest first. */
function sheetRuns(runtime: AutoresearchDashboardRuntime, indexed: readonly IndexedResult[]): JSXNode {
	const state = runtime.state;
	const baseline = findBaselineResult(state.results, state.currentSegment);
	const best = findBestResult(state);
	// Cells carry bare numbers at one precision per column; the unit goes in the head unless the name says it.
	const head = (name: string, unit: string): TspSpan[] =>
		unit && !name.toLowerCase().endsWith(`_${unit.toLowerCase()}`)
			? [span(name, "mono"), span(` ${unit}`, "muted")]
			: [span(name, "mono")];
	const measured = indexed.filter(({ result }) => result.status !== "crash").map(({ result }) => result);
	const metricDigits = fractionDigits(measured.map(result => result.metric));
	const secondaryDigits = state.secondaryMetrics.map(metric =>
		fractionDigits(measured.map(result => result.metrics[metric.name]).filter(value => value !== undefined)),
	);
	const cols: TspTableColumn[] = [
		{ id: "run", head: "#", align: "end", priority: 3 },
		{ id: "status", head: "Outcome", priority: 4 },
		{ id: "metric", head: head(state.metricName, state.metricUnit), align: "end", priority: 5 },
		{ id: "change", head: "vs baseline", align: "end", priority: 4 },
		...state.secondaryMetrics.map((metric, index): TspTableColumn => ({
			id: `secondary${index}`,
			head: head(metric.name, metric.unit),
			align: "end",
			priority: 1,
		})),
		{ id: "commit", head: "Commit", priority: 2 },
		{ id: "description", head: "Change", truncate: "end", grow: 1, priority: 3 },
	];
	const rows = indexed
		.slice()
		.reverse()
		.map(({ result, index }) => {
			const isBest = best?.index === index;
			const isBaseline = result === baseline;
			const crashed = result.status === "crash";
			const change = isBaseline || crashed ? null : percentChange(result.metric, baseline?.metric);
			const better = baseline !== null && isBetter(result.metric, baseline.metric, state.bestDirection);
			const cells: Record<string, TspText> = {
				run: [span(String(result.runNumber ?? index + 1), "mono")],
				status: isBest
					? [span("● ", "success"), span("best", "strong")]
					: [span("● ", STATUS_TOKEN[result.status]), span(STATUS_LABEL[result.status])],
				metric: crashed
					? [span("—", "muted")]
					: [span(fmtNum(result.metric, metricDigits), isBest ? "mono strong" : "mono")],
				change: isBaseline
					? [span("baseline", "muted")]
					: change
						? [span(change, `mono ${result.status === "keep" ? (better ? "success" : "error") : "muted"}`)]
						: [span("—", "muted")],
				commit: [span(result.commit ? result.commit.slice(0, 7) : "—", result.commit ? "mono" : "muted")],
				description: [span(replaceTabs(result.description))],
			};
			state.secondaryMetrics.forEach((metric, metricIndex) => {
				const value = result.metrics[metric.name];
				cells[`secondary${metricIndex}`] =
					value === undefined
						? [span("—", "muted")]
						: [span(fmtNum(value, secondaryDigits[metricIndex] ?? 0), "mono")];
			});
			return { id: String(index), cells };
		});
	return <table key="runs" cols={cols} rows={rows} role="omp.autoresearch.runs" />;
}
