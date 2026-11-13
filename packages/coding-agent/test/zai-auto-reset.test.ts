/**
 * Planner fixtures for claiming and spending Z.AI coding-plan resets. Pure and
 * offline — synthetic usage reports and live listings only; nothing is claimed
 * or spent. Each case asserts the produced actions (or the exact skip reason)
 * so a change to one gate cannot silently flip another.
 */
import { describe, expect, it } from "bun:test";
import type { ResetCreditAccountStatus, UsageReport, UsageResetCredit } from "@oh-my-pi/pi-ai";
import {
	ATTEMPT_COOLDOWN_MS,
	IMMINENT_RESET_EXPIRY_MS,
	REDEEM_RETRY_DEFER_MS,
	REPORT_FRESHNESS_MS,
	SALVAGE_MIN_USED_FRACTION,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import {
	fullestZaiTokenWindow,
	planZaiResetClaims,
	ZAI_OPPORTUNITY_POLL_MS,
	type ZaiResetPlanInput,
	zaiOpportunityAttemptKey,
	zaiUseAttemptKey,
} from "@oh-my-pi/pi-coding-agent/session/zai-auto-reset";

// Minute-aligned so attempt-key buckets are predictable.
const NOW = 1_700_000_040_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ACCOUNT_ID = "zai-user-1";
const EMAIL = "coder@example.com";
const ACCOUNT_KEY = `zai|-|${ACCOUNT_ID}`;
const FIVE_HOUR_LIMIT = "zai:tokens:5h";
const WEEKLY_LIMIT = "zai:tokens:1w";

function credit(type: "five_hour" | "week", expiresInMs: number): UsageResetCredit {
	const expireAtMs = NOW + expiresInMs;
	return {
		id: `${type}:${expireAtMs}`,
		title: type === "five_hour" ? "Z.AI 5-hour reset" : "Z.AI weekly reset",
		program: "zai-coding-plan",
		remainingCount: 1,
		usable: true,
		status: "available",
		expiresAt: new Date(expireAtMs).toISOString(),
		clears: [type === "five_hour" ? FIVE_HOUR_LIMIT : WEEKLY_LIMIT],
	};
}

interface ReportOpts {
	fiveHourUsed?: number;
	weeklyUsed?: number;
	fetchedAgoMs?: number;
	accountId?: string;
	email?: string;
}

function report(opts: ReportOpts = {}): UsageReport {
	const accountId = opts.accountId ?? ACCOUNT_ID;
	return {
		provider: "zai",
		fetchedAt: NOW - (opts.fetchedAgoMs ?? 0),
		limits: [
			{
				id: FIVE_HOUR_LIMIT,
				label: "ZAI 5 Hour Token Quota",
				scope: { provider: "zai", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR },
				amount: { usedFraction: opts.fiveHourUsed ?? 0.1, unit: "percent" },
			},
			{
				id: WEEKLY_LIMIT,
				label: "ZAI Weekly Token Quota",
				scope: { provider: "zai", windowId: "1w", shared: true },
				window: { id: "1w", label: "Weekly", durationMs: 7 * 24 * HOUR },
				amount: { usedFraction: opts.weeklyUsed ?? 0.1, unit: "percent" },
			},
		],
		metadata: { accountId, email: opts.email ?? EMAIL },
	};
}

function status(
	credits: UsageResetCredit[] = [],
	extra: Partial<ResetCreditAccountStatus> = {},
): ResetCreditAccountStatus {
	return {
		provider: "zai",
		credentialId: 1,
		accountId: ACCOUNT_ID,
		email: EMAIL,
		active: true,
		availableCount: credits.length,
		redeemableCount: credits.length,
		eligible: true,
		credits,
		...extra,
	};
}

function input(overrides: Partial<ZaiResetPlanInput> = {}): ZaiResetPlanInput {
	return {
		nowMs: NOW,
		trigger: "sweep",
		settings: { enabled: true },
		reports: [report()],
		statuses: [status()],
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		nextTryAtByAccount: new Map(),
		lastOpportunityAtByAccount: new Map(),
		...overrides,
	};
}

/** Silences the opportunity rule so use-rule cases stay isolated. */
const opportunityPolledJustNow = new Map([[ACCOUNT_KEY, NOW - MINUTE]]);

describe("planZaiResetClaims — gates", () => {
	it("returns a single plan-wide skip when disabled", () => {
		const plan = planZaiResetClaims(
			input({ settings: { enabled: false }, statuses: [status([credit("five_hour", 2 * MINUTE)])] }),
		);
		expect(plan).toEqual({ actions: [], skipped: [{ accountKey: "*", reason: "disabled" }] });
	});

	it("skips plan-wide when no zai status is listed", () => {
		const plan = planZaiResetClaims(input({ statuses: [{ ...status(), provider: "openai-codex" }] }));
		expect(plan).toEqual({ actions: [], skipped: [{ accountKey: "*", reason: "no-status" }] });
	});

	it("maps listing errors to missing-tokens and listing-failed", () => {
		const plan = planZaiResetClaims(
			input({
				statuses: [
					status([], { error: "missing_tokens" }),
					status([], { credentialId: 2, accountId: "other", email: "o@example.com", error: "credit_list_failed" }),
				],
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toEqual([
			{ accountKey: ACCOUNT_KEY, reason: "missing-tokens" },
			{ accountKey: "zai|-|other", reason: "listing-failed" },
		]);
	});

	it("maps a reauth-required listing error to its own skip reason", () => {
		const plan = planZaiResetClaims(input({ statuses: [status([], { error: "reauth_required" })] }));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toEqual([{ accountKey: ACCOUNT_KEY, reason: "reauth-required" }]);
	});

	it("falls back to the credential id when the status has no identity", () => {
		const plan = planZaiResetClaims(input({ statuses: [status([], { accountId: undefined, email: undefined })] }));
		expect(plan.actions).toEqual([
			{
				kind: "opportunity",
				target: { provider: "zai", credentialId: 1 },
				accountKey: "zai|1",
				attemptKey: zaiOpportunityAttemptKey("zai|1", NOW),
			},
		]);
	});
});

describe("planZaiResetClaims — opportunity", () => {
	it("claims once per account when nothing gates it", () => {
		const plan = planZaiResetClaims(input());
		expect(plan.actions).toEqual([
			{
				kind: "opportunity",
				target: { provider: "zai", credentialId: 1, accountId: ACCOUNT_ID, email: EMAIL },
				accountKey: ACCOUNT_KEY,
				attemptKey: `zai-opp|${ACCOUNT_KEY}|${NOW / MINUTE}`,
			},
		]);
		expect(plan.skipped).toEqual([{ accountKey: ACCOUNT_KEY, reason: "no-credits" }]);
	});

	it("waits for the server next_try_at, even when blocked", () => {
		const nextTryAtByAccount = new Map([[ACCOUNT_KEY, NOW + MINUTE]]);
		for (const trigger of ["sweep", "blocked"] as const) {
			const plan = planZaiResetClaims(input({ trigger, nextTryAtByAccount }));
			expect(plan.actions).toEqual([]);
			expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "server-wait" });
		}
		const due = planZaiResetClaims(input({ nextTryAtByAccount: new Map([[ACCOUNT_KEY, NOW]]) }));
		expect(due.actions.map(action => action.kind)).toEqual(["opportunity"]);
	});

	it("honours the poll cadence on sweeps", () => {
		const recent = planZaiResetClaims(
			input({ lastOpportunityAtByAccount: new Map([[ACCOUNT_KEY, NOW - ZAI_OPPORTUNITY_POLL_MS + 1]]) }),
		);
		expect(recent.actions).toEqual([]);
		expect(recent.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "poll-cadence" });

		const elapsed = planZaiResetClaims(
			input({ lastOpportunityAtByAccount: new Map([[ACCOUNT_KEY, NOW - ZAI_OPPORTUNITY_POLL_MS]]) }),
		);
		expect(elapsed.actions.map(action => action.kind)).toEqual(["opportunity"]);
	});

	it("lets a blocked trigger bypass the poll cadence but not the cooldown", () => {
		const bypass = planZaiResetClaims(
			input({ trigger: "blocked", lastOpportunityAtByAccount: new Map([[ACCOUNT_KEY, NOW - MINUTE]]) }),
		);
		expect(bypass.actions.map(action => action.kind)).toEqual(["opportunity"]);

		const cooled = planZaiResetClaims(
			input({
				trigger: "blocked",
				lastOpportunityAtByAccount: new Map([[ACCOUNT_KEY, NOW - MINUTE]]),
				lastAttemptAtByAccount: new Map([[ACCOUNT_KEY, NOW - ATTEMPT_COOLDOWN_MS + 1]]),
			}),
		);
		expect(cooled.actions).toEqual([]);
		expect(cooled.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "cooldown" });
	});

	it("skips an opportunity already attempted this minute", () => {
		const plan = planZaiResetClaims(input({ attemptedKeys: new Set([zaiOpportunityAttemptKey(ACCOUNT_KEY, NOW)]) }));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "already-attempted" });
	});

	it("parks every opportunity episode of an account while a deferral is active", () => {
		// The deferral was recorded under an earlier minute's attempt key.
		const earlierKey = zaiOpportunityAttemptKey(ACCOUNT_KEY, NOW - 5 * MINUTE);
		const deferred = planZaiResetClaims(
			input({ deferredUntilByKey: new Map([[earlierKey, NOW - 5 * MINUTE + REDEEM_RETRY_DEFER_MS]]) }),
		);
		expect(deferred.actions).toEqual([]);
		expect(deferred.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "deferred" });

		const lapsed = planZaiResetClaims(input({ deferredUntilByKey: new Map([[earlierKey, NOW]]) }));
		expect(lapsed.actions.map(action => action.kind)).toEqual(["opportunity"]);
	});
});

