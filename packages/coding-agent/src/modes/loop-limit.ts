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

const LOOP_USAGE = "Usage: /loop [count|duration]. Examples: /loop 10, /loop 10m, /loop 10min.";

export interface ParsedLoopArgs {
	/** Iteration/duration budget, when the user supplied a leading limit token. */
	limit?: LoopLimitConfig;
	/** Inline loop prompt: text after the limit, or the whole argument when no limit was given. */
	prompt?: string;
}

/**
 * Parse `/loop` arguments into an optional leading limit plus an optional inline
 * prompt. A token that *looks* like a limit (starts with a digit or sign) but
 * fails to parse is a hard error; anything else is treated as prompt text, so
 * plain prose after `/loop` keeps starting an unbounded loop instead of erroring
 * (the pre-arg-parsing behavior). Returns the error message string on failure.
 */
export function parseLoopLimitArgs(args: string): ParsedLoopArgs | string {
	const trimmed = args.trim();
	if (!trimmed) return {};

	const firstSpace = trimmed.search(/\s/);
	const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
	const token = firstToken.toLowerCase();

	// Not a limit attempt (prose like "keep going") → unbounded loop, prompt = full args.
	if (!/^[+-]?\d/.test(token)) {
		return { prompt: trimmed };
	}

	// Bare integer: iteration count, unless the next token is a time unit ("10 minutes").
	if (/^\d+$/.test(token)) {
		if (rest) {
			const restTokens = rest.split(/\s+/);
			const unitMs = TIME_UNITS_MS.get(restTokens[0].toLowerCase());
			if (unitMs !== undefined) {
				const limit = makeDuration(token, unitMs);
				if (typeof limit === "string") return limit;
				return { limit, prompt: restTokens.slice(1).join(" ").trim() || undefined };
			}
		}
		const limit = makeIterations(token);
		if (typeof limit === "string") return limit;
		return { limit, prompt: rest || undefined };
	}

	// Compact / compound duration: "10m", "90s", "1h30m".
	const duration = parseCompoundDuration(token);
	if (duration !== undefined) {
		if (typeof duration === "string") return duration;
		return { limit: duration, prompt: rest || undefined };
	}

	// Limit-shaped but unparseable ("-1", "1.5h", "10x10").
	return LOOP_USAGE;
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
