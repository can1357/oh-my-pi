/**
 * Anthropic subscription "slow mode" (Claude Code's `/low-priority`).
 *
 * After a Claude subscription account hits its 5-hour session limit, Anthropic
 * may offer to keep serving it on spare capacity. A request opts in with
 * `anthropic-usage-limit: slow`; the server reports the lane state back in
 * `anthropic-ratelimit-unified-slow-*` response headers, and answers "no spare
 * capacity right now" with a 429 `slot_busy` or a 529 overload that the client
 * retries after the server-stated interval.
 *
 * Before the slow lane, the server may grant a small wrap-up allowance (drawn
 * from the weekly limit) past the session limit: 2xx responses then carry
 * `anthropic-ratelimit-unified-grace-{5h,7d}-utilization` above zero.
 *
 * This module owns the wire contract only (header names, parsing). The mode's
 * state machine lives with the caller, which plugs into the Anthropic provider
 * through {@link AnthropicSlowModeHooks}.
 */
import type { HeadersLike } from "../utils/retry-after";

/** Request header that opts a first-party OAuth request into the slow lane. */
export const ANTHROPIC_USAGE_LIMIT_HEADER = "anthropic-usage-limit";
/** {@link ANTHROPIC_USAGE_LIMIT_HEADER} value selecting the slow lane. */
export const ANTHROPIC_SLOW_USAGE_LIMIT = "slow";

/** Server-side experiment arm; only `treatment` accounts may enter the slow lane. */
export type AnthropicSlowOffer = "treatment" | "control";

/** `anthropic-ratelimit-unified-slow-status` values; unknown strings map to `unrecognized`. */
export type AnthropicSlowStatus =
	| "active"
	| "not_needed"
	| "slot_busy"
	| "weekly_limit"
	| "budget_exhausted"
	| "ineligible"
	| "off"
	| "unrecognized";

/** Slow-lane facts carried by one Anthropic response (success or error). */
export interface AnthropicSlowModeSignal {
	offer?: AnthropicSlowOffer;
	status?: AnthropicSlowStatus;
	/** Server-stated interval between capacity retries. */
	retryAfterMs?: number;
	/** Server-stated ceiling on total time spent waiting for capacity. */
	maxWaitMs?: number;
	/** Fraction (0..1) of the weekly slow-lane allowance already used. */
	budgetUtilization?: number;
	/** Epoch seconds when the slow-lane allowance resets. */
	budgetResetAtSec?: number;
	/** Epoch seconds of `anthropic-ratelimit-unified-reset` (the limit that was hit). */
	unifiedResetAtSec?: number;
	/** Epoch seconds of the 5-hour window reset. */
	fiveHourResetAtSec?: number;
	/** Epoch seconds of the weekly window reset. */
	weeklyResetAtSec?: number;
	/** True when the response carries unified usage-limit claim headers (a limit wall). */
	unifiedLimitClaim: boolean;
	/** True when extra usage (overage) is serving this account. */
	overageInUse: boolean;
	/**
	 * Wrap-up allowance usage (0..1) past the 5-hour and weekly limits; any
	 * value above zero means the request ran on the allowance. Present only on
	 * responses carrying `anthropic-ratelimit-unified-status`.
	 */
	graceUtilization?: { fiveHour: number; sevenDay: number };
	/** True when `anthropic-ratelimit-unified-overage-status` lets extra usage serve requests. */
	overageAllowed?: boolean;
}

/** One pre-content failure the provider hands to {@link AnthropicSlowModeHooks.onFailure}. */
export interface AnthropicSlowModeFailure {
	/** Account lane of the failed request (see {@link AnthropicSlowModeHooks}). */
	lane: string;
	httpStatus?: number;
	/** 529 or an `overloaded_error` envelope. */
	overloaded: boolean;
	signal?: AnthropicSlowModeSignal;
	/** Whether the failed request carried `anthropic-usage-limit: slow`. */
	sentSlow: boolean;
	/** Milliseconds this request has already spent waiting for slow-lane capacity. */
	waitedMs: number;
	/** Capacity waits already taken by this request. */
	attempts: number;
}

/** Retry decision returned by {@link AnthropicSlowModeHooks.onFailure}. */
export interface AnthropicSlowModeRetry {
	/** Delay before resending; `0` resends immediately. */
	delayMs: number;
	/** True when the delay is a capacity wait (counts toward the max-wait budget). */
	capacityWait: boolean;
}

/**
 * Caller-owned slow-mode state machine. The Anthropic provider only consults
 * it for first-party OAuth requests (`api.anthropic.com` with a subscription
 * bearer); every other route ignores it.
 *
 * Slow-lane state belongs to one Claude account, so every call carries a
 * `lane` key identifying the credential that served the request: `cred:<id>`
 * for a stored credential, else `key:<hash>` of the bearer.
 */
export interface AnthropicSlowModeHooks {
	/** Whether the next request on `lane` should carry `anthropic-usage-limit: slow`. */
	isActive(lane: string): boolean;
	/** Observe the slow-lane headers of a successful (2xx) response on `lane`. */
	observe(signal: AnthropicSlowModeSignal, lane: string): void;
	/**
	 * Decide how to react to a failure that arrived before any content. Return
	 * a retry to resend the request (with or without the slow header, per
	 * {@link isActive}), or `undefined` to let normal error handling run.
	 */
	onFailure(
		failure: AnthropicSlowModeFailure,
	): AnthropicSlowModeRetry | undefined | Promise<AnthropicSlowModeRetry | undefined>;
}