describe("planZaiResetClaims — use", () => {
	it("salvages an offer at the usage threshold and not below it", () => {
		const offer = credit("five_hour", HOUR);
		const atThreshold = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: SALVAGE_MIN_USED_FRACTION })],
				statuses: [status([offer])],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(atThreshold.actions).toEqual([
			{
				kind: "use",
				target: { provider: "zai", credentialId: 1, accountId: ACCOUNT_ID, email: EMAIL, creditId: offer.id },
				accountKey: ACCOUNT_KEY,
				attemptKey: zaiUseAttemptKey(ACCOUNT_KEY, offer.id),
				reason: "salvage",
				window: "5h",
				expiresInMs: HOUR,
			},
		]);

		const below = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: SALVAGE_MIN_USED_FRACTION - 0.01 })],
				statuses: [status([offer])],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(below.actions).toEqual([]);
		expect(below.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "window-mostly-free" });
	});

	it("measures the window the offer clears, not an unrelated fuller one", () => {
		const plan = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: 0.05, weeklyUsed: 0.9 })],
				statuses: [status([credit("five_hour", HOUR)])],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "window-mostly-free" });
	});

	it("labels an exhausted window spend as blocked only on a blocked trigger", () => {
		const offer = credit("week", HOUR);
		const options = {
			reports: [report({ weeklyUsed: 1 })],
			statuses: [status([offer])],
			nextTryAtByAccount: new Map([[ACCOUNT_KEY, NOW + HOUR]]),
		};
		const blocked = planZaiResetClaims(input({ ...options, trigger: "blocked" }));
		expect(blocked.actions).toMatchObject([{ kind: "use", reason: "blocked" }]);
		const sweep = planZaiResetClaims(input({ ...options, trigger: "sweep" }));
		expect(sweep.actions).toMatchObject([{ kind: "use", reason: "salvage" }]);
	});

	it("spends a last-chance offer regardless of usage, staleness, or deferral", () => {
		const offer = credit("five_hour", IMMINENT_RESET_EXPIRY_MS);
		const plan = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: 0, weeklyUsed: 0, fetchedAgoMs: REPORT_FRESHNESS_MS + HOUR })],
				statuses: [status([offer])],
				deferredUntilByKey: new Map([[zaiUseAttemptKey(ACCOUNT_KEY, offer.id), NOW + HOUR]]),
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(plan.actions).toEqual([
			{
				kind: "use",
				target: { provider: "zai", credentialId: 1, accountId: ACCOUNT_ID, email: EMAIL, creditId: offer.id },
				accountKey: ACCOUNT_KEY,
				attemptKey: zaiUseAttemptKey(ACCOUNT_KEY, offer.id),
				reason: "last-chance",
				window: "5h",
				expiresInMs: IMMINENT_RESET_EXPIRY_MS,
			},
		]);
	});

	it("never lets a last-chance offer bypass the cooldown or a terminal attempt", () => {
		const offer = credit("five_hour", MINUTE);
		const cooled = planZaiResetClaims(
			input({
				statuses: [status([offer])],
				lastAttemptAtByAccount: new Map([[ACCOUNT_KEY, NOW - 1]]),
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(cooled.actions).toEqual([]);
		expect(cooled.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "cooldown" });

		const attempted = planZaiResetClaims(
			input({
				statuses: [status([offer])],
				attemptedKeys: new Set([zaiUseAttemptKey(ACCOUNT_KEY, offer.id)]),
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(attempted.actions).toEqual([]);
		expect(attempted.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "already-attempted" });
	});

	it("skips a non-imminent offer while its episode is deferred", () => {
		const offer = credit("five_hour", HOUR);
		const options = {
			reports: [report({ fiveHourUsed: 0.6 })],
			statuses: [status([offer])],
			lastOpportunityAtByAccount: opportunityPolledJustNow,
		};
		const deferred = planZaiResetClaims(
			input({ ...options, deferredUntilByKey: new Map([[zaiUseAttemptKey(ACCOUNT_KEY, offer.id), NOW + 1]]) }),
		);
		expect(deferred.actions).toEqual([]);
		expect(deferred.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "deferred" });

		const lapsed = planZaiResetClaims(
			input({ ...options, deferredUntilByKey: new Map([[zaiUseAttemptKey(ACCOUNT_KEY, offer.id), NOW]]) }),
		);
		expect(lapsed.actions).toMatchObject([{ kind: "use", reason: "salvage" }]);
	});

	it("skips a non-imminent offer when the usage report is stale", () => {
		const plan = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: 0.9, fetchedAgoMs: REPORT_FRESHNESS_MS + 1 })],
				statuses: [status([credit("five_hour", HOUR)])],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_KEY, reason: "stale-report" });
	});

	it("prefers the status's own report evidence over the reports list", () => {
		const plan = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: 0 })],
				statuses: [status([credit("five_hour", HOUR)], { report: report({ fiveHourUsed: 0.8 }) })],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(plan.actions).toMatchObject([{ kind: "use", reason: "salvage" }]);
	});

	it("excludes expired and non-available offers", () => {
		const expired = credit("five_hour", 0);
		const redeemed = { ...credit("week", HOUR), status: "redeemed" };
		const plan = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: 1, weeklyUsed: 1 })],
				statuses: [status([expired, redeemed])],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toEqual([
			{ accountKey: ACCOUNT_KEY, reason: "poll-cadence" },
			{ accountKey: ACCOUNT_KEY, reason: "no-credits" },
		]);
	});

	it("spends one offer per cleared window, the soonest-expiring", () => {
		const soon = credit("five_hour", 30 * MINUTE);
		const later = credit("five_hour", 90 * MINUTE);
		const plan = planZaiResetClaims(
			input({
				reports: [report({ fiveHourUsed: 0.7 })],
				statuses: [status([later, soon])],
				lastOpportunityAtByAccount: opportunityPolledJustNow,
			}),
		);
		expect(plan.actions).toMatchObject([{ kind: "use", attemptKey: zaiUseAttemptKey(ACCOUNT_KEY, soon.id) }]);
	});
});

