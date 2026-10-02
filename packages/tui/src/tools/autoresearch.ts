import { Text } from "../components/text";
import type { Theme } from "../theme/theme";
import { replaceTabs, truncateToWidth, shortenPath } from "../render/render-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { ansi, compact, kv, node, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, resultText, toolHead } from "./native-view";
import type { NativeToolView, ToolRenderer, ToolRenderResult } from "./renderer";
import type { TruncationResult } from "./streaming-output";

/** Whether a lower or higher metric is better. */
export type MetricDirection = "lower" | "higher";

/** Disposition of a completed experiment. */
export type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

/** JSON-compatible additional structured experiment information. */
export type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };

/** Named structured experiment observations. */
export interface ASIData {
	[key: string]: ASIValue;
}

/** Numeric metrics indexed by name. */
export interface NumericMetricMap {
	[key: string]: number;
}

/** Name and unit of an experiment metric. */
export interface MetricDef {
	name: string;
	unit: string;
}

/** Recorded metric and disposition of an experiment run. */
export interface ExperimentResult {
	runNumber: number | null;
	commit: string;
	metric: number;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi?: ASIData;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
}

/** Current experiment baseline, history, and scope. */
export interface ExperimentState {
	results: ExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	goal: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	confidence: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	notes: string;
	branch: string | null;
	baselineCommit: string | null;
	sessionId: number | null;
}

/** Live elapsed time and output metadata of a benchmark. */
export interface RunExperimentProgressDetails {
	phase: "running";
	elapsed: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	runDirectory?: string;
}