const SLOW_HEADER_PREFIX = "anthropic-ratelimit-unified-slow-";

function readHeader(headers: HeadersLike, name: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const direct = headers[name];
	if (direct !== undefined) return direct;
	for (const key in headers) {
		if (key.toLowerCase() === name) return headers[key];
	}
	return undefined;
}

function readNonNegative(headers: HeadersLike, name: string): number | undefined {
	const raw = readHeader(headers, name)?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Utilization header clamped to 0..1; absent or malformed reads as 0. */
function readUtilization(headers: HeadersLike, name: string): number {
	const value = readNonNegative(headers, name);
	return value === undefined ? 0 : Math.min(1, value);
}

function parseStatus(raw: string | undefined): AnthropicSlowStatus | undefined {
	if (raw === undefined) return undefined;
	switch (raw.trim()) {
		case "active":
			return "active";
		case "not_needed":
			return "not_needed";
		case "slot_busy":
			return "slot_busy";
		case "weekly_limit":
			return "weekly_limit";
		case "budget_exhausted":
			return "budget_exhausted";
		case "ineligible":
			return "ineligible";
		case "off":
			return "off";
		default:
			return "unrecognized";
	}
}

/**
 * Parse the slow-lane and unified-limit headers relevant to slow mode.
 * Returns `undefined` when the response carries none of them.
 */
export function parseAnthropicSlowModeHeaders(headers: HeadersLike): AnthropicSlowModeSignal | undefined {
	if (!headers) return undefined;
	const offerRaw = readHeader(headers, `${SLOW_HEADER_PREFIX}offer`)?.trim();
	const offer = offerRaw === "treatment" || offerRaw === "control" ? offerRaw : undefined;
	const status = parseStatus(readHeader(headers, `${SLOW_HEADER_PREFIX}status`));
	const retryAfterSec = readNonNegative(headers, `${SLOW_HEADER_PREFIX}retry-after`);
	const maxWaitSec = readNonNegative(headers, `${SLOW_HEADER_PREFIX}max-wait`);
	const budgetUtilization = readNonNegative(headers, `${SLOW_HEADER_PREFIX}budget-utilization`);
	const budgetResetAtSec = readNonNegative(headers, `${SLOW_HEADER_PREFIX}budget-reset`);
	const unifiedResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-reset");
	const fiveHourResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-5h-reset");
	const weeklyResetAtSec = readNonNegative(headers, "anthropic-ratelimit-unified-7d-reset");
	const unifiedLimitClaim = Boolean(
		readHeader(headers, "anthropic-ratelimit-unified-representative-claim") ||
		readHeader(headers, "anthropic-ratelimit-unified-overage-status"),
	);
	const overageInUse = readHeader(headers, "anthropic-ratelimit-unified-overage-in-use")?.trim() === "true";
	const overageStatus = readHeader(headers, "anthropic-ratelimit-unified-overage-status")?.trim();
	const overageAllowed = overageStatus === "allowed" || overageStatus === "allowed_warning";
	const graceUtilization =
		readHeader(headers, "anthropic-ratelimit-unified-status") === undefined
			? undefined
			: {
					fiveHour: readUtilization(headers, "anthropic-ratelimit-unified-grace-5h-utilization"),
					sevenDay: readUtilization(headers, "anthropic-ratelimit-unified-grace-7d-utilization"),
				};
	const signal: AnthropicSlowModeSignal = {
		...(offer !== undefined ? { offer } : {}),
		...(status !== undefined ? { status } : {}),
		...(retryAfterSec !== undefined ? { retryAfterMs: Math.round(retryAfterSec * 1000) } : {}),
		...(maxWaitSec !== undefined ? { maxWaitMs: Math.round(maxWaitSec * 1000) } : {}),
		...(budgetUtilization !== undefined ? { budgetUtilization: Math.min(1, budgetUtilization) } : {}),
		...(budgetResetAtSec !== undefined ? { budgetResetAtSec } : {}),
		...(unifiedResetAtSec !== undefined ? { unifiedResetAtSec } : {}),
		...(fiveHourResetAtSec !== undefined ? { fiveHourResetAtSec } : {}),
		...(weeklyResetAtSec !== undefined ? { weeklyResetAtSec } : {}),
		unifiedLimitClaim,
		overageInUse,
		...(overageAllowed ? { overageAllowed } : {}),
		...(graceUtilization !== undefined ? { graceUtilization } : {}),
	};
	const hasSlowFacts =
		offer !== undefined ||
		status !== undefined ||
		retryAfterSec !== undefined ||
		maxWaitSec !== undefined ||
		budgetUtilization !== undefined ||
		budgetResetAtSec !== undefined;
	// A unified-status response always carries wrap-up facts, even when both
	// grace readings are zero: that is how the controller sees the window close.
	if (
		!hasSlowFacts &&
		graceUtilization === undefined &&
		!unifiedLimitClaim &&
		fiveHourResetAtSec === undefined &&
		unifiedResetAtSec === undefined
	) {
		return undefined;
	}
	return signal;
}