describe("planZaiResetClaims — ordering", () => {
	it("orders opportunities first, then uses by soonest expiry across accounts", () => {
		const otherKey = "zai|-|zai-user-2";
		const weekly = credit("week", 2 * HOUR);
		const fiveHour = credit("five_hour", 20 * MINUTE);
		const otherFiveHour = credit("five_hour", 3 * MINUTE);
		const plan = planZaiResetClaims(
			input({
				reports: [
					report({ fiveHourUsed: 0.5, weeklyUsed: 0.5 }),
					report({ accountId: "zai-user-2", email: "two@example.com", fiveHourUsed: 0 }),
				],
				statuses: [
					status([weekly, fiveHour]),
					status([otherFiveHour], { credentialId: 2, accountId: "zai-user-2", email: "two@example.com" }),
				],
				lastOpportunityAtByAccount: new Map([[otherKey, NOW - MINUTE]]),
			}),
		);
		expect(plan.actions.map(action => [action.kind, action.accountKey, action.attemptKey])).toEqual([
			["opportunity", ACCOUNT_KEY, zaiOpportunityAttemptKey(ACCOUNT_KEY, NOW)],
			["use", otherKey, zaiUseAttemptKey(otherKey, otherFiveHour.id)],
			["use", ACCOUNT_KEY, zaiUseAttemptKey(ACCOUNT_KEY, fiveHour.id)],
			["use", ACCOUNT_KEY, zaiUseAttemptKey(ACCOUNT_KEY, weekly.id)],
		]);
		expect(plan.actions).toMatchObject([{}, { reason: "last-chance" }, { reason: "salvage" }, { reason: "salvage" }]);
	});
});