/** Completed benchmark measurements, status, and output. */
export interface RunDetails {
	runNumber: number;
	runDirectory: string;
	benchmarkLogPath: string;
	command: string;
	exitCode: number | null;
	durationSeconds: number;
	passed: boolean;
	crashed: boolean;
	timedOut: boolean;
	tailOutput: string;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	parsedAsi: ASIData | null;
	metricName: string;
	metricUnit: string;
	preRunDirtyPaths: string[];
	abandonedPriorRun: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** Logged experiment result and updated baseline state. */
export interface LogDetails {
	experiment: ExperimentResult;
	state: ExperimentState;
	wallClockSeconds: number | null;
	scopeDeviations: string[];
	justification: string | null;
	flaggedRuns: Array<{ runId: number; reason: string }>;
}

/** Format an integer with comma-separated digit groups. */
export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

/** Format a number with grouped digits and optional decimals. */
export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

/** Format an optional metric value with its unit. */
export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

/** Filename of the benchmark harness. */
export const HARNESS_FILENAME = "autoresearch.sh";

/** Default command that executes the benchmark harness. */
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;

/** Initialization outcome and experiment state. */
export interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

/** Tone of an experiment disposition: kept succeeds, discarded warns, the rest fail. */
function experimentTone(status: ExperimentStatus): TspTone {
	return status === "keep" ? "success" : status === "discard" ? "warning" : "error";
}

/** Plain first line of a free-form argument, for single-line heads. */
function firstLine(value: string | undefined): string {
	return (
		plainText(value ?? "")
			.trim()
			.split("\n")[0] ?? ""
	);
}

/** Result text as a wrapped body, or an error card. */
function describeTextResult(
	title: string,
	result: ToolRenderResult<unknown>,
	style?: string,
): NativeToolView | undefined {
	const output = resultText(result);
	if (result.isError) return errorView(title, output);
	const body = plainText(output).trimEnd();
	return body ? { body: [text(style ? [span(body, style)] : body, { wrap: "word" })] } : undefined;
}

const logResultMemo = new OwnerMemo<NativeToolView | undefined>();
const runResultMemo = new OwnerMemo<NativeToolView | undefined>();

function renderInitCall(name: string, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("init_experiment"))} ${theme.fg("accent", truncateToWidth(replaceTabs(name), 100))}`;
}

/** Render init-experiment tool calls and results. */
export const initExperimentToolRenderer = {
	renderCall(args, _options, theme): Text {
		return new Text(renderInitCall(args.name, theme), 0, 0);
	},
	renderResult(result): Text {
		const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
		return new Text(text, 0, 0);
	},
	describeCall(args): NativeToolView {
		return { head: toolHead("init_experiment", span(firstLine(args.name), "accent")) };
	},
	describeResult(result): NativeToolView | undefined {
		return describeTextResult("init_experiment", result);
	},
} satisfies ToolRenderer<{ name: string }, InitExperimentDetails>;

/** Native log summary: disposition badge, description, and metric/baseline grid. */
function describeSummary(details: LogDetails): NativeToolView {
	const { experiment, state } = details;
	const tone = experimentTone(experiment.status);
	const deviations = details.scopeDeviations.length;
	return {
		tone,
		body: compact([
			row(
				[
					node("badge", { text: experiment.status.toUpperCase(), tone }),
					text([span(plainText(experiment.description), "muted")], { wrap: "word", grow: 1 }),
				],
				{ gap: "sm" },
			),
			kv([
				[plainText(state.metricName), [span(formatNum(experiment.metric, state.metricUnit), "accent num")]],
				[
					"baseline",
					state.bestMetric !== null ? [span(formatNum(state.bestMetric, state.metricUnit), "num")] : undefined,
				],
				["confidence", state.confidence !== null ? [span(`${state.confidence.toFixed(1)}x`, "num")] : undefined],
				["deviations", deviations > 0 ? [span(String(deviations), "warning")] : undefined],
			]),
		]),
	};
}

function renderSummary(details: LogDetails, theme: Theme): string {
	const { experiment, state } = details;
	const color = experiment.status === "keep" ? "success" : experiment.status === "discard" ? "warning" : "error";
	let summary = `${theme.fg(color, experiment.status.toUpperCase())} ${theme.fg("muted", truncateToWidth(replaceTabs(experiment.description), 100))}`;
	summary += ` ${theme.fg("accent", `${state.metricName}=${formatNum(experiment.metric, state.metricUnit)}`)}`;
	if (state.bestMetric !== null) {
		summary += ` ${theme.fg("dim", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`)}`;
	}
	if (state.confidence !== null) {
		summary += ` ${theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`)}`;
	}
	if (details.scopeDeviations.length > 0) {
		summary += ` ${theme.fg("warning", `deviations:${details.scopeDeviations.length}`)}`;
	}
	return summary;
}

/** Render log-experiment tool calls and results. */
export const logExperimentToolRenderer = {
	renderCall(args, _options, theme): Text {
		const color = args.status === "keep" ? "success" : args.status === "discard" ? "warning" : "error";
		const description = truncateToWidth(replaceTabs(args.description), 100);
		return new Text(
			`${theme.fg("toolTitle", theme.bold("log_experiment"))} ${theme.fg(color, args.status)} ${theme.fg("muted", description)}`,
			0,
			0,
		);
	},
	renderResult(result, _options, theme): Text {
		const details = result.details;
		if (!details) {
			return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
		}
		return new Text(renderSummary(details, theme), 0, 0);
	},
	describeCall(args): NativeToolView {
		return {
			head: toolHead(
				"log_experiment",
				args.status ? span(args.status, experimentTone(args.status)) : undefined,
				span(firstLine(args.description), "muted"),
			),
		};
	},
	describeResult(result): NativeToolView | undefined {
		return logResultMemo.get(result, [], () => {
			const details = result.details;
			if (result.isError || !details) return describeTextResult("log_experiment", result);
			return describeSummary(details);
		});
	},
} satisfies ToolRenderer<{ status: ExperimentStatus; description: string }, LogDetails>;

/** Native run status: TIMEOUT/FAIL/PASS badge with duration and primary metric. */
function describeStatus(details: RunDetails): { tone: TspTone; node: NativeNode } {
	const duration = `${details.durationSeconds.toFixed(1)}s`;
	let tone: TspTone = "success";
	let label = "PASS";
	let meta = duration;
	if (details.timedOut) {
		tone = "error";
		label = "TIMEOUT";
	} else if (details.exitCode !== 0) {
		tone = "error";
		label = "FAIL";
		meta = `exit=${details.exitCode} ${duration}`;
	} else if (details.parsedPrimary !== null) {
		meta = `${duration} ${plainText(details.metricName)}=${formatNum(details.parsedPrimary, details.metricUnit)}`;
	}
	return {
		tone,
		node: row([node("badge", { text: label, tone }), text([span(meta, tone)], { truncate: "end" })], { gap: "sm" }),
	};
}

function renderStatus(details: RunDetails, theme: Theme): string {
	if (details.timedOut) {
		return theme.fg("error", `TIMEOUT ${details.durationSeconds.toFixed(1)}s`);
	}
	if (details.exitCode !== 0) {
		return theme.fg("error", `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`);
	}
	const metric =
		details.parsedPrimary !== null
			? ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`
			: "";
	return theme.fg("success", `PASS ${details.durationSeconds.toFixed(1)}s${metric}`);
}

