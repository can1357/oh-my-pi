import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { matchesKey } from "../keys";
import { replaceTabs, truncateToWidth, visibleWidth } from "../utils";
import { ScrollView } from "../components/scroll-view";
import { renderTableRow, type TableCell, type TableColumn } from "../components/table";
import { Text } from "../components/text";
import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import {
	currentResults,
	findBaselineMetric,
	findBaselineRunNumber,
	findBaselineSecondary,
	formatElapsed,
	isBetter,
} from "./autoresearch-data";
import { formatNum, type ExperimentResult, type ExperimentState } from "../tools/autoresearch";
import type { TspSpan, TspTableColumn, TspText } from "@oh-my-pi/pi-wire";
import { card, col, elapsed, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton, hintsRow } from "../native/overlay";
import { Memo } from "../native/memo";
import { isNativeRendering } from "../native/state";

/** The widget's ANSI `Text`, describing itself from the runtime instead of its pre-rendered lines. */
class DashboardWidget extends Text {
	readonly #build: (cx: DescribeContext) => NativeNode;
	#node: NativeNode | undefined;

	constructor(content: string, build: (cx: DescribeContext) => NativeNode) {
		super(content, 0, 0);
		this.#build = build;
	}

	override describe(cx: DescribeContext): NativeNode {
		this.#node ??= this.#build(cx);
		return this.#node;
	}
}

/** Experiment runtime fields rendered by the dashboard. */
export interface AutoresearchDashboardRuntime {
	autoresearchMode: boolean;
	dashboardExpanded: boolean;
	state: ExperimentState;
	lastRunSummary: { runNumber: number; passed: boolean; parsedPrimary: number | null } | null;
	runningExperiment: { startedAt: number; command: string } | null;
}

/** Widget and overlay capabilities supplied by an extension context. */
export interface AutoresearchDashboardHost {
	hasUI: boolean;
	ui: {
		setWidget(key: string, content: ((tui: { requestRender(): void }, theme: Theme) => Component) | undefined): void;
		custom<T>(
			factory: (
				tui: { requestRender(): void },
				theme: Theme,
				keybindings: unknown,
				done: (result: T) => void,
			) => Component,
			options?: { overlay: boolean },
		): Promise<T>;
	};
}

/** Dashboard lifecycle and rendering controls. */
export interface DashboardController {
	clear(ctx: AutoresearchDashboardHost): void;
	requestRender(): void;
	showOverlay(ctx: AutoresearchDashboardHost, runtime: AutoresearchDashboardRuntime): Promise<void>;
	updateWidget(ctx: AutoresearchDashboardHost, runtime: AutoresearchDashboardRuntime): void;
}

