/**
 * Pure pacing policy for the usage governor (spec 3.4). No I/O and no clock reads:
 * callers pass `nowMs` and every snapshot or ledger fact they observed.
 */
import { isUsageLimitExhausted, reserveUsageLimits } from "../auth/usage-report";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageLimit,
	UsageReport,
	UsageWindow,
} from "../usage";
import type { UsageGovernorWaitReason, UsageWindowState } from "./types";

/** A snapshot older than this never gates a request. */
export const GOVERNOR_STALE_MS = 15 * 60_000;
/** Reservations between the first and last observation needed before a cost is measured. */
export const GOVERNOR_CALIBRATION_MIN_SAMPLES = 3;
/** Width of a generation bucket: `floor(resetsAt / GOVERNOR_GENERATION_MS)`. */
export const GOVERNOR_GENERATION_MS = 60_000;

/** Reset labels that name a rolling regeneration rather than a full window reset. */
const ROLLING_RESET_LABELS: Record<string, true> = { tick: true, regen: true };

/** One paced window of the selected account, derived from a cached usage report. */
export interface ApplicableWindow {
	/** Quota identity shared by duplicate rows and routing-specific copies (see {@link quotaKey}). */
	quotaKey: string;
	limitId?: string;
	/** Usage window id (for example `5h`, `7d`), or the limit id when the window has no id. */
	windowId: string;
	/** Display label for the window. */
	label: string;
	/** Absolute window reset in ms. */
	resetsAt: number;
	/** Window duration in ms when known. */
	durationMs?: number;
	/** Used fraction (0..1; above 1 is overage) from the snapshot, when reported. */
	usedFraction?: number;
	/** Whether the snapshot shows the limit exhausted. */
	exhausted: boolean;
	/** When the snapshot was fetched. */
	fetchedAt: number;
	/** Reset bucket for calibration. */
	generation: number;
}

/** Identity of a quota for the ledger. */
export interface QuotaIdentity {
	provider: string;
	/** `scope.sharedGroup` when the limit is a shared copy of one upstream quota. */
	sharedGroup?: string;
	/** Window id; part of the identity when a shared group is set. */
	windowId: string;
	/** Limit id; part of the identity for account-scoped quotas. */
	limitId: string;
	/** Stable account identity from `usageCacheIdentity`; unused when `sharedGroup` is set. */
	accountIdentity: string;
}

/** Quota key: duplicate rows and shared copies of one upstream quota are charged once. */
export function quotaKey(identity: QuotaIdentity): string {
	if (identity.sharedGroup !== undefined) {
		return `${identity.provider} | acct:${identity.accountIdentity} | group:${identity.sharedGroup} | win:${identity.windowId}`;
	}
	return `${identity.provider} | acct:${identity.accountIdentity} | limit:${identity.limitId}`;
}

/** Reset bucket of a window: `floor(resetsAt / 60_000)`. */
export function governorGeneration(resetsAt: number): number {
	return Math.floor(resetsAt / GOVERNOR_GENERATION_MS);
}

function finitePositive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Applicable windows of the selected account (spec 3.4): reserve limits for the
 * model, kept only when the reset is finite, current and not a rolling label.
 * Windowless limits (credits, extra usage) and rolling windows are not paced.
 */
