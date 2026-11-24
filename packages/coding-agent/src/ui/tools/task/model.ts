/**
 * What the task presenter and the task look both read from a call: the
 * spawn list of its args, the display order of agents, each result's
 * outcome, the run tally, a reviewer's verdict. Plain data, no styling.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { repairDoubleEncodedJsonString } from "../../../task/repair-args";
import {
	type AgentProgress,
	type FindingDetails,
	formatTaskId,
	parseFindingDetails,
	type SingleResult,
	type SubmitReviewDetails,
	type TaskParams,
	type YieldItem,
} from "../../../task/task-details";
import { assembleYieldResult, type YieldSectionShapes } from "../../../task/yield-sections";

/** Agent rows a collapsed list shows; the rest fold into one `… N more agents` row. */
export const COLLAPSED_AGENT_LIMIT = 4;
/** Nested task snapshots deeper than this are not drawn. */
export const MAX_NESTED_DEPTH = 8;

const ASSIGNMENT_PREFIX = /^\s*Complete assignment thoroughly:\s*/i;
const MISSING_YIELD_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

/** Untrusted text made safe for a row: escapes and controls dropped, tabs expanded. */
export function displayText(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** One-line task summary without the subagent prompt's fixed preamble. */
export function taskSummary(text: string): string {
	return displayText(text.replace(ASSIGNMENT_PREFIX, "")).replace(/[\r\n]+/g, " ");
}

/** A spawn's brief: its `task`, else its first step. */
export function taskPreviewText(task: unknown, steps: unknown): string {
	if (typeof task === "string") return task;
	return Array.isArray(steps) && typeof steps[0] === "string" ? steps[0] : "";
}

/** The first line of a (streaming) brief, trimmed; "" while it is not a string yet. */
export function taskFirstLine(task: unknown): string {
	if (typeof task !== "string") return "";
	const trimmed = sanitizeText(task).trim();
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? trimmed : trimmed.slice(0, newline);
}

/** The flat form's agent type, the head's target before anything spawned. */
export function flatAgentLabel(args: Partial<TaskParams> | undefined): string | undefined {
	const agent = typeof args?.agent === "string" ? args.agent.trim() : "";
	return agent || undefined;
}

/** The batch's shared context (markdown), cleaned. */
export function contextSource(args: Partial<TaskParams> | undefined): string {
	const context = typeof args?.context === "string" ? args.context : "";
	return sanitizeText(repairDoubleEncodedJsonString(context)).trim();
}

/** The flat call's brief (markdown): its `task`, else its steps as numbered sections. */
export function assignmentSource(args: Partial<TaskParams> | undefined): string {
	let brief = "";
	if (typeof args?.task === "string") brief = repairDoubleEncodedJsonString(args.task);
	else if (Array.isArray(args?.steps)) {
		brief = args.steps
			.flatMap((step, index) =>
				typeof step === "string" ? [`**Step ${index + 1}**\n\n${repairDoubleEncodedJsonString(step)}`] : [],
			)
			.join("\n\n");
	}
	return sanitizeText(brief).trim();
}

/** A spawn requested by the call's args (they stream in, so every field is checked). */
export interface RequestedSpawn {
	/** Display name (`#N` for an unnamed batch item, `agent` for an unnamed flat call). */
	readonly name: string;
	/** Node identity. */
	readonly key: string;
	readonly agent?: string;
	readonly brief: string;
	readonly steps?: number;
	readonly isolated: boolean;
	/** A batch item (its row shows `[isolated]`; the flat call's head says it). */
	readonly item: boolean;
}

/** The spawns a call requests: the flat form's one, then each batch item. */
export function requestedSpawns(args: Partial<TaskParams> | undefined): RequestedSpawn[] {
	const spawns: RequestedSpawn[] = [];
	if (!args) return spawns;
	const stepCount = (steps: unknown): number | undefined =>
		Array.isArray(steps) && steps.length > 0 ? steps.length : undefined;
	const agentOf = (agent: unknown): string | undefined =>
		typeof agent === "string" && agent.trim() ? agent.trim() : undefined;
	const flatName = typeof args.name === "string" ? args.name.trim() : "";
	const flatBrief = taskPreviewText(args.task, args.steps);
	if (flatName || taskFirstLine(flatBrief)) {
		spawns.push({
			name: flatName ? formatTaskId(flatName) : "agent",
			key: flatName || "agent",
			agent: agentOf(args.agent),
			brief: flatBrief,
			steps: stepCount(args.steps),
			isolated: args.isolated === true,
			item: false,
		});
	}
	if (Array.isArray(args.tasks)) {
		args.tasks.forEach((entry, index) => {
			const name = typeof entry?.name === "string" ? entry.name.trim() : "";
			spawns.push({
				name: name ? formatTaskId(name) : `#${index + 1}`,
				key: name || `#${index + 1}`,
				agent: agentOf(entry?.agent),
				brief: taskPreviewText(entry?.task, entry?.steps),
				steps: stepCount(entry?.steps),
				isolated: entry?.isolated === true,
				item: true,
			});
		});
	}
	return spawns;
}

/** Settled agents by runtime (then dispatch order). */
export function orderResults(results: readonly SingleResult[]): SingleResult[] {
	return [...results].sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
}

/** Finished agents first (by runtime), live ones after them in dispatch order. */
export function orderProgress(progress: readonly AgentProgress[]): AgentProgress[] {
	const finished: AgentProgress[] = [];
	const live: AgentProgress[] = [];
	for (const p of progress) (p.status === "pending" || p.status === "running" ? live : finished).push(p);
	finished.sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
	return finished.concat(live);
}

/** The results a collapsed list keeps: problems first, then the fastest, in display order. */
export function pickCollapsedResults(ordered: readonly SingleResult[]): readonly SingleResult[] {
	if (ordered.length <= COLLAPSED_AGENT_LIMIT) return ordered;
	const picked = new Set<SingleResult>();
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		if (result.aborted || result.exitCode !== 0 || result.error) picked.add(result);
	}
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		picked.add(result);
	}
	return ordered.filter(result => picked.has(result));
}