/** Create a dashboard backed by the host's widget and overlay surfaces. */
export function createDashboardController(): DashboardController {
	let overlayTui: { requestRender(): void } | null = null;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let spinnerFrame = 0;

	const requestRender = (): void => {
		overlayTui?.requestRender();
	};

	const clear = (): void => {
		overlayTui = null;
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	};

	return {
		clear(ctx): void {
			clear();
			if (ctx.hasUI) {
				ctx.ui.setWidget("autoresearch", undefined);
			}
		},
		requestRender,
		updateWidget(ctx, runtime): void {
			if (!ctx.hasUI) return;
			const state = runtime.state;
			if (!shouldShowDashboard(runtime, state)) {
				ctx.ui.setWidget("autoresearch", undefined);
				return;
			}

			ctx.ui.setWidget("autoresearch", (_tui, theme) => {
				if (state.results.length === 0 && runtime.runningExperiment) {
					return new DashboardWidget(renderRunningOnly(runtime, state, theme), () =>
						describeRunningOnly(runtime, state),
					);
				}
				if (runtime.dashboardExpanded) {
					const width = process.stdout.columns ?? 120;
					const lines = [
						renderExpandedHeader(runtime, width, theme),
						...renderDashboardLines(runtime, width, theme, 8),
					];
					return new DashboardWidget(lines.join("\n"), cx =>
						card({ role: "omp.widget.autoresearch", head: describeTitle(runtime) }, [
							...describeDashboard(runtime, 8, cx.supports("chart")),
							hintsRow([
								{ keys: ["ctrl+x"], label: "collapse" },
								{ keys: ["ctrl+shift+x"], label: "overlay" },
							]),
						]),
					);
				}
				return new DashboardWidget(renderCollapsedLine(runtime, state, theme), () =>
					describeCollapsed(runtime, state),
				);
			});
		},
		async showOverlay(ctx, runtime): Promise<void> {
			if (!ctx.hasUI || !shouldShowDashboard(runtime, runtime.state)) return;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					// Repaint-only: the native overlay declares a spinner and elapsed timer instead.
					if (!spinnerTimer && !isNativeRendering()) {
						spinnerTimer = setInterval(() => {
							spinnerFrame += 1;
							requestRender();
						}, 80);
					}

					let scrollView: ScrollView | undefined;
					const native = new Memo();
					return {
						/** A glass sheet titled by the experiment (the panels' sheet style); the body is borderless. */
						get nativeOverlay() {
							return { role: "omp.overlay.autoresearch", head: describeTitle(runtime), size: "lg" as const };
						},
						describe(cx: DescribeContext): NativeNode {
							const state = runtime.state;
							const chart = cx.supports("chart");
							return native.get(
								[
									chart,
									state,
									state.results.length,
									state.results.at(-1),
									state.bestMetric,
									state.confidence,
									state.currentSegment,
									state.name,
									runtime.autoresearchMode,
									runtime.lastRunSummary,
									runtime.runningExperiment,
								],
								() => {
									const running = runtime.runningExperiment;
									const children: NativeNode[] = describeDashboard(runtime, 0, chart);
									if (running) {
										children.push(
											row(
												[
													node("spinner", { label: [span("running", "warning")], tone: "warning" }),
													elapsed(Date.now() - running.startedAt),
													text([span(replaceTabs(running.command), "warning")], { truncate: "end" }),
												],
												{ gap: "sm" },
											),
										);
									}
									children.push(
										hintsRow([
											{ keys: ["up", "down", "j", "k"], label: "scroll" },
											{ keys: ["pageUp", "pageDown"], label: "page" },
											{ keys: ["g", "shift+g"], label: "top/bottom" },
										]),
									);
									children.push(actionBar([null, actionButton("Close", "close", { keys: "escape" })]));
									return col(children, { gap: "md", role: "omp.app.autoresearch" });
								},
							);
						},
						render(width: number): readonly string[] {
							const terminalRows = process.stdout.rows ?? 40;
							const header = renderExpandedHeader(runtime, width, theme);
							const body = renderDashboardLines(runtime, width, theme, 0);
							if (runtime.runningExperiment) {
								body.push(renderOverlayRunningLine(runtime, theme, width, spinnerFrame));
							}
							const viewportRows = Math.max(4, terminalRows - 4);
							scrollView ??= new ScrollView(body, {
								height: viewportRows,
								scrollbar: "auto",
								theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
							});
							scrollView.setLines(body);
							scrollView.setHeight(viewportRows);
							return [header, ...scrollView.render(width), renderOverlayFooter(width, theme)];
						},
						/** The Close button runs Esc's path. */
						handleNativeEvent(event: NativeUiEvent): void {
							if (event.type === "action" && event.act === "close") done(undefined);
						},
						handleInput(data: string): void {
							if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, "up") || matchesKey(data, "k")) {
								scrollView?.scroll(-1);
							} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
								scrollView?.scroll(1);
							} else if (matchesKey(data, "pageUp")) {
								scrollView?.page(-1);
							} else if (matchesKey(data, "pageDown")) {
								scrollView?.page(1);
							} else if (data === "g") {
								scrollView?.scrollToTop();
							} else if (data === "G") {
								scrollView?.scrollToBottom();
							}
							tui.requestRender();
						},
						invalidate(): void {},
						dispose(): void {
							scrollView?.dispose();
							clear();
						},
					};
				},
				{ overlay: true },
			);
		},
	};
}

// -- native ------------------------------------------------------------------

/** Card/overlay title: the experiment name plus its mode status. */
function describeTitle(runtime: AutoresearchDashboardRuntime): TspSpan[] {
	const state = runtime.state;
	const spans = [span(state.name ? `autoresearch: ${replaceTabs(state.name)}` : "autoresearch", "accent")];
	const status = renderModeStatus(runtime, state);
	if (status) spans.push(span(` · ${status}`, "muted"));
	return spans;
}

