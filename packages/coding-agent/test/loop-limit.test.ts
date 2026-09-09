import { describe, expect, test, vi } from "bun:test";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	parseLoopLimitArgs,
} from "@oh-my-pi/pi-coding-agent/modes/loop-limit";
import type { BuiltinSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

describe("/loop slash command", () => {
	test("forwards a bare limit argument verbatim", async () => {
		const handleLoopCommand = vi.fn(async (_args?: string) => undefined);
		const runtime = {
			ctx: { handleLoopCommand, editor: { setText: vi.fn() } },
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10min", runtime);

		expect(result).toBe(true);
		expect(handleLoopCommand).toHaveBeenCalledWith("10min");
	});

	test("forwards the full residual and propagates the inline prompt for submission", async () => {
		// The dispatcher must hand the entire `<limit> <prompt>` string to
		// handleLoopCommand (the parser, not the dispatcher, splits limit vs prompt)
		// and surface the returned inline prompt so input-controller submits it.
		const handleLoopCommand = vi.fn(async (_args?: string) => "fix the failing tests");
		const setText = vi.fn();
		const runtime = {
			ctx: { handleLoopCommand, editor: { setText } },
		} as unknown as BuiltinSlashCommandRuntime;
		const result = await executeBuiltinSlashCommand("/loop 10m fix the failing tests", runtime);

		expect(handleLoopCommand).toHaveBeenCalledWith("10m fix the failing tests");
		expect(result).toBe("fix the failing tests");
		expect(setText).toHaveBeenCalledWith("");
	});
});

describe("loop limit parsing", () => {
	test("empty args produce neither a limit nor a prompt", () => {
		expect(parseLoopLimitArgs("")).toEqual({});
		expect(parseLoopLimitArgs("   ")).toEqual({});
	});

	test("parses a bare positive integer as an iteration limit", () => {
		expect(parseLoopLimitArgs("10")).toEqual({ limit: { kind: "iterations", iterations: 10 } });
	});

	test("parses minute duration aliases", () => {
		expect(parseLoopLimitArgs("10m")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
		expect(parseLoopLimitArgs("10min")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
		expect(parseLoopLimitArgs("10 minutes")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
	});

	test("parses compound durations like 1h30m", () => {
		expect(parseLoopLimitArgs("1h30m")).toEqual({ limit: { kind: "duration", durationMs: 5_400_000 } });
		expect(parseLoopLimitArgs("2h30min")).toEqual({ limit: { kind: "duration", durationMs: 9_000_000 } });
	});

	test("treats trailing text after a valid limit as an inline prompt", () => {
		expect(parseLoopLimitArgs("10m keep refactoring")).toEqual({
			limit: { kind: "duration", durationMs: 600_000 },
			prompt: "keep refactoring",
		});
		expect(parseLoopLimitArgs("5 fix the bug")).toEqual({
			limit: { kind: "iterations", iterations: 5 },
			prompt: "fix the bug",
		});
		// Space-separated unit must win over treating the count as bare iterations.
		expect(parseLoopLimitArgs("10 minutes keep going")).toEqual({
			limit: { kind: "duration", durationMs: 600_000 },
			prompt: "keep going",
		});
	});

	test("treats non-limit prose as an unbounded loop with an inline prompt", () => {
		expect(parseLoopLimitArgs("keep going")).toEqual({ prompt: "keep going" });
		expect(parseLoopLimitArgs("fix the failing tests")).toEqual({ prompt: "fix the failing tests" });
	});

	test("rejects zero, negative, and unknown limit-shaped tokens", () => {
		expect(parseLoopLimitArgs("0")).toBe("Loop count must be a positive integer.");
		expect(parseLoopLimitArgs("-1")).toContain("Usage: /loop");
		expect(parseLoopLimitArgs("10fortnights")).toBe("Loop duration unit must be seconds, minutes, or hours.");
	});
});

describe("loop limit runtime", () => {
	test("allows exactly the configured number of auto-submitted iterations", () => {
		const parsed = parseLoopLimitArgs("3");
		if (typeof parsed === "string" || !parsed.limit) throw new Error("expected parsed limit");
		expect(parsed.limit).toEqual({ kind: "iterations", iterations: 3 });

		const limit = createLoopLimitRuntime(parsed.limit);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(true);
		expect(consumeLoopLimitIteration(limit)).toBe(false);
		expect(limit).toEqual({ kind: "iterations", initial: 3, remaining: 0 });
	});

	test("stops duration-limited loops at the configured deadline", () => {
		const parsed = parseLoopLimitArgs("10m");
		if (typeof parsed === "string" || !parsed.limit) throw new Error("expected parsed limit");
		expect(parsed.limit).toEqual({ kind: "duration", durationMs: 600_000 });

		const limit = createLoopLimitRuntime(parsed.limit, 1_000);
		expect(consumeLoopLimitIteration(limit, 600_999)).toBe(true);
		expect(isLoopDurationExpired(limit, 600_999)).toBe(false);
		expect(consumeLoopLimitIteration(limit, 601_000)).toBe(false);
		expect(isLoopDurationExpired(limit, 601_000)).toBe(true);
	});
});
