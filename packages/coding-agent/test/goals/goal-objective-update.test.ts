import { describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import { cfgGoalEnabled, cfgGoalModelObjectiveUpdates } from "@oh-my-pi/pi-coding-agent/goals/settings";
import type { GoalModeState, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";

function createHarness(goal: Partial<Goal> = {}) {
	let state: GoalModeState | undefined = {
		enabled: true,
		mode: "active",
		goal: {
			id: "existing-goal",
			objective: "Ship the release",
			status: "active",
			tokenBudget: 100,
			tokensUsed: 37,
			timeUsedSeconds: 12,
			createdAt: 10,
			updatedAt: 20,
			...goal,
		},
	};

	let sessionId = "original-session";
	let usage: GoalTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const settings = Settings.isolated();

	const runtime = new GoalRuntime({
		getState: () => state,
		setState: next => {
			state = next;
		},
		getCurrentUsage: () => usage,
		emit: () => {},
		persist: () => {},
		sendHiddenMessage: async () => {},
		now: () => 100,
	});

	const toolSession: ToolSession = {
		cwd: "/tmp/goal-objective-update",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => sessionId,
		getGoalModeState: () => state,
		getGoalRuntime: () => runtime,
	};

	const tool = new GoalTool(toolSession);

	return {
		tool,
		runtime,
		settings,
		state: () => structuredClone(state),
		setUsage: (next: GoalTokenUsage) => {
			usage = next;
		},
		switchSession: () => {
			sessionId = "other-session";
		},
		update: (objective: string, context?: AgentToolContext, signal?: AbortSignal) =>
			tool.execute("edit-goal", { op: "update", objective }, signal, undefined, context),
	};
}

function confirmationContext(confirm: ExtensionUIContext["confirm"]): AgentToolContext {
	const approve: NonNullable<ExtensionUIContext["approve"]> = async (proposal, options) =>
		(await confirm("Update goal objective?", proposal.full, options)) ? "once" : "deny";

	// This tool reads only the UI and approval flags from the execution context.
	return { hasUI: true, ui: { approve }, autoApprove: true } as AgentToolContext;
}

describe("model goal objective updates", () => {
	it("rejects edits without an opt-in, leaving the active mandate unchanged", async () => {
		const harness = createHarness();
		const before = harness.state();
		await expect(harness.update("Skip the release")).rejects.toThrow("disabled");
		expect(harness.state()).toEqual(before);
	});

	it("edits in place without resetting accounting or weakening a budget-limited goal", async () => {
		const harness = createHarness({ status: "budget-limited", tokenBudget: 30 });
		cfgGoalModelObjectiveUpdates.set(harness.settings, "on-request");
		const before = harness.state();

		if (!before) throw new Error("expected goal fixture");
		await harness.update("  Audit <release> & report  ");
		expect(harness.state()).toEqual({
			...before,
			goal: { ...before.goal, objective: "Audit <release> & report", updatedAt: 100 },
		});
		expect(harness.runtime.buildContinuationPrompt()).toBeUndefined();
	});

	it("keeps the turn usage baseline when the objective changes", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "on-request");
		harness.runtime.onTurnStart("turn", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		harness.setUsage({ input: 4, output: 2, cacheRead: 99, cacheWrite: 1 });
		await harness.update("Audit <release> & report");
		expect(harness.runtime.buildActivePrompt()).toContain("Audit &lt;release&gt; &amp; report");
		await harness.runtime.flushUsage("suppressed");
		expect(harness.state()?.goal.tokensUsed).toBe(44);
		expect(harness.state()?.goal.timeUsedSeconds).toBe(12);
	});

	it("requires a separate approval for every edit even when auto-approval is enabled", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const requests: string[] = [];

		const confirm = vi.fn<ExtensionUIContext["confirm"]>(async (_title, message) => {
			requests.push(message);

			return true;
		});

		const context = confirmationContext(confirm);
		await harness.update("Audit the release", context);
		await harness.update("Audit and publish the release", context);
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(requests[0]).toContain("Ship the release");
		expect(requests[0]).toContain("Audit the release");
		expect(requests[1]).toContain("Audit the release");
		expect(requests[1]).toContain("Audit and publish the release");
		expect(harness.state()?.goal.objective).toBe("Audit and publish the release");
	});

	it("leaves the goal unchanged when approval is denied or no UI can ask", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		await expect(
			harness.update(
				"Audit the release",
				confirmationContext(async () => false),
			),
		).rejects.toThrow("not approved");
		expect(harness.state()).toEqual(before);
		await expect(harness.update("Audit the release")).rejects.toThrow(/no interactive.*UI/);
		expect(harness.state()).toEqual(before);
	});

	it("rejects a select-only host instead of treating its choice as objective approval", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		const select: ExtensionUIContext["select"] = async () => "Approve";

		const context = {
			hasUI: true,
			ui: { select },
		} as AgentToolContext;

		await expect(harness.update("Publish the release", context)).rejects.toThrow(/no interactive.*UI/);
		expect(harness.state()).toEqual(before);
	});

	it("honors live permission changes without rebuilding the tool", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "on-request");
		await harness.update("Audit the release");
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		await expect(
			harness.update(
				"Publish the release",
				confirmationContext(async () => false),
			),
		).rejects.toThrow("not approved");
		cfgGoalModelObjectiveUpdates.set(harness.settings, "disabled");
		await expect(harness.update("Publish the release")).rejects.toThrow("disabled");
		expect(harness.state()?.goal.objective).toBe("Audit the release");
		const result = await harness.tool.execute("get-permissions", { op: "get" });
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringContaining("Objective editing: disabled"),
		});
	});

	it("rejects stale consent after permissions are revoked while approval is pending", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		await expect(
			harness.update(
				"Audit the release",
				confirmationContext(async () => {
					cfgGoalModelObjectiveUpdates.set(harness.settings, "disabled");

					return true;
				}),
			),
		).rejects.toThrow("permissions or session changed");
		expect(harness.state()).toEqual(before);
	});

	it("rechecks permission at the serialized mutation boundary", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "on-request");
		const before = harness.state();
		const pending = harness.update("Audit the release");
		cfgGoalModelObjectiveUpdates.set(harness.settings, "disabled");
		await expect(pending).rejects.toThrow("permissions or session changed");
		expect(harness.state()).toEqual(before);
	});

	it("refuses a session-wide grant when only this edit was presented for approval", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		const approve: NonNullable<ExtensionUIContext["approve"]> = async () => "session";
		const context = { hasUI: true, ui: { approve } } as AgentToolContext;
		await expect(harness.update("Audit the release", context)).rejects.toThrow("not approved");
		expect(harness.state()).toEqual(before);
	});

	it("rejects consent for a different session even if it inherits the same goal", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		await expect(
			harness.update(
				"Audit the release",
				confirmationContext(async () => {
					harness.switchSession();

					return true;
				}),
			),
		).rejects.toThrow("permissions or session changed");
		expect(harness.state()).toEqual(before);
	});

	it("does not apply old consent over an intervening objective edit on the same goal", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		await expect(
			harness.update(
				"Publish the release",
				confirmationContext(async () => {
					const current = harness.state()?.goal;

					if (!current) throw new Error("expected goal fixture");
					await harness.runtime.updateGoalObjective(
						{
							objective: "Inspect only; do not publish",
							expectedGoalId: current.id,
							expectedObjective: current.objective,
						},
						() => {},
					);

					return true;
				}),
			),
		).rejects.toThrow("goal changed");
		expect(harness.state()?.goal.objective).toBe("Inspect only; do not publish");
	});

	it("rejects cancellation and goal-mode disablement before applying approval", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		const controller = new AbortController();
		await expect(
			harness.update(
				"Audit the release",
				confirmationContext(async () => {
					controller.abort();

					return true;
				}),
				controller.signal,
			),
		).rejects.toThrow();
		expect(harness.state()).toEqual(before);
		await expect(
			harness.update(
				"Audit the release",
				confirmationContext(async () => {
					cfgGoalEnabled.set(harness.settings, false);

					return true;
				}),
			),
		).rejects.toThrow("permissions or session changed");
		expect(harness.state()).toEqual(before);
	});

	it("rejects budget edits and empty objectives without opening an approval prompt", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "confirm");
		const before = harness.state();
		const confirm = vi.fn<ExtensionUIContext["confirm"]>(async () => true);
		const context = confirmationContext(confirm);
		await expect(
			harness.tool.execute(
				"edit-budget",
				{
					op: "update",
					objective: "Audit the release",
					token_budget: 1000,
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("cannot change the token budget");
		await expect(harness.update(" \t\n ", context)).rejects.toThrow("objective is required");
		expect(confirm).not.toHaveBeenCalled();
		expect(harness.state()).toEqual(before);
	});

	it("does not reactivate a paused goal when editing its objective", async () => {
		const harness = createHarness();
		cfgGoalModelObjectiveUpdates.set(harness.settings, "on-request");
		await harness.runtime.pauseGoal();
		const before = harness.state();
		await expect(harness.update("Audit the release")).rejects.toThrow("no goal is active");
		expect(harness.state()).toEqual(before);
	});
});
