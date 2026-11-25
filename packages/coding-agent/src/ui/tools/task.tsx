/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Task (subagent spawns): the batch's shared context, then one `agent` node
 * per subagent: pending while the call streams, live from progress
 * snapshots, settled from results (its children: the assignment, notes,
 * errors, the output, artifacts and nested agents). The head counts agents
 * and, once results exist, tallies the run.
 *
 * Terminal look: `task` (`src/ui/styles/tools/task.ts`), which draws the
 * classic card from the call's raw facts (`term.task`): context and brief as
 * markdown, the spawn list or agent rows, the run footer. Agent names take
 * their session identity colour (`agent-identity.ts`).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { formatDuration, formatNumber, pluralize, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspAgentProps, TspPropNode, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import type { ConfiguredThinkingLevel } from "../../utils/render-utils";
import { repairDoubleEncodedJsonString } from "../../task/repair-args";
import {
	type AgentProgress,
	formatTaskId,
	isTaskToolDetails,
	type SingleResult,
	type TaskParams,
	type TaskToolDetails,
} from "../../task/task-details";
import { shortenPath } from "../../utils/render-utils";
import { stripGeneratedOutputNotice } from "../../tools/output-meta-format";
import { expandKeyLabel } from "../keys/hints";
import { ErrorText, NoteText } from "./agent-common";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { registerToolPresenter } from "./registry";
import {
	contextSource,
	flatAgentLabel,
	MAX_NESTED_DEPTH,
	noticeLines,
	orderProgress,
	orderResults,
	requestedSpawns,
	resultOutcome,
	resultText,
	runTally,
	taskSummary,
} from "./task/model";
import { type Line, linesToSpans, nestedResultLines, type RowContext, toolCallDetail } from "./task/rows";

/** What the task look draws from (`term.task`). */
export interface TaskTerm {
	readonly phase: "call" | "result";
	readonly args: Partial<TaskParams> | undefined;
	/** A result snapshot exists (the call view then draws no spawn list). */
	readonly hasResult: boolean;
	/** The transcript clock time-derived rows sample. */
	readonly nowMs: number;
	/** The card left the live region: live rows draw dim. */
	readonly frozen: boolean;
	readonly details?: TaskToolDetails;
	/** The result's text. */
	readonly text?: string;
	readonly isError?: boolean;
	readonly isPartial?: boolean;
}

interface TaskRenderContext {
	readonly hasResult?: boolean;
	readonly nowMs?: number;
	readonly frozen?: boolean;
}

function renderContextOf(state: ToolViewState): TaskRenderContext {
	return (state.renderContext ?? {}) as TaskRenderContext;
}

/** The batch context as one quiet line above the agents. */
function ContextLine(props: { readonly args: Partial<TaskParams> | undefined }): JSXNode {
	const line = contextSource(props.args).replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return <text spans={[{ s: "muted", t: line }]} wrap="word" lines={2} role="omp.tool.context" />;
}

/** A brief as markdown (an agent's first child and its row's hover card); undefined when empty. */
function assignmentNode(raw: string | undefined): TspPropNode | undefined {
	const text = raw ? sanitizeText(repairDoubleEncodedJsonString(raw)).trim() : "";
	return text ? { k: "md", p: { role: "omp.task.assignment", text } } : undefined;
}

function Assignment(props: { readonly node: TspPropNode | undefined }): JSXNode {
	if (props.node?.k !== "md") return undefined;
	return <md role="omp.task.assignment" text={props.node.p?.text ?? ""} />;
}

function errorLine(message: string, token = "error"): JSXNode {
	return <text role="omp.tool.error" spans={[{ s: token, t: message }]} wrap="word" />;
}

function thinkingToken(level: ConfiguredThinkingLevel | undefined): string | undefined {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
		case "max":
			return "thinkingXhigh";
		default:
			return undefined;
	}
}

/** Context fill and its `19K / 200K` label. */
function contextStats(
	tokens: number | undefined,
	window: number | undefined,
): Pick<NonNullable<TspAgentProps["stats"]>, "context" | "contextLabel"> {
	if (!tokens || tokens <= 0) return {};
	if (!window || window <= 0) return { contextLabel: formatNumber(tokens) };
	return { context: Math.min(1, tokens / window), contextLabel: `${formatNumber(tokens)} / ${formatNumber(window)}` };
}

