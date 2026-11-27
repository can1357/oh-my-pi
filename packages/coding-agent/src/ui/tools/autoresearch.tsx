/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Autoresearch tools: `init_experiment`, `log_experiment`, `run_experiment`
 * and `update_notes`. Calls are one header (`log_experiment keep faster
 * parse`); results are a status badge with the run's facts (exit code,
 * duration, metrics) and the benchmark's output tail.
 *
 * Terminal look: `autoresearch` (`src/ui/styles/tools/autoresearch.ts`).
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** Terminal facts of the `autoresearch` look. */
export type AutoresearchTerm = {
	readonly look: "autoresearch";
	/** Header spans (calls). */
	readonly head?: readonly TspSpan[];
	/** A benchmark run: status badge, facts and output. */
	readonly run?: {
		readonly status: string;
		readonly tone: TspTone;
		readonly facts: string;
		readonly output: string;
		readonly fullOutputPath?: string;
	};
	/** A run still going: `Running 3s...` and its output so far. */
	readonly running?: { readonly elapsed: string; readonly output: string };
	/** A logged experiment as one paragraph. */
	readonly logged?: {
		readonly status: string;
		readonly tone: TspTone;
		readonly description: string;
		readonly metric?: string;
		readonly baseline?: string;
		readonly confidence?: string;
		readonly deviations?: number;
	};
};

/** Characters of a header argument the native head carries (update_notes bodies). */
const NOTE_CHARS = 100;
/** Output lines the collapsed run view keeps. */
const RUN_PREVIEW = 6;

const STATUS_TONE: Readonly<Record<string, TspTone>> = {
	keep: "success",
	discard: "warning",
	crash: "error",
};

function header(title: string, arg?: TspSpan, status?: TspSpan): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: title }];
	if (status) spans.push({ t: " " }, status);
	if (arg?.t) spans.push({ t: " " }, arg);
	return spans;
}

function callView(spans: TspSpan[]): ToolView {
	return {
		label: spans,
		term: { look: "autoresearch", head: spans } satisfies AutoresearchTerm,
	};
}

function textView(text: string, muted = false): ToolView | undefined {
	if (!text) return undefined;
	const flat = replaceTabs(text);
	return {
		body: muted ? <text spans={[{ s: "muted", t: flat }]} wrap="word" /> : <text text={flat} wrap="word" />,
		term: { look: "autoresearch" } satisfies AutoresearchTerm,
	};
}

/** init_experiment args. */
export interface InitExperimentArgs {
	readonly name?: string;
}

export const initExperimentPresenter: ToolPresenter<InitExperimentArgs> = {
	call: args =>
		callView(
			header("init_experiment", {
				s: "accent",
				t: replaceTabs(args?.name ?? ""),
			}),
		),
	result: result => textView(resultText(result)),
};

/** update_notes args. */
export interface UpdateNotesArgs {
	readonly body?: string;
	readonly append_idea?: string;
}

export const updateNotesPresenter: ToolPresenter<UpdateNotesArgs> = {
	call: args => {
		const note = args?.append_idea ?? args?.body ?? "";
		return callView(
			header("update_notes", {
				s: "muted",
				t: replaceTabs(note).slice(0, NOTE_CHARS),
			}),
		);
	},
	result: result => textView(resultText(result), true),
};

/** log_experiment args. */
export interface LogExperimentArgs {
	readonly status?: string;
	readonly description?: string;
}

/** A logged experiment. */
export interface ExperimentDetails {
	readonly experiment?: {
		readonly status?: string;
		readonly description?: string;
		readonly metric?: number | null;
		readonly confidence?: number | null;
	};
	readonly state?: {
		readonly bestMetric?: number | null;
		readonly metricName?: string;
		readonly metricUnit?: string;
		readonly confidence?: number | null;
	};
	readonly scopeDeviations?: readonly string[];
}

/** `12.50ms`, `10ms`. */
function metricText(value: number, unit: string | undefined, fixed: boolean): string {
	return `${fixed ? value.toFixed(2) : String(value)}${unit ?? ""}`;
}