/** Widget shown while the very first run is in flight. */
function describeRunningOnly(runtime: AutoresearchDashboardRuntime, state: ExperimentState): NativeNode {
	const children: NativeNode[] = [
		node("spinner", { label: [span("autoresearch", "accent"), span(" running", "warning")], tone: "warning" }),
	];
	if (runtime.runningExperiment) children.push(elapsed(Date.now() - runtime.runningExperiment.startedAt));
	const details: TspSpan[] = [];
	if (state.name) details.push(span(`| ${replaceTabs(state.name)}`, "dim"));
	if (runtime.runningExperiment) details.push(span(` | ${replaceTabs(runtime.runningExperiment.command)}`, "dim"));
	if (details.length > 0) children.push(text(details, { truncate: "end" }));
	return row(children, { gap: "sm", role: "omp.widget.autoresearch" });
}

/** One-line collapsed widget: run counts, best/baseline, confidence and mode. */
function describeCollapsed(runtime: AutoresearchDashboardRuntime, state: ExperimentState): NativeNode {
	const role = "omp.widget.autoresearch";
	const hint = hintsRow([{ keys: ["ctrl+x"], label: "expand" }]);
	if (runtime.lastRunSummary) {
		const spans = [
			span("autoresearch", "accent"),
			span(` pending run #${runtime.lastRunSummary.runNumber}`, "warning"),
			span(runtime.lastRunSummary.passed ? " pass" : " fail", "dim"),
		];
		if (runtime.lastRunSummary.parsedPrimary !== null) {
			spans.push(
				span(
					` | ${state.metricName}=${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}`,
					"muted",
				),
			);
		}
		spans.push(span(" | log_experiment required", "warning"));
		if (!runtime.autoresearchMode) spans.push(span(" | mode off", "dim"));
		return text(spans, { truncate: "end", role });
	}
	if (state.results.length === 0) {
		const spans = [
			span("autoresearch", "accent"),
			span(` ${runtime.autoresearchMode ? "baseline pending" : "mode off"}`, "warning"),
		];
		if (state.name) spans.push(span(` | ${replaceTabs(state.name)}`, "dim"));
		if (runtime.autoresearchMode) spans.push(span(" | run the baseline", "dim"));
		return text(spans, { truncate: "end", role });
	}
	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const best = findBestResult(state);
	const archivedRuns = Math.max(0, state.results.length - current.length);
	const spans = [
		span("autoresearch", "accent"),
		span(` ${current.length} runs`, "muted"),
		span(` ${counts.keep} kept`, "success"),
	];
	if (archivedRuns > 0) spans.push(span(` +${archivedRuns} archived`, "dim"));
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
		spans.push(span(" | ", "dim"));
		spans.push(span(`conf ${state.confidence.toFixed(1)}x`, confidenceToken(state.confidence)));
	}
	const children: NativeNode[] = [text(spans, { truncate: "end" })];
	if (runtime.runningExperiment) {
		children.push(text([span("| running", "dim")]), elapsed(Date.now() - runtime.runningExperiment.startedAt));
	} else if (!runtime.autoresearchMode) {
		children.push(text([span(`| ${renderModeStatus(runtime, state)}`, "dim")]));
	}
	children.push(hint);
	return row(children, { gap: "sm", role });
}

/**
 * Summary `kv`, the metric per run as a `bars` chart when the terminal draws
 * `chart` (`chart`), and the run `table`; `maxRows > 0` keeps only the latest runs.
 */
