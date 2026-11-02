/**
 * Live status board for `omp cleanse`.
 *
 * Interactive terminals get a transient board repainted in place: a phase
 * spinner (model resolution, checker discovery), one row per running checker,
 * and one row per repair subagent showing its latest intent, current tool,
 * tool count, and elapsed time from {@link AgentProgress} snapshots. Finished
 * work is promoted to permanent scrollback lines as it settles.
 *
 * Non-TTY output keeps the original plain-line protocol
 * (`[start]`/`[done]`/`[fail]`), so scripted callers see unchanged output.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { sanitizeDisplaySingleLine } from "../overlays/extensions/display-text";
import { truncateToWidth } from "../utils";
import { renderProgressBar, type ProgressBarStyle } from "../components/progress-bar";
import { fgOrPlain, theme } from "../theme/theme";
import { createLiveBoard, type LiveBoardOutput } from "../chrome/live-board";
import type { AgentProgress } from "../tools/task";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { col, elapsed, keyed, node, row, span, stableKey, text } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { Memo } from "../native/memo";

/** Checker identity shown in live rows and verdicts. */
export interface CleanseCheckerDescriptor {
	id: string;
	label: string;
}

/** Checker result fields consumed by the verdict line. */
export interface CleanseCheckResult extends CleanseCheckerDescriptor {
	diagnostics: readonly unknown[];
}

/** Repair workload fields displayed in agent rows. */
export interface CleanseAssignment {
	index: number;
	groups: readonly { file?: string }[];
	weight: number;
}

/** Completion fields displayed when a repair agent settles. */
export interface CleanseAgentOutcome {
	name: string;
	success: boolean;
	error?: string;
	resolvedModel?: string;
}

const BAR_WIDTH = 16;
const ACTIVITY_WIDTH = 96;
const ERROR_WIDTH = 300;

const REPAIR_BAR_STYLE: ProgressBarStyle = {
	filled: "█",
	empty: "░",
	styleFilled: text => fgOrPlain("accent", text),
	styleEmpty: text => fgOrPlain("dim", text),
};

/** Rendering surface for one `omp cleanse` run. */
export interface CleanseStatusBoard {
	readonly interactive: boolean;
	/** Print a permanent line above the live area (plain write when non-TTY). */
	log(text: string): void;
	/** Show a transient spinner line; `undefined` clears it. Non-TTY prints the text once. */
	phase(text: string | undefined): void;
	checkerStarted(checker: CleanseCheckerDescriptor): void;
	checkerFinished(check: CleanseCheckResult, durationMs: number): void;
	/** End the repair phase and drop its live rows before verification. */
	repairFinished(): void;
	agentStarted(name: string, assignment: CleanseAssignment): void;
	agentProgress(name: string, progress: AgentProgress): void;
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): void;
	/** Clear the live area and restore the cursor. Idempotent. */
	close(): void;
}

interface RunningChecker {
	label: string;
	startedAt: number;
}

interface RunningAgent {
	assignment: CleanseAssignment;
	startedAt: number;
	progress?: AgentProgress;
}

/**
 * Live-view state for one cleanse run, shared by the CLI stdout board and the
 * interactive-mode overlay panel so both surfaces render identical rows.
 *
 * Mutators mirror {@link CleanseStatusBoard}; the finish mutators return the
 * permanent line the surface should log above the live area.
 */
export class CleanseBoardModel {
	#phaseText: string | undefined;
	readonly #checkers = new Map<string, RunningChecker>();
	readonly #agents = new Map<string, RunningAgent>();
	/** Lifetime token/cost totals per agent; survives row removal for the header sums. */
	readonly #totals = new Map<string, { tokens: number; cost: number }>();
	#repairTotal = 0;
	#repairDone = 0;
	#repairStartedAt = 0;
	/** Bumped by every mutator that changes the live rows; keys the native memo. */
	#version = 0;
	readonly #native = new Memo();
	#lastSettled: NativeNode | undefined;

	phase(text: string | undefined): void {
		this.#phaseText = text;
		this.#version += 1;
	}

	checkerStarted(checker: CleanseCheckerDescriptor): void {
		this.#checkers.set(checker.id, { label: checker.label, startedAt: Date.now() });
		this.#version += 1;
	}