describe("fullestZaiTokenWindow", () => {
	it("picks the fullest zai token window and ignores other limits", () => {
		const base = report({ fiveHourUsed: 0.3, weeklyUsed: 0.6 });
		const withRequests: UsageReport = {
			...base,
			limits: [
				...base.limits,
				{
					id: "zai:requests:5h",
					label: "ZAI Request Quota",
					scope: { provider: "zai", windowId: "5h" },
					amount: { usedFraction: 0.99, unit: "percent" },
				},
			],
		};
		expect(fullestZaiTokenWindow(withRequests)).toMatchObject({ limit: { id: WEEKLY_LIMIT }, usedFraction: 0.6 });
	});

	it("resolves used/limit amounts and returns undefined without known usage", () => {
		const resolved: UsageReport = {
			provider: "zai",
			fetchedAt: NOW,
			limits: [
				{
					id: FIVE_HOUR_LIMIT,
					label: "ZAI 5 Hour Token Quota",
					scope: { provider: "zai" },
					amount: { used: 30, limit: 40, unit: "tokens" },
				},
			],
		};
		expect(fullestZaiTokenWindow(resolved)?.usedFraction).toBe(0.75);
		expect(
			fullestZaiTokenWindow({ ...resolved, limits: [{ ...resolved.limits[0]!, amount: { unit: "tokens" } }] }),
		).toBeUndefined();
	});
});