interface DescribeState {
	readonly nowMs: number;
	readonly expanded: boolean;
	readonly background: boolean;
	readonly seen: Set<object>;
}

/** Child task snapshots an agent carries, as nested agent nodes. */
function nestedAgents(
	source: { readonly extractedToolData?: Record<string, unknown[]>; readonly inflightTaskDetails?: TaskToolDetails },
	state: DescribeState,
	depth: number,
): JSXNode[] {
	const snapshots = (source.extractedToolData?.task ?? []).filter(isTaskToolDetails);
	if (source.inflightTaskDetails) snapshots.push(source.inflightTaskDetails);
	const out: JSXNode[] = [];
	for (const details of snapshots) {
		if (state.seen.has(details)) {
			out.push(<NoteText message="↻ nested task cycle" token="dim" />);
			continue;
		}
		if (depth >= MAX_NESTED_DEPTH) {
			out.push(<NoteText message="… nested task depth limit reached" token="dim" />);
			continue;
		}
		state.seen.add(details);
		out.push(...agentNodes(details, state, depth + 1));
		state.seen.delete(details);
	}
	return out;
}

function progressAgent(progress: AgentProgress, state: DescribeState, depth: number): JSXNode {
	const { nowMs } = state;
	const running = progress.status === "running";
	const status: TspAgentProps["status"] = progress.status === "completed" ? "done" : progress.status;
	const tool =
		running && progress.currentTool
			? {
					name: sanitizeText(progress.currentTool),
					intent:
						sanitizeText(
							toolCallDetail(progress.currentToolIntent, progress.currentToolArgs, progress.currentToolArgsKey),
						) || undefined,
					age: progress.currentToolStartMs ? Math.max(0, nowMs - progress.currentToolStartMs) : undefined,
				}
			: null;
	const summary = taskSummary(progress.description || progress.assignment || progress.task);
	const stage = running && progress.stage ? sanitizeText(progress.stage) : "";
	const task: TspAgentProps["task"] = stage
		? summary
			? [{ t: summary }, { s: "muted", t: ` · ${stage}` }]
			: stage
		: summary || undefined;
	const assignment = assignmentNode(progress.assignment ?? progress.task);
	const retry =
		running && progress.retryState
			? {
					attempt: progress.retryState.attempt,
					max: progress.retryState.maxAttempts,
					age: Math.max(0, nowMs - progress.retryState.startedAtMs),
					delay: progress.retryState.delayMs,
					error: sanitizeText(progress.retryState.errorMessage),
				}
			: null;
	const failure = progress.retryFailure;
	return (
		<agent
			key={progress.id}
			name={formatTaskId(progress.id)}
			agent={progress.agent || undefined}
			task={task}
			status={status}
			model={progress.resolvedModelIdentity ?? progress.resolvedModel}
			thinking={thinkingToken(progress.resolvedThinkingLevel)}
			tool={tool}
			stats={{
				tools: progress.toolCount || undefined,
				requests: progress.requests || undefined,
				tokens: progress.tokens || undefined,
				...contextStats(progress.contextTokens, progress.contextWindow),
				done: running && progress.completionPercent !== undefined ? progress.completionPercent / 100 : undefined,
				cost: progress.cost > 0 ? progress.cost : undefined,
				...(running ? { age: Math.max(0, progress.durationMs) } : { took: progress.durationMs }),
			}}
			retry={retry}
			badges={state.background ? [{ text: "background" }] : undefined}
			depth={depth > 0 ? depth : undefined}
			collapsible
			collapsed={!state.expanded}
			hovercard={assignment}
		>
			<Assignment node={assignment} />
			{progress.resolvedModelRoute ? <NoteText message={progress.resolvedModelRoute} token="dim" /> : undefined}
			{!running && failure
				? errorLine(
						`auto-retry gave up after ${failure.attempt} ${pluralize("attempt", failure.attempt)}: ${sanitizeText(failure.errorMessage)}`,
					)
				: undefined}
			{nestedAgents(progress, state, depth)}
		</agent>
	);
}

