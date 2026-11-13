/**
 * Pool-wide planner for Z.AI coding-plan resets.
 *
 * Z.AI grants reset offers in two stages, so the planner emits two action kinds:
 *
 * - `opportunity`: ask the server to grant a reset offer. The zcode desktop
 *   client polls every {@link ZAI_OPPORTUNITY_POLL_MS}; a refusal carries a
 *   server `next_try_at` that the planner honours before asking again. A
 *   `blocked` trigger skips the poll cadence (a stuck turn is worth an early
 *   ask) but never the server wait, a non-terminal deferral, or the account
 *   cooldown.
 * - `use`: spend a granted offer before it expires. Offers live ~2h, so any
 *   offer within {@link IMMINENT_RESET_EXPIRY_MS} of expiry is a `last-chance`
 *   spend that ignores usage, staleness and non-terminal deferrals (never the
 *   cooldown). Otherwise a fresh usage report must show the token window the
 *   offer clears at least {@link SALVAGE_MIN_USED_FRACTION} used (`salvage`),
 *   or exhausted while a turn is blocked (`blocked`).
 *
 * Pure: a function of its snapshot inputs only — no IO, no clock. The shared
 * {@link CodexAutoRedeemCoordinator} supplies the episode maps.
 */
import {
	type ResetCreditAccountStatus,
	type ResetCreditTarget,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
	type UsageResetCredit,
} from "@oh-my-pi/pi-ai";
import { zaiResetTypeFromCreditId } from "@oh-my-pi/pi-ai/usage/zai-reset";
import { reportMatchesStatus } from "./claude-auto-reset";
import {
	ATTEMPT_COOLDOWN_MS,
	DEBOUNCE_BUCKET_MS,
	IMMINENT_RESET_EXPIRY_MS,
	REPORT_FRESHNESS_MS,
	resetAccountLockKey,
	SALVAGE_MIN_USED_FRACTION,
	WINDOW_EXHAUSTED_MIN_FRACTION,
} from "./codex-auto-reset";

const ZAI_PROVIDER = "zai";
const ZAI_TOKEN_LIMIT_PREFIX = "zai:tokens:";

/** zcode desktop cadence between unprompted opportunity claims. */
export const ZAI_OPPORTUNITY_POLL_MS = 10 * 60_000;

/** What woke the planner. `blocked` also bypasses the opportunity poll cadence and may spend for an exhausted window. */
export type ZaiResetTrigger = "blocked" | "sweep";

export interface ZaiResetPlanInput {
	nowMs: number;
	trigger: ZaiResetTrigger;
	settings: { enabled: boolean };
	/** Usage reports; only `zai` entries are considered. */
	reports: readonly UsageReport[];
	/** Live reset listing; only `zai` entries are considered. */
	statuses: readonly ResetCreditAccountStatus[];
	attemptedKeys: ReadonlySet<string>;
	/** Episodes parked by a non-terminal outcome, keyed by attempt key (epoch ms). */
	deferredUntilByKey: ReadonlyMap<string, number>;
	lastAttemptAtByAccount: ReadonlyMap<string, number>;
	/** Server `next_try_at` from opportunity refusals (epoch ms). */
	nextTryAtByAccount: ReadonlyMap<string, number>;
	/** Last completed opportunity claim per account (epoch ms). */
	lastOpportunityAtByAccount: ReadonlyMap<string, number>;
}

export type ZaiResetAction =
	| { kind: "opportunity"; target: ResetCreditTarget; accountKey: string; attemptKey: string }
	| {
			kind: "use";
			target: ResetCreditTarget;
			accountKey: string;
			attemptKey: string;
			reason: "salvage" | "last-chance" | "blocked";
			/** Window whose auto-redeem consent governs this spend. */
			window: "5h" | "weekly";
			expiresInMs: number;
	  };

export type ZaiResetSkipReason =
	| "disabled"
	| "no-status"
	| "missing-tokens"
	| "reauth-required"
	| "listing-failed"
	| "deferred"
	| "cooldown"
	| "already-attempted"
	| "server-wait"
	| "poll-cadence"
	| "stale-report"
	| "window-mostly-free"
	| "no-credits";

export interface ZaiResetSkip {
	/** Normalized account key, or `"*"` for a plan-wide gate. */
	accountKey: string;
	reason: ZaiResetSkipReason;
}

export interface ZaiResetPlan {
	/** Opportunity claims first, then uses by soonest expiry. */
	actions: ZaiResetAction[];
	/** Diagnostics for `logger.debug` and tests. */
	skipped: ZaiResetSkip[];
}

