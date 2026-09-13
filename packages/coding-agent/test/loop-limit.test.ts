import { describe, expect, test, vi } from "bun:test";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	isLoopLimitExhausted,
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

	// A quoted condition can legitimately contain an escaped instance of its
	// own outer delimiter (e.g. a `node -e` one-liner). An `indexOf`-based
	// scanner treats that escaped quote as the closing delimiter and silently
	// splits the command into condition/prompt text; the escape-aware scanner
	// must keep it intact end to end.
	test("handles an escaped instance of the outer delimiter inside a quoted condition", () => {
		expect(parseLoopArgs(`--until "node -e \\"process.exit(0)\\"" fix it`)).toEqual({
			condition: { command: 'node -e "process.exit(0)"', until: true },
			prompt: "fix it",
		});
		expect(parseLoopArgs(`--while "test \\"$READY\\" = yes" continue`)).toEqual({
			condition: { command: 'test "$READY" = yes', until: false },
			prompt: "continue",
		});
	});

	// A malformed flag whose valid name is immediately followed by a digit or
	// punctuation (no whitespace/`=` delimiter) must still be reported as an
	// unknown flag, not matched as a truncated known flag with the remainder
	// swallowed into the condition/prompt text.
	test("requires whitespace, `=`, or end-of-input after the flag name", () => {
		expect(parseLoopArgs("--until123 fix")).toContain("Unknown /loop flag --until123");
		expect(parseLoopArgs("--until, keep going")).toContain("Unknown /loop flag --until,");
	});

	// A multiline invocation puts the prompt on the next line. A scanner that
	// only treats space/tab as unquoted whitespace folds that next line into
	// the condition command, which then runs part of the prompt as a shell
	// command and typically disables the loop with exit 127.
	test("ends a quoted condition at a newline, leaving the next line as the prompt", () => {
		expect(parseLoopArgs("--until 'bun test'\nfix the tests")).toEqual({
			condition: { command: "bun test", until: true },
			prompt: "fix the tests",
		});
	});
});

describe("loop reminder interval (--every) parsing", () => {
	test("parses compact and compound durations", () => {
		expect(parseLoopArgs("--every 30m")).toEqual({ intervalMs: 1_800_000 });
		expect(parseLoopArgs("--every 90s")).toEqual({ intervalMs: 90_000 });
		expect(parseLoopArgs("--every 1h30m")).toEqual({ intervalMs: 5_400_000 });
	});

	test("accepts the = form", () => {
		expect(parseLoopArgs("--every=30m")).toEqual({ intervalMs: 1_800_000 });
	});

	test("composes with a leading duration budget and an inline prompt", () => {
		expect(parseLoopArgs("2h --every 30m fix tests")).toEqual({
			limit: { kind: "duration", durationMs: 7_200_000 },
			intervalMs: 1_800_000,
			prompt: "fix tests",
		});
	});

	// Order must not matter: --every is spliced into the same flag loop as
	// --while/--until, not bolted on before or after it.
	test("combines with a --while/--until condition in either order", () => {
		expect(parseLoopArgs("--every 30m --until 'bun test' fix")).toEqual({
			intervalMs: 1_800_000,
			condition: { command: "bun test", until: true },
			prompt: "fix",
		});
		expect(parseLoopArgs("--until 'bun test' --every 30m fix")).toEqual({
			condition: { command: "bun test", until: true },
			intervalMs: 1_800_000,
			prompt: "fix",
		});
	});

	test("rejects a duplicate --every flag", () => {
		expect(parseLoopArgs("--every 30m --every 1h")).toBe("Use only one --every flag.");
	});

	test("rejects a missing or unparseable value, ending with the usage string", () => {
		expect(parseLoopArgs("--every")).toContain("Usage: /loop");
		expect(parseLoopArgs("--every soon")).toContain("Usage: /loop");
		expect(parseLoopArgs("--every soon")).toContain("needs a duration");
	});

	test("rejects a zero interval", () => {
		expect(parseLoopArgs("--every 0m")).toBe("Loop duration must be positive.");
	});

	// A larger value overflows setInterval's signed 32-bit ms delay and fires
	// immediately instead of after the requested delay.
	test("rejects an interval beyond Node's max timer delay", () => {
		const result = parseLoopArgs("--every 1000h");
		expect(typeof result).toBe("string");
		expect(result).toContain("2147483647");
		expect(result).toContain("Node's max timer delay");
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

	// Non-breaking proof: a bare leading duration is still a *budget*, not a
	// reminder cadence — `--every` is the only thing that configures one.
	test("a bare leading duration still stops the loop at its deadline and configures no interval", () => {
		const parsed = parseLoopArgs("1h");
		if (typeof parsed === "string" || !parsed.limit) throw new Error("expected parsed limit");
		expect(parsed.limit).toEqual({ kind: "duration", durationMs: 3_600_000 });
		expect(parsed.intervalMs).toBeUndefined();

		const limit = createLoopLimitRuntime(parsed.limit, 0);
		expect(isLoopDurationExpired(limit, 3_599_999)).toBe(false);
		expect(isLoopLimitExhausted(limit, 3_599_999)).toBe(false);
		expect(isLoopDurationExpired(limit, 3_600_000)).toBe(true);
		expect(isLoopLimitExhausted(limit, 3_600_000)).toBe(true);
	});
});