function describeDashboard(runtime: AutoresearchDashboardRuntime, maxRows: number, chart: boolean): NativeNode[] {
	const state = runtime.state;
	if (state.results.length === 0) {
		const pending = runtime.lastRunSummary;
		if (pending) {
			const items: { k: string; v: TspText }[] = [
				{ k: "Pending run", v: `#${pending.runNumber}` },
				{
					k: "Result",
					v: `${pending.passed ? "passed" : "failed"}${pending.parsedPrimary !== null ? `  ${state.metricName} ${formatNum(pending.parsedPrimary, state.metricUnit)}` : ""}`,
				},
				{ k: "Next action", v: "finish log_experiment before starting another run." },
			];
			if (!runtime.autoresearchMode) items.push({ k: "Mode", v: "off" });
			return [node("kv", { items, layout: "grid" }, undefined, "summary")];
		}
		if (runtime.autoresearchMode) {
			return [
				node(
					"kv",
					{
						items: [
							{ k: "Current segment", v: "0 runs" },
							{ k: "Baseline", v: "pending" },
							{ k: "Next action", v: "run and log the baseline experiment." },
						],
						layout: "grid",
					},
					undefined,
					"summary",
				),
			];
		}
		return [keyed(text([span("No experiments logged yet.", "dim")]), "summary")];
	}

	const current = currentResults(state.results, state.currentSegment);
	const counts = statusCounts(current);
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
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
		{
			k: "Baseline",
			v: `${formatNum(baseline, state.metricUnit)}${baselineRunNumber ? ` (#${baselineRunNumber})` : ""}`,
		},
	];
	if (state.results.length > current.length) {
		items.push({ k: "Archived", v: `${state.results.length - current.length} runs from earlier segments` });
	}
	if (runtime.lastRunSummary) {
		items.push({
			k: "Pending run",
			v: [
				span(`#${runtime.lastRunSummary.runNumber} (${runtime.lastRunSummary.passed ? "passed" : "failed"})`),
				span(" — log_experiment required", "warning"),
			],
		});
	}
	if (!runtime.autoresearchMode) items.push({ k: "Mode", v: renderModeStatus(runtime, state) });
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		const value: TspSpan[] = [
			span(`${formatNum(best.result.metric, state.metricUnit)} (#${bestRunNumber})`, "strong"),
		];
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
				renderSecondarySummary(
					metric.name,
					best.result.metrics[metric.name],
					baselineSecondary[metric.name],
					metric.unit,
				),
			)
			.filter((detail): detail is string => Boolean(detail));
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
	const indexed = state.results
		.map((result, index) => ({ result, index }))
		.filter(({ result }) => result.segment === state.currentSegment);
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
			cells[`secondary${metricIndex}`] = renderSecondaryCell(
				result.metrics[metric.name],
				metric.unit,
				baselineSecondary[metric.name],
			);
		});
		return { id: String(index), cells };
	});
	const children: NativeNode[] = [node("kv", { items, layout: "grid" }, undefined, "summary")];
	if (chart && visible.length >= 2) {
		children.push(
			node(
				"chart",
				{
					kind: "bars",
					series: visible.map(({ result, index }) => {
						const run = result.runNumber ?? index + 1;
						return {
							label: `#${run}`,
							value: result.metric,
							title: `#${run} ${result.status} · ${formatNum(result.metric, state.metricUnit)} · ${replaceTabs(result.description)}`,
						};
					}),
					token: "accent",
					summary: [
						span(`${state.metricName} per run`, "muted"),
						...(best ? [span(` · best ${formatNum(best.result.metric, state.metricUnit)}`, "success")] : []),
					],
					size: "md",
					role: "omp.autoresearch.trend",
				},
				undefined,
				"trend",
			),
		);
	}
	if (visible.length < indexed.length) {
		children.push(keyed(text([span(`… ${indexed.length - visible.length} earlier runs hidden`, "dim")]), "hidden"));
	}
	children.push(node("table", { cols, rows, role: "omp.autoresearch.runs" }, undefined, "runs"));
	return [keyed(col(children, { gap: "sm" }), "dashboard")];
}

function statusCounts(results: readonly ExperimentResult[]): Record<ExperimentResult["status"], number> {
	const counts: Record<ExperimentResult["status"], number> = { keep: 0, discard: 0, crash: 0, checks_failed: 0 };
	for (const result of results) counts[result.status] += 1;
	return counts;
}

function confidenceToken(confidence: number): string {
	return confidence >= 2 ? "success" : confidence >= 1 ? "warning" : "error";
}

// -- ANSI --------------------------------------------------------------------