	/** Drop the checker's live row and build its permanent verdict line. */
	checkerFinished(check: CleanseCheckResult, durationMs: number): string {
		this.#checkers.delete(check.id);
		this.#version += 1;
		const count = check.diagnostics.length;
		const tone = count === 0 ? "success" : "warning";
		this.#lastSettled = text(
			[
				span(count === 0 ? "✓ " : "● ", tone),
				span(`${check.label} `),
				span(count === 0 ? "clean" : `${count} issue${count === 1 ? "" : "s"}`, tone),
				span(` · ${formatDuration(durationMs)}`, "dim"),
			],
			{ wrap: "word", role: "omp.cleanse.verdict" },
		);
		const verdict =
			count === 0 ? fgOrPlain("success", "clean") : fgOrPlain("warning", `${count} issue${count === 1 ? "" : "s"}`);
		const glyph = count === 0 ? fgOrPlain("success", "✓") : fgOrPlain("warning", "●");
		return `${glyph} ${check.label} ${verdict} ${fgOrPlain("dim", `· ${formatDuration(durationMs)}`)}`;
	}

	repairFinished(): void {
		this.#repairTotal = 0;
		this.#repairDone = 0;
		this.#agents.clear();
		this.#version += 1;
	}

	agentStarted(name: string, assignment: CleanseAssignment): void {
		if (this.#repairStartedAt === 0) this.#repairStartedAt = Date.now();
		this.#repairTotal += 1;
		this.#agents.set(name, { assignment, startedAt: Date.now() });
		this.#version += 1;
	}

	agentProgress(name: string, progress: AgentProgress): void {
		this.#totals.set(name, { tokens: progress.tokens, cost: progress.cost });
		const agent = this.#agents.get(name);
		if (agent) agent.progress = progress;
		this.#version += 1;
	}

	/** Drop the agent's live row, advance the repair bar, and build its permanent outcome line. */
	agentFinished(outcome: CleanseAgentOutcome, assignment: CleanseAssignment): string {
		const agent = this.#agents.get(outcome.name);
		this.#agents.delete(outcome.name);
		this.#repairDone = Math.min(this.#repairDone + 1, this.#repairTotal);
		this.#version += 1;
		const total = this.#totals.get(outcome.name);
		this.#lastSettled = describeOutcome(outcome, assignment, agent, total);
		return renderOutcomeLine(outcome, assignment, agent, total);
	}

	/**
	 * Semantic twin of the permanent line the most recent
	 * {@link checkerFinished}/{@link agentFinished} call returned, for native
	 * surfaces that log settled work as nodes.
	 */
	get lastSettled(): NativeNode | undefined {
		return this.#lastSettled;
	}

	/**
	 * Native live rows (NATIVE_REDESIGN §10): phase and checker spinners, the
	 * repair head with a `meter` of fixed lanes, and the running repair agents
	 * as a grid of lanes, one `agent` row each (status, current tool with its
	 * intent, tools, tokens, cost, timer). Terminals without `agent`/`meter`
	 * get the plain rows and a `progress` bar. Spinners and timers are
	 * terminal-clocked, so the node only changes when the board state does.
	 * `undefined` while nothing is live.
	 */
	describeLive(cx: DescribeContext): NativeNode | undefined {
		if (!this.#phaseText && this.#checkers.size === 0 && this.#repairTotal === 0) return undefined;
		const lanes = cx.supports("agent");
		const meter = cx.supports("meter");
		return this.#native.get([this.#version, lanes, meter], () => {
			const rows: NativeNode[] = [];
			if (this.#phaseText) {
				rows.push(node("spinner", { label: this.#phaseText, tone: "warning" }, undefined, "phase"));
			}
			for (const [id, checker] of this.#checkers) {
				const checkerRow = row(
					[node("spinner", { label: checker.label, tone: "warning" }), elapsed(Date.now() - checker.startedAt)],
					{ gap: "sm" },
				);
				rows.push(keyed(checkerRow, `checker-${stableKey(id)}`));
			}
			if (this.#repairTotal > 0) {
				rows.push(this.#describeRepairHeader(meter));
				const agents = [...this.#agents.entries()].sort(
					(left, right) => left[1].assignment.index - right[1].assignment.index,
				);
				if (lanes) {
					const now = Date.now();
					rows.push(
						node(
							"col",
							{ role: "omp.cleanse.lanes", gap: "sm" },
							agents.map(([name, agent]) => describeAgentLane(name, agent, now)),
							"lanes",
						),
					);
				} else {
					for (const [name, agent] of agents) rows.push(describeAgentRow(name, agent));
				}
			}
			return col(rows, { role: "omp.cleanse.live", gap: lanes ? "sm" : "xs" });
		});
	}

	#describeRepairHeader(meter: boolean): NativeNode {
		let tokens = 0;
		let cost = 0;
		for (const entry of this.#totals.values()) {
			tokens += entry.tokens;
			cost += entry.cost;
		}
		const parts: string[] = [];
		if (this.#agents.size > 0) parts.push(`${this.#agents.size} running`);
		if (tokens > 0) parts.push(`${formatNumber(tokens)} tok`);
		if (cost > 0) parts.push(formatCost(cost));
		const value = this.#repairDone / this.#repairTotal;
		const label = `${this.#repairDone}/${this.#repairTotal}`;
		const children: NativeNode[] = [
			node("spinner", { label: "Repairing", tone: "accent" }),
			meter
				? node("meter", {
						value,
						style: "bar",
						size: "md",
						label: `${label} lanes`,
						title: `${this.#repairDone} of ${this.#repairTotal} repair lanes finished`,
						role: "omp.cleanse.meter",
					})
				: node("progress", { value, label, tone: "accent" }),
		];
		if (parts.length > 0) children.push(text([span(parts.join(" · "), "muted")]));
		children.push(elapsed(Date.now() - this.#repairStartedAt));
		return keyed(row(children, { gap: "sm", align: "center", role: "omp.cleanse.head" }), "repair");
	}

	/** Render the transient live rows for the current spinner frame. */
	renderLive(spinner: string): string[] {
		const lines: string[] = [];
		if (this.#phaseText) lines.push(`${fgOrPlain("warning", spinner)} ${this.#phaseText}`);
		for (const checker of this.#checkers.values()) {
			const elapsed = formatDuration(Date.now() - checker.startedAt);
			lines.push(`${fgOrPlain("warning", spinner)} ${checker.label} ${fgOrPlain("dim", `· ${elapsed}`)}`);
		}
		if (this.#repairTotal > 0) {
			lines.push(
				renderWaveHeader(
					spinner,
					this.#repairTotal,
					this.#repairDone,
					this.#agents.size,
					this.#totals,
					this.#repairStartedAt,
				),
			);
			const rows = [...this.#agents.entries()].sort(
				(left, right) => left[1].assignment.index - right[1].assignment.index,
			);
			for (const [name, agent] of rows) lines.push(renderAgentRow(spinner, name, agent));
		}
		return lines;
	}
}

/** Create the cleanse status board bound to `output` (default `process.stdout`). */
export function createCleanseStatusBoard(
	output: LiveBoardOutput = process.stdout,
	errors: LiveBoardOutput = process.stderr,
): CleanseStatusBoard {
	const model = new CleanseBoardModel();
	const board = createLiveBoard(spinner => model.renderLive(spinner), output);

	return {
		interactive: board.interactive,
		log: board.log,
		phase(text) {
			if (!board.interactive) {
				if (text) output.write(`${text}\n`);
				return;
			}
			model.phase(text);
			board.repaint();
		},
		checkerStarted(checker) {
			if (!board.interactive) return;
			model.checkerStarted(checker);
			board.repaint();
		},
		checkerFinished(check, durationMs) {
			board.log(model.checkerFinished(check, durationMs));
		},
		repairFinished() {
			model.repairFinished();
			board.repaint();
		},
		agentStarted(name, assignment) {
			if (!board.interactive) {
				const files = assignment.groups.map(group => group.file ?? "<project>").join(", ");
				output.write(`[start] ${name}: ${files} (weight ${assignment.weight})\n`);
				return;
			}
			model.agentStarted(name, assignment);
			board.repaint();
		},
		agentProgress(name, progress) {
			model.agentProgress(name, progress);
		},
		agentFinished(outcome, assignment) {
			if (!board.interactive) {
				model.agentFinished(outcome, assignment);
				if (outcome.success) {
					output.write(`[done] ${outcome.name}${outcome.resolvedModel ? ` (${outcome.resolvedModel})` : ""}\n`);
				} else {
					const message = truncateToWidth(
						sanitizeDisplaySingleLine(outcome.error ?? "subagent failed")
							.replace(/\s+/g, " ")
							.trim(),
						ERROR_WIDTH,
					);
					errors.write(`[fail] ${outcome.name}: ${message}\n`);
				}
				return;
			}
			board.log(model.agentFinished(outcome, assignment));
		},
		close: board.close,
	};
}

function renderWaveHeader(
	spinner: string,
	total: number,
	done: number,
	running: number,
	totals: ReadonlyMap<string, { tokens: number; cost: number }>,
	startedAt: number,
): string {
	const bar = renderProgressBar(done, BAR_WIDTH, {
		min: 0,
		max: total,
		style: REPAIR_BAR_STYLE,
	});
	let tokens = 0;
	let cost = 0;
	for (const entry of totals.values()) {
		tokens += entry.tokens;
		cost += entry.cost;
	}
	const parts = [`${done}/${total}`];
	if (running > 0) parts.push(`${running} running`);
	if (tokens > 0) parts.push(`${formatNumber(tokens)} tok`);
	if (cost > 0) parts.push(formatCost(cost));
	parts.push(formatDuration(Date.now() - startedAt));
	return `${fgOrPlain("accent", spinner)} Repairing [${bar}] ${parts.join(fgOrPlain("dim", " · "))}`;
}

function renderAgentRow(spinner: string, agentName: string, agent: RunningAgent): string {
	const label = agentName.replace(/^Cleanse/, "");
	const meta: string[] = [];
	const toolCount = agent.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	meta.push(formatDuration(Date.now() - agent.startedAt));
	return (
		`${fgOrPlain("warning", spinner)} ${theme ? theme.bold(label) : label} ${compactFiles(agent.assignment)} ` +
		`${fgOrPlain("dim", "·")} ${agentActivity(agent.progress)} ${fgOrPlain("dim", `· ${meta.join(" · ")}`)}`
	);
}

function describeAgentRow(agentName: string, agent: RunningAgent): NativeNode {
	const toolCount = agent.progress?.toolCount ?? 0;
	const children: NativeNode[] = [
		node("spinner", { label: [span(agentName.replace(/^Cleanse/, ""), "strong")], tone: "warning" }),
		text([span(compactFiles(agent.assignment), "path")], { truncate: "middle" }),
		text(describeActivity(agent.progress), { truncate: "end", grow: 1 }),
	];
	if (toolCount > 0) children.push(text([span(`${toolCount} tool${toolCount === 1 ? "" : "s"}`, "dim")]));
	children.push(elapsed(Date.now() - agent.startedAt));
	return keyed(row(children, { gap: "sm" }), `agent-${stableKey(agentName)}`);
}

/** A running repair lane as an `agent` row: its files as the task, the live tool and its intent, the run's stats. */
function describeAgentLane(agentName: string, agent: RunningAgent, now: number): NativeNode {
	const progress = agent.progress;
	const intent = sanitizeDisplaySingleLine(progress?.lastIntent ?? progress?.currentToolArgs ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return node(
		"agent",
		{
			name: agentName.replace(/^Cleanse/, "") || agentName,
			task: [span(compactFiles(agent.assignment), "path")],
			status: progress?.status === "pending" ? "pending" : "running",
			model: progress?.resolvedModel,
			tool: progress?.currentTool
				? {
						name: progress.currentTool,
						intent: intent || undefined,
						age: progress.currentToolStartMs ? Math.max(0, now - progress.currentToolStartMs) : undefined,
					}
				: null,
			retry: progress?.retryState
				? {
						attempt: progress.retryState.attempt,
						max: progress.retryState.maxAttempts,
						age: Math.max(0, now - progress.retryState.startedAtMs),
						delay: progress.retryState.delayMs,
						error: progress.retryState.errorMessage,
					}
				: null,
			stats: {
				tools: progress?.toolCount || undefined,
				tokens: progress?.tokens || undefined,
				cost: progress && progress.cost > 0 ? progress.cost : undefined,
				age: now - agent.startedAt,
			},
			role: "omp.cleanse.lane",
		},
		undefined,
		`agent-${stableKey(agentName)}`,
	);
}

/** Spans for a repair agent's latest activity, mirroring {@link agentActivity}. */
function describeActivity(progress: AgentProgress | undefined): TspSpan[] {
	if (!progress) return [span("starting", "dim")];
	if (progress.retryState) {
		return [
			span(`rate-limited · retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`, "warning"),
		];
	}
	const intent = sanitizeDisplaySingleLine(progress.lastIntent ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (progress.currentTool) {
		const args = sanitizeDisplaySingleLine(progress.currentToolArgs ?? "")
			.replace(/\s+/g, " ")
			.trim();
		const tool = span(args ? `${progress.currentTool} ${args}` : progress.currentTool, "dim");
		return intent ? [span(`${intent} `), tool] : [tool];
	}
	return intent ? [span(intent)] : [span("thinking", "dim")];
}

/** Semantic twin of {@link renderOutcomeLine}. */
function describeOutcome(
	outcome: CleanseAgentOutcome,
	assignment: CleanseAssignment,
	agent: RunningAgent | undefined,
	total: { tokens: number; cost: number } | undefined,
): NativeNode {
	const files = compactFiles(assignment);
	if (!outcome.success) {
		const message = sanitizeDisplaySingleLine(outcome.error ?? "subagent failed")
			.replace(/\s+/g, " ")
			.trim();
		return text([span("✗ ", "error"), span(`${outcome.name} `), span(files, "path"), span(` ${message}`, "error")], {
			wrap: "word",
			role: "omp.cleanse.outcome",
			tone: "error",
		});
	}
	const meta: string[] = [];
	const toolCount = agent?.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	if (total && total.tokens > 0) meta.push(`${formatNumber(total.tokens)} tok`);
	if (agent) meta.push(formatDuration(Date.now() - agent.startedAt));
	const spans = [span("✓ ", "success"), span(`${outcome.name} `), span(files, "path")];
	if (meta.length > 0) spans.push(span(` · ${meta.join(" · ")}`, "dim"));
	return text(spans, { wrap: "word", role: "omp.cleanse.outcome" });
}

function renderOutcomeLine(
	outcome: CleanseAgentOutcome,
	assignment: CleanseAssignment,
	agent: RunningAgent | undefined,
	total: { tokens: number; cost: number } | undefined,
): string {
	const files = compactFiles(assignment);
	if (!outcome.success) {
		const message = truncateToWidth(
			sanitizeDisplaySingleLine(outcome.error ?? "subagent failed")
				.replace(/\s+/g, " ")
				.trim(),
			ERROR_WIDTH,
		);
		return `${fgOrPlain("error", "✗")} ${outcome.name} ${files} ${fgOrPlain("error", message)}`;
	}
	const meta: string[] = [];
	const toolCount = agent?.progress?.toolCount ?? 0;
	if (toolCount > 0) meta.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
	if (total && total.tokens > 0) meta.push(`${formatNumber(total.tokens)} tok`);
	if (agent) meta.push(formatDuration(Date.now() - agent.startedAt));
	const suffix = meta.length > 0 ? ` ${fgOrPlain("dim", `· ${meta.join(" · ")}`)}` : "";
	return `${fgOrPlain("success", "✓")} ${outcome.name} ${files}${suffix}`;
}

/** Latest human-readable activity for a repair agent row. */
function agentActivity(progress: AgentProgress | undefined): string {
	if (!progress) return fgOrPlain("dim", "starting");
	if (progress.retryState) {
		return fgOrPlain(
			"warning",
			`rate-limited · retry ${progress.retryState.attempt}/${progress.retryState.maxAttempts}`,
		);
	}
	const intent = truncateToWidth(
		sanitizeDisplaySingleLine(progress.lastIntent ?? "")
			.replace(/\s+/g, " ")
			.trim(),
		ACTIVITY_WIDTH,
	);
	if (progress.currentTool) {
		const args = truncateToWidth(
			sanitizeDisplaySingleLine(progress.currentToolArgs ?? "")
				.replace(/\s+/g, " ")
				.trim(),
			ACTIVITY_WIDTH,
		);
		const tool = fgOrPlain("dim", args ? `${progress.currentTool} ${args}` : progress.currentTool);
		return intent ? `${intent} ${tool}` : tool;
	}
	return intent || fgOrPlain("dim", "thinking");
}

function compactFiles(assignment: CleanseAssignment): string {
	const files = assignment.groups.map(group => group.file ?? "<project>");
	const first = files[0] ?? "<project>";
	return files.length > 1 ? `${first} +${files.length - 1}` : first;
}

function formatCost(cost: number): string {
	return `$${cost >= 0.095 ? cost.toFixed(2) : cost.toFixed(3)}`;
}
