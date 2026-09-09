/**
 * Planner fixtures for spending saved Codex rate-limit resets. Pure and
 * offline — no `redeemResetCredit`, no `fetch`, no credit is ever spent. Each
 * case asserts the produced actions (or the exact skip reason) so a future
 * change to one gate can't silently flip another.
 *
 * Two rules under test:
 * - `blocked-account` (trigger `blocked` only): eligibility comes from the
 *   exact exhausted chat windows — 5h primary and/or weekly secondary; a
 *   banked reset also clears a 5h-only block (openai/codex#28525). The
 *   natural unblock is the LATEST reset among the exhausted windows.
 *   Candidates span ALL accounts, active first.
 * - `expiring-credit` (any trigger): use-it-or-lose-it salvage of credits
 *   whose `expiresAt` falls inside the horizon, gated only by the window
 *   having meaningful usage to restore — never by the reserve. A
 *   `nothing_to_reset` no-op defers the episode instead of burying it
 *   ({@link isTerminalRedeemOutcome}).
 */
import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	blockedAttemptKey,
	type CodexResetPlanInput,
	isTerminalRedeemOutcome,
	planCodexResetRedemptions,
	SALVAGE_MIN_USED_FRACTION,
	salvageAttemptKey,
	shouldEvaluateCodexAutoRedeem,
	shouldPromptCodexAutoRedeem,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";

// Epoch ms divisible by 60_000 so minute-boundary reset/expiry times let the
// debounce-jitter cases reason about bucket crossings precisely.
const NOW = 1_700_000_040_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ACCOUNT_ID = "acct-123";
const EMAIL = "user@example.com";
const IDENTITY = { accountId: ACCOUNT_ID, email: EMAIL };

interface AccountOpts {
	accountId?: string | undefined;
	email?: string | undefined;
	/** Weekly usedFraction; `undefined` omits the weekly limit entirely. */
	weeklyUsed?: number | undefined;
	/** Weekly `resetsAt = NOW + this`; `undefined` omits the timestamp. */
	weeklyResetInMs?: number | undefined;
	/** Primary (5h) usedFraction. Defaults to HEADROOM so weekly cases stay isolated. */
	primaryUsed?: number;
	/** Primary `resetsAt = NOW + this`; `undefined` omits the timestamp. */
	primaryResetInMs?: number | undefined;
	/** `availableCount`; `undefined` omits `resetCredits` (older broker / parse failure). */
	credits?: number | undefined;
	/** Per-credit `expiresAt = NOW + offset` (ISO). */
	creditExpiries?: (number | undefined)[];
	/** Per-credit status, paired with `creditExpiries`. */
	creditStatuses?: string[];
	limitReached?: boolean;
	fetchedAgoMs?: number;
}

/** Build a synthetic openai-codex `UsageReport` for one account. */
function report(opts: AccountOpts = {}): UsageReport {
	const accountId = "accountId" in opts ? opts.accountId : ACCOUNT_ID;
	const email = "email" in opts ? opts.email : EMAIL;
	const weeklyUsed = "weeklyUsed" in opts ? opts.weeklyUsed : 1.0;
	const weeklyResetInMs = "weeklyResetInMs" in opts ? opts.weeklyResetInMs : 3 * DAY;
	const primaryResetInMs = "primaryResetInMs" in opts ? opts.primaryResetInMs : 2 * HOUR;
	const credits = "credits" in opts ? opts.credits : 1;
	const limits: UsageReport["limits"] = [
		{
			id: "openai-codex:primary",
			label: "5 Hour",
			scope: { provider: "openai-codex", accountId },
			window: {
				id: "5h",
				label: "5 Hour",
				...(primaryResetInMs === undefined ? {} : { resetsAt: NOW + primaryResetInMs }),
			},
			amount: { usedFraction: opts.primaryUsed ?? 0.5, unit: "percent" },
		},
	];
	if (weeklyUsed !== undefined) {
		limits.push({
			id: "openai-codex:secondary",
			label: "Weekly",
			scope: { provider: "openai-codex", accountId },
			window: {
				id: "7d",
				label: "Weekly",
				...(weeklyResetInMs === undefined ? {} : { resetsAt: NOW + weeklyResetInMs }),
			},
			amount: { usedFraction: weeklyUsed, unit: "percent" },
		});
	}
	return {
		provider: "openai-codex",
		fetchedAt: NOW - (opts.fetchedAgoMs ?? 0),
		limits,
		resetCredits:
			credits === undefined
				? undefined
				: {
						availableCount: credits,
						credits: opts.creditExpiries?.map((offset, index) => ({
							status: opts.creditStatuses?.[index] ?? "available",
							expiresAt: offset === undefined ? undefined : new Date(NOW + offset).toISOString(),
						})),
					},
		metadata: { accountId, email, limitReached: opts.limitReached ?? true },
	};
}

