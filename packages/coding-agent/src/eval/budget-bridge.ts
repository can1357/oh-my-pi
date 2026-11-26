/**
 * Host-side handler for the eval `budget` helper.
 *
 * Reports the active token ceiling and amount spent so kernel helpers can
 * compute remaining budget. Precedence: a `+Nk`/`+Nk!` per-turn directive (the
 * user's immediate intent) wins; otherwise an active Goal Mode budget; otherwise
 * no ceiling, with `spent` still reflecting this turn's output where available.
 */
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

/** The ceiling eval `budget()` reports and `agent()` admission enforces, with the setting that imposed it. */
export interface EvalBudgetResolution {
	budget: EvalBudgetResult;
	/** Which setting imposed the ceiling; `null` when none applies. */
	from: "turn" | "goal" | null;
}

/**
 * The one eval ceiling: a `+Nk`/`+Nk!` turn directive wins, else an active Goal
 * Mode budget. `budget()` reports it and eval `agent()` admission enforces it.
 */
export function resolveEvalBudget(session: ToolSession): EvalBudgetResolution {
	const turn = session.getTurnBudget?.();
	if (turn && turn.total !== null) {
		return { budget: { total: turn.total, spent: turn.spent, hard: turn.hard }, from: "turn" };
	}
	const goal = session.getGoalModeState?.();
	if (goal?.enabled && goal.goal) {
		const total = goal.goal.tokenBudget ?? null;
		return {
			budget: { total, spent: goal.goal.tokensUsed ?? 0, hard: total !== null },
			from: total === null ? null : "goal",
		};
	}
	const spent = turn?.spent ?? session.getUsageStatistics?.()?.output ?? 0;
	return { budget: { total: null, spent, hard: false }, from: null };
}

/**
 * Resolve the current token budget snapshot for an eval cell's `budget` helper.
 * The returned object is JSON-passed verbatim by the bridge transport; kernel
 * helpers read `.total`/`.spent`/`.hard` directly.
 */
export async function runEvalBudget(_args: unknown, options: EvalBudgetBridgeOptions): Promise<EvalBudgetResult> {
	return resolveEvalBudget(options.session).budget;
}
