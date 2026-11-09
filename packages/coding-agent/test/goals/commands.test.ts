import { describe, expect, it } from "bun:test";
import { parseGoalBudget, parseGoalSubcommand } from "@oh-my-pi/pi-coding-agent/goals/commands";

describe("parseGoalBudget", () => {
	it("accepts positive decimal digits and normalizes leading zeroes", () => {
		expect(parseGoalBudget(" \t0100\n")).toBe(100);
	});

	it("clears the budget only for case-insensitive off", () => {
		expect(parseGoalBudget(" \tOfF\n")).toBeUndefined();
	});

	it.each(["", "0", "1e3", "off extra", "9".repeat(400)])("rejects invalid budget %j with command usage", raw => {
		expect(() => parseGoalBudget(raw)).toThrow("Usage: /goal budget <positive integer|off>");
	});
});

describe("parseGoalSubcommand", () => {
	it("recognizes subcommands case-insensitively while preserving argument case", () => {
		expect(parseGoalSubcommand(" \tBUDGET\n Keep Original\nCase \t")).toEqual({
			sub: "budget",
			rest: "Keep Original\nCase",
		});
	});

	it("accepts empty input and subcommands without arguments", () => {
		expect(parseGoalSubcommand(" \t\n")).toEqual({ sub: undefined, rest: "" });
		expect(parseGoalSubcommand(" BUDGET ")).toEqual({ sub: "budget", rest: "" });
	});

	it.each(["budgeting for release", "constructor"])("preserves unknown objective %j", objective => {
		expect(parseGoalSubcommand(`  ${objective}  `)).toEqual({ sub: undefined, rest: objective });
	});
});
