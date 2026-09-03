import { describe, expect, it } from "bun:test";
import { runEvalBudget } from "../../src/eval/budget-bridge";
import type { GoalModeState } from "../../src/goals/state";
import type { UsageStatistics } from "../../src/session/session-entries";
import type { ToolSession } from "../../src/tools";

type TurnBudget = { total: number | null; spent: number; hard: boolean };

function makeSession(parts: { turn?: TurnBudget; goal?: GoalModeState; usage?: UsageStatistics }): ToolSession {
	return {
		getTurnBudget: parts.turn ? () => parts.turn as TurnBudget : undefined,
		getGoalModeState: parts.goal ? () => parts.goal : undefined,
		getUsageStatistics: parts.usage ? () => parts.usage as UsageStatistics : undefined,
	} as unknown as ToolSession;
}

function goalState(extra: Partial<GoalModeState["goal"]>): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		goal: { id: "g1", status: "active", tokensUsed: 0, timeUsedSeconds: 0, ...extra },
	} as GoalModeState;
}

function usage(output: number): UsageStatistics {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

describe("runEvalBudget", () => {
	it("prefers an active +Nk turn directive over Goal Mode", async () => {
		const session = makeSession({
			turn: { total: 200_000, spent: 5_000, hard: true },
			goal: goalState({ tokenBudget: 100_000, tokensUsed: 4_200 }),
		});
		expect(await runEvalBudget({}, { session })).toEqual({ total: 200_000, spent: 5_000, hard: true });
	});

	it("reports an advisory turn budget as hard:false", async () => {
		const session = makeSession({ turn: { total: 50_000, spent: 1_000, hard: false } });
		expect(await runEvalBudget({}, { session })).toEqual({ total: 50_000, spent: 1_000, hard: false });
	});

	it("falls through to Goal Mode when no turn directive set a ceiling", async () => {
		const session = makeSession({
			turn: { total: null, spent: 7_777, hard: false },
			goal: goalState({ tokenBudget: 100_000, tokensUsed: 4_200 }),
		});
		expect(await runEvalBudget({}, { session })).toEqual({ total: 100_000, spent: 4_200, hard: true });
	});

	it("treats a Goal Mode budget as hard, and a budgetless goal as no ceiling", async () => {
		const withBudget = makeSession({ goal: goalState({ tokenBudget: 80_000, tokensUsed: 9_000 }) });
		expect(await runEvalBudget({}, { session: withBudget })).toEqual({ total: 80_000, spent: 9_000, hard: true });

		const noBudget = makeSession({ goal: goalState({ tokenBudget: undefined, tokensUsed: 1_234 }) });
		expect(await runEvalBudget({}, { session: noBudget })).toEqual({ total: null, spent: 1_234, hard: false });
	});

	it("reports no ceiling but still surfaces spend", async () => {
		const fromTurn = makeSession({ turn: { total: null, spent: 333, hard: false } });
		expect(await runEvalBudget({}, { session: fromTurn })).toEqual({ total: null, spent: 333, hard: false });

		const fromUsage = makeSession({ usage: usage(777) });
		expect(await runEvalBudget({}, { session: fromUsage })).toEqual({ total: null, spent: 777, hard: false });

		const empty = makeSession({});
		expect(await runEvalBudget({}, { session: empty })).toEqual({ total: null, spent: 0, hard: false });
	});
});
