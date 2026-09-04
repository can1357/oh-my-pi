import { describe, expect, test, vi } from "bun:test";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	parseLoopArgs,
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
		expect(parseLoopArgs("")).toEqual({});
		expect(parseLoopArgs("   ")).toEqual({});
	});

	test("parses a bare positive integer as an iteration limit", () => {
		expect(parseLoopArgs("10")).toEqual({ limit: { kind: "iterations", iterations: 10 } });
	});

	test("parses minute duration aliases", () => {
		expect(parseLoopArgs("10m")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
		expect(parseLoopArgs("10min")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
		expect(parseLoopArgs("10 minutes")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
	});

	test("parses compound durations like 1h30m", () => {
		expect(parseLoopArgs("1h30m")).toEqual({ limit: { kind: "duration", durationMs: 5_400_000 } });
		expect(parseLoopArgs("2h30min")).toEqual({ limit: { kind: "duration", durationMs: 9_000_000 } });
	});

	test("treats trailing text after a valid limit as an inline prompt", () => {
		expect(parseLoopArgs("10m keep refactoring")).toEqual({
			limit: { kind: "duration", durationMs: 600_000 },
			prompt: "keep refactoring",
		});
		expect(parseLoopArgs("5 fix the bug")).toEqual({
			limit: { kind: "iterations", iterations: 5 },
			prompt: "fix the bug",
		});
		// Space-separated unit must win over treating the count as bare iterations.
		expect(parseLoopArgs("10 minutes keep going")).toEqual({
			limit: { kind: "duration", durationMs: 600_000 },
			prompt: "keep going",
		});
	});

	test("treats non-limit prose as an unbounded loop with an inline prompt", () => {
		expect(parseLoopArgs("keep going")).toEqual({ prompt: "keep going" });
		expect(parseLoopArgs("fix the failing tests")).toEqual({ prompt: "fix the failing tests" });
	});

	test("rejects zero, negative, and unknown limit-shaped tokens", () => {
		expect(parseLoopArgs("0")).toBe("Loop count must be a positive integer.");
		expect(parseLoopArgs("-1")).toContain("Usage: /loop");
		expect(parseLoopArgs("10fortnights")).toBe("Loop duration unit must be seconds, minutes, or hours.");
	});
});

describe("loop condition parsing", () => {
	test("composes a limit, a condition, and an inline prompt", () => {
		expect(parseLoopArgs("20 --until 'bun test' fix the failing tests")).toEqual({
			limit: { kind: "iterations", iterations: 20 },
			condition: { command: "bun test", until: true },
			prompt: "fix the failing tests",
		});
	});

	test("records the polarity of each flag", () => {
		expect(parseLoopArgs("--until 'bun test'")).toEqual({ condition: { command: "bun test", until: true } });
		expect(parseLoopArgs("--while 'test -f GO'")).toEqual({ condition: { command: "test -f GO", until: false } });
	});

	test("accepts equals, double-quoted, and bare single-token values", () => {
		expect(parseLoopArgs("--until='bun test'")).toEqual({ condition: { command: "bun test", until: true } });
		expect(parseLoopArgs('--until "bun test"')).toEqual({ condition: { command: "bun test", until: true } });
		expect(parseLoopArgs("--until true keep going")).toEqual({
			condition: { command: "true", until: true },
			prompt: "keep going",
		});
	});

	// A flag typo like `--until --while 'bun test'` must not silently consume
	// the next flag (or a bare `-f`-style token) as the command text — that
	// would only surface as a confusing runtime `exit 127` from the shell
	// instead of the parse-time error every other malformed flag gets.
	test("rejects a flag-shaped token as the condition value", () => {
		expect(parseLoopArgs("--until --while 'bun test'")).toContain("needs a shell command");
		expect(parseLoopArgs("--until -f GO keep going")).toContain("needs a shell command");
		// An explicitly quoted value starting with -- is still a real command.
		expect(parseLoopArgs("--until '--foo'")).toEqual({ condition: { command: "--foo", until: true } });
	});

	// The two limit spellings below reach the condition through different code
	// paths (space-separated unit vs. compact unit); both must hand the
	// remainder to the condition parser without collapsing internal whitespace.
	test("preserves condition-command whitespace regardless of limit spelling", () => {
		expect(parseLoopArgs('10 minutes --until "a  b" go')).toEqual({
			limit: { kind: "duration", durationMs: 600_000 },
			condition: { command: "a  b", until: true },
			prompt: "go",
		});
		expect(parseLoopArgs('10m --until "a  b" go')).toEqual({
			limit: { kind: "duration", durationMs: 600_000 },
			condition: { command: "a  b", until: true },
			prompt: "go",
		});
	});

	// A mistyped flag must not silently become prompt text — that would start an
	// unbounded, ungated loop while looking like it had a condition.
	test("rejects an unknown flag instead of treating it as prompt text", () => {
		expect(parseLoopArgs("--untl 'bun test'")).toContain("Unknown /loop flag --untl");
		expect(parseLoopArgs("--until-ish 'bun test'")).toContain("Unknown /loop flag --until-ish");
	});

	test("rejects a missing value, an unterminated quote, and both polarities at once", () => {
		expect(parseLoopArgs("--until")).toContain("needs a shell command");
		expect(parseLoopArgs("--until ''")).toContain("needs a shell command");
		expect(parseLoopArgs("--until 'bun test")).toBe("--until has an unterminated quote.");
		expect(parseLoopArgs("--until 'a' --while 'b'")).toBe("Use only one of --while or --until.");
	});

	test("leaves prose prompts that merely contain a dash untouched", () => {
		expect(parseLoopArgs("keep going --until it works")).toEqual({ prompt: "keep going --until it works" });
	});
});

describe("loop limit runtime", () => {
	test("allows exactly the configured number of auto-submitted iterations", () => {
		const parsed = parseLoopArgs("3");
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
		const parsed = parseLoopArgs("10m");
		if (typeof parsed === "string" || !parsed.limit) throw new Error("expected parsed limit");
		expect(parsed.limit).toEqual({ kind: "duration", durationMs: 600_000 });

		const limit = createLoopLimitRuntime(parsed.limit, 1_000);
		expect(consumeLoopLimitIteration(limit, 600_999)).toBe(true);
		expect(isLoopDurationExpired(limit, 600_999)).toBe(false);
		expect(consumeLoopLimitIteration(limit, 601_000)).toBe(false);
		expect(isLoopDurationExpired(limit, 601_000)).toBe(true);
	});
});
