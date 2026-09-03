/**
 * Pool-wide planner for spending saved OpenAI Codex rate-limit resets, plus
 * the process-wide coordinator that serializes attempts.
 *
 * A saved reset is a scarce, ~monthly credit — but it is also perishable:
 * every credit carries an `expiresAt`, and an expired credit is worth exactly
 * nothing. The planner therefore balances two failure modes instead of only
 * one: wasting a credit on a window that would have healed anyway, and letting
 * a credit die unspent. Two rules, evaluated over EVERY stored Codex account
 * (not just the session's active one):
 *
 * - `expiring-credit` (salvage; any trigger): the account's soonest available
 *   credit expires within `salvageHorizonMs` and the weekly window is at least
 *   {@link SALVAGE_MIN_USED_FRACTION} used, so redeeming restores real quota.
 *   The `keepCredits` reserve is deliberately ignored here — reserving a
 *   credit that is about to expire preserves nothing. If the window resets
 *   naturally before the credit expires, the next sweep sees a mostly-free
 *   window and skips: the credit had nothing left to restore. The backend may
 *   refuse a partial-usage consume with `nothing_to_reset`; that outcome is
 *   NON-terminal — the episode is deferred (not buried), so the credit is
 *   retried as usage grows or a window exhausts before expiry.
 * - `blocked-account` (restore; `blocked` trigger only): a live 429 blocked
 *   the turn and no sibling credential could take over, so the pool is dry.
 *   Candidates are accounts with at least one genuinely exhausted chat window
 *   — 5h primary or weekly secondary. A banked reset clears the account's
 *   chat rate limits generally, not just the weekly window: OpenAI's own
 *   client consumes one for a 5h-only block while the weekly window still has
 *   ~80% headroom (openai/codex#28525). The natural unblock is the LATEST
 *   reset among the exhausted windows (the account stays blocked until every
 *   one rolls over) and must be far enough away to justify the spend, with
 *   credits above the reserve. One candidate is redeemed — active account
 *   first, then the account whose credit dies soonest — and the redeem clears
 *   its credential blocks so the retry's re-rank picks it up.
 *
 * TRIGGERS: `blocked` runs from the usage-limit branch of the retry pipeline
 * after sibling switch fails, on force-refreshed reports (the cached snapshot
 * predates the 429 that got us there). `sweep` piggybacks on every successful
 * usage-report fetch — the status line polls every 5 minutes while the TUI is
 * open — so expiring credits are caught even when nothing is blocked.
 *
 * THE DECISION-2 TRAP (status MUST NOT be used to find the blocker):
 * `openai-codex.ts` applies the top-level `rate_limit.limit_reached` flag to
 * BOTH the primary (5h) and secondary (weekly) `buildUsageLimit` calls, so when
 * an account is blocked, *both* limit entries carry `status: "exhausted"`
 * regardless of which window is actually at 100%. Only `amount.usedFraction`
 * disambiguates. This module keys eligibility off exact limit ids
 * (`openai-codex:primary` / `openai-codex:secondary`) and `usedFraction`,
 * never off `status`, so the plan names the true blocking window(s) and their
 * real unblock time. Whether a short wait (e.g. a 5h-only block) is worth a
 * credit is the `minBlockedMinutes` knob's call, not hardcoded fiat.
 *
 * All of this is pure — no fetches, no IO. The only stateful piece is the
 * {@link CodexAutoRedeemCoordinator} container, whose read-only views are
 * passed in so the planner itself stays deterministic.
 */
