/**
 * Adaptive Context Fidelity — token accounting baseline (ACF CH0).
 *
 * This is the FOUNDATION phase (ADAPTIVE_CONTEXT_FIDELITY_PLAN.md §7, CH0:
 * "Token accounting baseline … must land first"). Every other phase's rule #4
 * obligation — "Every transform records token telemetry (before/after, class,
 * reason) and can fail open" — is satisfied by the primitives here.
 *
 * Before this module, CH1 (distillation), CH2 (dedup) and CH6 (coverage) each
 * carried their own inline `estimateTokens = ceil(len / 4)`. This module makes
 * that estimator the single, injectable, replaceable source of truth:
 *
 *   - A `TokenCounter` PORT so a real model tokenizer can be injected later
 *     without touching any hot-path caller (rule #10 "no new source of truth",
 *     rule #16 "model-aware budgets").
 *   - The default `heuristicTokenCounter` is `ceil(len / 4)` — numerically
 *     identical to the existing inline estimators, so migrating CH1/CH2/CH6 to
 *     it is a behavior-preserving no-op.
 *   - Before/after DELTA accounting that never lies about growth.
 *   - A fail-open TELEMETRY event + injectable SINK (default no-op) so counting
 *     or emission can never crash a caller (rule #4). The sink is disabled by
 *     default — nothing here is wired into memory-fabric/index.ts or the Event
 *     Gateway; a later observe → suggest → active phase backs the sink with the
 *     real gateway (plan §5).
 *   - A model-aware budget helper (rule #16) that produces the CH0 exit
 *     criterion: trustworthy before/after token counts for one real model call.
 *
 * Additive, injectable, disabled by default. Non-mutating. Never throws.
 */

// ---------------------------------------------------------------------------
// Token counting port
// ---------------------------------------------------------------------------

/**
 * A pluggable token counter. The production hot path uses the heuristic
 * default; a real per-model tokenizer (e.g. a cl100k/o200k binding) can be
 * injected at a seam without changing any caller. Implementations MUST be
 * pure and SHOULD be fast; they may throw — callers go through `countTokens`,
 * which fails open to the heuristic.
 */
export interface TokenCounter {
	readonly name: string;
	readonly version: string;
	/** Return an estimated token count for `text` (>= 0). */
	count(text: string): number;
}

export const HEURISTIC_COUNTER_NAME = "acf-heuristic-approx";
export const HEURISTIC_COUNTER_VERSION = "ch0-1";

/**
 * Characters-per-token for the heuristic. 4 matches the inline estimators
 * already used by output-distillation (OD1), CH2 dedup and CH6 coverage, so
 * this module is a drop-in for all three with identical numbers.
 */
export const CHARS_PER_TOKEN = 4;

function heuristicCount(text: string): number {
	const len = typeof text === "string" ? text.length : 0;
	return len === 0 ? 0 : Math.ceil(len / CHARS_PER_TOKEN);
}

/** Default counter: `ceil(len / 4)`. Deterministic, dependency-free, safe. */
export const heuristicTokenCounter: TokenCounter = {
	name: HEURISTIC_COUNTER_NAME,
	version: HEURISTIC_COUNTER_VERSION,
	count: heuristicCount,
};

/** A single measured count, with the counter identity that produced it. */
export interface TokenCount {
	tokens: number;
	chars: number;
	counter: string;
	counterVersion: string;
	/** True when the injected counter failed and the heuristic was used. */
	failedOpen: boolean;
}

/**
 * Count tokens with fail-open semantics: if the injected counter throws or
 * returns a non-finite/negative value, fall back to the heuristic and flag it.
 * Never throws. A non-integer count is floored; the result is clamped to >= 0.
 */
export function countTokens(text: string, counter: TokenCounter = heuristicTokenCounter): TokenCount {
	const chars = typeof text === "string" ? text.length : 0;
	try {
		const raw = counter.count(text);
		if (!Number.isFinite(raw) || raw < 0) throw new Error("invalid token count");
		return {
			tokens: Math.floor(raw),
			chars,
			counter: counter.name,
			counterVersion: counter.version,
			failedOpen: false,
		};
	} catch {
		return {
			tokens: heuristicCount(text),
			chars,
			counter: HEURISTIC_COUNTER_NAME,
			counterVersion: HEURISTIC_COUNTER_VERSION,
			failedOpen: true,
		};
	}
}

// ---------------------------------------------------------------------------
// Before/after delta
// ---------------------------------------------------------------------------