export function applicableWindows(input: {
	strategy: CredentialRankingStrategy | undefined;
	report: UsageReport;
	context: CredentialRankingContext;
	nowMs: number;
	provider: string;
	accountIdentity: string;
}): ApplicableWindow[] {
	const { strategy, report, context, nowMs } = input;
	const limits = reserveUsageLimits(strategy, report, context);
	if (limits.length === 0) return [];
	const defaults = strategy ? strategy.findWindowLimits(report, context) : undefined;
	const windows: ApplicableWindow[] = [];
	for (const limit of limits) {
		const window = limit.window;
		if (!window) continue;
		const resetsAt = window.resetsAt;
		if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) continue;
		if (window.resetLabel !== undefined && ROLLING_RESET_LABELS[window.resetLabel] === true) continue;
		// Same current-window test as the health reserve check (health.ts): a reset that has passed
		// stays current only while the snapshot was fetched after it.
		if (!(resetsAt > nowMs || report.fetchedAt >= resetsAt)) continue;
		const windowId = window.id || limit.id;
		windows.push({
			quotaKey: quotaKey({
				provider: input.provider,
				sharedGroup: limit.scope.sharedGroup,
				windowId,
				limitId: limit.id,
				accountIdentity: input.accountIdentity,
			}),
			limitId: limit.id,
			windowId,
			label: window.label || limit.label,
			resetsAt,
			durationMs: windowDuration(limit, window, defaults, strategy),
			usedFraction: usedFractionOf(limit),
			exhausted: isUsageLimitExhausted(limit),
			fetchedAt: limit.observedAt ?? 0,
			generation: governorGeneration(resetsAt),
		});
	}
	return windows;
}

function windowDuration(
	limit: UsageLimit,
	window: UsageWindow,
	defaults: { primary?: UsageLimit; secondary?: UsageLimit } | undefined,
	strategy: CredentialRankingStrategy | undefined,
): number | undefined {
	const declared = finitePositive(window.durationMs);
	if (declared !== undefined) return declared;
	if (!strategy || !defaults) return undefined;
	if (defaults.primary !== undefined && (defaults.primary === limit || defaults.primary.id === limit.id)) {
		return finitePositive(strategy.windowDefaults.primaryMs);
	}
	if (defaults.secondary !== undefined && (defaults.secondary === limit || defaults.secondary.id === limit.id)) {
		return finitePositive(strategy.windowDefaults.secondaryMs);
	}
	return undefined;
}

function usedFractionOf(limit: UsageLimit): number | undefined {
	const { amount } = limit;
	if (amount.usedFraction !== undefined && Number.isFinite(amount.usedFraction)) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		const fraction = amount.used / amount.limit;
		return Number.isFinite(fraction) ? fraction : undefined;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined && Number.isFinite(amount.remainingFraction)) {
		return Math.max(0, 1 - amount.remainingFraction);
	}
	return undefined;
}

/** Inputs for one window's decision. */
export interface WindowPolicyInput {
	nowMs: number;
	/** Share of the window's allowance usable ahead of linear pacing at the window start (0..1). */
	lead: number;
	/** Reserve fraction `r` (0..1) for this request. */
	reserve: number;
	resetsAt: number;
	durationMs?: number;
	usedFraction?: number;
	exhausted: boolean;
	fetchedAt: number;
	/** Reservations created after the snapshot, across all processes (`p`). */
	pending: number;
	/** Calibrated cost per request (`c`); 0 when uncalibrated. */
	costPerRequest: number;
}

/** A window's state and the earliest time a request may pass it. */
export interface WindowDecision {
	state: UsageWindowState;
	/** Earliest time the window admits a request; `<= nowMs` when it does not gate. */
	admissibleAtMs: number;
	reason?: UsageGovernorWaitReason;
	/** Allowed fraction `A` at `nowMs`, when computed. */
	allowedFraction?: number;
	/** Projected used fraction `need`, when computed. */
	neededFraction?: number;
}