/** Build a planner input around reports, with overridable knobs. */
function input(reports: UsageReport[] | null, overrides: Partial<CodexResetPlanInput> = {}): CodexResetPlanInput {
	return {
		nowMs: NOW,
		trigger: "blocked",
		provider: "openai-codex",
		modelId: "gpt-5.3-codex",
		settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 12 * HOUR },
		identity: IDENTITY,
		reports,
		attemptedKeys: new Set<string>(),
		deferredUntilByKey: new Map<string, number>(),
		lastAttemptAtByAccount: new Map<string, number>(),
		...overrides,
	};
}

describe("planCodexResetRedemptions: blocked-account", () => {
	it("restores a weekly-only block (5h has headroom) far from the natural reset", () => {
		const plan = planCodexResetRedemptions(input([report()]));
		expect(plan.actions).toEqual([
			{
				reason: "blocked-account",
				target: { accountId: ACCOUNT_ID, email: EMAIL },
				accountKey: ACCOUNT_ID,
				attemptKey: blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY),
				label: EMAIL,
				availableCount: 1,
				weeklyUsedFraction: 1.0,
				remainingMs: 3 * DAY,
				expiresInMs: undefined,
				blockedWindows: ["weekly"],
				active: true,
			},
		]);
	});

	it("restores a 5h-only block: a banked reset clears it too (openai/codex#28525)", () => {
		const plan = planCodexResetRedemptions(input([report({ primaryUsed: 1.0, weeklyUsed: 0.8 })]));
		expect(plan.actions).toEqual([
			expect.objectContaining({
				reason: "blocked-account",
				attemptKey: blockedAttemptKey(ACCOUNT_ID, NOW + 2 * HOUR),
				remainingMs: 2 * HOUR,
				blockedWindows: ["5h"],
			}),
		]);
	});

	it("unblocks at the LATEST exhausted-window reset when both are exhausted", () => {
		const plan = planCodexResetRedemptions(input([report({ primaryUsed: 1.0, weeklyUsed: 1.0 })]));
		expect(plan.actions).toEqual([
			expect.objectContaining({
				remainingMs: 3 * DAY,
				attemptKey: blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY),
				blockedWindows: ["5h", "weekly"],
			}),
		]);
	});

	it("restores at exactly the 0.999 exhaustion threshold", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyUsed: 0.999 })]));
		expect(plan.actions).toHaveLength(1);
	});

	it("skips when no chat window is exhausted", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyUsed: 0.4, primaryUsed: 0.9 })]));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "no-exhausted-window",
		});
	});

	it("skips a nearly-but-not-fully exhausted weekly window", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyUsed: 0.995 })]));
		expect(plan.actions).toEqual([]);
	});

	it("skips when the provider omitted the weekly limit and 5h has headroom", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyUsed: undefined })]));
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "no-exhausted-window",
		});
	});

	it("skips when the wire flag does not confirm the block", () => {
		const plan = planCodexResetRedemptions(input([report({ limitReached: false })]));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "not-limit-reached",
		});
	});

	it("skips when the natural unblock is only minutes away (weekly)", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyResetInMs: 2 * 60_000 })]));
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-too-soon",
		});
	});

	it("skips a 5h-only block whose reset is closer than minBlockedMinutes", () => {
		const plan = planCodexResetRedemptions(
			input([report({ primaryUsed: 1.0, weeklyUsed: 0.8, primaryResetInMs: 30 * 60_000 })]),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-too-soon",
		});
	});

	it("skips a reset already in the past (treated as too-soon)", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyResetInMs: -60_000 })]));
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-too-soon",
		});
	});

	it("skips an implausibly distant weekly reset (more than one window length away)", () => {
		const plan = planCodexResetRedemptions(input([report({ weeklyResetInMs: 8 * DAY })]));
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-implausible",
		});
	});

	it("bounds 5h plausibility by the 5h window length, not the weekly one", () => {
		const plan = planCodexResetRedemptions(
			input([report({ primaryUsed: 1.0, weeklyUsed: 0.8, primaryResetInMs: 8 * HOUR })]),
		);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-implausible",
		});
	});

	it("skips when any exhausted window lacks a reset timestamp", () => {
		const both = report({ primaryUsed: 1.0, weeklyUsed: 1.0, weeklyResetInMs: undefined });
		const plan = planCodexResetRedemptions(input([both]));
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "blocked-account", reason: "no-reset-time" });
	});

	it("skips an account with zero credits", () => {
		const plan = planCodexResetRedemptions(input([report({ credits: 0 })]));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "account", reason: "no-credits" });
	});

	it("skips when resetCredits is undefined (cannot verify availability)", () => {
		const plan = planCodexResetRedemptions(input([report({ credits: undefined })]));
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "account", reason: "credits-unknown" });
	});

	it("respects the reserve: 1 credit with keepCredits 1 is held back", () => {
		const plan = planCodexResetRedemptions(
			input([report()], { settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 1, salvageHorizonMs: 0 } }),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "blocked-account", reason: "reserve" });
	});

	it("restores above the reserve: 2 credits with keepCredits 1", () => {
		const plan = planCodexResetRedemptions(
			input([report({ credits: 2 })], {
				settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 1, salvageHorizonMs: 0 },
			}),
		);
		expect(plan.actions).toMatchObject([{ reason: "blocked-account", availableCount: 2 }]);
	});

	it("skips a block episode that was already attempted", () => {
		const plan = planCodexResetRedemptions(
			input([report()], { attemptedKeys: new Set([blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY)]) }),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "already-attempted",
		});
	});

	it("treats +20s resetsAt jitter as the same block bucket", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyResetInMs: 3 * DAY + 20_000 })], {
				attemptedKeys: new Set([blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY)]),
			}),
		);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "already-attempted",
		});
	});

	it("falls back to the per-account cooldown when jitter crosses the minute boundary", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyResetInMs: 3 * DAY + 40_000 })], {
				attemptedKeys: new Set([blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY)]),
				lastAttemptAtByAccount: new Map([[ACCOUNT_ID, NOW - 10_000]]),
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "blocked-account", reason: "cooldown" });
	});

	it("parks a deferred episode until its retry time, then allows it again", () => {
		const key = blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY);
		const parked = planCodexResetRedemptions(
			input([report()], { deferredUntilByKey: new Map([[key, NOW + 60_000]]) }),
		);
		expect(parked.actions).toEqual([]);
		expect(parked.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "blocked-account", reason: "deferred" });
		const resumed = planCodexResetRedemptions(input([report()], { deferredUntilByKey: new Map([[key, NOW - 1]]) }));
		expect(resumed.actions).toHaveLength(1);
	});

	// --- live 429 evidence: the report layer can serve a pre-block snapshot
	// (in-flight adoption, last-good-on-failure under IP throttling), so the
	// parsed unblock timestamp from the live error is authoritative for the
	// active account.

	it("restores from live 429 evidence when the fresh report still shows a healthy account", () => {
		const staleFlag = report({ weeklyUsed: 0.5, primaryUsed: 0.6, limitReached: false });
		const plan = planCodexResetRedemptions(input([staleFlag], { activeBlockUnblockAtMs: NOW + 3 * DAY }));
		expect(plan.actions).toEqual([
			expect.objectContaining({
				reason: "blocked-account",
				accountKey: ACCOUNT_ID,
				attemptKey: blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY),
				remainingMs: 3 * DAY,
				blockedWindows: ["weekly"],
				active: true,
			}),
		]);
	});

	it("classifies a short live block as 5h-scale", () => {
		const staleFlag = report({ weeklyUsed: 0.5, primaryUsed: 0.6, limitReached: false });
		const plan = planCodexResetRedemptions(input([staleFlag], { activeBlockUnblockAtMs: NOW + 2 * HOUR }));
		expect(plan.actions).toMatchObject([{ blockedWindows: ["5h"], remainingMs: 2 * HOUR }]);
	});

	it("still gates live evidence on minBlockedMinutes and plausibility", () => {
		const staleFlag = report({ weeklyUsed: 0.5, limitReached: false });
		const soon = planCodexResetRedemptions(input([staleFlag], { activeBlockUnblockAtMs: NOW + 30 * 60_000 }));
		expect(soon.actions).toEqual([]);
		expect(soon.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-too-soon",
		});
		const absurd = planCodexResetRedemptions(input([staleFlag], { activeBlockUnblockAtMs: NOW + 9 * DAY }));
		expect(absurd.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "reset-implausible",
		});
	});

	it("prefers exact report windows over the live hint when the report shows the block", () => {
		const fresh = report({ weeklyUsed: 1.0 });
		const plan = planCodexResetRedemptions(input([fresh], { activeBlockUnblockAtMs: NOW + 2 * HOUR }));
		// Weekly resetsAt (3d) wins over the 2h hint: per-window data is more precise.
		expect(plan.actions).toMatchObject([{ remainingMs: 3 * DAY, blockedWindows: ["weekly"] }]);
	});

	it("applies live evidence to the active account only — a sibling never inherits it", () => {
		const sibling = report({
			accountId: "acct-sib",
			email: "sib@example.com",
			weeklyUsed: 0.5,
			limitReached: false,
		});
		const plan = planCodexResetRedemptions(input([sibling], { activeBlockUnblockAtMs: NOW + 3 * DAY }));
		// The healthy sibling is skipped on its own (stale-proof) evidence…
		expect(plan.skipped).toContainEqual({
			accountKey: "acct-sib",
			rule: "blocked-account",
			reason: "not-limit-reached",
		});
		// …while the report-less ACTIVE account synthesizes from the live 429.
		expect(plan.actions).toMatchObject([{ reason: "blocked-account", accountKey: ACCOUNT_ID, active: true }]);
	});

	it("synthesizes the active candidate when the report is stale-dropped", () => {
		const stale = report({ fetchedAgoMs: 11 * 60_000 });
		const plan = planCodexResetRedemptions(input([stale], { activeBlockUnblockAtMs: NOW + 3 * DAY }));
		expect(plan.actions).toEqual([
			{
				reason: "blocked-account",
				target: { accountId: ACCOUNT_ID, email: EMAIL },
				accountKey: ACCOUNT_ID,
				attemptKey: blockedAttemptKey(ACCOUNT_ID, NOW + 3 * DAY),
				label: EMAIL,
				availableCount: undefined,
				weeklyUsedFraction: undefined,
				remainingMs: 3 * DAY,
				expiresInMs: undefined,
				blockedWindows: ["weekly"],
				active: true,
			},
		]);
	});

	it("synthesizes the active candidate when there are no reports at all", () => {
		const plan = planCodexResetRedemptions(input(null, { activeBlockUnblockAtMs: NOW + 3 * DAY }));
		expect(plan.actions).toMatchObject([
			{ reason: "blocked-account", accountKey: ACCOUNT_ID, availableCount: undefined, active: true },
		]);
	});

	it("refuses to synthesize against a reserve (unknown balance cannot honor keepCredits)", () => {
		const plan = planCodexResetRedemptions(
			input(null, {
				activeBlockUnblockAtMs: NOW + 3 * DAY,
				settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 1, salvageHorizonMs: 0 },
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "blocked-account",
			reason: "credits-unknown",
		});
	});

	it("does not synthesize when a fresh report proves the account has no credits", () => {
		const fresh = report({ credits: 0, limitReached: false });
		const plan = planCodexResetRedemptions(input([fresh], { activeBlockUnblockAtMs: NOW + 3 * DAY }));
		expect(plan.actions).toEqual([]);
	});

	it("does not synthesize on the sweep trigger or without identity", () => {
		expect(
			planCodexResetRedemptions(input(null, { trigger: "sweep", activeBlockUnblockAtMs: NOW + 3 * DAY })).actions,
		).toEqual([]);
		const plan = planCodexResetRedemptions(
			input(null, { identity: undefined, activeBlockUnblockAtMs: NOW + 3 * DAY }),
		);
		expect(plan.actions).toEqual([]);
	});

	it("disables the rule for Spark models (reset vs Spark meter is unknown)", () => {
		const plan = planCodexResetRedemptions(input([report()], { modelId: "gpt-5.3-codex-spark" }));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: "*", rule: "blocked-account", reason: "spark-model" });
	});

	it("disables the rule when the active model is not Codex", () => {
		const plan = planCodexResetRedemptions(input([report()], { provider: "anthropic" }));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: "*", rule: "blocked-account", reason: "wrong-provider" });
	});

	it("never restores from a sweep trigger", () => {
		const plan = planCodexResetRedemptions(input([report()], { trigger: "sweep" }));
		expect(plan.actions).toEqual([]);
	});

	it("returns nothing when the policy is disabled", () => {
		const plan = planCodexResetRedemptions(
			input([report()], {
				settings: { enabled: false, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 0 },
			}),
		);
		expect(plan).toEqual({ actions: [], skipped: [{ accountKey: "*", rule: "account", reason: "disabled" }] });
	});

	it("skips a stale usage report", () => {
		const plan = planCodexResetRedemptions(input([report({ fetchedAgoMs: 11 * 60_000 })]));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "account", reason: "stale-report" });
	});

	it("plans without an active identity (pool-wide, account marked inactive)", () => {
		const plan = planCodexResetRedemptions(input([report()], { identity: undefined }));
		expect(plan.actions).toMatchObject([{ reason: "blocked-account", active: false }]);
	});

	it("restores an exhausted sibling when the active account has no credits", () => {
		const active = report({ credits: 0 });
		const sibling = report({ accountId: "acct-sib", email: "sib@example.com", credits: 2 });
		const plan = planCodexResetRedemptions(input([active, sibling]));
		expect(plan.actions).toMatchObject([
			{ reason: "blocked-account", accountKey: "acct-sib", label: "sib@example.com", active: false },
		]);
	});

	it("prefers the active account over an otherwise better sibling", () => {
		const active = report({ credits: 1 });
		const sibling = report({ accountId: "acct-sib", email: "sib@example.com", credits: 3 });
		const plan = planCodexResetRedemptions(input([active, sibling]));
		expect(plan.actions[0]).toMatchObject({ accountKey: ACCOUNT_ID, active: true });
	});

	it("breaks sibling ties by soonest credit expiry", () => {
		const a = report({ accountId: "acct-a", email: "a@example.com", creditExpiries: [5 * DAY] });
		const b = report({ accountId: "acct-b", email: "b@example.com", creditExpiries: [2 * DAY] });
		const plan = planCodexResetRedemptions(input([a, b], { identity: undefined }));
		expect(plan.actions[0]).toMatchObject({ accountKey: "acct-b" });
	});

	it("emits at most one restore action even with several blocked candidates", () => {
		const a = report({ accountId: "acct-a", email: "a@example.com" });
		const b = report({ accountId: "acct-b", email: "b@example.com" });
		const plan = planCodexResetRedemptions(input([a, b], { identity: undefined }));
		expect(plan.actions.filter(action => action.reason === "blocked-account")).toHaveLength(1);
	});

	it("ignores non-Codex reports and empty inputs", () => {
		const foreign = { ...report(), provider: "anthropic" } as UsageReport;
		expect(planCodexResetRedemptions(input([foreign])).actions).toEqual([]);
		expect(planCodexResetRedemptions(input(null)).actions).toEqual([]);
	});
});