/** Before/after token change for one transform. Honest about growth. */
export interface TokenDelta {
	before: number;
	after: number;
	/** before - after. Negative when the transform GREW the content. */
	saved: number;
	/** after / before. 1 when before is 0 (nothing to reduce). */
	ratio: number;
	/** Rounded percent reduction. Negative when the content grew. */
	percentSaved: number;
	/** True when after > before (a "never-worse" size violation upstream). */
	grew: boolean;
}

/** Compute a before/after delta from two token counts. Never throws. */
export function tokenDelta(before: number, after: number): TokenDelta {
	const b = Number.isFinite(before) && before > 0 ? Math.floor(before) : 0;
	const a = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
	const saved = b - a;
	const ratio = b === 0 ? 1 : a / b;
	const percentSaved = b === 0 ? 0 : Math.round((saved / b) * 100);
	return { before: b, after: a, saved, ratio, percentSaved, grew: a > b };
}

// ---------------------------------------------------------------------------
// Telemetry event + sink
// ---------------------------------------------------------------------------

export const TOKEN_TELEMETRY_KIND = "acf.token-accounting" as const;
export const TOKEN_TELEMETRY_SCHEMA_VERSION = 1;

/**
 * A structured token-telemetry event (rule #4). Deliberately decoupled from the
 * Event Gateway's MemoryRecord schema and from CH3's FidelityClass (fidelity is
 * a plain string here) so this foundation module has no upstream dependency; a
 * later phase maps this onto a gateway event when the sink is wired.
 */
export interface TokenTelemetryEvent {
	kind: typeof TOKEN_TELEMETRY_KIND;
	schemaVersion: number;
	/** Pipeline stage, e.g. "dedup" | "distill" | "coverage" | "model-call". */
	stage: string;
	/** Why the transform ran (free-form, for auditability). */
	reason?: string;
	/** Fidelity class of the item, when applicable (F0–F4 as a string). */
	fidelityClass?: string;
	/** Id of the item this event concerns, when applicable. */
	itemId?: string;
	counter: string;
	counterVersion: string;
	before: number;
	after: number;
	saved: number;
	ratio: number;
	percentSaved: number;
	grew: boolean;
	/** True when a token count failed and fell back to the heuristic. */
	failedOpen: boolean;
	/** ISO timestamp. */
	at: string;
}

export interface AccountOptions {
	/** Pipeline stage label (required so every event is attributable). */
	stage: string;
	reason?: string;
	fidelityClass?: string;
	itemId?: string;
	/** Token counter to use for both sides (default: heuristic). */
	counter?: TokenCounter;
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

/**
 * Build a telemetry event from raw before/after TEXT. Counts both sides with
 * the same counter so the delta is apples-to-apples. Never throws.
 */
export function accountText(before: string, after: string, options: AccountOptions): TokenTelemetryEvent {
	const counter = options.counter ?? heuristicTokenCounter;
	const b = countTokens(before, counter);
	const a = countTokens(after, counter);
	return buildEvent(b.tokens, a.tokens, b.failedOpen || a.failedOpen, b.counter, b.counterVersion, options);
}

/**
 * Build a telemetry event from pre-computed before/after TOKEN counts (for
 * callers that already counted, e.g. dedup summing item lengths). Never throws.
 */
export function accountTokens(before: number, after: number, options: AccountOptions): TokenTelemetryEvent {
	const counter = options.counter ?? heuristicTokenCounter;
	return buildEvent(before, after, false, counter.name, counter.version, options);
}

function buildEvent(
	before: number,
	after: number,
	failedOpen: boolean,
	counterName: string,
	counterVersion: string,
	options: AccountOptions,
): TokenTelemetryEvent {
	const now = options.now ?? (() => new Date());
	const delta = tokenDelta(before, after);
	const event: TokenTelemetryEvent = {
		kind: TOKEN_TELEMETRY_KIND,
		schemaVersion: TOKEN_TELEMETRY_SCHEMA_VERSION,
		stage: options.stage,
		counter: counterName,
		counterVersion: counterVersion,
		before: delta.before,
		after: delta.after,
		saved: delta.saved,
		ratio: delta.ratio,
		percentSaved: delta.percentSaved,
		grew: delta.grew,
		failedOpen,
		at: now().toISOString(),
	};
	if (options.reason !== undefined) event.reason = options.reason;
	if (options.fidelityClass !== undefined) event.fidelityClass = options.fidelityClass;
	if (options.itemId !== undefined) event.itemId = options.itemId;
	return event;
}

/** A sink for telemetry events. Implementations MUST NOT throw to the caller. */
export interface TokenTelemetrySink {
	emit(event: TokenTelemetryEvent): void;
}

/** Default sink: discards everything (disabled by default; observe-mode off). */
export const noopTelemetrySink: TokenTelemetrySink = { emit() {} };

/** Buffering sink for tests and observe mode. Never throws. */
export class InMemoryTelemetrySink implements TokenTelemetrySink {
	readonly events: TokenTelemetryEvent[] = [];