import type {
	OAuthAccountIdentity,
	ResetCreditAccountStatus,
	ResetCreditTarget,
	UsageReport,
	UsageResetCreditDetail,
} from "@oh-my-pi/pi-ai";
import type { CodexAutoRedeemMode } from "../config/settings-schema";
import { reportMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";

/** A chat window counts as exhausted at `usedFraction >= 0.999` (used_percent >= 99.9). */
export const WINDOW_EXHAUSTED_MIN_FRACTION = 0.999;
/** A weekly reset can never be more than one window length (7d) away; +1h slack for skew. */
export const MAX_PLAUSIBLE_WEEKLY_REMAINING_MS = 7 * 24 * 3_600_000 + 60 * 60_000;
/** A 5h reset can never be more than one window length (5h) away; +1h slack for skew. */
export const MAX_PLAUSIBLE_PRIMARY_REMAINING_MS = 5 * 3_600_000 + 60 * 60_000;
/** Below this usage on BOTH chat windows a salvaged reset restores too little to bother (and risks a `nothing_to_reset` no-op). */
export const SALVAGE_MIN_USED_FRACTION = 0.25;
/** Retry spacing after a non-terminal consume outcome (`nothing_to_reset`, transport failure). */
export const REDEEM_RETRY_DEFER_MS = 30 * 60_000;

/** Report must be no older than the 5-min usage cache TTL plus slack. */
export const REPORT_FRESHNESS_MS = 10 * 60_000;
/** Per-account cooldown that catches attempt-key drift across a minute boundary. */
export const ATTEMPT_COOLDOWN_MS = 60_000;
/** Minute bucket for attempt keys, absorbing `reset_after_seconds`/expiry jitter. */
export const DEBOUNCE_BUCKET_MS = 60_000;
/** Floor between salvage sweeps; dedupe keys make sweeps idempotent, this just avoids useless re-planning. */
export const SWEEP_MIN_INTERVAL_MS = 60_000;

export function shouldEvaluateCodexAutoRedeem(mode: CodexAutoRedeemMode): boolean {
	return mode !== "no";
}

export function shouldPromptCodexAutoRedeem(mode: CodexAutoRedeemMode): boolean {
	return mode === "unset";
}

/** What woke the planner. `sweep` may only salvage; `blocked` may also restore. */
export type CodexResetTrigger = "blocked" | "sweep";

/** Why one account produced no action (or, with `accountKey: "*"`, a whole rule was off). */
export type CodexResetSkipReason =
	| "disabled"
	| "wrong-provider"
	| "spark-model"
	| "no-identity"
	| "stale-report"
	| "not-limit-reached"
	| "no-exhausted-window"
	| "deferred"
	| "no-reset-time"
	| "reset-too-soon"
	| "reset-implausible"
	| "credits-unknown"
	| "no-credits"
	| "reserve"
	| "no-expiring-credit"
	| "window-mostly-free"
	| "already-attempted"
	| "cooldown";

export interface CodexResetPlanInput {
	nowMs: number;
	trigger: CodexResetTrigger;
	/** `this.model.provider` — gates the `blocked-account` rule only. */
	provider: string;
	/** `this.model.id` — gates the `blocked-account` rule only. */
	modelId: string;
	settings: {
		enabled: boolean;
		/** `blocked-account`: skip when the natural unblock is closer than this. */
		minBlockedMinutes: number;
		/** `blocked-account`: never spend below this many remaining credits. */
		keepCredits: number;
		/** `expiring-credit`: salvage window; `<= 0` disables the rule. */
		salvageHorizonMs: number;
	};
	/** Active account (marks the preferred restore candidate); may be undefined. */
	identity: OAuthAccountIdentity | undefined;
	/** Usage reports for ALL stored accounts (one per account for Codex). */
	reports: UsageReport[] | null;
	attemptedKeys: ReadonlySet<string>;
	/** Episodes parked by a non-terminal consume outcome, keyed by attempt key (epoch ms). */
	deferredUntilByKey: ReadonlyMap<string, number>;
	lastAttemptAtByAccount: ReadonlyMap<string, number>;
	/**
	 * Live 429 evidence for the ACTIVE account: absolute epoch ms when the
	 * provider said the account unblocks, derived from the usage-limit error's
	 * parsed retry hint AT THE ERROR (absolute, so slow usage IO between the
	 * error and planning cannot drift it). Authoritative when the usage report
	 * is stale or missing — the report layer can adopt a pre-block in-flight
	 * fetch or serve the last-good snapshot when `/wham/usage` fails (it is
	 * IP-throttled, so failure right after a 429 is common), and such a
	 * snapshot still shows `limitReached: false` with healthy windows. With no
	 * usable report at all, a candidate is synthesized from `identity` and the
	 * redeem re-checks credits live. Only used on `blocked`.
	 */
	activeBlockUnblockAtMs?: number;
}

/** One credit to spend. `redeemResetCredit` picks the account's soonest-expiring credit. */
export interface CodexResetAction {
	reason: "blocked-account" | "expiring-credit";
	target: ResetCreditTarget;
	accountKey: string;
	/** Once-per-episode dedupe key; record in `attemptedKeys` BEFORE consuming. */
	attemptKey: string;
	/** Human label for notices/prompts (email preferred). */
	label: string;
	/** Redeemable credits per the report; undefined for a synthesized live-429 candidate. */
	availableCount?: number;
	weeklyUsedFraction?: number;
	/** `blocked-account`: ms until the natural unblock (latest exhausted-window reset). */
	remainingMs?: number;
	/** `blocked-account`: the exhausted chat windows a redeem would clear. */
	blockedWindows?: ("5h" | "weekly")[];
	/** `expiring-credit`: the fuller chat window a redeem restores (for messaging). */
	salvageWindow?: "5h" | "weekly";
	/** `expiring-credit`: used fraction of {@link CodexResetAction.salvageWindow}. */
	salvageUsedFraction?: number;
	/** `expiring-credit`: ms until the credit expires. */
	expiresInMs?: number;
	/** True when this is the session's active account. */
	active: boolean;
}

export interface CodexResetSkip {
	/** Normalized account key, or `"*"` for a rule-wide gate. */
	accountKey: string;
	rule: "blocked-account" | "expiring-credit" | "account";
	reason: CodexResetSkipReason;
}

export interface CodexResetPlan {
	/** At most one `blocked-account` action (first), then salvages by soonest expiry. */
	actions: CodexResetAction[];
	/** Diagnostics for `logger.debug` and tests. */
	skipped: CodexResetSkip[];
}

/** Soonest future expiry (epoch ms) among available credits, or undefined. */
function soonestCreditExpiryMs(
	credits: readonly UsageResetCreditDetail[] | undefined,
	nowMs: number,
): number | undefined {
	let soonest: number | undefined;
	for (const credit of credits ?? []) {
		if ((credit.status ?? "available") !== "available") continue;
		if (!credit.expiresAt) continue;
		const expiry = Date.parse(credit.expiresAt);
		if (Number.isNaN(expiry) || expiry <= nowMs) continue;
		if (soonest === undefined || expiry < soonest) soonest = expiry;
	}
	return soonest;
}

interface AccountSnapshot {
	accountKey: string;
	target: ResetCreditTarget;
	label: string;
	active: boolean;
	/** Undefined when synthesized from live 429 evidence without a report. */
	availableCount: number | undefined;
	primaryUsed: number | undefined;
	primaryResetsAt: number | undefined;
	weeklyUsed: number | undefined;
	weeklyResetsAt: number | undefined;
	limitReached: boolean;
	creditExpiresAtMs: number | undefined;
}

/**
 * Plan which saved Codex resets to spend right now. Pure: a function of the
 * snapshot inputs only. Callers execute the returned actions in order,
 * re-checking `attemptedKeys` immediately before each consume.
 */
export function planCodexResetRedemptions(input: CodexResetPlanInput): CodexResetPlan {
	const { nowMs, settings } = input;
	const skipped: CodexResetSkip[] = [];
	if (!settings.enabled) return { actions: [], skipped: [{ accountKey: "*", rule: "account", reason: "disabled" }] };

	// Rule-wide gates for `blocked-account`: a redeem can only unblock the turn
	// when the turn is actually on Codex, and it is unknown whether a credit
	// resets the separate Spark meter.
	let blockedRuleActive = input.trigger === "blocked";
	if (blockedRuleActive && input.provider !== "openai-codex") {
		blockedRuleActive = false;
		skipped.push({ accountKey: "*", rule: "blocked-account", reason: "wrong-provider" });
	}
	if (blockedRuleActive && input.modelId.includes("-spark")) {
		blockedRuleActive = false;
		skipped.push({ accountKey: "*", rule: "blocked-account", reason: "spark-model" });
	}
	const salvageRuleActive = settings.salvageHorizonMs > 0;

	const snapshots: AccountSnapshot[] = [];
	// Whether the ACTIVE account produced a usable snapshot, and whether a
	// FRESH report proved it has no credits — both gate the last-resort
	// synthesized candidate below (live 429 with no usable report).
	let activeHasSnapshot = false;
	let activeKnownNoCredits = false;
	for (const report of input.reports ?? []) {
		if (report.provider !== "openai-codex") continue;
		const accountIdValue = report.metadata?.accountId;
		const emailValue = report.metadata?.email;
		const accountId = typeof accountIdValue === "string" && accountIdValue.trim() ? accountIdValue : undefined;
		const email = typeof emailValue === "string" && emailValue.trim() ? emailValue : undefined;
		// Trimmed lowercase, mirroring `normalizeIdentityValue` in active-oauth-account.ts.
		const accountKey = (accountId ?? email)?.trim().toLowerCase();
		if (!accountKey) {
			skipped.push({ accountKey: "*", rule: "account", reason: "no-identity" });
			continue;
		}
		const isActive = reportMatchesActiveAccount(report, input.identity);
		if (nowMs - report.fetchedAt > REPORT_FRESHNESS_MS) {
			skipped.push({ accountKey, rule: "account", reason: "stale-report" });
			continue;
		}
		const available = report.resetCredits?.availableCount;
		// Can't verify availability from the snapshot → don't spend (precision over recall).
		if (available === undefined) {
			skipped.push({ accountKey, rule: "account", reason: "credits-unknown" });
			continue;
		}
		if (available < 1) {
			if (isActive) activeKnownNoCredits = true;
			skipped.push({ accountKey, rule: "account", reason: "no-credits" });
			continue;
		}
		const primary = report.limits.find(l => l.id === "openai-codex:primary");
		const weekly = report.limits.find(l => l.id === "openai-codex:secondary");
		if (isActive) activeHasSnapshot = true;
		snapshots.push({
			accountKey,
			target: { accountId, email },
			label: email ?? accountId ?? accountKey,
			active: isActive,
			availableCount: available,
			primaryUsed: primary?.amount.usedFraction,
			primaryResetsAt: primary?.window?.resetsAt,
			weeklyUsed: weekly?.amount.usedFraction,
			weeklyResetsAt: weekly?.window?.resetsAt,
			limitReached: report.metadata?.limitReached === true,
			creditExpiresAtMs: soonestCreditExpiryMs(report.resetCredits?.credits, nowMs),
		});
	}

	const cooledDown = (accountKey: string): boolean => {
		const lastAt = input.lastAttemptAtByAccount.get(accountKey);
		return lastAt !== undefined && nowMs - lastAt < ATTEMPT_COOLDOWN_MS;
	};

	// --- blocked-account: pick ONE restore candidate; one open lane is enough,
	// the next block re-plans on live data.
	let restore: CodexResetAction | undefined;
	if (blockedRuleActive) {
		interface RestoreCandidate {
			snapshot: AccountSnapshot;
			remainingMs: number;
			unblockAtMs: number;
			blockedWindows: ("5h" | "weekly")[];
		}
		const candidates: RestoreCandidate[] = [];
		for (const snapshot of snapshots) {
			const rule = "blocked-account" as const;
			const skip = (reason: CodexResetSkipReason) => skipped.push({ accountKey: snapshot.accountKey, rule, reason });
			// Live evidence: the 429 that triggered this pass names the active
			// account directly, outranking a possibly pre-block report snapshot.
			const liveUnblockAtMs = snapshot.active ? input.activeBlockUnblockAtMs : undefined;
			// The wire's own blocked flag must confirm the 429 for THIS account,
			// unless the live block evidence already does.
			if (!snapshot.limitReached && liveUnblockAtMs === undefined) {
				skip("not-limit-reached");
				continue;
			}
			// Identify the exact exhausted window(s) via usedFraction — never
			// `status` (see the Decision-2 trap in the module docs). Either
			// window qualifies: a banked reset also clears a 5h-only block
			// (openai/codex#28525).
			const exhausted: { window: "5h" | "weekly"; resetsAt: number | undefined; plausibleMs: number }[] = [];
			if (snapshot.primaryUsed !== undefined && snapshot.primaryUsed >= WINDOW_EXHAUSTED_MIN_FRACTION) {
				exhausted.push({
					window: "5h",
					resetsAt: snapshot.primaryResetsAt,
					plausibleMs: MAX_PLAUSIBLE_PRIMARY_REMAINING_MS,
				});
			}
			if (snapshot.weeklyUsed !== undefined && snapshot.weeklyUsed >= WINDOW_EXHAUSTED_MIN_FRACTION) {
				exhausted.push({
					window: "weekly",
					resetsAt: snapshot.weeklyResetsAt,
					plausibleMs: MAX_PLAUSIBLE_WEEKLY_REMAINING_MS,
				});
			}
			let unblockAtMs: number;
			let blockedWindows: ("5h" | "weekly")[];
			if (exhausted.length > 0) {
				// Blocked until EVERY exhausted window rolls over — the unblock is
				// the latest reset among them. A missing or implausible reset on any
				// of them means the unblock time is unknown; stay conservative.
				let latest = Number.NEGATIVE_INFINITY;
				let invalid: CodexResetSkipReason | undefined;
				for (const entry of exhausted) {
					if (entry.resetsAt === undefined) {
						invalid = "no-reset-time";
						break;
					}
					if (entry.resetsAt - nowMs > entry.plausibleMs) {
						invalid = "reset-implausible";
						break;
					}
					if (entry.resetsAt > latest) latest = entry.resetsAt;
				}
				if (invalid) {
					skip(invalid);
					continue;
				}
				unblockAtMs = latest;
				blockedWindows = exhausted.map(e => e.window);
			} else if (liveUnblockAtMs !== undefined) {
				// The report's windows look healthy but the live 429 says otherwise:
				// the snapshot predates the block. Trust the provider's own hint for
				// the unblock horizon, classifying the window by its scale.
				if (liveUnblockAtMs - nowMs > MAX_PLAUSIBLE_WEEKLY_REMAINING_MS) {
					skip("reset-implausible");
					continue;
				}
				unblockAtMs = liveUnblockAtMs;
				blockedWindows = [liveUnblockAtMs - nowMs > MAX_PLAUSIBLE_PRIMARY_REMAINING_MS ? "weekly" : "5h"];
			} else {
				skip("no-exhausted-window");
				continue;
			}
			const remainingMs = unblockAtMs - nowMs;
			// Anti-waste: too close to the natural unblock — let it roll over.
			if (remainingMs < settings.minBlockedMinutes * 60_000) {
				skip("reset-too-soon");
				continue;
			}
			if ((snapshot.availableCount ?? 0) - Math.max(0, Math.trunc(settings.keepCredits)) < 1) {
				skip("reserve");
				continue;
			}
			if (input.attemptedKeys.has(blockedAttemptKey(snapshot.accountKey, unblockAtMs))) {
				skip("already-attempted");
				continue;
			}
			const deferredUntil = input.deferredUntilByKey.get(blockedAttemptKey(snapshot.accountKey, unblockAtMs));
			if (deferredUntil !== undefined && nowMs < deferredUntil) {
				skip("deferred");
				continue;
			}
			if (cooledDown(snapshot.accountKey)) {
				skip("cooldown");
				continue;
			}
			candidates.push({ snapshot, remainingMs, unblockAtMs, blockedWindows });
		}
		candidates.sort((a, b) => {
			// Active account first: the sticky session credential stays usable.
			if (a.snapshot.active !== b.snapshot.active) return a.snapshot.active ? -1 : 1;
			// Then spend the credit that dies soonest.
			const aExpiry = a.snapshot.creditExpiresAtMs ?? Number.POSITIVE_INFINITY;
			const bExpiry = b.snapshot.creditExpiresAtMs ?? Number.POSITIVE_INFINITY;
			if (aExpiry !== bExpiry) return aExpiry - bExpiry;
			// Then the deepest bank, then the longest natural wait (most value).
			const aCount = a.snapshot.availableCount ?? 0;
			const bCount = b.snapshot.availableCount ?? 0;
			if (aCount !== bCount) {
				return bCount - aCount;
			}
			return b.remainingMs - a.remainingMs;
		});
		let best = candidates[0];
		// Last resort: the live 429 names the active account but no usable report
		// survived — stale-dropped, fetch failed entirely, or the credits block
		// was absent. Synthesize the candidate from the captured identity; the
		// redeem re-lists credits live, so a blind guess costs nothing
		// (`no_credit` is terminal, `credit_list_failed` defers). A FRESH report
		// proving zero credits suppresses this.
		if (!best && input.activeBlockUnblockAtMs !== undefined && !activeHasSnapshot && !activeKnownNoCredits) {
			const idValue = input.identity?.accountId;
			const emailValue = input.identity?.email;
			const accountId = typeof idValue === "string" && idValue.trim() ? idValue : undefined;
			const email = typeof emailValue === "string" && emailValue.trim() ? emailValue : undefined;
			const accountKey = (accountId ?? email)?.trim().toLowerCase();
			const unblockAtMs = input.activeBlockUnblockAtMs;
			const remainingMs = unblockAtMs - nowMs;
			const skip = (reason: CodexResetSkipReason) =>
				skipped.push({ accountKey: accountKey ?? "*", rule: "blocked-account", reason });
			if (!accountKey) {
				skip("no-identity");
			} else if (Math.max(0, Math.trunc(settings.keepCredits)) > 0) {
				// A reserve cannot be enforced against an unknown balance.
				skip("credits-unknown");
			} else if (remainingMs > MAX_PLAUSIBLE_WEEKLY_REMAINING_MS) {
				skip("reset-implausible");
			} else if (remainingMs < settings.minBlockedMinutes * 60_000) {
				skip("reset-too-soon");
			} else if (input.attemptedKeys.has(blockedAttemptKey(accountKey, unblockAtMs))) {
				skip("already-attempted");
			} else if ((input.deferredUntilByKey.get(blockedAttemptKey(accountKey, unblockAtMs)) ?? 0) > nowMs) {
				skip("deferred");
			} else if (cooledDown(accountKey)) {
				skip("cooldown");
			} else {
				best = {
					snapshot: {
						accountKey,
						target: { accountId, email },
						label: email ?? accountId ?? accountKey,
						active: true,
						availableCount: undefined,
						primaryUsed: undefined,
						primaryResetsAt: undefined,
						weeklyUsed: undefined,
						weeklyResetsAt: undefined,
						limitReached: true,
						creditExpiresAtMs: undefined,
					},
					remainingMs,
					unblockAtMs,
					blockedWindows: [remainingMs > MAX_PLAUSIBLE_PRIMARY_REMAINING_MS ? "weekly" : "5h"],
				};
			}
		}
		if (best) {
			restore = {
				reason: "blocked-account",
				target: best.snapshot.target,
				accountKey: best.snapshot.accountKey,
				attemptKey: blockedAttemptKey(best.snapshot.accountKey, best.unblockAtMs),
				label: best.snapshot.label,
				availableCount: best.snapshot.availableCount,
				weeklyUsedFraction: best.snapshot.weeklyUsed,
				remainingMs: best.remainingMs,
				expiresInMs:
					best.snapshot.creditExpiresAtMs === undefined ? undefined : best.snapshot.creditExpiresAtMs - nowMs,
				blockedWindows: best.blockedWindows,
				active: best.snapshot.active,
			};
		}
	}

	// --- expiring-credit: salvage every credit that would otherwise die.
	const salvages: CodexResetAction[] = [];
	if (salvageRuleActive) {
		for (const snapshot of snapshots) {
			if (snapshot.accountKey === restore?.accountKey) continue; // restore already spends its soonest credit
			const rule = "expiring-credit" as const;
			const skip = (reason: CodexResetSkipReason) => skipped.push({ accountKey: snapshot.accountKey, rule, reason });
			const expiresAtMs = snapshot.creditExpiresAtMs;
			if (expiresAtMs === undefined || expiresAtMs - nowMs > settings.salvageHorizonMs) {
				skip("no-expiring-credit");
				continue;
			}
			// Value = the fuller of the two chat windows a redeem restores. A
			// 5h-only exhausted account with a light week still gains real quota
			// (openai/codex#28525); a reset on two mostly-free windows restores
			// ~nothing. If usage grows before the credit expires, a later sweep
			// reconsiders.
			const primaryUsed = snapshot.primaryUsed ?? 0;
			const weeklyUsed = snapshot.weeklyUsed ?? 0;
			const salvageUsedFraction = Math.max(primaryUsed, weeklyUsed);
			if (salvageUsedFraction < SALVAGE_MIN_USED_FRACTION) {
				skip("window-mostly-free");
				continue;
			}
			const salvageWindow: "5h" | "weekly" = primaryUsed >= weeklyUsed ? "5h" : "weekly";
			const attemptKey = salvageAttemptKey(snapshot.accountKey, expiresAtMs);
			if (input.attemptedKeys.has(attemptKey)) {
				skip("already-attempted");
				continue;
			}
			const deferredUntil = input.deferredUntilByKey.get(attemptKey);
			if (deferredUntil !== undefined && nowMs < deferredUntil) {
				skip("deferred");
				continue;
			}
			if (cooledDown(snapshot.accountKey)) {
				skip("cooldown");
				continue;
			}
			salvages.push({
				reason: "expiring-credit",
				target: snapshot.target,
				accountKey: snapshot.accountKey,
				attemptKey,
				label: snapshot.label,
				availableCount: snapshot.availableCount,
				weeklyUsedFraction: snapshot.weeklyUsed,
				salvageWindow,
				salvageUsedFraction,
				expiresInMs: expiresAtMs - nowMs,
				active: snapshot.active,
			});
		}
		salvages.sort((a, b) => (a.expiresInMs ?? 0) - (b.expiresInMs ?? 0));
	}

	const actions = restore ? [restore, ...salvages] : salvages;
	return { actions, skipped };
}

/** One attempt per (account, weekly-reset-minute) block episode. */
export function blockedAttemptKey(accountKey: string, weeklyResetsAtMs: number): string {
	return `block|${accountKey}|${Math.round(weeklyResetsAtMs / DEBOUNCE_BUCKET_MS)}`;
}

/** One attempt per (account, credit-expiry-minute) salvage episode. */
export function salvageAttemptKey(accountKey: string, creditExpiresAtMs: number): string {
	return `salvage|${accountKey}|${Math.round(creditExpiresAtMs / DEBOUNCE_BUCKET_MS)}`;
}

/**
 * Overlay LIVE per-account credit state (from the dedicated
 * `rate-limit-reset-credits` route) onto usage reports before a blocked pass.
 *
 * `/wham/usage` credit counts can be stale or pre-feature, and the usage
 * provider only consults the live detail endpoint when the usage payload
 * already reports a POSITIVE count — a stale ZERO is never corrected there.
 * Live data therefore replaces the report's credit block wholesale; accounts
 * with no live row (or a failed lookup) get the block stripped, so the planner
 * treats them as `credits-unknown` instead of trusting a stale count: siblings
 * stay conservative while the active account can still be synthesized from
 * live 429 evidence (the redeem re-lists atomically either way).
 */
export function overlayLiveResetCredits(
	reports: UsageReport[] | null,
	statuses: readonly ResetCreditAccountStatus[],
): UsageReport[] | null {
	if (!reports) return reports;
	return reports.map(report => {
		if (report.provider !== "openai-codex") return report;
		const status = statuses.find(
			s =>
				(!!s.accountId && s.accountId === report.metadata?.accountId) ||
				(!!s.email && s.email === report.metadata?.email),
		);
		if (!status || status.error) return { ...report, resetCredits: undefined };
		return {
			...report,
			resetCredits: {
				availableCount: status.availableCount,
				credits: status.credits
					.filter(credit => (credit.status ?? "available") === "available")
					.map(credit => ({ grantedAt: credit.grantedAt, expiresAt: credit.expiresAt, status: credit.status })),
			},
		};
	});
}

/**
 * Whether a consume outcome permanently settles its episode. Terminal codes
 * either spent the credit (`reset`), or prove this credit can never be spent
 * (`already_redeemed`, `no_credit` — a live listing that really had nothing).
 * Everything else — `nothing_to_reset` (limits not constrained enough right
 * now), `credit_list_failed` (flaky listing), thrown transport failures,
 * unknown codes — leaves the credit banked: the executor releases the attempt
 * key and
 * defers the episode by {@link REDEEM_RETRY_DEFER_MS} instead of burying a
 * live credit for the rest of the process.
 */
export function isTerminalRedeemOutcome(code: string): boolean {
	return code === "reset" || code === "already_redeemed" || code === "no_credit";
}

/**
 * Process-wide (NOT per-session) coordinator state. Parallel subagent sessions
 * share the same Codex accounts and must not race a double-spend, so this is a
 * single shared container, not a per-session field.
 *
 * - `attemptedKeys`: one attempt per episode key — recorded before calling the
 *   consume so exceptions can't re-enter. Non-terminal outcomes (see
 *   {@link isTerminalRedeemOutcome}) release the key again and park the
 *   episode in `deferredUntilByKey` instead.
 * - `deferredUntilByKey`: earliest retry time for episodes whose consume was
 *   refused non-terminally (`nothing_to_reset`, transport failure).
 * - `lastAttemptAtByAccount`: per-account cooldown timestamps (epoch ms),
 *   catching attempt-key drift across a minute boundary.
 * - `inFlightByAccount`: serializes blocked passes per account — a second
 *   session for the same account adopts the in-flight promise instead of
 *   starting a second consume.
 * - `sweepInFlight` / `lastSweepAt` / `sweepPromise`: re-entrancy guard, floor,
 *   and settlement handle for the salvage sweep (a redeem refreshes usage,
 *   which would recurse into a sweep; the promise lets tests and diagnostics
 *   await a fire-and-forget sweep instead of polling).
 * - `notifiedKeys`: headless "run /usage reset" notices already emitted, so a
 *   5-minute sweep cadence can't spam the transcript.
 */
export interface CodexAutoRedeemCoordinator {
	attemptedKeys: Set<string>;
	deferredUntilByKey: Map<string, number>;
	lastAttemptAtByAccount: Map<string, number>;
	inFlightByAccount: Map<string, Promise<boolean>>;
	sweepInFlight: boolean;
	lastSweepAt: number;
	/** Settlement of the most recently scheduled sweep (never rejects). */
	sweepPromise: Promise<void> | undefined;
	notifiedKeys: Set<string>;
}

/** Fresh, empty coordinator: backs the process-wide default; inject one per test for isolation. */
export function createCodexAutoRedeemCoordinator(): CodexAutoRedeemCoordinator {
	return {
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		inFlightByAccount: new Map(),
		sweepInFlight: false,
		lastSweepAt: 0,
		sweepPromise: undefined,
		notifiedKeys: new Set(),
	};
}

export const defaultCodexAutoRedeemCoordinator: CodexAutoRedeemCoordinator = createCodexAutoRedeemCoordinator();