describe("planCodexResetRedemptions: expiring-credit", () => {
	it("salvages a credit expiring inside the horizon on a well-used window", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, limitReached: false, creditExpiries: [2 * HOUR] })], { trigger: "sweep" }),
		);
		expect(plan.actions).toEqual([
			{
				reason: "expiring-credit",
				target: { accountId: ACCOUNT_ID, email: EMAIL },
				accountKey: ACCOUNT_ID,
				attemptKey: salvageAttemptKey(ACCOUNT_ID, NOW + 2 * HOUR),
				label: EMAIL,
				availableCount: 1,
				weeklyUsedFraction: 0.8,
				salvageWindow: "weekly",
				salvageUsedFraction: 0.8,
				expiresInMs: 2 * HOUR,
				active: true,
			},
		]);
	});

	it("salvages at exactly the horizon boundary", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, creditExpiries: [12 * HOUR] })], { trigger: "sweep" }),
		);
		expect(plan.actions).toHaveLength(1);
	});

	it("leaves credits outside the horizon alone", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, creditExpiries: [13 * HOUR] })], { trigger: "sweep" }),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "expiring-credit",
			reason: "no-expiring-credit",
		});
	});

	it("ignores already-expired and non-available credits", () => {
		const plan = planCodexResetRedemptions(
			input(
				[
					report({
						weeklyUsed: 0.8,
						creditExpiries: [-HOUR, 2 * HOUR],
						creditStatuses: ["available", "redeemed"],
					}),
				],
				{ trigger: "sweep" },
			),
		);
		expect(plan.actions).toEqual([]);
	});

	it("ignores credits without an expiry date", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, creditExpiries: [undefined] })], { trigger: "sweep" }),
		);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "expiring-credit",
			reason: "no-expiring-credit",
		});
	});

	it("skips when both chat windows are mostly free (nothing worth restoring)", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.1, primaryUsed: 0.1, creditExpiries: [2 * HOUR] })], { trigger: "sweep" }),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "expiring-credit",
			reason: "window-mostly-free",
		});
	});

	it("salvages a 5h-exhausted account with a light week (openai/codex#28525 shape)", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.2, primaryUsed: 1.0, creditExpiries: [2 * HOUR] })], { trigger: "sweep" }),
		);
		expect(plan.actions).toMatchObject([
			{ reason: "expiring-credit", salvageWindow: "5h", salvageUsedFraction: 1.0 },
		]);
	});

	it("salvages at exactly the minimum used fraction", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: SALVAGE_MIN_USED_FRACTION, primaryUsed: 0, creditExpiries: [2 * HOUR] })], {
				trigger: "sweep",
			}),
		);
		expect(plan.actions).toMatchObject([{ salvageWindow: "weekly", salvageUsedFraction: SALVAGE_MIN_USED_FRACTION }]);
	});

	it("judges value from the 5h window when the weekly limit is missing", () => {
		const missingWeekly = planCodexResetRedemptions(
			input([report({ weeklyUsed: undefined, primaryUsed: 0.9, creditExpiries: [2 * HOUR] })], { trigger: "sweep" }),
		);
		expect(missingWeekly.actions).toMatchObject([{ salvageWindow: "5h", salvageUsedFraction: 0.9 }]);
		const bothMissing = planCodexResetRedemptions(
			input([report({ weeklyUsed: undefined, primaryUsed: 0, creditExpiries: [2 * HOUR] })], { trigger: "sweep" }),
		);
		expect(bothMissing.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "expiring-credit",
			reason: "window-mostly-free",
		});
	});

	it("bypasses the reserve — a dying credit preserves nothing", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, creditExpiries: [2 * HOUR] })], {
				trigger: "sweep",
				settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 5, salvageHorizonMs: 12 * HOUR },
			}),
		);
		expect(plan.actions).toHaveLength(1);
	});

	it("skips a salvage episode that was already attempted", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, creditExpiries: [2 * HOUR] })], {
				trigger: "sweep",
				attemptedKeys: new Set([salvageAttemptKey(ACCOUNT_ID, NOW + 2 * HOUR)]),
			}),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: ACCOUNT_ID,
			rule: "expiring-credit",
			reason: "already-attempted",
		});
	});

	it("parks a deferred salvage (e.g. after nothing_to_reset) until its retry time", () => {
		const key = salvageAttemptKey(ACCOUNT_ID, NOW + 2 * HOUR);
		const base = [report({ weeklyUsed: 0.8, creditExpiries: [2 * HOUR] })];
		const parked = planCodexResetRedemptions(
			input(base, { trigger: "sweep", deferredUntilByKey: new Map([[key, NOW + 60_000]]) }),
		);
		expect(parked.actions).toEqual([]);
		expect(parked.skipped).toContainEqual({ accountKey: ACCOUNT_ID, rule: "expiring-credit", reason: "deferred" });
		const resumed = planCodexResetRedemptions(
			input(base, { trigger: "sweep", deferredUntilByKey: new Map([[key, NOW - 1]]) }),
		);
		expect(resumed.actions).toHaveLength(1);
	});

	it("is disabled by a zero horizon", () => {
		const plan = planCodexResetRedemptions(
			input([report({ weeklyUsed: 0.8, creditExpiries: [2 * HOUR] })], {
				trigger: "sweep",
				settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 0 },
			}),
		);
		expect(plan.actions).toEqual([]);
	});

	it("salvages several accounts in one sweep, soonest expiry first", () => {
		const a = report({ accountId: "acct-a", email: "a@example.com", weeklyUsed: 0.9, creditExpiries: [5 * HOUR] });
		const b = report({ accountId: "acct-b", email: "b@example.com", weeklyUsed: 0.7, creditExpiries: [2 * HOUR] });
		const plan = planCodexResetRedemptions(input([a, b], { trigger: "sweep", identity: undefined }));
		expect(plan.actions.map(action => action.accountKey)).toEqual(["acct-b", "acct-a"]);
	});

	it("does not double-spend an account the blocked rule already restores", () => {
		const blocked = report({ creditExpiries: [2 * HOUR] });
		const sibling = report({
			accountId: "acct-sib",
			email: "sib@example.com",
			weeklyUsed: 0.8,
			limitReached: false,
			creditExpiries: [3 * HOUR],
		});
		const plan = planCodexResetRedemptions(input([blocked, sibling]));
		expect(plan.actions).toMatchObject([
			{ reason: "blocked-account", accountKey: ACCOUNT_ID },
			{ reason: "expiring-credit", accountKey: "acct-sib" },
		]);
	});
});

