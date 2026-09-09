import { matchesKey, replaceTabs, ScrollView, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { Theme } from "../modes/theme/theme";
import { formatElapsed, formatNum, isBetter } from "./helpers";
import { currentResults, findBaselineMetric, findBaselineRunNumber, findBaselineSecondary } from "./state";
import type { AutoresearchRuntime, DashboardController, ExperimentResult, ExperimentState } from "./types";

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
					return new Text(renderRunningOnly(runtime, state, theme), 0, 0);
				}
				if (runtime.dashboardExpanded) {
					const width = process.stdout.columns ?? 120;
					const lines = [
						renderExpandedHeader(runtime, width, theme),
						...renderDashboardLines(runtime, width, theme, 8),
					];
					return new Text(lines.join("\n"), 0, 0);
				}
				return new Text(renderCollapsedLine(runtime, state, theme), 0, 0);
			});
		},
		async showOverlay(ctx, runtime): Promise<void> {
			if (!ctx.hasUI || !shouldShowDashboard(runtime, runtime.state)) return;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					if (!spinnerTimer) {
						spinnerTimer = setInterval(() => {
							spinnerFrame += 1;
							requestRender();
						}, 80);
					}

					let scrollOffset = 0;
					return {
						render(width: number): readonly string[] {
							const terminalRows = process.stdout.rows ?? 40;
							const header = renderExpandedHeader(runtime, width, theme);
							const body = renderDashboardLines(runtime, width, theme, 0);
							if (runtime.runningExperiment) {
								body.push(renderOverlayRunningLine(runtime, theme, width, spinnerFrame));
							}
							const viewportRows = Math.max(4, terminalRows - 4);
							const maxScroll = Math.max(0, body.length - viewportRows);
							if (scrollOffset > maxScroll) scrollOffset = maxScroll;
							const sv = new ScrollView(body.slice(scrollOffset, scrollOffset + viewportRows), {
								height: viewportRows,
								scrollbar: "auto",
								totalRows: body.length,
								theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
							});
							sv.setScrollOffset(scrollOffset);
							return [header, ...sv.render(width), renderOverlayFooter(width, theme)];
						},
						handleInput(data: string): void {
							const totalRows =
								renderDashboardLines(runtime, process.stdout.columns ?? 120, theme, 0).length +
								(runtime.runningExperiment ? 1 : 0);
							const viewportRows = Math.max(4, (process.stdout.rows ?? 40) - 4);
							const maxScroll = Math.max(0, totalRows - viewportRows);
							if (matchesKey(data, "escape") || matchesKey(data, "esc") || data === "q") {
								done(undefined);
								return;
							}
							if (matchesKey(data, "up") || matchesKey(data, "k")) {
								scrollOffset = Math.max(0, scrollOffset - 1);
							} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
								scrollOffset = Math.min(maxScroll, scrollOffset + 1);
							} else if (matchesKey(data, "pageUp")) {
								scrollOffset = Math.max(0, scrollOffset - viewportRows);
							} else if (matchesKey(data, "pageDown")) {
								scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
							} else if (data === "g") {
								scrollOffset = 0;
							} else if (data === "G") {
								scrollOffset = maxScroll;
							}
							tui.requestRender();
						},
						invalidate(): void {},
						dispose(): void {
							clear();
						},
					};
				},
				{ overlay: true },
			);
		},
	};
}

function renderRunningOnly(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
	const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", " running...")];
	if (state.name) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(state.name)}`));
	}
	if (runtime.runningExperiment) {
		parts.push(theme.fg("dim", ` | ${replaceTabs(runtime.runningExperiment.command)}`));
	}
	return parts.join("");
}

function shouldShowDashboard(runtime: AutoresearchRuntime, state: ExperimentState): boolean {
	return (
		runtime.autoresearchMode ||
		state.results.length > 0 ||
		runtime.runningExperiment !== null ||
		runtime.lastRunSummary !== null
	);
}

function renderExpandedHeader(runtime: AutoresearchRuntime, width: number, theme: Theme): string {
	const state = runtime.state;
	const status = renderModeStatus(runtime, state);
	const label = state.name ? ` autoresearch: ${replaceTabs(state.name)} ` : " autoresearch ";
	const hint = theme.fg("dim", ` ctrl+x collapse  ctrl+shift+x overlay${status ? `  ${status}` : ""} `);
	const fillWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncateToWidth(theme.fg("accent", label) + theme.fg("borderMuted", "-".repeat(fillWidth)) + hint, width);
}

function renderCollapsedLine(runtime: AutoresearchRuntime, state: ExperimentState, theme: Theme): string {
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
	parts.push(theme.fg("dim", " | ctrl+x expand"));
	return parts.join("");
}

export function renderDashboardLines(
	runtime: AutoresearchRuntime,
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
	lines.push(renderTableHeader(state, width, theme));
	lines.push(theme.fg("borderMuted", "-".repeat(Math.max(0, width - 1))));

	const visible = maxRows > 0 ? current.slice(-maxRows) : current;
	if (visible.length < current.length) {
		lines.push(theme.fg("dim", `... ${current.length - visible.length} earlier runs hidden ...`));
	}
	for (const result of visible) {
		lines.push(renderResultRow(result, state, baselineSecondary, width, theme));
	}
	return lines;
}

function renderTableHeader(state: ExperimentState, width: number, theme: Theme): string {
	const secondaryHeader = state.secondaryMetrics.map(metric => truncateToWidth(metric.name, 10)).join(" ");
	return truncateToWidth(
		`${theme.fg("muted", "#".padEnd(4))}${theme.fg("muted", "commit".padEnd(10))}${theme.fg("warning", state.metricName.padEnd(12))}${secondaryHeader ? `${theme.fg("muted", secondaryHeader)} ` : ""}${theme.fg("muted", "status".padEnd(14))}${theme.fg("muted", "description")}`,
		width,
	);
}

function renderResultRow(
	result: ExperimentResult,
	state: ExperimentState,
	baselineSecondary: { [key: string]: number },
	width: number,
	theme: Theme,
): string {
	const runNumber = result.runNumber ?? state.results.indexOf(result) + 1;
	const secondary = state.secondaryMetrics
		.map(metric =>
			truncateToWidth(
				renderSecondaryCell(result.metrics[metric.name], metric.unit, baselineSecondary[metric.name]),
				10,
			).padEnd(11),
		)
		.join("");
	const statusColor = result.status === "keep" ? "success" : result.status === "discard" ? "warning" : "error";
	const line =
		`${theme.fg("dim", String(runNumber).padEnd(4))}` +
		`${theme.fg("accent", (result.commit || "-").padEnd(10))}` +
		`${theme.fg(statusColor, formatNum(result.metric, state.metricUnit).padEnd(12))}` +
		`${secondary}` +
		`${theme.fg(statusColor, result.status.padEnd(14))}` +
		`${theme.fg("muted", replaceTabs(result.description))}`;
	return truncateToWidth(line, width);
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
	runtime: AutoresearchRuntime,
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
	const hint = theme.fg("dim", " up/down j/k pageup pagedown g G esc ");
	const fill = Math.max(0, width - visibleWidth(hint));
	return theme.fg("borderMuted", "-".repeat(fill)) + hint;
}

function renderModeStatus(runtime: AutoresearchRuntime, state: ExperimentState): string {
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