export const logExperimentPresenter: ToolPresenter<LogExperimentArgs, ExperimentDetails> = {
	call: args => {
		const status = args?.status;
		return callView(
			header(
				"log_experiment",
				{ s: "muted", t: replaceTabs(args?.description ?? "") },
				status ? { s: STATUS_TONE[status] ?? "muted", t: status } : undefined,
			),
		);
	},
	result(result): ToolView | undefined {
		const experiment = result.details?.experiment;
		if (!experiment) return textView(resultText(result));
		const state = result.details?.state;
		const status = experiment.status ?? "keep";
		const tone = STATUS_TONE[status] ?? "muted";
		const unit = state?.metricUnit;
		const name = state?.metricName ?? "metric";
		const items: { k: TspSpan[]; v: TspSpan[] }[] = [];
		const metric =
			experiment.metric !== undefined && experiment.metric !== null
				? metricText(experiment.metric, unit, true)
				: undefined;
		if (metric)
			items.push({
				k: [{ s: "muted", t: name }],
				v: [{ s: "accent num", t: metric }],
			});
		const baseline =
			state?.bestMetric !== undefined && state.bestMetric !== null
				? metricText(state.bestMetric, unit, false)
				: undefined;
		if (baseline)
			items.push({
				k: [{ s: "muted", t: "baseline" }],
				v: [{ s: "num", t: baseline }],
			});
		const confidence =
			state?.confidence !== undefined && state.confidence !== null && experiment.confidence != null
				? `${experiment.confidence}x`
				: undefined;
		if (confidence)
			items.push({
				k: [{ s: "muted", t: "confidence" }],
				v: [{ s: "num", t: confidence }],
			});
		const deviations = result.details?.scopeDeviations?.length ?? 0;
		if (deviations > 0)
			items.push({
				k: [{ s: "muted", t: "deviations" }],
				v: [{ s: "warning", t: String(deviations) }],
			});
		const description = replaceTabs(experiment.description ?? "");
		return {
			tone,
			body: [
				<row gap="sm">
					<badge text={status.toUpperCase()} tone={tone} />
					<text spans={[{ s: "muted", t: description }]} wrap="word" grow={1} />
				</row>,
				items.length > 0 ? <kv items={items} /> : undefined,
			],
			term: {
				look: "autoresearch",
				logged: {
					status: status.toUpperCase(),
					tone,
					description,
					metric: metric ? `${name}=${metric}` : undefined,
					baseline,
					confidence,
					deviations,
				},
			} satisfies AutoresearchTerm,
		};
	},
};

/** run_experiment args. */
export interface RunExperimentArgs {
	readonly command?: string;
}

/** A benchmark run's details (or its progress while running). */
export interface RunDetails {
	readonly phase?: string;
	readonly elapsed?: string;
	readonly runNumber?: number;
	readonly exitCode?: number | null;
	readonly durationSeconds?: number;
	readonly passed?: boolean;
	readonly crashed?: boolean;
	readonly timedOut?: boolean;
	readonly tailOutput?: string;
	readonly parsedPrimary?: number | null;
	readonly metricName?: string;
	readonly metricUnit?: string;
	readonly truncation?: unknown;
	readonly fullOutputPath?: string;
}

export const runExperimentPresenter: ToolPresenter<RunExperimentArgs, RunDetails> = {
	call: args =>
		callView(
			header("run_experiment", {
				s: "muted",
				t: replaceTabs(args?.command ?? "bash autoresearch.sh"),
			}),
		),
	result(result): ToolView | undefined {
		const details = result.details;
		const text = resultText(result);
		if (details?.phase === "running") {
			const elapsed = details.elapsed ?? "";
			return {
				tone: "warning",
				preview: { lines: RUN_PREVIEW },
				body: [
					<spinner label={[{ s: "warning", t: `Running ${elapsed}…` }]} />,
					text ? <ansi text={text} follow /> : undefined,
				],
				term: {
					look: "autoresearch",
					running: { elapsed, output: text },
				} satisfies AutoresearchTerm,
			};
		}
		if (!details || details.runNumber === undefined) return textView(text);
		const status = details.timedOut ? "TIMEOUT" : details.crashed ? "CRASH" : details.passed ? "PASS" : "FAIL";
		const tone: TspTone = status === "PASS" ? "success" : "error";
		const facts: string[] = [];
		if (status === "FAIL" && details.exitCode !== undefined && details.exitCode !== null)
			facts.push(`exit=${details.exitCode}`);
		if (details.durationSeconds !== undefined) facts.push(`${details.durationSeconds.toFixed(1)}s`);
		if (status === "PASS" && details.parsedPrimary !== undefined && details.parsedPrimary !== null)
			facts.push(`${details.metricName ?? "metric"}=${metricText(details.parsedPrimary, details.metricUnit, true)}`);
		const output = details.tailOutput ?? "";
		const fullOutputPath = details.truncation && details.fullOutputPath ? details.fullOutputPath : undefined;
		return {
			tone,
			preview: { lines: RUN_PREVIEW },
			body: [
				<row gap="sm">
					<badge text={status} tone={tone} />
					<text spans={[{ s: tone, t: facts.join(" ") }]} truncate="end" />
				</row>,
				output ? <ansi text={output} follow /> : undefined,
				fullOutputPath ? (
					<text
						spans={[
							{ s: "warning", t: "Full output: " },
							{ s: "path", t: fullOutputPath },
						]}
						truncate="middle"
					/>
				) : undefined,
			],
			term: {
				look: "autoresearch",
				run: { status, tone, facts: facts.join(" "), output, fullOutputPath },
			} satisfies AutoresearchTerm,
		};
	},
};

registerToolPresenter("init_experiment", initExperimentPresenter);
registerToolPresenter("log_experiment", logExperimentPresenter);
registerToolPresenter("run_experiment", runExperimentPresenter);
registerToolPresenter("update_notes", updateNotesPresenter);
