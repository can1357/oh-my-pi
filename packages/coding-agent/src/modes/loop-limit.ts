import type { LoopConditionConfig } from "./loop-condition";

export type LoopLimitConfig =
	| {
			kind: "iterations";
			iterations: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
	  };

export type LoopLimitRuntime =
	| {
			kind: "iterations";
			initial: number;
			remaining: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
			deadlineMs: number;
	  };

const TIME_UNITS_MS = new Map<string, number>([
	["s", 1_000],
	["sec", 1_000],
	["secs", 1_000],
	["second", 1_000],
	["seconds", 1_000],
	["m", 60_000],
	["min", 60_000],
	["mins", 60_000],
	["minute", 60_000],
	["minutes", 60_000],
	["h", 3_600_000],
	["hr", 3_600_000],
	["hrs", 3_600_000],
	["hour", 3_600_000],
	["hours", 3_600_000],
]);

const LOOP_USAGE =
	"Usage: /loop [count|duration] [--while|--until '<command>'] [prompt]. Examples: /loop 10, /loop 10m, /loop 20 --until 'bun test' fix the failing tests.";

/**
 * Flag → `until` polarity. `--while` continues while the command succeeds;
 * `--until` continues while it fails.
 */
const CONDITION_FLAGS: Record<string, boolean | undefined> = {
	"--while": false,
	"--until": true,
};

export interface ParsedLoopArgs {
	/** Iteration/duration budget, when the user supplied a leading limit token. */
	limit?: LoopLimitConfig;
	/** Continue-condition from `--while` / `--until`, re-evaluated before each iteration. */
	condition?: LoopConditionConfig;
	/** Inline loop prompt: text after the limit and flags, or the whole argument when neither was given. */
	prompt?: string;
}

/**
 * Parse `/loop` arguments into an optional leading limit, an optional
 * continue-condition flag, and an optional inline prompt.
 *
 * A leading token that *looks* like a limit (starts with a digit or sign) or
 * like a flag (starts with `--`) but fails to parse is a hard error, so a typo
 * surfaces instead of silently becoming prompt text. Anything else is prompt
 * text, so plain prose after `/loop` keeps starting an unbounded loop (the
 * pre-arg-parsing behavior). Returns the error message string on failure.
 */
export function parseLoopArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const limitResult = takeLoopLimit(trimmed);
	if (typeof limitResult === "string") return limitResult;

	const conditionResult = takeLoopCondition(limitResult.rest);
	if (typeof conditionResult === "string") return conditionResult;

	return {
		limit: limitResult.limit,
		condition: conditionResult.condition,
		prompt: conditionResult.rest || undefined,
	};
}

/** Split an optional leading limit token off the argument string. */
function takeLoopLimit(input: string): { limit?: LoopLimitConfig; rest: string } | string {
	const firstSpace = input.search(/\s/);
	const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
	const token = firstToken.toLowerCase();

	// Not a limit attempt (prose like "keep going", or a leading condition flag).
	if (!/^[+-]?\d/.test(token)) return { rest: input };

	// Bare integer: iteration count, unless the next token is a time unit ("10 minutes").
	if (/^\d+$/.test(token)) {
		if (rest) {
			const unitToken = /^\S+/.exec(rest)?.[0] ?? "";
			const unitMs = TIME_UNITS_MS.get(unitToken.toLowerCase());
			if (unitMs !== undefined) {
				const limit = makeDuration(token, unitMs);
				if (typeof limit === "string") return limit;
				return { limit, rest: rest.slice(unitToken.length).trim() };
			}
		}
		const limit = makeIterations(token);
		if (typeof limit === "string") return limit;
		return { limit, rest };
	}

	// Compact / compound duration: "10m", "90s", "1h30m".
	const duration = parseCompoundDuration(token);
	if (duration !== undefined) {
		if (typeof duration === "string") return duration;
		return { limit: duration, rest };
	}

	// Limit-shaped but unparseable ("-1", "1.5h", "10x10").
	return LOOP_USAGE;
}

/** Split an optional leading `--while` / `--until` flag off the argument string. */
function takeLoopCondition(input: string): { condition?: LoopConditionConfig; rest: string } | string {
	let rest = input.trim();
	let condition: LoopConditionConfig | undefined;

	while (rest.startsWith("--")) {
		const name = /^--[a-z][a-z-]*/.exec(rest)?.[0];
		const until = name === undefined ? undefined : CONDITION_FLAGS[name];
		if (name === undefined || until === undefined) {
			return `Unknown /loop flag ${name ?? rest.split(/\s+/, 1)[0]}. ${LOOP_USAGE}`;
		}
		if (condition) return "Use only one of --while or --until.";

		const afterName = rest.slice(name.length);
		const valueText = afterName.startsWith("=") ? afterName.slice(1) : afterName;
		const value = readFlagValue(valueText);
		if (value === "unterminated") return `${name} has an unterminated quote.`;
		if (value === undefined || !value.value.trim() || valueText.trim().startsWith("-")) {
			return `${name} needs a shell command. Quote it when it contains spaces: /loop ${name} 'bun test'.`;
		}
		condition = { command: value.value.trim(), until };
		rest = value.rest;
	}

	return { condition, rest };
}