function resultAgent(result: SingleResult, state: DescribeState, depth: number): JSXNode {
	const outcome = resultOutcome(result);
	const { aborted, mergeFailed, success } = outcome;
	const status: TspAgentProps["status"] = aborted ? "aborted" : success || mergeFailed ? "done" : "failed";
	const output = sanitizeText(stripGeneratedOutputNotice(outcome.output)).trim();
	const badges: { text: string; tone?: TspTone }[] = [];
	if (state.background) badges.push({ text: "background" });
	if (result.isolated) badges.push({ text: "isolated" });
	if (mergeFailed) badges.push({ text: "merge failed", tone: "warning" });
	else if (outcome.missingYield && success) badges.push({ text: "warning", tone: "warning" });
	if (result.truncated) badges.push({ text: "truncated", tone: "warning" });
	const cost = result.usage?.cost.total ?? 0;
	const assignment = assignmentNode(result.assignment ?? result.task);
	const structured = result.structuredOutput?.data;
	const artifacts: { k: TspSpan[]; v: string }[] = [];
	if (result.patchPath && result.hasRootChanges !== false && success)
		artifacts.push({ k: [{ s: "muted", t: "Patch" }], v: shortenPath(result.patchPath) });
	if (result.branchName && success)
		artifacts.push({ k: [{ s: "muted", t: "Branch" }], v: sanitizeText(result.branchName) });
	return (
		<agent
			key={result.id}
			name={formatTaskId(result.id)}
			agent={result.agent || undefined}
			task={taskSummary(result.description || result.assignment || result.task) || undefined}
			status={status}
			model={result.resolvedModelIdentity ?? result.resolvedModel}
			thinking={thinkingToken(result.resolvedThinkingLevel)}
			tool={null}
			stats={{
				requests: result.requests || undefined,
				tokens: result.tokens || undefined,
				...contextStats(result.contextTokens, result.contextWindow),
				cost: cost > 0 ? cost : undefined,
				took: result.durationMs,
			}}
			retry={null}
			badges={badges.length > 0 ? badges : undefined}
			depth={depth > 0 ? depth : undefined}
			collapsible
			collapsed={!state.expanded}
			hovercard={assignment}
		>
			<Assignment node={assignment} />
			{result.resolvedModelRoute ? <NoteText message={result.resolvedModelRoute} token="dim" /> : undefined}
			{aborted && result.abortReason ? errorLine(sanitizeText(result.abortReason)) : undefined}
			{outcome.missingYield ? errorLine(outcome.missingYield, "warning") : undefined}
			{result.error ? errorLine(sanitizeText(result.error)) : undefined}
			{result.retryFailure
				? errorLine(`auto-retry gave up: ${sanitizeText(result.retryFailure.errorMessage)}`)
				: undefined}
			{structured !== undefined ? (
				<json value={structured} open={1} />
			) : output ? (
				<md role="omp.task.output" text={output} />
			) : undefined}
			{result.stderr.trim() && !success ? <ansi text={result.stderr} preview={{ lines: 6 }} /> : undefined}
			{artifacts.length > 0 ? <kv items={artifacts} /> : undefined}
			{nestedAgents(result, state, depth)}
		</agent>
	);
}

/** Agent nodes of a snapshot: settled results, then live spawns without a result. */
function agentNodes(details: TaskToolDetails, state: DescribeState, depth: number): JSXNode[] {
	const nodes = orderResults(details.results).map(result => resultAgent(result, state, depth));
	const settled = new Set(details.results.map(result => result.id));
	for (const progress of orderProgress(details.progress ?? []))
		if (!settled.has(progress.id)) nodes.push(progressAgent(progress, state, depth));
	return nodes;
}

function agentCount(count: number): string {
	return `${count} ${pluralize("agent", count)}`;
}

function termFacts(
	state: ToolViewState,
	args: Partial<TaskParams> | undefined,
	extra: Partial<TaskTerm>,
): { task: TaskTerm } {
	const context = renderContextOf(state);
	return {
		task: {
			phase: "call",
			args,
			hasResult: context.hasResult === true,
			nowMs: context.nowMs ?? Date.now(),
			frozen: context.frozen === true,
			...extra,
		},
	};
}

function callView(args: Partial<TaskParams> | undefined, state: ToolViewState): ToolView {
	const spawns = requestedSpawns(args);
	const target = spawns.length > 1 ? agentCount(spawns.length) : flatAgentLabel(args);
	const agents = spawns.map(spawn => {
		const assignment = assignmentNode(spawn.brief || undefined);
		return (
			<agent
				key={spawn.key}
				name={spawn.name}
				agent={spawn.agent}
				task={taskSummary(spawn.brief) || undefined}
				status="pending"
				badges={spawn.isolated ? [{ text: "isolated" }] : undefined}
				hovercard={assignment}
			/>
		);
	});
	return {
		head: { title: "Task", target, targetKind: target ? "text" : undefined },
		body: [<ContextLine args={args} />, ...agents],
		term: termFacts(state, args, {}),
	};
}