/** Decide one window (spec 3.4): stale and unknown never gate; closed, paced or open otherwise. */
export function evaluateWindow(input: WindowPolicyInput): WindowDecision {
	const { nowMs, lead, reserve, resetsAt, fetchedAt } = input;
	if (nowMs - fetchedAt > GOVERNOR_STALE_MS) return { state: "stale", admissibleAtMs: nowMs };
	// A reset that has already passed has no admissible time to pace toward; the next snapshot names the next window.
	if (resetsAt <= nowMs) return { state: "unknown", admissibleAtMs: nowMs };
	if (input.exhausted && input.usedFraction === undefined) {
		return { state: "closed", admissibleAtMs: resetsAt, reason: "exhausted" };
	}
	if (input.usedFraction === undefined) return { state: "unknown", admissibleAtMs: nowMs };
	const headroom = 1 - reserve;
	const need = input.usedFraction + (input.pending + 1) * input.costPerRequest;
	if (input.exhausted || input.usedFraction >= 1) {
		return { state: "closed", admissibleAtMs: resetsAt, reason: "exhausted", neededFraction: need };
	}
	if (need > headroom + 1e-9) {
		return { state: "closed", admissibleAtMs: resetsAt, reason: "reserve-held", neededFraction: need };
	}
	const duration = input.durationMs;
	if (duration === undefined) {
		// Without a duration there is no line; the reserve is the only bound.
		return { state: "open", admissibleAtMs: nowMs, allowedFraction: headroom, neededFraction: need };
	}
	const elapsed = clamp01((nowMs - (resetsAt - duration)) / duration);
	const allowed = headroom * (lead + (1 - lead) * elapsed);
	if (need <= allowed + 1e-9) {
		return { state: "open", admissibleAtMs: nowMs, allowedFraction: allowed, neededFraction: need };
	}
	const pacedUntil = pacedUntilMs({ resetsAt, duration, lead, headroom, need });
	if (pacedUntil <= nowMs) {
		return { state: "open", admissibleAtMs: nowMs, allowedFraction: allowed, neededFraction: need };
	}
	return {
		state: "paced",
		admissibleAtMs: pacedUntil,
		reason: "over-allowance",
		allowedFraction: allowed,
		neededFraction: need,
	};
}

/** Time at which the allowance line reaches `need`: `resetsAt - D + D * x`, solving the line for `x`. */
function pacedUntilMs(input: {
	resetsAt: number;
	duration: number;
	lead: number;
	headroom: number;
	need: number;
}): number {
	const { resetsAt, duration, lead, headroom, need } = input;
	if (headroom <= 0 || lead >= 1) return resetsAt;
	const x = clamp01((need / headroom - lead) / (1 - lead));
	return resetsAt - duration + duration * x;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(value, 0), 1);
}

/** The binding window of a request: the latest admissible time across all applicable windows. */
export interface AdmissionVerdict {
	admissibleAtMs: number;
	/** Index into the input array of the binding window, when any window gates. */
	bindingIndex?: number;
}

/** Latest admissible time across windows; the request waits for the binding window. */
export function admissionVerdict(decisions: readonly WindowDecision[], nowMs: number): AdmissionVerdict {
	let admissibleAtMs = nowMs;
	let bindingIndex: number | undefined;
	for (let index = 0; index < decisions.length; index += 1) {
		const decision = decisions[index];
		if (decision.admissibleAtMs > admissibleAtMs) {
			admissibleAtMs = decision.admissibleAtMs;
			bindingIndex = index;
		}
	}
	return { admissibleAtMs, bindingIndex };
}

/** Observed used fractions for one quota and generation, as the ledger stores them. */
export interface CalibrationObservation {
	firstUsed: number;
	lastUsed: number;
	/** Reservations created between the first and last observation. */
	samples: number;
}

/**
 * Cost per request for one quota and generation (spec 3.4): `(u_last - u_first) / n`, measured
 * once `n >= 3` and `u_last > u_first`. Otherwise `priorCost` (the last value for the same quota
 * from an earlier generation), otherwise undefined: the window is uncalibrated.
 */
export function calibrateCostPerRequest(
	observation: CalibrationObservation | undefined,
	priorCost: number | undefined,
): number | undefined {
	if (observation && observation.samples >= GOVERNOR_CALIBRATION_MIN_SAMPLES) {
		const delta = observation.lastUsed - observation.firstUsed;
		if (delta > 0) return delta / observation.samples;
	}
	return priorCost;
}

/** Resolve the reserve fraction `r` for a request. `spend` drops it only for interactive foreground requests. */
export function reserveFraction(input: {
	reservePct: number;
	interactiveReserve: "hold" | "spend";
	interactive: boolean;
}): number {
	if (input.interactiveReserve === "spend" && input.interactive) return 0;
	return clamp01(input.reservePct / 100);
}
