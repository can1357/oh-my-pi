/**
 * Turn-card markdown: the header (title, duration, cost, context), the todo
 * plan checklist and the tool-step lines, including the collapse of older
 * steps under a `<details>` block.
 *
 * Native port of the lifeos activity renderer; all text is English.
 */
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { mdCode, mdText, plural } from "./rich";
import { clip } from "./text";

/** Status of the turn a card describes. */
export type ActivityStatus = "running" | "done" | "stopped" | "failed";

/** Lifecycle of one tool step inside a card. */
export type StepStatus = "running" | "ok" | "error";

/** One executed tool call. */
export interface ToolStep {
	kind: "tool";
	callId: string | null;
	name: string;
	arg: string | null;
	status: StepStatus;
	startedAt: number | null;
	endedAt: number | null;
}

/** A line the conveyor adds without a tool call (retry, compaction, …). */
export interface NoticeStep {
	kind: "notice";
	icon: string | null;
	label: string;
}

export type ActivityStep = ToolStep | NoticeStep;

/** One checklist entry taken from the todo tool's phases. */
export interface PlanTask {
	content: string;
	status: string;
}

/** Everything the markdown needs for one publish. */
export interface ActivityState {
	status: ActivityStatus;
	startedAt: number | null;
	now: number;
	steps: readonly ActivityStep[];
	plan: readonly PlanTask[];
	cost: number | null;
	contextPercent: number | null;
	error: string | null;
}

const ICON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
	[/^(read|view|cat)/u, "📖"],
	[/^(edit|write|apply_patch|notebook_edit)/u, "✏️"],
	[/^(bash|shell|exec|process)/u, "💻"],
	[/^(web|browser|fetch|http|search_web)/u, "🌐"],
	[/^(grep|glob|find|search|scout|recon)/u, "🔍"],
	[/^(task|agent|subagent|workpool)/u, "🤖"],
	[/^eval/u, "🧮"],
	[/^todo/u, "📋"],
	[/^(ask|question)/u, "❓"],
	[/^lsp/u, "🧭"],
];
const COUNTED_ARGS: ReadonlyArray<readonly [string, string, string]> = [
	["tasks", "agent", "agents"],
	["phases", "phase", "phases"],
	["images", "image", "images"],
];
const ARG_FIELDS = [
	"command",
	"file_path",
	"filePath",
	"file",
	"pattern",
	"path",
	"url",
	"query",
	"prompt",
	"message",
	"text",
	"sessionPath",
	"sessionId",
	"model",
	"level",
	"i",
];
const ARGUMENT_LIMIT = 75;
const NAME_LIMIT = 40;
const VISIBLE_STEPS = 8;
const TITLES: Record<ActivityStatus, string> = {
	running: "⚙️ Working",
	done: "✅ Done",
	stopped: "⏹ Stopped",
	failed: "⚠️ Failed",
};

/** Best one-line argument for a tool call: a known field, else the caller's intent. */
export function argumentOf(args: unknown, intent = ""): string | null {
	if (args !== null && typeof args === "object" && !Array.isArray(args)) {
		const fields = args as Record<string, unknown>;
		for (const [field, one, many] of COUNTED_ARGS) {
			const value = fields[field];
			if (Array.isArray(value) && value.length > 0) return `${value.length} ${plural(value.length, one, many)}`;
		}
		for (const field of ARG_FIELDS) {
			const value = fields[field];
			if (typeof value === "string" && value.trim() !== "") return value.split("\n", 1)[0];
		}
	}
	const fallback = intent.trim();
	return fallback === "" ? null : fallback.split("\n", 1)[0];
}

/** Flattens the todo tool's phases into the checklist the card renders. */
export function planTasks(phases: readonly TodoPhase[] | null): PlanTask[] {
	const tasks: PlanTask[] = [];
	for (const phase of phases ?? []) {
		for (const task of phase?.tasks ?? [])
			tasks.push({ content: String(task?.content ?? ""), status: String(task?.status ?? "") });
	}
	return tasks;
}

