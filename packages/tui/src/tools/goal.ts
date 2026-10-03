import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme, ThemeColor } from "../theme/theme";
import { formatDuration, formatErrorDetail, formatNumber, TRUNCATE_LENGTHS } from "../render/render-utils";
import { renderStatusLine, truncateToWidth } from "../render/index";
import { framedToolCard } from "../render/tool-card";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { compact, node, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { errorView, noteText, resultText, toolHead } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
/** Lifecycle state of a tracked goal. */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

/** Serializable goal progress and resource budget. */
export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

/** Goal operation outcome displayed in the transcript. */
export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
}
function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
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
	op?: GoalToolDetails["op"];
	objective?: string;
	token_budget?: number;
}

function describeGoalResult(result: ToolRenderResult<GoalToolDetails>, args?: GoalRenderArgs): NativeToolView {
	const details = result.details;
	const description = describeOp(details?.op ?? args?.op);
	if (result.isError) return errorView("Goal", resultText(result) || "Goal tool failed", description);
	const goal = details?.goal ?? null;
	if (!goal) return { head: toolHead("Goal", description, "no active goal"), tone: "warning" };

	const head = [
		...toolHead("Goal", description),
		span(" "),
		span(goal.status, `${goalBadgeColor(goal.status)} strong`),
	];
	const used = formatNumber(goal.tokensUsed);
	const left = goal.tokenBudget !== undefined ? Math.max(0, goal.tokenBudget - goal.tokensUsed) : 0;
	const tokens =
		goal.tokenBudget !== undefined
			? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(left)} left)`
			: `${used} tokens`;
	const meta = [tokens];
	if (goal.timeUsedSeconds > 0) meta.push(`${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`);
	const report = details?.completionBudgetReport;
	return {
		head,
		body: compact([
			text([span(`"${goal.objective.trim()}"`, "muted")], { wrap: "word" }),
			text([span(meta.join(" · "), "dim")], { wrap: "word" }),
			report ? node("section", { head: [span("Report", "toolTitle")] }, [noteText(report)], "report") : undefined,
		]),
	};
}

const goalResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Renders goal creation, status, and lifecycle results. */
export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		if (args.op === "create" && args.token_budget !== undefined) {
			meta.push(`budget ${formatNumber(args.token_budget)}`);
		}
		return new Text(renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme), 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			return framedToolCard(
				uiTheme,
				() => ({
					header,
					sections: [{ content: formatErrorDetail(fallbackText || "Goal tool failed", uiTheme).split("\n") }],
					phase: "error",
					borderColor: "error",
				}),
				{ flat: options.renderContext?.flat === true },
			);
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
		const objectiveText = truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG);
		lines.push(uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`)));

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
		const sections: Array<{ label?: string; content: string[] }> = [{ content: lines }];
		if (report) {
			sections.push({ label: "Report", content: report.split("\n").map(line => uiTheme.fg("muted", line)) });
		}

		return framedToolCard(
			uiTheme,
			() => ({
				header,
				sections,
				phase: "success",
				borderColor: "borderMuted",
			}),
			{ flat: options.renderContext?.flat === true },
		);
	},

	describeCall(args: GoalRenderArgs): NativeToolView {
		const head: TspSpan[] = toolHead("Goal", describeOp(args.op));
		const objective = args.objective?.trim();
		if (args.op === "create" && objective) head.push(span(" "), span(`"${objective}"`, "muted"));
		if (args.op === "create" && args.token_budget !== undefined) {
			head.push(span(" "), span(`budget ${formatNumber(args.token_budget)}`, "muted"));
		}
		return { head };
	},

	describeResult(
		result: ToolRenderResult<GoalToolDetails>,
		_options: RenderResultOptions,
		args?: GoalRenderArgs,
	): NativeToolView | undefined {
		return goalResultMemo.get(result, [args?.op], () => describeGoalResult(result, args));
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<GoalRenderArgs, GoalToolDetails>;