/** One opportunity claim per (account, minute). */
export function zaiOpportunityAttemptKey(accountKey: string, nowMs: number): string {
	return `zai-opp|${accountKey}|${Math.floor(nowMs / DEBOUNCE_BUCKET_MS)}`;
}

/** One spend attempt per (account, offer). The offer id already encodes its type and expiry. */
export function zaiUseAttemptKey(accountKey: string, creditId: string): string {
	return `zai-use|${accountKey}|${creditId}`;
}

/** The `zai:tokens:*` window with the highest known used fraction. */
export function fullestZaiTokenWindow(report: UsageReport): { limit: UsageLimit; usedFraction: number } | undefined {
	return fullestTokenWindow(report.limits.filter(limit => limit.id.startsWith(ZAI_TOKEN_LIMIT_PREFIX)));
}

function fullestTokenWindow(limits: readonly UsageLimit[]): { limit: UsageLimit; usedFraction: number } | undefined {
	let fullest: { limit: UsageLimit; usedFraction: number } | undefined;
	for (const limit of limits) {
		const usedFraction = resolveUsedFraction(limit);
		if (usedFraction === undefined || !Number.isFinite(usedFraction)) continue;
		if (!fullest || usedFraction > fullest.usedFraction) fullest = { limit, usedFraction };
	}
	return fullest;
}

/**
 * The token window an offer restores: the fullest of the windows it clears,
 * or the fullest token window when the offer names none present in the report.
 */
function measuredWindow(
	report: UsageReport,
	credit: UsageResetCredit,
): { limit: UsageLimit; usedFraction: number } | undefined {
	const clears = credit.clears;
	if (clears && clears.length > 0) {
		const covered = report.limits.filter(
			limit => limit.id.startsWith(ZAI_TOKEN_LIMIT_PREFIX) && clears.includes(limit.id),
		);
		if (covered.length > 0) return fullestTokenWindow(covered);
	}
	return fullestZaiTokenWindow(report);
}

/** The usage report for a live status: its own evidence, else the matching report, else the unique pairing. */
function reportForStatus(
	status: ResetCreditAccountStatus,
	zaiStatusCount: number,
	zaiReports: readonly UsageReport[],
): UsageReport | undefined {
	if (status.report && status.report.provider === ZAI_PROVIDER) return status.report;
	const matched = zaiReports.find(report => reportMatchesStatus(report, status));
	if (matched) return matched;
	return zaiStatusCount === 1 && zaiReports.length === 1 ? zaiReports[0] : undefined;
}

/**
 * Plan which Z.AI reset opportunities to claim and which granted offers to
 * spend right now. Callers execute the actions in order, recording each
 * attempt key before the request.
 */
