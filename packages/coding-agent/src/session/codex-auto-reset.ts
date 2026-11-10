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
 *   credit expires within `salvageHorizonMs` and either chat window is at least
 *   {@link SALVAGE_MIN_USED_FRACTION} used, so redeeming restores real quota.
 *   As a last chance, credits expiring within {@link IMMINENT_RESET_EXPIRY_MS}
 *   are attempted even with a zero/shorter horizon or zero/unknown usage.
 *   This fallback ignores non-terminal deferrals, but keeps live credit
 *   eligibility, terminal-attempt dedupe, and the account cooldown. It still
 *   needs consent, except that a host with no prompt UI spends it while
 *   auto-redeem is unset (see {@link headlessApprovedResetActions}).
 *   The `keepCredits` reserve is deliberately ignored here — reserving a
 *   credit that is about to expire preserves nothing. If the window resets
 *   naturally before the credit expires, broader salvage skips the mostly-free
 *   window until the last-chance horizon. The backend may
 *   refuse a partial-usage consume with `nothing_to_reset`; that outcome is
 *   NON-terminal — the episode is deferred (not buried), so the credit is
 *   retried as usage grows or a window exhausts before expiry.
 * - `blocked-account` (restore; `blocked` trigger only): a live 429 blocked
 *   the turn and no sibling credential could take over, so the pool is dry.
 *   Candidates are accounts with at least one genuinely exhausted normalized
 *   chat window — 5h or weekly. A banked reset clears the account's
 *   chat rate limits generally, not just the weekly window: OpenAI's own
 *   client consumes one for a 5h-only block while the weekly window still has
 *   ~80% headroom (openai/codex#28525). The natural unblock is the LATEST
 *   reset among the exhausted windows (the account stays blocked until every
 *   one rolls over), extended to the live 429 deadline when the provider named
 *   a later one — a deadline past the reported 5h reset also proves the weekly
 *   window is blocking even though the pre-block report still showed headroom,
 *   so the weekly key governs that spend. It must be far enough away to
 *   justify the spend, with credits above the reserve, on an account the
 *   session may use (its account pool). One candidate is redeemed — an
 *   approved consent first, then the active account, then the account whose
 *   credit dies soonest — and the redeem clears its credential blocks so the
 *   retry's re-rank picks it up.
 * Each action follows its governing window's policy: restores clearing any
 * weekly exhaustion use weekly, otherwise 5h; salvages use the fullest window.
 * A live 429 hint alone cannot distinguish the windows within one 5h span, so
 * such a restore is planned only when both windows consent identically.
 * Imminent credits may spend when either restorable window permits evaluation.
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
 * disambiguates. This module selects the base chat entries by their stable
 * limit ids, then classifies the actual window from normalized window metadata
 * before applying duration-specific policy. Whether a short wait (e.g. a
 * 5h-only block) is worth a credit is the `minBlockedMinutes` knob's call,
 * not hardcoded fiat.
 *
 * All of this is pure — no fetches, no IO. The only stateful piece is the
 * {@link CodexAutoRedeemCoordinator} container, whose read-only views are
 * passed in so the planner itself stays deterministic.
 */
import type {
	OAuthAccountIdentity,
	ResetCreditAccountStatus,
	ResetCreditTarget,
	UsageLimit,
	UsageReport,
	UsageResetCreditDetail,
} from "@oh-my-pi/pi-ai";
import type { ResetAutoRedeemMode } from "./settings";
import {
	IMMINENT_RESET_EXPIRY_MS,
	type ResetPlanSettings,
	type ResetWindow,
	actionConsent,
	classifyResetGrant,
	resetPlannerSettings,
	shouldEvaluateResetAutoRedeem,
} from "./reset-consent";
import { reportMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";

/** A chat window counts as exhausted at `usedFraction >= 0.999` (used_percent >= 99.9). */
export const WINDOW_EXHAUSTED_MIN_FRACTION = 0.999;
/** A weekly reset can never be more than one window length (7d) away; +1h slack for skew. */
export const MAX_PLAUSIBLE_WEEKLY_REMAINING_MS = 7 * 24 * 3_600_000 + 60 * 60_000;
/** A 5h reset can never be more than one window length (5h) away; +1h slack for skew. */
export const MAX_PLAUSIBLE_PRIMARY_REMAINING_MS = 5 * 3_600_000 + 60 * 60_000;
/**
 * Slack between a live 429 deadline and a reported reset before the live one
 * counts as evidence of a LATER window: the usage snapshot and the 429 are
 * taken seconds apart and `reset_after_seconds` is rounded, so a hint that
 * merely echoes the reported 5h reset must not be read as a weekly block.
 */
const LIVE_HINT_TOLERANCE_MS = 5 * 60_000;
/** Below this usage on BOTH chat windows, non-imminent salvage restores too little to bother. */
export const SALVAGE_MIN_USED_FRACTION = 0.25;
/** Retry spacing after a non-terminal consume outcome, except during imminent-expiry salvage. */
export const REDEEM_RETRY_DEFER_MS = 30 * 60_000;

/** Report must be no older than the 5-min usage cache TTL plus slack. */
export const REPORT_FRESHNESS_MS = 10 * 60_000;
/** Per-account cooldown that catches attempt-key drift across a minute boundary. */
export const ATTEMPT_COOLDOWN_MS = 60_000;
/** Minute bucket for attempt keys, absorbing `reset_after_seconds`/expiry jitter. */
export const DEBOUNCE_BUCKET_MS = 60_000;
/** Floor between salvage sweeps; dedupe keys make sweeps idempotent, this just avoids useless re-planning. */
export const SWEEP_MIN_INTERVAL_MS = 60_000;
export type ResetWindowModes = Record<ResetWindow, ResetAutoRedeemMode>;

export function resetWindowModes(cfg: {
	autoRedeem5h: ResetAutoRedeemMode;
	autoRedeemWeekly: ResetAutoRedeemMode;
}): ResetWindowModes {
	return { "5h": cfg.autoRedeem5h, weekly: cfg.autoRedeemWeekly };
}

/** Planner settings from the `codexResets.*` group. */
export function resetPlanSettings(cfg: {
	autoRedeem5h: ResetAutoRedeemMode;
	autoRedeemWeekly: ResetAutoRedeemMode;
	minBlockedMinutes: number;
	keepCredits: number;
	salvageHorizonHours: number;
}): CodexResetPlanInput["settings"] {
	return resetPlannerSettings(resetWindowModes(cfg), cfg);
}

/** What woke the planner. `sweep` may only salvage; `blocked` may also restore. */
export type CodexResetTrigger = "blocked" | "sweep";

/** Why one account produced no action (or, with `accountKey: "*"`, a whole rule was off). */
export type CodexResetSkipReason =
	| "disabled"
	| "window-disabled"
	| "window-unknown"
	| "wrong-provider"
	| "spark-model"
	| "no-identity"
	| "stale-report"
	| "outside-account-pool"
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
	settings: ResetPlanSettings<ResetWindow>;
	/** Active account (marks the preferred restore candidate); may be undefined. */
	identity: OAuthAccountIdentity | undefined;
	/** `blocked-account`: whether a stored credential may serve the blocked session; absent allows every account. */
	permitsCredential?: (credentialId: number) => boolean;
	/** Usage reports for ALL stored accounts (one per account for Codex). */
	reports: UsageReport[] | null;
	attemptedKeys: ReadonlySet<string>;
	/** Episodes parked by a non-terminal consume outcome, keyed by attempt key (epoch ms). */
	deferredUntilByKey: ReadonlyMap<string, number>;
	lastAttemptAtByAccount: ReadonlyMap<string, number>;
	/**
	 * Live 429 evidence for the ACTIVE account: absolute epoch ms when the
	 * provider said the account unblocks, captured before eligibility IO so
	 * slow refreshes cannot drift it. A pre-block report, or a synthetic report
	 * built from a uniquely identified live credit status, may use this timing.
	 */
	activeBlockUnblockAtMs?: number;
}

/** One credit to spend. `target.creditId` pins the credit picked here, so a redeem cannot spend a later one. */
export interface CodexResetAction {
	reason: "blocked-account" | "expiring-credit";
	/** Window whose policy governs this spend. */
	window: ResetWindow;
	/** Windows restored by the spent credit, including those not currently exhausted. */
	restorableWindows: ResetWindow[];
	target: ResetCreditTarget;
	accountKey: string;
	/** Once-per-episode dedupe key; record in `attemptedKeys` BEFORE consuming. */
	attemptKey: string;
	/** Human label for notices/prompts (email preferred). */
	label: string;
	/** Redeemable credits in the authoritative live status. */
	availableCount?: number;
	weeklyUsedFraction?: number;
	/** `blocked-account`: ms until the natural unblock (latest exhausted-window reset). */
	remainingMs?: number;
	/**
	 * `blocked-account`: the exhausted chat windows a redeem would clear. Empty
	 * when only the live 429 hint is known and it fits either window.
	 */
	blockedWindows?: ResetWindow[];
	/** `expiring-credit`: the fuller chat window a redeem restores (for messaging). */
	salvageWindow?: ResetWindow;
	/** `expiring-credit`: used fraction of {@link CodexResetAction.salvageWindow}. */
	salvageUsedFraction?: number;
	/** Remaining lifetime, at planning time, of the soonest available credit (the one a redeem spends). */
	expiresInMs?: number;
	/** Id of the credit {@link CodexResetAction.expiresInMs} describes, when the listing reports one. */
	creditId?: string;
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

/** Soonest future-expiring available credit, or undefined. */
function soonestAvailableCredit(
	credits: readonly UsageResetCreditDetail[] | undefined,
	nowMs: number,
): { credit: UsageResetCreditDetail; expiresAtMs: number } | undefined {
	let soonest: { credit: UsageResetCreditDetail; expiresAtMs: number } | undefined;
	for (const credit of credits ?? []) {
		if ((credit.status ?? "available") !== "available") continue;
		if (!credit.expiresAt) continue;
		const expiry = Date.parse(credit.expiresAt);
		if (Number.isNaN(expiry) || expiry <= nowMs) continue;
		if (soonest === undefined || expiry < soonest.expiresAtMs) soonest = { credit, expiresAtMs: expiry };
	}
	return soonest;
}

export interface CodexChatWindowSnapshot {
	limit: UsageLimit;
	window: ResetWindow;
	usedFraction: number | undefined;
	resetsAt: number | undefined;
	plausibleMs: number;
}

interface AccountSnapshot {
	accountKey: string;
	target: ResetCreditTarget;
	label: string;
	active: boolean;
	availableCount: number;
	windows: CodexChatWindowSnapshot[];
	limitReached: boolean;
	creditExpiresAtMs: number | undefined;
	creditId: string | undefined;
	/** Windows the account's soonest credit restores, classified from the credit itself. */
	restorableWindows: ResetWindow[];
}

function classifyChatWindow(limit: UsageLimit, fallback: ResetWindow): ResetWindow {
	const durationMs = limit.window?.durationMs;
	if (durationMs !== undefined && Number.isFinite(durationMs)) {
		if (Math.abs(durationMs - 7 * 24 * 3_600_000) <= 60_000) return "weekly";
		if (Math.abs(durationMs - 5 * 3_600_000) <= 60_000) return "5h";
	}
	const windowId = limit.window?.id.toLowerCase();
	const scopeWindowId = limit.scope.windowId?.toLowerCase();
	if (windowId === "7d" || scopeWindowId === "7d") return "weekly";
	if (windowId === "5h" || scopeWindowId === "5h") return "5h";
	return fallback;
}

function snapshotChatWindow(limit: UsageLimit, fallback: ResetWindow): CodexChatWindowSnapshot {
	const window = classifyChatWindow(limit, fallback);
	return {
		limit,
		window,
		usedFraction: limit.amount.usedFraction,
		resetsAt: limit.window?.resetsAt,
		plausibleMs: window === "weekly" ? MAX_PLAUSIBLE_WEEKLY_REMAINING_MS : MAX_PLAUSIBLE_PRIMARY_REMAINING_MS,
	};
}

/** The 5h and weekly chat windows, selected by their stable limit ids. */
function codexChatWindows(report: UsageReport): CodexChatWindowSnapshot[] {
	const primary = report.limits.find(l => l.id === "openai-codex:primary");
	const weekly = report.limits.find(l => l.id === "openai-codex:secondary");
	const windows: CodexChatWindowSnapshot[] = [];
	if (primary) windows.push(snapshotChatWindow(primary, "5h"));
	if (weekly) windows.push(snapshotChatWindow(weekly, "weekly"));
	return windows;
}

/** The fullest chat window with known usage: the one a salvage redeem restores. */
function fullestChatWindow(windows: readonly CodexChatWindowSnapshot[]): CodexChatWindowSnapshot | undefined {
	let fullest: CodexChatWindowSnapshot | undefined;
	for (const window of windows) {
		if (
			window.usedFraction !== undefined &&
			window.usedFraction >= 0 &&
			(!fullest || window.usedFraction > (fullest.usedFraction ?? 0))
		) {
			fullest = window;
		}
	}
	return fullest;
}

/** The chat window the `expiring-credit` rule measures for one Codex usage report. */
export function fullestCodexChatWindow(report: UsageReport): CodexChatWindowSnapshot | undefined {
	return fullestChatWindow(codexChatWindows(report));
}

function usedFractionForWindow(snapshot: AccountSnapshot, window: ResetWindow): number | undefined {
	let fullest: number | undefined;
	for (const entry of snapshot.windows) {
		if (entry.window !== window || entry.usedFraction === undefined) continue;
		if (fullest === undefined || entry.usedFraction > fullest) fullest = entry.usedFraction;
	}
	return fullest;
}

/**
 * Plan which saved Codex resets to spend right now. Pure: a function of the
 * snapshot inputs only. Callers execute the returned actions in order,
 * re-checking `attemptedKeys` immediately before each consume.
 */
export function planCodexResetRedemptions(input: CodexResetPlanInput): CodexResetPlan {
	const { nowMs, settings } = input;
	const skipped: CodexResetSkip[] = [];
	if (!shouldEvaluateResetAutoRedeem(settings.modes)) {
		return { actions: [], skipped: [{ accountKey: "*", rule: "account", reason: "disabled" }] };
	}

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

	const snapshots: AccountSnapshot[] = [];
	for (const report of input.reports ?? []) {
		if (report.provider !== "openai-codex") continue;
		const accountIdValue = report.metadata?.accountId;
		const emailValue = report.metadata?.email;
		const orgIdValue = report.metadata?.orgId;
		const credentialIdValue = report.metadata?.resetCreditCredentialId;
		const accountId = typeof accountIdValue === "string" && accountIdValue.trim() ? accountIdValue : undefined;
		const email = typeof emailValue === "string" && emailValue.trim() ? emailValue : undefined;
		const orgId = typeof orgIdValue === "string" && orgIdValue.trim() ? orgIdValue : undefined;
		const credentialId =
			typeof credentialIdValue === "number" && Number.isInteger(credentialIdValue) ? credentialIdValue : undefined;
		if (credentialId === undefined) {
			skipped.push({ accountKey: "*", rule: "account", reason: "credits-unknown" });
			continue;
		}
		const accountKey = `openai-codex|${orgId?.trim().toLowerCase() ?? "-"}|${credentialId}`;
		const isActive =
			report.metadata?.resetCreditActive === true || reportMatchesActiveAccount(report, input.identity);
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
			skipped.push({ accountKey, rule: "account", reason: "no-credits" });
			continue;
		}
		const windows = codexChatWindows(report);
		const baseLabel = email ?? accountId ?? accountKey;
		const label = orgId && orgId !== baseLabel ? `${baseLabel} (${orgId})` : baseLabel;
		const soonestCredit = soonestAvailableCredit(report.resetCredits?.credits, nowMs);
		const restorableWindows: ResetWindow[] = soonestCredit
			? classifyResetGrant("openai-codex", soonestCredit.credit, report).restorableWindows.filter(
					(window): window is ResetWindow => window !== "fable",
				)
			: ["5h", "weekly"];
		snapshots.push({
			accountKey,
			target: {
				provider: "openai-codex",
				credentialId,
				accountId,
				email,
				...(orgId ? { orgId } : {}),
				...(soonestCredit?.credit.id ? { creditId: soonestCredit.credit.id } : {}),
			},
			label,
			active: isActive,
			availableCount: available,
			windows,
			limitReached: report.metadata?.limitReached === true,
			creditExpiresAtMs: soonestCredit?.expiresAtMs,
			creditId: soonestCredit?.credit.id,
			restorableWindows,
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
			blockedWindows: ResetWindow[];
			window: ResetWindow;
			approved: boolean;
		}
		const candidates: RestoreCandidate[] = [];
		for (const snapshot of snapshots) {
			const rule = "blocked-account" as const;
			const skip = (reason: CodexResetSkipReason) => skipped.push({ accountKey: snapshot.accountKey, rule, reason });
			// Restoring an account the session may not use cannot unblock it.
			if (input.permitsCredential && !input.permitsCredential(snapshot.target.credentialId)) {
				skip("outside-account-pool");
				continue;
			}
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
			const exhausted: CodexChatWindowSnapshot[] = [];
			for (const window of snapshot.windows) {
				if (window.usedFraction !== undefined && window.usedFraction >= WINDOW_EXHAUSTED_MIN_FRACTION) {
					exhausted.push(window);
				}
			}
			let unblockAtMs: number;
			let blockedWindows: ResetWindow[];
			// Set when the unblock time comes only from the live hint and fits
			// either chat window, so the blocked window is genuinely unknown.
			let windowUnknown = false;
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
				// The 429 can outlast every exhausted window: a report fetched
				// before the block still shows weekly headroom while the provider
				// has already blocked on it. Only the active account carries a live
				// hint, and one beyond the weekly window's maximum span is junk
				// rather than evidence — the report already names an unblock, so
				// fall back to it (the live-only branch below has no such fallback
				// and must skip instead).
				if (liveUnblockAtMs !== undefined && liveUnblockAtMs - nowMs <= MAX_PLAUSIBLE_WEEKLY_REMAINING_MS) {
					if (
						!blockedWindows.includes("weekly") &&
						(liveUnblockAtMs - nowMs > MAX_PLAUSIBLE_PRIMARY_REMAINING_MS ||
							liveUnblockAtMs - latest > LIVE_HINT_TOLERANCE_MS)
					) {
						// A wait a 5h window cannot span, or one running past the
						// reported 5h reset, means weekly is blocking too — the report
						// merely predates it. Naming it keeps the weekly key (which
						// may be `no`) in charge of a credit that clears it.
						blockedWindows.push("weekly");
					}
					// Blocked until the later of the two: the provider's own deadline
					// is authoritative when it runs past the reported resets.
					if (liveUnblockAtMs > latest) unblockAtMs = liveUnblockAtMs;
				}
			} else if (liveUnblockAtMs !== undefined) {
				// The report's windows look healthy but the live 429 says otherwise:
				// the snapshot predates the block. Trust the provider's own hint for
				// the unblock horizon.
				if (liveUnblockAtMs - nowMs > MAX_PLAUSIBLE_WEEKLY_REMAINING_MS) {
					skip("reset-implausible");
					continue;
				}
				unblockAtMs = liveUnblockAtMs;
				// The hint says WHEN, not WHICH window: a wait longer than a 5h
				// window can span can only be weekly, but a shorter one fits either —
				// a weekly block minutes from rolling over looks exactly like a 5h
				// one. Guessing `5h` here spent credits on blocks whose weekly policy
				// said no, so leave the window unknown and let consent decide below.
				windowUnknown = liveUnblockAtMs - nowMs <= MAX_PLAUSIBLE_PRIMARY_REMAINING_MS;
				blockedWindows = windowUnknown ? [] : ["weekly"];
			} else {
				skip("no-exhausted-window");
				continue;
			}
			// An unknown window falls back to `5h` only as the governing stand-in;
			// both windows are proven to consent identically just below, so
			// re-deriving consent from the emitted action reproduces that mode.
			const window: ResetWindow = blockedWindows.includes("weekly") ? "weekly" : "5h";
			const expiresInMs = snapshot.creditExpiresAtMs === undefined ? undefined : snapshot.creditExpiresAtMs - nowMs;
			const consent = actionConsent(
				{ target: snapshot.target, window, restorableWindows: snapshot.restorableWindows, expiresInMs },
				settings.modes,
			);
			if (
				windowUnknown &&
				actionConsent(
					{
						target: snapshot.target,
						window: "weekly",
						restorableWindows: snapshot.restorableWindows,
						expiresInMs,
					},
					settings.modes,
				).mode !== consent.mode
			) {
				// Redeeming could clear a window the user turned off; only a spend
				// both possible windows permit identically is safe to plan. (For an
				// imminent credit both consents widen to `restorableWindows`, so they
				// agree and the last-chance salvage still runs.)
				skip("window-unknown");
				continue;
			}
			if (consent.mode === "no") {
				skip("window-disabled");
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
			candidates.push({
				snapshot,
				remainingMs,
				unblockAtMs,
				blockedWindows,
				window,
				approved: consent.mode === "yes",
			});
		}
		candidates.sort((a, b) => {
			// Prefer a restore that can run without prompting for consent.
			if (a.approved !== b.approved) return a.approved ? -1 : 1;
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
		const best = candidates[0];
		if (best) {
			restore = {
				reason: "blocked-account",
				window: best.window,
				restorableWindows: best.snapshot.restorableWindows,
				target: best.snapshot.target,
				accountKey: best.snapshot.accountKey,
				attemptKey: blockedAttemptKey(best.snapshot.accountKey, best.unblockAtMs),
				label: best.snapshot.label,
				availableCount: best.snapshot.availableCount,
				weeklyUsedFraction: usedFractionForWindow(best.snapshot, "weekly"),
				remainingMs: best.remainingMs,
				expiresInMs:
					best.snapshot.creditExpiresAtMs === undefined ? undefined : best.snapshot.creditExpiresAtMs - nowMs,
				creditId: best.snapshot.creditId,
				blockedWindows: best.blockedWindows,
				active: best.snapshot.active,
			};
		}
	}

	// --- expiring-credit: salvage every credit that would otherwise die.
	const salvages: CodexResetAction[] = [];
	for (const snapshot of snapshots) {
		if (snapshot.accountKey === restore?.accountKey) continue; // restore already spends its soonest credit
		const rule = "expiring-credit" as const;
		const skip = (reason: CodexResetSkipReason) => skipped.push({ accountKey: snapshot.accountKey, rule, reason });
		const expiresAtMs = snapshot.creditExpiresAtMs;
		const imminent =
			expiresAtMs !== undefined && expiresAtMs > nowMs && expiresAtMs - nowMs <= IMMINENT_RESET_EXPIRY_MS;
		if (
			expiresAtMs === undefined ||
			(!imminent && !(settings.salvageHorizonMs > 0 && expiresAtMs - nowMs <= settings.salvageHorizonMs))
		) {
			skip("no-expiring-credit");
			continue;
		}
		// Broader salvage needs meaningful usage in either chat window. In the
		// last five minutes, live credit eligibility outranks zero/unknown usage:
		// let the provider decide whether there is anything left to restore.
		const fullestWindow = fullestChatWindow(snapshot.windows);
		const window = fullestWindow?.window ?? "5h";
		const consent = actionConsent(
			{
				target: snapshot.target,
				window,
				restorableWindows: snapshot.restorableWindows,
				expiresInMs: expiresAtMs - nowMs,
			},
			settings.modes,
		);
		if (consent.mode === "no") {
			skip("window-disabled");
			continue;
		}
		const salvageUsedFraction = fullestWindow?.usedFraction;
		if (!imminent && (salvageUsedFraction === undefined || salvageUsedFraction < SALVAGE_MIN_USED_FRACTION)) {
			skip("window-mostly-free");
			continue;
		}
		const attemptKey = salvageAttemptKey(snapshot.accountKey, expiresAtMs);
		if (input.attemptedKeys.has(attemptKey)) {
			skip("already-attempted");
			continue;
		}
		const deferredUntil = input.deferredUntilByKey.get(attemptKey);
		if (!imminent && deferredUntil !== undefined && nowMs < deferredUntil) {
			skip("deferred");
			continue;
		}
		if (cooledDown(snapshot.accountKey)) {
			skip("cooldown");
			continue;
		}
		salvages.push({
			reason: "expiring-credit",
			window,
			restorableWindows: snapshot.restorableWindows,
			target: snapshot.target,
			accountKey: snapshot.accountKey,
			attemptKey,
			label: snapshot.label,
			availableCount: snapshot.availableCount,
			weeklyUsedFraction: usedFractionForWindow(snapshot, "weekly"),
			salvageWindow: fullestWindow?.window,
			salvageUsedFraction,
			expiresInMs: expiresAtMs - nowMs,
			creditId: snapshot.creditId,
			active: snapshot.active,
		});
	}
	salvages.sort((a, b) => (a.expiresInMs ?? 0) - (b.expiresInMs ?? 0));

	const actions = restore ? [restore, ...salvages] : salvages;
	return { actions, skipped };
}

/**
 * Fence saved-reset spending by upstream provider, organization, and account,
 * never by a credential row id that another store may reuse.
 */
export function resetAccountLockKey(identity: {
	provider: string;
	accountId?: string;
	email?: string;
	orgId?: string;
}): string | undefined {
	const account = (identity.accountId ?? identity.email)?.trim().toLowerCase();
	if (!account) return undefined;
	return `${identity.provider}|${identity.orgId?.trim().toLowerCase() ?? "-"}|${account}`;
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
 * Live data replaces the report's credit block wholesale; accounts with no
 * live row get the block stripped. For blocked recovery, the active live row
 * may synthesize a minimal report carrying its durable credential id when
 * usage is missing/stale; the 429 supplies timing, never credit eligibility.
 */
export function overlayLiveResetCredits(
	reports: UsageReport[] | null,
	statuses: readonly ResetCreditAccountStatus[],
	options?: { synthesizeActive?: boolean; nowMs?: number },
): UsageReport[] | null {
	const merged = (reports ?? []).map(report => {
		if (report.provider !== "openai-codex") return report;
		const status = statuses.find(s => {
			if (s.provider !== "openai-codex") return false;
			const statusOrg = s.orgId?.trim().toLowerCase();
			const reportOrg =
				typeof report.metadata?.orgId === "string" ? report.metadata.orgId.trim().toLowerCase() : undefined;
			if (statusOrg !== reportOrg) return false;
			if (s.accountId && typeof report.metadata?.accountId === "string") {
				return s.accountId === report.metadata.accountId;
			}
			return !!s.email && s.email === report.metadata?.email;
		});
		if (!status || status.error) return { ...report, resetCredits: undefined };
		return {
			...report,
			metadata: { ...report.metadata, resetCreditCredentialId: status.credentialId },
			resetCredits: {
				availableCount: status.availableCount,
				credits: status.credits
					.filter(credit => (credit.status ?? "available") === "available")
					.map(credit => ({
						id: credit.id,
						grantedAt: credit.grantedAt,
						expiresAt: credit.expiresAt,
						status: credit.status,
					})),
			},
		};
	});
	if (options?.synthesizeActive) {
		const nowMs = options.nowMs ?? Date.now();
		const active = statuses.find(
			status => status.provider === "openai-codex" && status.active && !status.error && status.availableCount > 0,
		);
		const hasFreshActive =
			active !== undefined &&
			merged.some(
				report =>
					report.provider === "openai-codex" &&
					report.metadata?.resetCreditCredentialId === active.credentialId &&
					nowMs - report.fetchedAt <= REPORT_FRESHNESS_MS,
			);
		if (active && !hasFreshActive) {
			merged.push({
				provider: "openai-codex",
				fetchedAt: nowMs,
				limits: [],
				metadata: {
					accountId: active.accountId,
					email: active.email,
					orgId: active.orgId,
					limitReached: true,
					resetCreditCredentialId: active.credentialId,
					resetCreditActive: true,
				},
				resetCredits: {
					availableCount: active.availableCount,
					credits: active.credits
						.filter(credit => (credit.status ?? "available") === "available")
						.map(credit => ({
							id: credit.id,
							grantedAt: credit.grantedAt,
							expiresAt: credit.expiresAt,
							status: credit.status,
						})),
				},
			});
		}
	}
	return reports || merged.length > 0 ? merged : null;
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

/** A confirmed reset, or a safe eligibility read that must wait before retrying. */
export interface ResetRecoveryResult {
	restored: boolean;
	retryAfterMs?: number;
	/** Credentials whose reset the pass spent or adopted from a peer. */
	restoredCredentialIds?: number[];
	/** The session's account pool excluded a restore candidate or dropped a planned restore. */
	poolLimited?: boolean;
}

/**
 * Process-wide (NOT per-session) coordinator state. Parallel sessions share
 * provider accounts and must not race a double-spend; Claude reuses the same
 * attempt/defer/in-flight machinery rather than maintaining a second pipeline.
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
 *   starting a second consume, unless that pass could not serve its account pool.
 * - `sweepInFlight` / `lastSweepAt` / `sweepPromise`: re-entrancy guard, floor,
 *   and settlement handle for the combined provider salvage sweep (a redeem refreshes usage,
 *   which would recurse into a sweep; the promise lets tests and diagnostics
 *   await a fire-and-forget sweep instead of polling).
 * - `notifiedKeys`: headless "run /usage reset" notices already emitted, so a
 *   5-minute sweep cadence can't spam the transcript.
 */
export interface CodexAutoRedeemCoordinator {
	attemptedKeys: Set<string>;
	deferredUntilByKey: Map<string, number>;
	lastAttemptAtByAccount: Map<string, number>;
	/** Alternate lock root for isolated sessions (production uses the shared agent database path). */
	resetLockPath?: string;
	inFlightByAccount: Map<string, Promise<ResetRecoveryResult>>;
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