function resultView(
	result: ToolResult<TaskToolDetails>,
	state: ToolViewState,
	args: Partial<TaskParams> | undefined,
): ToolView {
	const details = result.details;
	const text = resultText(result);
	const label = flatAgentLabel(args);
	const term = termFacts(state, args, {
		phase: "result",
		details,
		text,
		isError: result.isError === true,
		isPartial: state.isPartial,
	});
	// An aborted or synthetic TASK result persists details without `results`
	// (`{}`, `{"__synthetic":true,…}`): render it as the plain result, or the
	// task card throws on the missing list and a session holding one cannot resume.
	if (!isTaskToolDetails(details)) {
		const fallback = text.trim();
		if (result.isError) {
			return {
				head: { title: "Task", target: label, targetKind: "text" },
				tone: "error",
				body: [<ContextLine args={args} />, <ErrorText message={fallback || "Task failed"} />],
				term,
			};
		}
		return {
			head: { title: "Task", target: label, targetKind: label ? "text" : undefined },
			body: [<ContextLine args={args} />, fallback ? <NoteText message={fallback} token="dim" /> : undefined],
			term,
		};
	}
	const describe: DescribeState = {
		nowMs: term.task.nowMs,
		expanded: state.expanded,
		background: details.async !== undefined,
		seen: new Set(),
	};
	const agents = agentNodes(details, describe, 0);
	const tally = runTally(details.results);
	const summary: string[] = [];
	if (details.results.length > 0) {
		if (tally.succeeded) summary.push(`${tally.succeeded} succeeded`);
		if (tally.failed) summary.push(`${tally.failed} failed`);
		if (tally.aborted) summary.push(`${tally.aborted} aborted`);
		if (tally.requests) summary.push(`${formatNumber(tally.requests)} req`);
		summary.push(formatDuration(details.totalDurationMs));
	}
	const trailer = noticeLines(text).join("\n");
	const target = agents.length > 0 ? agentCount(agents.length) : label;
	return {
		head: {
			title: "Task",
			target,
			targetKind: target ? "text" : undefined,
			meta: summary.length > 0 ? [summary.join(" · ")] : undefined,
			badges: describe.background ? [{ text: "background" }] : undefined,
		},
		tone: tally.aborted + tally.failed > 0 ? "error" : undefined,
		preview: "none",
		body: [
			<ContextLine args={args} />,
			...agents,
			agents.length === 0 ? <NoteText message={text.trim() || "No results"} token="dim" /> : undefined,
			trailer ? (
				<text role="omp.tool.stats" spans={[{ s: "muted", t: sanitizeText(trailer) }]} wrap="word" />
			) : undefined,
		],
		term,
	};
}

export const taskPresenter: ToolPresenter<Partial<TaskParams>, TaskToolDetails> = {
	merge: true,
	call: (args, state) => callView(args, state),
	result: (result, state, args) => resultView(result, state, args),
};

registerToolPresenter("task", taskPresenter);

/** Glyphs of nested rows sent natively (the terminal look draws its theme's). */
const UNICODE_SYMBOLS = presetSymbols("unicode");

/**
 * Settled child task snapshots as a tree of agent rows (the task card's
 * nested results; the `task` subprocess view): one `text` node, its rows as
 * spans; the terminal look (`omp.task.nested`) redraws them with the theme's
 * glyphs and agent identity colours.
 */
export function NestedTaskResults(props: {
	readonly snapshots: readonly TaskToolDetails[];
	readonly expanded: boolean;
}): JSXNode {
	const cx: RowContext = {
		glyph: key => UNICODE_SYMBOLS[key] ?? "",
		expandKey: () => expandKeyLabel(currentTheme()),
		expanded: props.expanded,
		nowMs: Date.now(),
		frozen: false,
	};
	const lines: Line[] = nestedResultLines(cx, props.snapshots, Number.POSITIVE_INFINITY);
	return (
		<text
			spans={linesToSpans(lines)}
			wrap="word"
			term={{ role: "omp.task.nested", snapshots: props.snapshots, expanded: props.expanded }}
		/>
	);
}