/** How one agent ended. */
export interface ResultOutcome {
	readonly aborted: boolean;
	/** The agent succeeded; folding its work back did not. */
	readonly mergeFailed: boolean;
	readonly success: boolean;
	/** The missing-yield warning heading its output, if any. */
	readonly missingYield?: string;
	/** The output without that warning. */
	readonly output: string;
}

/** The outcome of a settled agent. */
export function resultOutcome(result: SingleResult): ResultOutcome {
	const aborted = result.aborted ?? false;
	const lines = result.output.split("\n");
	const first = lines[0]?.trim() ?? "";
	const missingYield = first.startsWith(MISSING_YIELD_PREFIX) ? first : undefined;
	const output = missingYield
		? lines
				.slice(1)
				.join("\n")
				.replace(/^\s*\n+/, "")
		: result.output;
	return {
		aborted,
		mergeFailed: !aborted && result.exitCode === 0 && !!result.error,
		success: !aborted && result.exitCode === 0 && !result.error,
		missingYield,
		output,
	};
}

/** Counts over a run's settled agents. */
export interface RunTally {
	readonly aborted: number;
	readonly failed: number;
	readonly mergeFailed: number;
	readonly succeeded: number;
	readonly requests: number;
}

export function runTally(results: readonly SingleResult[]): RunTally {
	let aborted = 0;
	let failed = 0;
	let mergeFailed = 0;
	let succeeded = 0;
	let requests = 0;
	for (const r of results) {
		requests += r.requests ?? 0;
		if (r.aborted) aborted++;
		else if (r.exitCode !== 0) failed++;
		else if (r.error) mergeFailed++;
		else succeeded++;
	}
	return { aborted, failed, mergeFailed, succeeded, requests };
}

/** The trailing notices of a run's text result (patch application, system notifications), nonblank lines. */
export function noticeLines(text: string): string[] {
	const lines = text.split("\n");
	const start = lines.findIndex(
		line =>
			line.includes("<system-notification>") ||
			line.startsWith("Applied patches:") ||
			line.startsWith("No changes to apply."),
	);
	return start < 0 ? [] : lines.slice(start).filter(line => line.trim());
}

/** The first text block of a result. */
export function resultText(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

/** One `yield` record from extracted data. */
export interface YieldRecord {
	readonly data?: unknown;
	readonly type?: string | string[];
	readonly status?: string;
}

/** The `yield` slot of extracted data as records (a stray single object counts as one). */
export function yieldRecords(value: unknown): YieldRecord[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const out: YieldRecord[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		let type: YieldRecord["type"];
		if (typeof record.type === "string") type = record.type;
		else if (Array.isArray(record.type) && record.type.every(label => typeof label === "string"))
			type = record.type as string[];
		out.push({ data: record.data, type, status: typeof record.status === "string" ? record.status : undefined });
	}
	return out;
}

/** A yield record's section labels. */
export function yieldLabels(type: YieldRecord["type"]): string[] {
	const labels = typeof type === "string" ? [type] : Array.isArray(type) ? type : [];
	return labels.map(label => label.trim()).filter(Boolean);
}

/** Reviewer output shapes: findings accumulate, the verdict fields are scalars. */
const REVIEW_SHAPES: YieldSectionShapes = new Map([
	["findings", "array"],
	["overall_correctness", "scalar"],
	["explanation", "scalar"],
	["confidence", "scalar"],
]);

/** A reviewer's verdict and findings. */
export interface ReviewVerdict {
	readonly summary: SubmitReviewDetails;
	readonly findings: readonly FindingDetails[];
}

/** The review a reviewer's yields assemble into, else the last legacy verdict object, else undefined. */
export function reviewVerdict(records: readonly YieldRecord[]): ReviewVerdict | undefined {
	const items: YieldItem[] = records.map(item => ({
		data: item.data,
		type: item.type,
		status: item.status === "aborted" ? "aborted" : item.status === "success" ? "success" : undefined,
	}));
	const data = assembleYieldResult(items, REVIEW_SHAPES)?.data;
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const record = data as Record<string, unknown>;
		const verdict = record.overall_correctness;
		if (
			(verdict === "correct" || verdict === "incorrect") &&
			typeof record.explanation === "string" &&
			typeof record.confidence === "number"
		) {
			const findings: FindingDetails[] = [];
			if (Array.isArray(record.findings)) {
				for (const item of record.findings) {
					const finding = parseFindingDetails(item);
					if (finding) findings.push(finding);
				}
			}
			return {
				summary: { overall_correctness: verdict, explanation: record.explanation, confidence: record.confidence },
				findings,
			};
		}
	}
	const legacy = records
		.map(item => item.data)
		.filter(
			(entry): entry is SubmitReviewDetails =>
				entry !== null && typeof entry === "object" && "overall_correctness" in entry,
		);
	const last = legacy.at(-1);
	return last ? { summary: last, findings: [] } : undefined;
}