	emit(event: TokenTelemetryEvent): void {
		this.events.push(event);
	}

	/** Total tokens saved across all recorded events (negative if net growth). */
	get totalSaved(): number {
		let total = 0;
		for (const e of this.events) total += e.saved;
		return total;
	}

	clear(): void {
		this.events.length = 0;
	}
}

/**
 * Emit an event to a sink, fail-open: a throwing sink can never break the hot
 * path (rule #4). Defaults to the no-op sink so accounting is inert until a
 * later phase injects a real sink.
 */
export function emitTokenTelemetry(event: TokenTelemetryEvent, sink: TokenTelemetrySink = noopTelemetrySink): void {
	try {
		sink.emit(event);
	} catch {
		// Telemetry must never break the caller.
	}
}

// ---------------------------------------------------------------------------
// Model-aware budgets (rule #16) + the CH0 model-call exit criterion
// ---------------------------------------------------------------------------

/**
 * Known model context windows (tokens). Conservative, additive, and easy to
 * extend; `default` is used for unknown models. These are budgets, NOT targets
 * (plan §1.2: "a 1M-token window is capacity, not a target fill level").
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	default: 128000,
	"gpt-4o": 128000,
	"gpt-4-turbo": 128000,
	"gpt-4.1": 1000000,
	"claude-3-5-sonnet": 200000,
	"claude-3-5-haiku": 200000,
	"claude-3-opus": 200000,
	"gemini-1.5-pro": 1000000,
	"gemini-1.5-flash": 1000000,
};

/** Resolve a model's context window, falling back to `default`. Never throws. */
export function budgetForModel(model?: string): number {
	if (model && Object.hasOwn(MODEL_CONTEXT_WINDOWS, model)) {
		return MODEL_CONTEXT_WINDOWS[model];
	}
	return MODEL_CONTEXT_WINDOWS.default;
}

/** The result of accounting one real model call's before/after packet size. */
export interface ModelCallAccounting {
	model: string;
	contextWindow: number;
	/** Tokens in the raw packet before the hygiene gate ran. */
	beforeTokens: number;
	/** Tokens in the final packet actually sent. */
	afterTokens: number;
	/** contextWindow - afterTokens (can be negative if over budget). */
	remaining: number;
	/** afterTokens / contextWindow. */
	fillRatio: number;
	/** True when the final packet exceeds the model's window. */
	overBudget: boolean;
	delta: TokenDelta;
	/** The telemetry event for this model call (stage = "model-call"). */
	event: TokenTelemetryEvent;
}

export interface ModelCallOptions {
	model?: string;
	counter?: TokenCounter;
	reason?: string;
	now?: () => Date;
}

/**
 * Account one real model call: measure the raw packet vs the final packet
 * against the target model's window, and produce a telemetry event. This is
 * the CH0 exit criterion — trustworthy before/after token counts for one real
 * model call. Never throws.
 */
export function accountModelCall(
	rawPacket: string,
	finalPacket: string,
	options: ModelCallOptions = {},
): ModelCallAccounting {
	const model = options.model ?? "default";
	const contextWindow = budgetForModel(options.model);
	const counter = options.counter ?? heuristicTokenCounter;
	const before = countTokens(rawPacket, counter);
	const after = countTokens(finalPacket, counter);
	const delta = tokenDelta(before.tokens, after.tokens);
	const failedOpen = before.failedOpen || after.failedOpen;
	const event = buildEvent(before.tokens, after.tokens, failedOpen, before.counter, before.counterVersion, {
		stage: "model-call",
		reason: options.reason ?? `model=${model}`,
		now: options.now,
	});
	return {
		model,
		contextWindow,
		beforeTokens: delta.before,
		afterTokens: delta.after,
		remaining: contextWindow - delta.after,
		fillRatio: contextWindow === 0 ? 0 : delta.after / contextWindow,
		overBudget: delta.after > contextWindow,
		delta,
		event,
	};
}

export const TOKEN_ACCOUNTING_NAME = "acf-token-accounting";
export const TOKEN_ACCOUNTING_VERSION = "ch0-1";