describe("codexResets policy plumbing", () => {
	it("classifies consume outcomes: spent/settled stay buried, refusals defer", () => {
		// Terminal: the credit is gone or provably unusable — the episode stays settled.
		expect(isTerminalRedeemOutcome("reset")).toBe(true);
		expect(isTerminalRedeemOutcome("already_redeemed")).toBe(true);
		expect(isTerminalRedeemOutcome("no_credit")).toBe(true);
		// Non-terminal: the credit is still banked — the executor must release the
		// attempt key and defer, or an early `nothing_to_reset` would bury a live
		// credit for the rest of the process.
		expect(isTerminalRedeemOutcome("nothing_to_reset")).toBe(false);
		expect(isTerminalRedeemOutcome("http_500")).toBe(false);
		expect(isTerminalRedeemOutcome("credit_list_failed")).toBe(false);
	});

	it("maps the tri-state policy onto evaluate/prompt gates", () => {
		// The public setting defaults to prompt-on-eligibility, not silent spend.
		expect(SETTINGS_SCHEMA["codexResets.autoRedeem"].default).toBe("unset");
		expect(SETTINGS_SCHEMA["codexResets.salvageHorizonHours"].default).toBe(12);
		expect(shouldEvaluateCodexAutoRedeem("unset")).toBe(true);
		expect(shouldPromptCodexAutoRedeem("unset")).toBe(true);
		expect(shouldEvaluateCodexAutoRedeem("yes")).toBe(true);
		expect(shouldPromptCodexAutoRedeem("yes")).toBe(false);
		expect(shouldEvaluateCodexAutoRedeem("no")).toBe(false);
		expect(shouldPromptCodexAutoRedeem("no")).toBe(false);
	});

	it("migrates legacy boolean autoRedeem config to the tri-state policy", () => {
		expect(Settings.isolated().get("codexResets.autoRedeem")).toBe("unset");
		expect(Settings.isolated({ "codexResets.autoRedeem": true }).get("codexResets.autoRedeem")).toBe("yes");
		expect(Settings.isolated({ "codexResets.autoRedeem": false }).get("codexResets.autoRedeem")).toBe("no");
	});
});
