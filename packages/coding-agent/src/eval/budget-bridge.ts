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

/**
 * Resolve the current token budget snapshot for an eval cell's `budget` helper.
 * The returned object is JSON-passed verbatim by the bridge transport; kernel
 * helpers read `.total`/`.spent`/`.hard` directly.
 */
export async function runEvalBudget(_args: unknown, options: EvalBudgetBridgeOptions): Promise<EvalBudgetResult> {
	const turn = options.session.getTurnBudget?.();
	if (turn && turn.total !== null) {
		return { total: turn.total, spent: turn.spent, hard: turn.hard };
	}
	const goal = options.session.getGoalModeState?.();
	if (goal?.enabled && goal.goal) {
		return {
			total: goal.goal.tokenBudget ?? null,
			spent: goal.goal.tokensUsed ?? 0,
			hard: goal.goal.tokenBudget != null,
		};
	}
	const spent = turn?.spent ?? options.session.getUsageStatistics?.()?.output ?? 0;
	return { total: null, spent, hard: false };
}