function isRunDetails(value: unknown): value is RunDetails {
	if (typeof value !== "object" || value === null) return false;
	return "command" in value && "durationSeconds" in value;
}

function isProgressDetails(value: unknown): value is RunExperimentProgressDetails {
	if (typeof value !== "object" || value === null) return false;
	return "phase" in value && (value as { phase: unknown }).phase === "running";
}

/** Render run-experiment tool calls and results. */
export const runExperimentToolRenderer = {
	renderCall(_args, _options, theme): Text {
		return new Text(
			`${theme.fg("toolTitle", theme.bold("run_experiment"))} ${theme.fg("muted", DEFAULT_HARNESS_COMMAND)}`,
			0,
			0,
		);
	},
	renderResult(result, options, theme): Text {
		if (isProgressDetails(result.details)) {
			const header = theme.fg("warning", `Running ${result.details.elapsed}...`);
			const preview = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
			return new Text(preview ? `${header}\n${theme.fg("dim", preview)}` : header, 0, 0);
		}
		const details = result.details;
		if (!details || !isRunDetails(details)) {
			return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
		}
		const statusText = renderStatus(details, theme);
		if (!options.expanded && details.tailOutput.trim().length === 0) {
			return new Text(statusText, 0, 0);
		}
		const preview = replaceTabs(
			options.expanded ? details.tailOutput : details.tailOutput.split("\n").slice(-5).join("\n"),
		);
		const suffix =
			options.expanded && details.truncation && details.fullOutputPath
				? `\n${theme.fg("warning", `Full output: ${shortenPath(details.fullOutputPath)}`)}`
				: "";
		return new Text(preview ? `${statusText}\n${theme.fg("dim", preview)}${suffix}` : statusText, 0, 0);
	},
	describeCall(): NativeToolView {
		return { head: toolHead("run_experiment", span(DEFAULT_HARNESS_COMMAND, "muted")) };
	},
	describeResult(result): NativeToolView | undefined {
		return runResultMemo.get(result, [], () => {
			const details = result.details;
			if (isProgressDetails(details)) {
				const output = resultText(result);
				return {
					tone: "warning",
					preview: { lines: 6 },
					body: compact([
						node("spinner", { label: [span(`Running ${plainText(details.elapsed)}…`, "warning")] }),
						output.trim() ? ansi(output, { follow: true }) : undefined,
					]),
				};
			}
			if (result.isError || !details || !isRunDetails(details)) return describeTextResult("run_experiment", result);
			const status = describeStatus(details);
			return {
				tone: status.tone,
				preview: { lines: 6 },
				body: compact([
					status.node,
					details.tailOutput.trim() ? ansi(details.tailOutput, { follow: true }) : undefined,
					details.truncation && details.fullOutputPath
						? text([span("Full output: ", "warning"), span(shortenPath(details.fullOutputPath), "path")], {
								truncate: "middle",
							})
						: undefined,
				]),
			};
		});
	},
} satisfies ToolRenderer<unknown, RunDetails | RunExperimentProgressDetails>;

/** Persisted experiment notes after an update. */
export interface UpdateNotesDetails {
	notes: string;
}

/** Render update-notes tool calls and results. */
export const updateNotesToolRenderer = {
	renderCall(args, _options, theme): Text {
		const preview = args.append_idea ?? args.body.slice(0, 100);
		return new Text(
			`${theme.fg("toolTitle", theme.bold("update_notes"))} ${theme.fg("muted", truncateToWidth(replaceTabs(preview), 100))}`,
			0,
			0,
		);
	},
	renderResult(result, _options, theme: Theme): Text {
		const text = replaceTabs(result.content.find(part => part.type === "text")?.text ?? "");
		return new Text(theme.fg("muted", text), 0, 0);
	},
	describeCall(args): NativeToolView {
		const preview = args.append_idea ?? args.body?.slice(0, 100);
		return { head: toolHead("update_notes", span(firstLine(preview), "muted")) };
	},
	describeResult(result): NativeToolView | undefined {
		return describeTextResult("update_notes", result, "muted");
	},
} satisfies ToolRenderer<{ body: string; append_idea?: string }, UpdateNotesDetails>;
