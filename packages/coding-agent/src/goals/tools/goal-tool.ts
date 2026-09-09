import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatNumber, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { formatErrorDetail, previewLine, replaceTabs, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { framedBlock, renderStatusLine, truncateToWidth } from "../../tui";
import { completionBudgetReport, remainingTokens } from "../runtime";
import type { Goal, GoalStatus, GoalToolDetails } from "../state";
import type { GoalWayfindingUpdate } from "../wayfinding";

const goalSchema = type({
	op: type("'create' | 'get' | 'update' | 'complete' | 'resume' | 'drop'").describe("goal operation"),
	"objective?": type("string").describe("goal objective"),
	"token_budget?": type("number.integer").describe("token budget"),
	"goal_id?": type("string").describe("active goal id returned by create/get"),
	"expected_revision?": type("number.integer").describe("current wayfinding revision returned by create/get"),
	"focus?": type("string").describe("current problem focus"),
	"next_action?": type("string").describe("next substantive action"),
	"why?": type("string").describe("short operational reason for the next action"),
	"guidance?": type("string").describe("execution method or scope constraints"),
	"success_signal?": type("string").describe("evidence that justifies advancing"),
	"replan_if?": type("string").describe("evidence or condition that invalidates the route"),
	"outcome?": type("'succeeded' | 'partial' | 'failed' | 'unexpected' | 'blocked'").describe(
		"outcome of the previous waypoint",
	),
	"observation?": type("string").describe("material observation from the previous waypoint"),
	"blockers?": type("string[]").describe("current blockers; full replacement"),
	"assumptions?": type("string[]").describe("route assumptions; full replacement"),
});

export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string; tokenBudget?: number } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("objective is required when op=create");
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget };
}

function validateUpdateParams(params: GoalToolInput): GoalWayfindingUpdate {
	const goalId = params.goal_id?.trim();
	if (!goalId) {
		throw new ToolError("goal_id is required when op=update");
	}
	const expectedRevision = params.expected_revision;
	if (
		expectedRevision === undefined ||
		!Number.isSafeInteger(expectedRevision) ||
		expectedRevision < 0 ||
		expectedRevision >= Number.MAX_SAFE_INTEGER
	) {
		throw new ToolError(
			"expected_revision must be a non-negative safe integer below Number.MAX_SAFE_INTEGER when op=update",
		);
	}
	const action = params.next_action?.trim();
	if (!action) {
		throw new ToolError("next_action is required when op=update");
	}
	const rationale = params.why?.trim();
	if (!rationale) {
		throw new ToolError("why is required when op=update");
	}
	const observation = params.observation?.trim();
	if (params.observation !== undefined && !observation) {
		throw new ToolError("observation must not be blank when provided");
	}
	if ((params.outcome === undefined) !== (observation === undefined)) {
		throw new ToolError("outcome and observation must be provided together when op=update");
	}
	return {
		goalId,
		expectedRevision,
		focus: params.focus,
		waypoint: {
			action,
			rationale,
			guidance: params.guidance,
			successSignal: params.success_signal,
			replanIf: params.replan_if,
		},
		lastObservation:
			params.outcome !== undefined && observation !== undefined
				? { outcome: params.outcome, summary: observation }
				: undefined,
		blockers: params.blockers,
		assumptions: params.assumptions,
	};
}

