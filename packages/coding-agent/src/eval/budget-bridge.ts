/**
 * Host-side handler for the eval `budget` helper.
 *
 * Reports the active token ceiling and amount spent so kernel helpers can
 * compute remaining budget. Precedence: a `+Nk`/`+Nk!` per-turn directive (the
 * user's immediate intent) wins; otherwise an active Goal Mode budget; otherwise
 * no ceiling, with `spent` still reflecting this turn's output where available.
 * {@link assertEvalSpawnBudget} enforces the same resolved ceiling for eval `agent()`.
 */
import { ToolError } from "../tools/tool-errors";
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

/** Effective ceiling plus which setting imposed it (`null` when none applies). */
interface ResolvedEvalBudget extends EvalBudgetResult {
	source: "turn" | "goal" | null;
}

function resolveEvalBudget(session: ToolSession): ResolvedEvalBudget {
	const turn = session.getTurnBudget?.();
	if (turn && turn.total !== null) {
		return { total: turn.total, spent: turn.spent, hard: turn.hard, source: "turn" };
	}
	const goal = session.getGoalModeState?.();
	if (goal?.enabled && goal.goal) {
		const total = goal.goal.tokenBudget ?? null;
		return { total, spent: goal.goal.tokensUsed ?? 0, hard: total !== null, source: total === null ? null : "goal" };
	}
	const spent = turn?.spent ?? session.getUsageStatistics?.()?.output ?? 0;
	return { total: null, spent, hard: false, source: null };
}

/**
 * Resolve the current token budget snapshot for an eval cell's `budget` helper.
 * The returned object is JSON-passed verbatim by the bridge transport; kernel
 * helpers read `.total`/`.spent`/`.hard` directly.
 */
export async function runEvalBudget(_args: unknown, options: EvalBudgetBridgeOptions): Promise<EvalBudgetResult> {
	const { total, spent, hard } = resolveEvalBudget(options.session);
	return { total, spent, hard };
}

/**
 * Gate eval `agent()` admission on the same effective ceiling `budget` reports,
 * so `hard: true` always means `agent()` refuses once `spent >= total`.
 */
export function assertEvalSpawnBudget(session: ToolSession): void {
	const { total, spent, hard, source } = resolveEvalBudget(session);
	if (!hard || total === null || spent < total) return;
	if (source === "goal") {
		throw new ToolError(
			`agent() blocked: Goal Mode token budget exhausted (${spent}/${total} tokens). Raise or clear the goal budget to continue.`,
		);
	}
	throw new ToolError(
		`agent() blocked: turn token budget exhausted (${spent}/${total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
	);
}