/** Emoji that names the kind of tool a step ran. */
export function toolIcon(name: string): string {
	const tool = name.toLowerCase();
	for (const [pattern, icon] of ICON_RULES) if (pattern.test(tool)) return icon;
	return "🔧";
}

/** Builds a fresh running step for a tool call. */
export function toolStep(params: { toolName: string; args?: unknown; intent?: string; at?: number | null }): ToolStep {
	const detail = argumentOf(params.args, params.intent ?? "");
	return {
		kind: "tool",
		callId: null,
		name: clip(params.toolName.split("\n", 1)[0], NAME_LIMIT),
		arg: detail === null ? null : clip(detail, ARGUMENT_LIMIT),
		status: "running",
		startedAt: params.at ?? null,
		endedAt: null,
	};
}

function percentText(percent: number | null): string | null {
	return percent === null || !Number.isFinite(percent) ? null : `${percent.toFixed(1)}%`;
}

function costText(cost: number | null): string | null {
	if (cost === null || !Number.isFinite(cost)) return null;
	return `$${cost.toFixed(cost < 0.1 ? 4 : 2)}`;
}

function stepLine(step: ActivityStep): string {
	if (step.kind === "notice") return `- ${step.icon ?? "🔔"} ${mdText(step.label)}`;
	const status = step.status === "ok" ? "✅" : step.status === "error" ? "❌" : "⏳";
	let line = `- ${status} ${toolIcon(step.name)} ${mdCode(step.name)}`;
	if (step.arg !== null && step.arg !== "") line += ` ${mdCode(step.arg)}`;
	if (step.startedAt !== null && step.endedAt !== null)
		line += ` · ${formatDuration(Math.max(0, step.endedAt - step.startedAt))}`;
	return line;
}

function details(summary: string, lines: readonly string[]): string {
	return `<details><summary>${summary}</summary>\n\n${lines.join("\n")}\n\n</details>`;
}

function stepsBlock(state: ActivityState): string {
	if (state.steps.length === 0) return "";
	if (state.status !== "running") return details(`Steps (${state.steps.length})`, state.steps.map(stepLine));
	const hidden = state.steps.slice(0, -VISIBLE_STEPS);
	const blocks = state.steps.slice(-VISIBLE_STEPS).map(stepLine);
	if (hidden.length > 0) {
		const more = `${hidden.length} more ${plural(hidden.length, "step", "steps")}`;
		blocks.unshift(details(more, hidden.map(stepLine)));
	}
	return blocks.join("\n");
}

function planBlock(plan: readonly PlanTask[]): string {
	if (plan.length === 0) return "";
	const lines = plan.map(task => `- [${task.status === "completed" ? "x" : " "}] ${mdText(task.content)}`);
	return ["**📋 Plan**", ...lines].join("\n");
}

function header(state: ActivityState): string {
	const bits: string[] = [];
	if (state.steps.length > 0) bits.push(`${state.steps.length} ${plural(state.steps.length, "step", "steps")}`);
	const elapsed =
		state.startedAt !== null && Number.isFinite(state.startedAt) ? Math.max(0, state.now - state.startedAt) : 0;
	bits.push(formatDuration(elapsed));
	if (state.status !== "running") {
		const cost = costText(state.cost);
		if (cost !== null) bits.push(cost);
		const context = percentText(state.contextPercent);
		if (context !== null) bits.push(`context ${context}`);
	}
	let title = TITLES[state.status];
	if (state.status === "failed" && state.error !== null && state.error.trim() !== "")
		title += `: ${mdText(state.error.trim())}`;
	return `**${title}** · ${bits.join(" · ")}`;
}

/** Renders the whole card. */
export function activityMarkdown(state: ActivityState): string {
	const blocks = [header(state)];
	const plan = planBlock(state.plan);
	if (plan !== "") blocks.push(plan);
	const steps = stepsBlock(state);
	if (steps !== "") blocks.push(steps);
	return blocks.join("\n\n");
}