function renderRunningOnly(runtime: AutoresearchDashboardRuntime, state: ExperimentState, theme: Theme): string {
	const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", " running...")];
	if (state.name) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.runningExperiment.command)}`));
	}
	return parts.join("");
}

function shouldShowDashboard(runtime: AutoresearchDashboardRuntime, state: ExperimentState): boolean {
	return (
		runtime.autoresearchMode ||
		state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

function renderExpandedHeader(runtime: AutoresearchDashboardRuntime, width: number, theme: Theme): string {
	const state = runtime.state;
	const status = renderModeStatus(runtime, state);
	const label = state.name ? ` autoresearch: ${replaceTabs(state.name)} ` : " autoresearch ";
	const hint = theme.fg(
		"dim",
		` ${formatKeyHint("ctrl+x")} collapse  ${formatKeyHint("ctrl+shift+x")} overlay${status ? `  ${status}` : ""} `,
	);
	const fillWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncateToWidth(theme.fg("accent", label) + theme.fg("borderMuted", "-".repeat(fillWidth)) + hint, width);
}

function renderCollapsedLine(runtime: AutoresearchDashboardRuntime, state: ExperimentState, theme: Theme): string {
	if (runtime.lastRunSummary) {
		const parts = [
			theme.fg("accent", "autoresearch"),
			theme.fg("warning", ` pending run #${runtime.lastRunSummary.runNumber}`),
			theme.fg("dim", runtime.lastRunSummary.passed ? " pass" : " fail"),
		];
		if (runtime.lastRunSummary.parsedPrimary !== null) {
			parts.push(
				theme.fg(
					"muted",
					` | ${state.metricName}=${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}`,
				),
			);
		}
		parts.push(theme.fg("warning", " | log_experiment required"));
		if (!runtime.autoresearchMode) {
			parts.push(theme.fg("dim", " | mode off"));
		}
		return parts.join("");
	}
	if (state.results.length === 0) {
		const modeStatus = runtime.autoresearchMode ? "baseline pending" : "mode off";
		const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", ` ${modeStatus}`)];
		if (state.name) {
			parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
		}
		if (runtime.autoresearchMode) {
			parts.push(theme.fg("dim", " | run the baseline"));
		}
		return parts.join("");
	}
	const current = currentResults(state.results, state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const best = findBestResult(state);
	const archivedRuns = Math.max(0, state.results.length - current.length);
	const parts = [
		theme.fg("accent", "autoresearch"),
		theme.fg("muted", ` ${current.length} runs`),
		theme.fg("success", ` ${kept} kept`),
	];
	if (archivedRuns > 0) parts.push(theme.fg("dim", ` +${archivedRuns} archived`));
	if (crashed > 0) parts.push(theme.fg("error", ` ${crashed} crash`));
	if (checksFailed > 0) parts.push(theme.fg("error", ` ${checksFailed} checks_failed`));
	parts.push(theme.fg("dim", " | "));
	if (best && state.bestMetric !== null && best.result.metric !== state.bestMetric) {
		parts.push(theme.fg("warning", `best ${formatNum(best.result.metric, state.metricUnit)}`));
		parts.push(theme.fg("dim", ` baseline ${formatNum(state.bestMetric, state.metricUnit)}`));
	} else if (state.bestMetric !== null) {
		parts.push(theme.fg("warning", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`));
	} else {
		parts.push(theme.fg("warning", `no kept runs yet`));
	}
	if (state.confidence !== null) {
		const confidenceColor = state.confidence >= 2 ? "success" : state.confidence >= 1 ? "warning" : "error";
		parts.push(theme.fg("dim", " | "));
		parts.push(theme.fg(confidenceColor, `conf ${state.confidence.toFixed(1)}x`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | running ${formatElapsed(Date.now() - runtime.runningExperiment.startedAt)}`));
	} else if (!runtime.autoresearchMode) {
		parts.push(theme.fg("dim", ` | ${renderModeStatus(runtime, state)}`));
	}
	parts.push(theme.fg("dim", ` | ${formatKeyHint("ctrl+x")} expand`));
	return parts.join("");
}

