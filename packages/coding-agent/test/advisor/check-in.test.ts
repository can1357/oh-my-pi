import { describe, expect, it, vi } from "bun:test";
import {
	ADVISOR_DEFAULT_MAX_CHECK_IN_TURNS,
	AdvisorCheckInTool,
	isAdvisorCheckInDue,
	normalizeAdvisorCheckInTurns,
	scheduleAdvisorCheckIn,
} from "../../src/advisor/check-in";

describe("Advisor self-scheduled check-ins", () => {
	it("defaults an unscheduled advisor to the next completed turn", () => {
		expect(isAdvisorCheckInDue(1, undefined)).toBe(true);
		expect(isAdvisorCheckInDue(2, 3)).toBe(false);
		expect(isAdvisorCheckInDue(3, 3)).toBe(true);
	});

	it("turns a review decision into an absolute next review turn", () => {
		expect(scheduleAdvisorCheckIn(4, 1)).toBe(5);
		expect(scheduleAdvisorCheckIn(4, 3)).toBe(7);
	});

	it("clamps a deferral to the safety bound and rejects invalid delays", () => {
		expect(normalizeAdvisorCheckInTurns(99)).toBe(ADVISOR_DEFAULT_MAX_CHECK_IN_TURNS);
		expect(normalizeAdvisorCheckInTurns(2.9)).toBe(2);
		expect(normalizeAdvisorCheckInTurns(0)).toBeUndefined();
		expect(normalizeAdvisorCheckInTurns(Number.NaN)).toBeUndefined();
		expect(scheduleAdvisorCheckIn(4, 0)).toBeUndefined();
	});

	it("lets the advisor declare one bounded check-in per review", async () => {
		const onCheckIn = vi.fn((afterTurns: number, reason?: string) => ({
			afterTurns,
			nextTurn: 7,
			reason,
		}));
		const tool = new AdvisorCheckInTool(onCheckIn);
		tool.beginUpdate();

		const scheduled = await tool.execute("check-1", { afterTurns: 3, reason: "let the worker finish" });
		expect(scheduled.details).toEqual({
			accepted: true,
			afterTurns: 3,
			nextTurn: 7,
			reason: "let the worker finish",
		});
		expect(onCheckIn).toHaveBeenCalledWith(3, "let the worker finish");

		const repeated = await tool.execute("check-2", { afterTurns: 1 });
		expect(repeated.details?.accepted).toBe(false);
		expect(onCheckIn).toHaveBeenCalledTimes(1);
	});

	it("rejects an invalid check-in without changing the schedule", async () => {
		const onCheckIn = vi.fn(() => ({ afterTurns: 1, nextTurn: 2 }));
		const tool = new AdvisorCheckInTool(onCheckIn);
		tool.beginUpdate();

		const result = await tool.execute("check-1", { afterTurns: 0 });
		expect(result.details).toEqual({ accepted: false });
		expect(onCheckIn).not.toHaveBeenCalled();
	});
});