/**
 * Read one flag value: a single- or double-quoted run, so a multi-word command
 * survives intact, otherwise a single whitespace-delimited token. Returns
 * `undefined` when no value follows and `"unterminated"` for an unclosed quote.
 */
function readFlagValue(input: string): { value: string; rest: string } | "unterminated" | undefined {
	const text = input.trim();
	if (!text) return undefined;
	const quote = text[0];
	if (quote === "'" || quote === '"') {
		const end = text.indexOf(quote, 1);
		if (end === -1) return "unterminated";
		return { value: text.slice(1, end), rest: text.slice(end + 1).trim() };
	}
	const space = text.search(/\s/);
	if (space === -1) return { value: text, rest: "" };
	return { value: text.slice(0, space), rest: text.slice(space + 1).trim() };
}

function makeIterations(amountText: string): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop count must be a positive integer.";
	}
	return { kind: "iterations", iterations: amount };
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
	const amount = Number(amountText);
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		return "Loop duration must be positive.";
	}
	return { kind: "duration", durationMs: amount * unitMs };
}

/**
 * Parse a compact duration token such as `10m`, or a compound one like `1h30m`.
 * Returns `undefined` when the token is not duration-shaped, or an error string
 * when it is shaped like a duration but uses an unknown unit / non-positive
 * amount.
 */
function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
	if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
	const segments = token.match(/\d+[a-z]+/g);
	if (!segments) return undefined;
	let totalMs = 0;
	for (const segment of segments) {
		const match = /^(\d+)([a-z]+)$/.exec(segment);
		if (!match) return LOOP_USAGE;
		const unitMs = TIME_UNITS_MS.get(match[2]);
		if (unitMs === undefined) {
			return "Loop duration unit must be seconds, minutes, or hours.";
		}
		const amount = Number(match[1]);
		if (!Number.isSafeInteger(amount) || amount <= 0) {
			return "Loop duration must be positive.";
		}
		totalMs += amount * unitMs;
	}
	if (totalMs <= 0) return "Loop duration must be positive.";
	return { kind: "duration", durationMs: totalMs };
}

export function createLoopLimitRuntime(
	config: LoopLimitConfig | undefined,
	nowMs = Date.now(),
): LoopLimitRuntime | undefined {
	if (!config) return undefined;
	if (config.kind === "iterations") {
		return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
	}
	return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

export function consumeLoopLimitIteration(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return true;
	if (limit.kind === "duration") {
		return nowMs < limit.deadlineMs;
	}
	if (limit.remaining <= 0) return false;
	limit.remaining -= 1;
	return true;
}

export function isLoopDurationExpired(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	return limit?.kind === "duration" && nowMs >= limit.deadlineMs;
}

/**
 * True when the loop's budget is already spent: a duration past its deadline,
 * or an iteration count with none remaining. Unlike {@link consumeLoopLimitIteration}
 * this never mutates the runtime, so callers can check it before deciding
 * whether to run anything (e.g. a `/loop --while`/`--until` condition command)
 * that would otherwise run once more for a loop that is already over.
 */
export function isLoopLimitExhausted(limit: LoopLimitRuntime | undefined, nowMs = Date.now()): boolean {
	if (!limit) return false;
	if (limit.kind === "duration") return nowMs >= limit.deadlineMs;
	return limit.remaining <= 0;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
	if (config.kind === "iterations") {
		return `${config.iterations} ${config.iterations === 1 ? "iteration" : "iterations"}`;
	}
	return formatDuration(config.durationMs);
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
	if (limit.kind === "iterations") {
		return `${limit.remaining} of ${limit.initial} ${limit.initial === 1 ? "iteration" : "iterations"} remaining`;
	}
	return `${formatDuration(limit.durationMs)} limit`;
}

function formatDuration(durationMs: number): string {
	if (durationMs % 3_600_000 === 0) {
		const hours = durationMs / 3_600_000;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	if (durationMs % 60_000 === 0) {
		const minutes = durationMs / 60_000;
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}
	const seconds = durationMs / 1_000;
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