/** Render experiment progress and result rows at the requested width. */
export function renderDashboardLines(
	runtime: AutoresearchDashboardRuntime,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const state = runtime.state;
	if (state.results.length === 0) {
		if (runtime.lastRunSummary) {
			const lines = [
				truncateToWidth(`Pending run: #${runtime.lastRunSummary.runNumber}`, width),
				truncateToWidth(
					`Result: ${runtime.lastRunSummary.passed ? "passed" : "failed"}${runtime.lastRunSummary.parsedPrimary !== null ? `  ${state.metricName} ${formatNum(runtime.lastRunSummary.parsedPrimary, state.metricUnit)}` : ""}`,
					width,
				),
				truncateToWidth("Next action: finish log_experiment before starting another run.", width),
			];
			if (!runtime.autoresearchMode) {
				lines.push(truncateToWidth("Mode: off", width));
			}
			return lines;
		}
		if (runtime.autoresearchMode) {
			return [
				truncateToWidth("Current segment: 0 runs", width),
				truncateToWidth("Baseline: pending", width),
				truncateToWidth("Next action: run and log the baseline experiment.", width),
			];
		}
		return [theme.fg("dim", "No experiments logged yet.")];
	}

	const current = currentResults(state.results, state.currentSegment);
	const kept = current.filter(result => result.status === "keep").length;
	const discarded = current.filter(result => result.status === "discard").length;
	const crashed = current.filter(result => result.status === "crash").length;
	const checksFailed = current.filter(result => result.status === "checks_failed").length;
	const baseline = findBaselineMetric(state.results, state.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment);
	const baselineSecondary = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
	const best = findBestResult(state);
	const columns = experimentColumns(state, width);
	const lines = [
		truncateToWidth(
			`Current segment: ${current.length} runs  ${kept} kept  ${discarded} discarded  ${crashed} crashed  ${checksFailed} checks_failed`,
			width,
		),
		truncateToWidth(
			`Baseline: ${formatNum(baseline, state.metricUnit)}${baselineRunNumber ? ` (#${baselineRunNumber})` : ""}`,
			width,
		),
	];
	if (state.results.length > current.length) {
		lines.push(
			truncateToWidth(`Archived from earlier segments: ${state.results.length - current.length} runs`, width),
		);
	}
	if (runtime.lastRunSummary) {
		lines.push(
			truncateToWidth(
				`Pending run: #${runtime.lastRunSummary.runNumber} (${runtime.lastRunSummary.passed ? "passed" : "failed"}) — log_experiment required`,
				width,
			),
		);
	}
	if (!runtime.autoresearchMode) {
		lines.push(truncateToWidth(`Mode: ${renderModeStatus(runtime, state)}`, width));
	}
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		let progress = `Best: ${formatNum(best.result.metric, state.metricUnit)} (#${bestRunNumber})`;
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			progress += ` ${sign}${delta.toFixed(1)}%`;
		}
		if (state.confidence !== null) {
			progress += `  conf ${state.confidence.toFixed(1)}x`;
		}
		lines.push(truncateToWidth(progress, width));
		if (state.secondaryMetrics.length > 0) {
			const details = state.secondaryMetrics
				.map(metric =>
					renderSecondarySummary(
						metric.name,
						best.result.metrics[metric.name],
						baselineSecondary[metric.name],
						metric.unit,
					),
				)
				.filter((value): value is string => Boolean(value));
			if (details.length > 0) {
				lines.push(truncateToWidth(`Secondary: ${details.join("  ")}`, width));
			}
		}
	}
	lines.push("");
	lines.push(renderTableHeader(state, columns, width, theme));
	lines.push(theme.fg("borderMuted", "-".repeat(Math.max(0, width - 1))));

	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	if (visible.length < current.length) {
		lines.push(theme.fg("dim", `... ${current.length - visible.length} earlier runs hidden ...`));
	}
	for (const result of visible) {
		lines.push(renderResultRow(result, state, baselineSecondary, columns, width, theme));
	}
	return lines;
}

function experimentColumns(state: ExperimentState, width: number): TableColumn[] {
	const fixed = 4 + 10 + 12 + 11 * state.secondaryMetrics.length + 14;
	return [
		{ width: 4, align: "left", overflow: "truncate" },
		{ width: 10, align: "left", overflow: "truncate" },
		{ width: 12, align: "left", overflow: "truncate" },
		...state.secondaryMetrics.map((): TableColumn => ({ width: 11, align: "left", overflow: "truncate" })),
		{ width: 14, align: "left", overflow: "truncate" },
		{ width: Math.max(8, width - fixed), align: "left", overflow: "truncate", minWidth: 8 },
	];
}

