/**
 * Host-side handler for the eval `budget` helper and the matching `agent()`
 * admission check.
 *
 * Reports the active token ceiling and amount spent so kernel helpers can
 * compute remaining budget. Precedence: a `+Nk`/`+Nk!` per-turn directive (the
 * user's immediate intent) wins; otherwise an active Goal Mode budget; otherwise
 * no ceiling, with `spent` still reflecting this turn's output where available.
 * {@link assertEvalSpawnBudget} enforces the same resolved ceiling, so `hard`
 * always matches what eval `agent()` admission does.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../tools";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `budget` helper across both runtimes. */
export const EVAL_BUDGET_BRIDGE_NAME = "__budget__";

export interface EvalBudgetBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalBudgetResult {
	total: number | null;
	spent: number;
	/** Whether the ceiling is enforced (eval `agent()` throws past it) vs advisory. */
	hard: boolean;
}

interface ResolvedEvalBudget {
	budget: EvalBudgetResult;
	/** Which setting imposed the ceiling; `null` when none applies. */
	source: "turn" | "goal" | null;
}

async function resolveEvalBudget(session: ToolSession): Promise<ResolvedEvalBudget> {
	const turn = session.getTurnBudget?.();
	if (turn && turn.total !== null) {
		return { budget: { total: turn.total, spent: turn.spent, hard: turn.hard }, source: "turn" };
	}
	// `goal.tokensUsed` lags the assistant request invoking eval until `tool_execution_end`.
	// Account for it now, but delay the budget-limit steer until the eval tool completes:
	// a mid-cell steer would background the running cell.
	await session.getGoalRuntime?.()?.flushUsage("deferred");
	const goal = session.getGoalModeState?.();
	if (goal?.enabled && goal.goal) {
		const total = goal.goal.tokenBudget ?? null;
		return {
			budget: { total, spent: goal.goal.tokensUsed ?? 0, hard: total !== null },
			source: total === null ? null : "goal",
		};
	}
	const spent = turn?.spent ?? session.getUsageStatistics?.()?.output ?? 0;
	return { budget: { total: null, spent, hard: false }, source: null };
}

/**
 * Resolve the current token budget snapshot for an eval cell's `budget` helper.
 * The returned object is JSON-passed verbatim by the bridge transport; kernel
 * helpers read `.total`/`.spent`/`.hard` directly.
 */
export async function runEvalBudget(_args: unknown, options: EvalBudgetBridgeOptions): Promise<EvalBudgetResult> {
	return (await resolveEvalBudget(options.session)).budget;
}

/**
 * Gate eval `agent()` admission on the same effective ceiling `budget` reports.
 *
 * @throws {ToolError} when the resolved ceiling is hard and `spent >= total`,
 * naming the `+Nk!` directive or the Goal Mode budget that imposed it.
 */
export async function assertEvalSpawnBudget(session: ToolSession): Promise<void> {
	const { budget, source } = await resolveEvalBudget(session);
	if (!budget.hard || budget.total === null || budget.spent < budget.total) return;
	if (source === "goal") {
		throw new ToolError(
			`agent() blocked: Goal Mode token budget exhausted (${budget.spent}/${budget.total} tokens). Raise or clear the goal budget to continue.`,
		);
	}
	throw new ToolError(
		`agent() blocked: turn token budget exhausted (${budget.spent}/${budget.total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
	);
}
