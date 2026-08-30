import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";

function createRunner(
	getPlanModeState?: () => PlanModeState | undefined,
	getGoalModeState?: () => GoalModeState | undefined,
): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner(
		[],
		runtime,
		"/tmp",
		{ getCwd: () => "/tmp" } as never,
		{} as never,
		undefined,
		undefined,
		undefined,
		undefined,
		getPlanModeState,
		getGoalModeState,
	);
}

const planModeState: PlanModeState = { enabled: true, planFilePath: "local://feature-plan.md" };

function activeGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-extension-context",
			objective: "Ship the release",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

describe("ExtensionRunner plan mode context", () => {
	it("defaults to undefined outside a session", () => {
		expect(createRunner().createContext().getPlanModeState()).toBeUndefined();
	});

	// Reads must be live: a handler that spans a plan-mode toggle has to observe
	// the change through the context object it already holds. A snapshot taken at
	// createContext() time would pass every other case here and fail this one.
	it("reads live through a single context object across a toggle", () => {
		let current: PlanModeState | undefined;
		const ctx = createRunner(() => current).createContext();

		expect(ctx.getPlanModeState()).toBeUndefined();

		current = planModeState;
		expect(ctx.getPlanModeState()?.enabled).toBe(true);
		expect(ctx.getPlanModeState()?.planFilePath).toBe("local://feature-plan.md");

		// Leaving plan mode clears the state rather than flipping `enabled`
		// (`setPlanModeState(undefined)`), so cover the real exit shape.
		current = undefined;
		expect(ctx.getPlanModeState()).toBeUndefined();
	});

	// createCommandContext() spreads createContext(). A spread snapshots a getter
	// but copies a method's closure, so the command context must stay live too.
	it("stays live through the command-context spread", () => {
		let current: PlanModeState | undefined;
		const ctx = createRunner(() => current).createCommandContext();

		expect(ctx.getPlanModeState()).toBeUndefined();

		current = planModeState;
		expect(ctx.getPlanModeState()?.enabled).toBe(true);
		expect(ctx.getPlanModeState()?.planFilePath).toBe("local://feature-plan.md");
	});

	it("returns a snapshot so mutating the result does not change session state", () => {
		const current: PlanModeState = { ...planModeState };
		const ctx = createRunner(() => current).createContext();
		const seen = ctx.getPlanModeState();
		expect(seen).toBeDefined();
		seen!.enabled = false;
		seen!.planFilePath = "tampered";
		expect(current).toEqual(planModeState);
		expect(ctx.getPlanModeState()).toEqual(planModeState);
	});
});

describe("ExtensionRunner goal mode context", () => {
	it("defaults to undefined outside a session", () => {
		expect(createRunner().createContext().getGoalModeState()).toBeUndefined();
	});

	it("reads live through a single context object, including the exiting phase", () => {
		let current: GoalModeState | undefined;
		const ctx = createRunner(undefined, () => current).createContext();

		expect(ctx.getGoalModeState()).toBeUndefined();

		current = activeGoalState();
		expect(ctx.getGoalModeState()?.mode).toBe("active");

		current = { ...activeGoalState(), mode: "exiting", reason: "completed" };
		expect(ctx.getGoalModeState()?.mode).toBe("exiting");
	});

	it("is independent of plan mode state", () => {
		const goal = activeGoalState();
		const ctx = createRunner(
			() => planModeState,
			() => goal,
		).createContext();

		expect(ctx.getPlanModeState()?.planFilePath).toBe("local://feature-plan.md");
		expect(ctx.getGoalModeState()?.goal.id).toBe(goal.goal.id);

		const seenGoal = ctx.getGoalModeState();
		expect(seenGoal).toBeDefined();
		seenGoal!.mode = "exiting";
		seenGoal!.goal.objective = "tampered";
		expect(ctx.getGoalModeState()?.mode).toBe("active");
		expect(ctx.getGoalModeState()?.goal.objective).toBe("Ship the release");
	});
});
