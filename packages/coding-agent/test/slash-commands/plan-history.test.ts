import { describe, expect, it, mock } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

/**
 * Build a minimal ctx that simulates plan/goal-mode handlers.
 *
 * `confirmExit` controls what handlePlanModeCommand does when plan mode is
 * already active: `true` simulates the user confirming exit (mode flips off);
 * `false` simulates cancel (mode stays on).
 */
function createPlanHarness(opts: { planModeEnabled: boolean; confirmExit: boolean }) {
	const state = { planModeEnabled: opts.planModeEnabled };
	const addToHistory = mock((_text: string) => {});
	const clearDraft = mock((_historyText?: string) => {});

	const ctx = {
		editor: { addToHistory, clearDraft } as unknown as InteractiveModeContext["editor"],
		get planModeEnabled() {
			return state.planModeEnabled;
		},
		handlePlanModeCommand: mock(async (_initialPrompt?: string) => {
			// Mirror interactive-mode.ts: if already active, confirm → exit; else enter.
			if (state.planModeEnabled) {
				if (opts.confirmExit) state.planModeEnabled = false;
				return;
			}
			state.planModeEnabled = true;
		}),
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx },
		state,
		addToHistory,
		clearDraft,
	};
}

function createGoalHarness(opts: { goalModeEnabled: boolean; dropOnCall: boolean }) {
	const state = { goalModeEnabled: opts.goalModeEnabled };
	const addToHistory = mock((_text: string) => {});
	const clearDraft = mock((_historyText?: string) => {});

	const ctx = {
		editor: { addToHistory, clearDraft } as unknown as InteractiveModeContext["editor"],
		get goalModeEnabled() {
			return state.goalModeEnabled;
		},
		handleGoalModeCommand: mock(async (rest?: string) => {
			if (state.goalModeEnabled && opts.dropOnCall) state.goalModeEnabled = false;
			else if (!state.goalModeEnabled && rest) state.goalModeEnabled = true;
		}),
	} as unknown as InteractiveModeContext;

	return {
		runtime: { ctx },
		state,
		addToHistory,
		clearDraft,
	};
}

describe("/plan handler when already active", () => {
	it("exits plan mode when user confirms exit", async () => {
		const h = createPlanHarness({ planModeEnabled: true, confirmExit: true });

		const handled = await executeBuiltinSlashCommand("/plan hello world", h.runtime);

		expect(handled).toBe(true);
		// Sanity check: exit was confirmed, so plan mode is now off.
		expect(h.state.planModeEnabled).toBe(false);
		expect(h.clearDraft).toHaveBeenCalled();
	});

	it("keeps plan mode active when user cancels exit", async () => {
		const h = createPlanHarness({ planModeEnabled: true, confirmExit: false });

		const handled = await executeBuiltinSlashCommand("/plan hello world", h.runtime);

		expect(handled).toBe(true);
		// Cancel: plan mode stays active.
		expect(h.state.planModeEnabled).toBe(true);
		expect(h.clearDraft).toHaveBeenCalled();
	});

	it("enters plan mode when invoked for the first time", async () => {
		const h = createPlanHarness({ planModeEnabled: false, confirmExit: false });

		await executeBuiltinSlashCommand("/plan hello world", h.runtime);

		expect(h.state.planModeEnabled).toBe(true);
		expect(h.clearDraft).toHaveBeenCalled();
	});
});

describe("/goal handler when already active", () => {
	it("drops goal mode when handler clears it", async () => {
		// Simulates the user invoking a drop path that turns goal mode off
		// inside handleGoalModeCommand. Without capturing state up-front,
		// the post-call check would miss this case.
		const h = createGoalHarness({ goalModeEnabled: true, dropOnCall: true });

		const handled = await executeBuiltinSlashCommand("/goal new objective", h.runtime);

		expect(handled).toBe(true);
		expect(h.state.goalModeEnabled).toBe(false);
	});

	it("keeps goal mode active when handler does not clear it", async () => {
		const h = createGoalHarness({ goalModeEnabled: true, dropOnCall: false });

		await executeBuiltinSlashCommand("/goal new objective", h.runtime);

		expect(h.state.goalModeEnabled).toBe(true);
	});

	it("enters goal mode when invoked for the first time", async () => {
		const h = createGoalHarness({ goalModeEnabled: false, dropOnCall: false });

		await executeBuiltinSlashCommand("/goal new objective", h.runtime);

		expect(h.state.goalModeEnabled).toBe(true);
	});
});
