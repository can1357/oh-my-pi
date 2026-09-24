/** `goal` — goal-mode lifecycle: set/check/complete/resume/drop an objective with an optional token budget. */
import type { ReactNode } from "react";
import type { I18n } from "@oh-my-pi/pi-i18n";
import { useCollabI18n } from "../../lib/i18n";
import type { Tone } from "../parts";
import { Badge, InvalidArg, Kv, KvGrid, Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

interface GoalView {
	objective: string;
	status: string;
	tokenBudget: number | null;
	tokensUsed: number | null;
	timeUsedSeconds: number | null;
}

/** Narrow `details.goal` (untrusted JSON) to the fields we render. */
function goalOf(details: Record<string, unknown> | null): GoalView | null {
	const g = details?.goal;
	if (!isRecord(g)) return null;
	const objective = str(g.objective);
	const status = str(g.status);
	if (objective === null || status === null) return null;
	return {
		objective,
		status,
		tokenBudget: num(g.tokenBudget),
		tokensUsed: num(g.tokensUsed),
		timeUsedSeconds: num(g.timeUsedSeconds),
	};
}

/** Mirrors the TUI's describeOp: "create" reads as "set", "get" as "check". */
function describeOp(op: string | null, i18n: I18n): string {
	switch (op) {
		case "create":
			return i18n.t("collab.tool.set");
		case "get":
			return i18n.t("collab.tool.check");
		default:
			return op ?? "?";
	}
}

function statusTone(status: string): Tone | undefined {
	switch (status) {
		case "complete":
			return "ok";
		case "budget-limited":
			return "warn";
		case "paused":
		case "dropped":
			return undefined;
		default:
			return "accent";
	}
}

/** Compact count: 999, 1.5K, 25K, 1.5M, 2B. */
function fmtNum(n: number): string {
	if (n < 1_000) return `${n}`;
	const scaled = (v: number): string => {
		const s = v < 10 ? v.toFixed(1) : `${Math.round(v)}`;
		return s.endsWith(".0") ? s.slice(0, -2) : s;
	};
	if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
	if (n < 1_000_000_000) return `${scaled(n / 1_000_000)}M`;
	return `${scaled(n / 1_000_000_000)}B`;
}

/** Coarse duration label from seconds: 45s, 12m, 3h, 2d. */
function fmtDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

/** "12K / 100K tokens (88K left)" or "12K tokens" without a budget. */
function tokensLine(goal: GoalView, i18n: I18n): string {
	const used = fmtNum(goal.tokensUsed ?? 0);
	if (goal.tokenBudget === null) return `${used} ${i18n.t("collab.tool.tokens")}`;
	const left = Math.max(0, goal.tokenBudget - (goal.tokensUsed ?? 0));
	return i18n.t("collab.tool.tokensWithBudget", {
		used,
		budget: fmtNum(goal.tokenBudget),
		left: fmtNum(left),
	});
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const { i18n } = useCollabI18n();
	const details = detailsRecord(result);
	const goal = goalOf(details);
	const op = str(details?.op) ?? str(args.op);
	const objective = goal?.objective ?? str(args.objective);
	const budget = num(args.token_budget);
	return (
		<>
			{op === null && args.op !== undefined ? <InvalidArg what="op" /> : <span>{describeOp(op, i18n)}</span>}
			{goal && <Badge tone={statusTone(goal.status)}>{goal.status}</Badge>}
			{objective !== null && objective.trim() !== "" && (
				<span className="tv-muted">“{truncate(normalizeWs(objective), 64)}”</span>
			)}
			{budget !== null && (
				<span className="tv-faint">{i18n.t("collab.tool.budget", { tokens: fmtNum(budget) })}</span>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const { i18n } = useCollabI18n();
	const details = detailsRecord(result);
	const goal = goalOf(details);
	const op = str(details?.op) ?? str(args.op);
	const objective = goal?.objective ?? str(args.objective);
	const budgetArg = num(args.token_budget);
	const report = str(details?.completionBudgetReport);
	const hasTokens = goal !== null && (goal.tokensUsed !== null || goal.tokenBudget !== null);
	return (
		<>
			<KvGrid>
				<Kv k={i18n.t("collab.tool.op")}>{describeOp(op, i18n)}</Kv>
				{goal && (
					<Kv k="status">
						<Badge tone={statusTone(goal.status)}>{goal.status}</Badge>
					</Kv>
				)}
				{objective !== null && objective.trim() !== "" && (
					<Kv k={i18n.t("collab.tool.objective")}>{objective.trim()}</Kv>
				)}
				{hasTokens && goal ? (
					<Kv k={i18n.t("collab.tool.tokens")}>{tokensLine(goal, i18n)}</Kv>
				) : (
					budgetArg !== null && (
						<Kv k={i18n.t("collab.tool.budgetLabel")}>
							{fmtNum(budgetArg)} {i18n.t("collab.tool.tokens")}
						</Kv>
					)
				)}
				{goal !== null && goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 && (
					<Kv k={i18n.t("collab.tool.elapsed")}>{fmtDuration(goal.timeUsedSeconds)}</Kv>
				)}
			</KvGrid>
			{details !== null && goal === null && !result?.isError && (
				<Note tone="warn">{i18n.t("collab.tool.noActiveGoal")}</Note>
			)}
			{report !== null && report !== "" && (
				<Output text={report} title={i18n.t("collab.tool.report")} maxLines={12} />
			)}
			{(goal === null || result?.isError) && <ResultText result={result} maxLines={10} />}
		</>
	);
}

export const goalRenderer: ToolRenderer = { Summary, Body };