function appendWayfindingText(text: string, goal: Goal): string {
	const revision = goal.wayfinding?.revision ?? 0;
	let next = `${text}\nGoal ID: ${goal.id}\nWayfinding revision: ${revision}`;
	const wayfinding = goal.wayfinding;
	if (!wayfinding) return next;
	if (wayfinding.focus) next += `\nCurrent focus: ${wayfinding.focus}`;
	next += `\nNext action: ${wayfinding.waypoint.action}`;
	next += `\nWhy: ${wayfinding.waypoint.rationale}`;
	if (wayfinding.waypoint.guidance) next += `\nGuidance: ${wayfinding.waypoint.guidance}`;
	if (wayfinding.waypoint.successSignal) next += `\nSuccess signal: ${wayfinding.waypoint.successSignal}`;
	if (wayfinding.waypoint.replanIf) next += `\nReplan if: ${wayfinding.waypoint.replanIf}`;
	if (wayfinding.lastObservation) {
		next += `\nLast observation (${wayfinding.lastObservation.outcome}): ${wayfinding.lastObservation.summary}`;
	}
	if (wayfinding.blockers?.length) next += `\nBlockers:\n- ${wayfinding.blockers.join("\n- ")}`;
	if (wayfinding.assumptions?.length) next += `\nAssumptions:\n- ${wayfinding.assumptions.join("\n- ")}`;
	return next;
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) {
			throw new ToolError("Goal mode is not active.");
		}

		let response: GoalToolResponse;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateCreateParams(params));
			response = buildGoalToolResponse(created.goal);
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null);
		} else if (params.op === "update") {
			const updated = await runtime.updateGoalWayfinding(validateUpdateParams(params));
			response = buildGoalToolResponse(updated.goal);
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal);
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null);
		} else {
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true });
		}
		let text: string;
		if (response.goal) {
			text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
			if (response.goal.tokenBudget !== undefined) {
				text += ` / ${response.goal.tokenBudget} budget`;
			}
			if (response.remainingTokens !== null) {
				text += `\nRemaining tokens: ${response.remainingTokens}`;
			}
			if (params.op === "create" || params.op === "get" || params.op === "update" || params.op === "resume") {
				text = appendWayfindingText(text, response.goal);
			}
			if (response.completionBudgetReport) {
				text += `\n\n${response.completionBudgetReport}`;
			}
		} else {
			text = "No active goal.";
		}
		return {
			content: [{ type: "text", text }],
			details: {
				op: params.op,
				goal: response.goal,
				remainingTokens: response.remainingTokens,
				completionBudgetReport: response.completionBudgetReport,
			},
		};
	}
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "update":
			return "navigate";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
	token_budget?: number;
	next_action?: string;
	expected_revision?: number;
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(replaceTabs(trimmedObjective), TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "create" && args.token_budget !== undefined) {
			meta.push(`budget ${formatNumber(args.token_budget)}`);
		}
		const nextAction = args.next_action?.trim();
		if (args.op === "update" && nextAction) {
			const actionPreview = previewLine(sanitizeText(nextAction), TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", actionPreview)));
		}
		if (args.op === "update" && args.expected_revision !== undefined) {
			meta.push(`rev ${formatNumber(args.expected_revision)}`);
		}
		return new Text(renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(fallbackText || "Goal tool failed", uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			return new Text(
				renderStatusLine({ icon: "warning", title: "Goal", description, meta: ["no active goal"] }, uiTheme),
				0,
				0,
			);
		}

		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.goal", "accent"),
				title: "Goal",
				description,
				badge: { label: goal.status, color: goalBadgeColor(goal.status) },
			},
			uiTheme,
		);

		const lines: string[] = [];
		const objectiveText = truncateToWidth(replaceTabs(goal.objective.trim()), TRUNCATE_LENGTHS.LONG);
		lines.push(uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`)));
		if (goal.wayfinding) {
			const action = previewLine(sanitizeText(goal.wayfinding.waypoint.action), TRUNCATE_LENGTHS.LONG);
			lines.push(uiTheme.fg("accent", `route r${formatNumber(goal.wayfinding.revision)} → ${action}`));
			if (goal.wayfinding.focus) {
				lines.push(uiTheme.fg("muted", previewLine(sanitizeText(goal.wayfinding.focus), TRUNCATE_LENGTHS.LONG)));
			}
		}

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
				: `${used} tokens`;
		const metaParts = [tokensLine];
		if (goal.timeUsedSeconds > 0) {
			metaParts.push(`${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`);
		}
		lines.push(uiTheme.fg("dim", metaParts.join(" · ")));

		const report = details?.completionBudgetReport;
		const sections: Array<{ label?: string; lines: string[] }> = [{ lines }];
		if (report) {
			sections.push({ label: "Report", lines: report.split("\n").map(line => uiTheme.fg("muted", line)) });
		}

		return framedBlock(uiTheme, width => ({
			header,
			sections,
			state: "success",
			borderColor: "borderMuted",
			width,
		}));
	},

	mergeCallAndResult: true,
};
