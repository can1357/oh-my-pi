import { describe, expect, it } from "bun:test";
import { parseTurnBudget } from "@oh-my-pi/pi-coding-agent/modes/turn-budget";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("parseTurnBudget", () => {
	it("parses k/m multipliers, plain counts, and decimals", () => {
		expect(parseTurnBudget("+500k")).toEqual({ total: 500_000, hard: false });
		expect(parseTurnBudget("+2m")).toEqual({ total: 2_000_000, hard: false });
		expect(parseTurnBudget("+1500")).toEqual({ total: 1_500, hard: false });
		expect(parseTurnBudget("+1.5k")).toEqual({ total: 1_500, hard: false });
	});

	it("marks the budget hard only with a trailing !", () => {
		expect(parseTurnBudget("+500k!")).toEqual({ total: 500_000, hard: true });
		expect(parseTurnBudget("audit this thoroughly +250k!")).toEqual({ total: 250_000, hard: true });
	});

	it("matches the directive embedded in a sentence", () => {
		expect(parseTurnBudget("be exhaustive +500k please")).toEqual({ total: 500_000, hard: false });
	});

	it("ignores non-directives and junk", () => {
		expect(parseTurnBudget("nothing here")).toBeNull();
		expect(parseTurnBudget("version 1.2.3")).toBeNull();
		expect(parseTurnBudget("+0")).toBeNull();
		expect(parseTurnBudget("c++ stuff")).toBeNull();
		// `+` glued to a non-numeric or trailing garbage must not match.
		expect(parseTurnBudget("+500kfoo")).toBeNull();
	});
});

describe("SessionManager turn budget accounting", () => {
	it("snapshots a window, accrues eval-subagent output, and reports the ceiling + hard flag", () => {
		const sm = SessionManager.inMemory();

		sm.beginTurnBudget(100_000, true);
		expect(sm.getTurnBudget()).toEqual({ total: 100_000, spent: 0, hard: true });

		sm.recordEvalSubagentOutput(3_000);
		sm.recordEvalSubagentOutput(1_500);
		expect(sm.getTurnBudget()).toEqual({ total: 100_000, spent: 4_500, hard: true });

		// Non-positive / non-finite deltas are ignored.
		sm.recordEvalSubagentOutput(0);
		sm.recordEvalSubagentOutput(Number.NaN);
		expect(sm.getTurnBudget().spent).toBe(4_500);
	});

	it("resets spend and clears the ceiling when a new window opens with no directive", () => {
		const sm = SessionManager.inMemory();
		sm.beginTurnBudget(50_000, false);
		sm.recordEvalSubagentOutput(9_000);
		expect(sm.getTurnBudget()).toEqual({ total: 50_000, spent: 9_000, hard: false });

		sm.beginTurnBudget(null, false);
		expect(sm.getTurnBudget()).toEqual({ total: null, spent: 0, hard: false });
	});
});