function renderTableHeader(
	state: ExperimentState,
	columns: readonly TableColumn[],
	width: number,
	theme: Theme,
): string {
	const muted = (text: string): string => theme.fg("muted", text);
	const cells: TableCell[] = [
		{ text: "#", style: muted },
		{ text: "commit", style: muted },
		{ text: state.metricName, style: text => theme.fg("warning", text) },
		...state.secondaryMetrics.map((metric): TableCell => ({ text: truncateToWidth(metric.name, 10), style: muted })),
		{ text: "status", style: muted },
		{ text: "description", style: muted },
	];
	return truncateToWidth(renderTableRow(cells, columns, width, { gap: "" }), width);
}

function renderResultRow(
	result: ExperimentResult,
	state: ExperimentState,
	baselineSecondary: { [key: string]: number },
	columns: readonly TableColumn[],
	width: number,
	theme: Theme,
): string {
	const runNumber = result.runNumber ?? state.results.indexOf(result) + 1;
	const statusColor = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
	const statusStyle = (text: string): string => theme.fg(statusColor, text);
	const cells: TableCell[] = [
		{ text: String(runNumber), style: text => theme.fg("dim", text) },
		{ text: result.commit || "-", style: text => theme.fg("accent", text) },
		{ text: formatNum(result.metric, state.metricUnit), style: statusStyle },
		...state.secondaryMetrics.map((metric): TableCell => ({
			text: truncateToWidth(
				renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
				10,
			),
		})),
		{ text: result.status, style: statusStyle },
		{ text: replaceTabs(result.description), style: text => theme.fg("muted", text) },
	];
	return truncateToWidth(renderTableRow(cells, columns, width, { gap: "" }), width);
}

function renderSecondaryCell(value: number | undefined, unit: string, baseline: number | undefined): string {
	if (value === undefined) return "-";
	const formatted = formatNum(value, unit);
	if (baseline === undefined || baseline === 0 || baseline === value) return formatted;
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${formatted} ${sign}${delta.toFixed(1)}%`;
}

function renderSecondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	if (baseline === undefined || baseline === 0 || baseline === value) {
		return `${name} ${formatNum(value, unit)}`;
	}
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${name} ${formatNum(value, unit)} ${sign}${delta.toFixed(1)}%`;
}

function renderOverlayRunningLine(
	runtime: AutoresearchDashboardRuntime,
	theme: Theme,
	width: number,
	spinnerFrame: number,
): string {
	const spinner = theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length] ?? "*";
	return truncateToWidth(
		theme.fg(
			"warning",
			`${spinner} running ${formatElapsed(Date.now() - (runtime.runningExperiment?.startedAt ?? Date.now()))} ${replaceTabs(
				runtime.runningExperiment?.command ?? "",
			)}`,
		),
		width,
	);
}

function renderOverlayFooter(width: number, theme: Theme): string {
	const hint = theme.fg(
		"dim",
		` ${formatKeyHints(["up", "down"])} ${formatKeyHints(["j", "k"])} ${formatKeyHint("pageUp")} ${formatKeyHint("pageDown")} ${formatKeyHint("g")} ${formatKeyHint("shift+g")} ${formatKeyHint("escape")} `,
	);
	const fill = Math.max(0, width - visibleWidth(hint));
	return theme.fg("borderMuted", "-".repeat(fill)) + hint;
}

function renderModeStatus(runtime: AutoresearchDashboardRuntime, state: ExperimentState): string {
	if (runtime.autoresearchMode) {
		return state.results.length === 0 ? "baseline pending" : "mode on";
	}
	const current = currentResults(state.results, state.currentSegment);
	if (state.maxExperiments !== null && current.length >= state.maxExperiments) {
		return "segment complete";
	}
	return "mode off";
}

function findBestResult(state: ExperimentState): { index: number; result: ExperimentResult } | null {
	let best: { index: number; result: ExperimentResult } | null = null;
	for (let index = 0; index < state.results.length; index += 1) {
		const result = state.results[index];
		if (result.segment !== state.currentSegment || result.status !== "keep" || result.metric <= 0) continue;
		if (!best || isBetter(result.metric, best.result.metric, state.bestDirection)) {
			best = { index, result };
		}
	}
	return best;
}