export function planZaiResetClaims(input: ZaiResetPlanInput): ZaiResetPlan {
	const { nowMs, trigger } = input;
	if (!input.settings.enabled) return { actions: [], skipped: [{ accountKey: "*", reason: "disabled" }] };

	const statuses = input.statuses.filter(status => status.provider === ZAI_PROVIDER);
	if (statuses.length === 0) return { actions: [], skipped: [{ accountKey: "*", reason: "no-status" }] };
	const reports = input.reports.filter(report => report.provider === ZAI_PROVIDER);

	const skipped: ZaiResetSkip[] = [];
	const opportunities: ZaiResetAction[] = [];
	const uses: Extract<ZaiResetAction, { kind: "use" }>[] = [];

	for (const status of statuses) {
		const accountKey =
			resetAccountLockKey({
				provider: ZAI_PROVIDER,
				accountId: status.accountId,
				email: status.email,
				orgId: status.orgId,
			}) ?? `${ZAI_PROVIDER}|${status.credentialId}`;
		const skip = (reason: ZaiResetSkipReason) => skipped.push({ accountKey, reason });
		if (status.error) {
			skip(
				status.error === "missing_tokens"
					? "missing-tokens"
					: status.error === "reauth_required"
						? "reauth-required"
						: "listing-failed",
			);
			continue;
		}
		const target: ResetCreditTarget = {
			provider: ZAI_PROVIDER,
			credentialId: status.credentialId,
			...(status.accountId ? { accountId: status.accountId } : {}),
			...(status.email ? { email: status.email } : {}),
			...(status.orgId ? { orgId: status.orgId } : {}),
		};
		const lastAttemptAt = input.lastAttemptAtByAccount.get(accountKey);
		const coolingDown = lastAttemptAt !== undefined && nowMs - lastAttemptAt < ATTEMPT_COOLDOWN_MS;

		// --- opportunity: at most one claim per account.
		const opportunityKey = zaiOpportunityAttemptKey(accountKey, nowMs);
		const nextTryAt = input.nextTryAtByAccount.get(accountKey);
		const lastOpportunityAt = input.lastOpportunityAtByAccount.get(accountKey);
		if (nextTryAt !== undefined && nowMs < nextTryAt) {
			skip("server-wait");
		} else if (
			trigger !== "blocked" &&
			lastOpportunityAt !== undefined &&
			nowMs - lastOpportunityAt < ZAI_OPPORTUNITY_POLL_MS
		) {
			skip("poll-cadence");
		} else if (input.attemptedKeys.has(opportunityKey)) {
			skip("already-attempted");
		} else if (opportunityDeferred(input.deferredUntilByKey, accountKey, nowMs)) {
			skip("deferred");
		} else if (coolingDown) {
			skip("cooldown");
		} else {
			opportunities.push({ kind: "opportunity", target, accountKey, attemptKey: opportunityKey });
		}

		// --- use: spend granted offers, soonest expiry first, one per cleared-window group.
		const live: { credit: UsageResetCredit; expiresInMs: number }[] = [];
		for (const credit of status.credits) {
			if ((credit.status ?? "available") !== "available" || credit.usable === false || !credit.expiresAt) continue;
			const expiresAtMs = Date.parse(credit.expiresAt);
			if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) continue;
			live.push({ credit, expiresInMs: expiresAtMs - nowMs });
		}
		if (live.length === 0) {
			skip("no-credits");
			continue;
		}
		live.sort((a, b) => a.expiresInMs - b.expiresInMs);
		const report = reportForStatus(status, statuses.length, reports);
		const fresh = report !== undefined && nowMs - report.fetchedAt <= REPORT_FRESHNESS_MS;
		const plannedGroups = new Set<string>();
		for (const { credit, expiresInMs } of live) {
			// Offers clearing the same windows are interchangeable: one spend per group.
			const group = credit.clears && credit.clears.length > 0 ? [...credit.clears].sort().join(",") : credit.id;
			if (plannedGroups.has(group)) continue;
			const lastChance = expiresInMs <= IMMINENT_RESET_EXPIRY_MS;
			let reason: "salvage" | "last-chance" | "blocked";
			if (lastChance) {
				reason = "last-chance";
			} else {
				if (!report || !fresh) {
					skip("stale-report");
					continue;
				}
				const usedFraction = measuredWindow(report, credit)?.usedFraction;
				if (usedFraction !== undefined && trigger === "blocked" && usedFraction >= WINDOW_EXHAUSTED_MIN_FRACTION) {
					reason = "blocked";
				} else if (usedFraction !== undefined && usedFraction >= SALVAGE_MIN_USED_FRACTION) {
					reason = "salvage";
				} else {
					skip("window-mostly-free");
					continue;
				}
			}
			const attemptKey = zaiUseAttemptKey(accountKey, credit.id);
			if (input.attemptedKeys.has(attemptKey)) {
				skip("already-attempted");
				continue;
			}
			const deferredUntil = input.deferredUntilByKey.get(attemptKey);
			if (!lastChance && deferredUntil !== undefined && nowMs < deferredUntil) {
				skip("deferred");
				continue;
			}
			if (coolingDown) {
				skip("cooldown");
				continue;
			}
			plannedGroups.add(group);
			uses.push({
				kind: "use",
				target: { ...target, creditId: credit.id },
				accountKey,
				attemptKey,
				reason,
				window: zaiResetTypeFromCreditId(credit.id) === "WEEK" ? "weekly" : "5h",
				expiresInMs,
			});
		}
	}

	uses.sort((a, b) => a.expiresInMs - b.expiresInMs);
	return { actions: [...opportunities, ...uses], skipped };
}

/** Opportunity keys rotate per minute, so a deferral parks every opportunity episode of the account. */
function opportunityDeferred(
	deferredUntilByKey: ReadonlyMap<string, number>,
	accountKey: string,
	nowMs: number,
): boolean {
	const prefix = `zai-opp|${accountKey}|`;
	for (const [key, until] of deferredUntilByKey) {
		if (nowMs < until && key.startsWith(prefix)) return true;
	}
	return false;
}
