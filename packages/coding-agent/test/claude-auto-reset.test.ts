import { describe, expect, it } from "bun:test";
import type { OAuthAccountSummary, ResetCreditAccountStatus, UsageReport, UsageResetCredit } from "@oh-my-pi/pi-ai";
import {
	claudeResetStatusesFromReports,
	planClaudeResetRedemptions,
	type ClaudeResetPlanInput,
	type ClaudeResetSkipReason,
} from "@oh-my-pi/pi-coding-agent/session/claude-auto-reset";

const NOW = 1_700_000_040_000;
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

interface ReportOptions {
	orgId?: string;
	email?: string;
	fiveHourUsed?: number;
	weeklyUsed?: number;
	sonnetUsed?: number;
}

function report(options: ReportOptions = {}): UsageReport {
	const orgId = options.orgId ?? "org-a";
	const email = options.email ?? "user@example.com";
	return {
		provider: "anthropic",
		fetchedAt: NOW,
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", shared: true, windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR, resetsAt: NOW + 2 * HOUR },
				amount: { usedFraction: options.fiveHourUsed ?? 0.4, unit: "percent" },
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", shared: true, windowId: "7d" },
				window: { id: "7d", label: "7 Day", durationMs: WEEK, resetsAt: NOW + 3 * 24 * HOUR },
				amount: { usedFraction: options.weeklyUsed ?? 1, unit: "percent" },
			},
			{
				id: "anthropic:7d:sonnet",
				label: "Claude 7 Day (Sonnet)",
				scope: { provider: "anthropic", tier: "sonnet", windowId: "7d" },
				window: { id: "7d", label: "7 Day", durationMs: WEEK, resetsAt: NOW + 4 * 24 * HOUR },
				amount: { usedFraction: options.sonnetUsed ?? 0.2, unit: "percent" },
			},
		],
		metadata: { email, orgId },
	};
}

interface StatusOptions {
	credentialId?: number;
	orgId?: string;
	email?: string;
	active?: boolean;
	availableCount?: number;
	eligible?: boolean;
	redeemableCount?: number;
	nextCreditId?: string;
	cooldownUntil?: string;
	credit?: Partial<UsageResetCredit>;
}

function status(options: StatusOptions = {}): ResetCreditAccountStatus {
	const id = options.credit?.id ?? "cedar-1";
	const credit: UsageResetCredit = {
		id,
		program: "cedar_ember",
		title: "Saved reset",
		remainingCount: 1,
		usable: true,
		requiresLimit: true,
		clears: ["anthropic:5h", "anthropic:7d"],
		blocking: ["anthropic:7d"],
		usedFractions: { "anthropic:5h": 0.4, "anthropic:7d": 1 },
		status: "available",
		expiresAt: new Date(NOW + 2 * HOUR).toISOString(),
		...options.credit,
	};
	return {
		provider: "anthropic",
		credentialId: options.credentialId ?? 11,
		email: options.email ?? "user@example.com",
		orgId: options.orgId ?? "org-a",
		active: options.active ?? true,
		availableCount: options.availableCount ?? 1,
		redeemableCount: options.redeemableCount ?? 1,
		eligible: options.eligible ?? true,
		nextCreditId: options.nextCreditId ?? id,
		cooldownUntil: options.cooldownUntil,
		credits: [credit],
	};
}

function input(overrides: Partial<ClaudeResetPlanInput> = {}): ClaudeResetPlanInput {
	return {
		nowMs: NOW,
		trigger: "blocked",
		provider: "anthropic",
		modelId: "claude-sonnet-4-6",
		settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 0, salvageHorizonMs: 12 * HOUR },
		reports: [report()],
		statuses: [status()],
		attemptedKeys: new Set(),
		deferredUntilByKey: new Map(),
		lastAttemptAtByAccount: new Map(),
		...overrides,
	};
}

describe("planClaudeResetRedemptions: blocked recovery", () => {
	it("spends only the live server-selected Cedar grant through its durable credential", () => {
		const plan = planClaudeResetRedemptions(input());
		expect(plan.actions).toEqual([
			expect.objectContaining({
				reason: "blocked-account",
				target: {
					provider: "anthropic",
					credentialId: 11,
					creditId: "cedar-1",
					accountId: undefined,
					email: "user@example.com",
					orgId: "org-a",
				},
				accountKey: "anthropic|org-a|11",
				blockedWindows: ["anthropic:7d"],
				remainingMs: 3 * 24 * HOUR,
			}),
		]);
	});

	it("uses quota evidence from live reset discovery when broker reports are unavailable or stale", () => {
		const live = status();
		live.report = report();
		const stale = report({ weeklyUsed: 0.1 });
		stale.fetchedAt = NOW - HOUR;

		for (const reports of [null, [stale]]) {
			const plan = planClaudeResetRedemptions(input({ reports, statuses: [live] }));
			expect(plan.actions).toMatchObject([
				{ reason: "blocked-account", target: { credentialId: 11 }, blockedWindows: ["anthropic:7d"] },
			]);
		}
	});

	it("does not redeem using another organization's reset-discovery quota", () => {
		const live = status();
		live.report = report({ orgId: "org-other" });

		const plan = planClaudeResetRedemptions(input({ reports: null, statuses: [live] }));

		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: "anthropic|org-a|11",
			rule: "account",
			reason: "no-report",
		});
	});

	it("uses live grant exhaustion when the usage report predates the blocking response", () => {
		const plan = planClaudeResetRedemptions(
			input({
				reports: [report({ fiveHourUsed: 0.4, weeklyUsed: 0.5 })],
				statuses: [status({ credit: { blocking: [], usedFractions: { "anthropic:7d": 1 } } })],
			}),
		);
		expect(plan.actions).toMatchObject([
			{
				reason: "blocked-account",
				target: { provider: "anthropic", credentialId: 11, creditId: "cedar-1" },
				blockedWindows: ["anthropic:7d"],
			},
		]);
	});

	it("never guesses eligibility or a grant when the live listing cannot select one", () => {
		expect(planClaudeResetRedemptions(input({ statuses: [] })).actions).toEqual([]);
		const changedSelection = status({ nextCreditId: "cedar-replaced" });
		const plan = planClaudeResetRedemptions(input({ statuses: [changedSelection] }));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: "anthropic|org-a|11",
			rule: "account",
			reason: "no-selected-credit",
		});
	});

	it("allows Juniper for a sole 5h block but never for a weekly or model-scoped block", () => {
		const juniper = status({
			credit: {
				id: "juniper_tide",
				program: "juniper_tide",
				clears: ["anthropic:5h"],
				blocking: ["anthropic:5h"],
				usedFractions: { "anthropic:5h": 1 },
				requiresLimit: true,
			},
		});
		const fiveHourOnly = planClaudeResetRedemptions(
			input({ reports: [report({ fiveHourUsed: 1, weeklyUsed: 0.5 })], statuses: [juniper] }),
		);
		expect(fiveHourOnly.actions).toMatchObject([
			{ program: "juniper_tide", blockedWindows: ["anthropic:5h"], remainingMs: 2 * HOUR },
		]);

		const weeklyAlsoBlocked = planClaudeResetRedemptions(
			input({ reports: [report({ fiveHourUsed: 1, weeklyUsed: 1 })], statuses: [juniper] }),
		);
		expect(weeklyAlsoBlocked.actions).toEqual([]);
		expect(weeklyAlsoBlocked.skipped).toContainEqual({
			accountKey: "anthropic|org-a|11",
			rule: "blocked-account",
			reason: "incomplete-coverage",
		});
	});

	it("refuses a Cedar grant that does not clear an exhausted relevant model scope", () => {
		const plan = planClaudeResetRedemptions(input({ reports: [report({ weeklyUsed: 0.5, sonnetUsed: 1 })] }));
		expect(plan.actions).toEqual([]);
		expect(plan.skipped).toContainEqual({
			accountKey: "anthropic|org-a|11",
			rule: "blocked-account",
			reason: "incomplete-coverage",
		});
	});

	it("honors provider cooldown, local reserve, and episode deferral before mutation", () => {
		// A Cedar grant can hold several resets. The bank depth versions an
		// episode key: ambiguous retries retain it, while a confirmed decrement
		// permits a later reset from the same grant.
		const first = planClaudeResetRedemptions(
			input({
				statuses: [
					status({
						availableCount: 2,
						redeemableCount: 2,
						credit: { remainingCount: 2 },
					}),
				],
			}),
		).actions[0];
		const next = planClaudeResetRedemptions(input()).actions[0];
		expect(first?.attemptKey).not.toBe(next?.attemptKey);
		const cooling = planClaudeResetRedemptions(
			input({ statuses: [status({ cooldownUntil: new Date(NOW + HOUR).toISOString() })] }),
		);
		expect(cooling.actions).toEqual([]);
		expect(cooling.skipped[0]?.reason).toBe("provider-cooldown");

		const reserved = planClaudeResetRedemptions(
			input({ settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 1, salvageHorizonMs: 12 * HOUR } }),
		);
		expect(reserved.actions).toEqual([]);
		expect(reserved.skipped[0]?.reason).toBe("reserve");

		const planned = planClaudeResetRedemptions(input()).actions[0];
		expect(planned).toBeDefined();
		const deferred = planClaudeResetRedemptions(
			input({ deferredUntilByKey: new Map([[planned!.attemptKey, NOW + HOUR]]) }),
		);
		expect(deferred.actions).toEqual([]);
		expect(deferred.skipped).toContainEqual({
			accountKey: "anthropic|org-a|11",
			rule: "blocked-account",
			reason: "deferred",
		});
	});
});

describe("planClaudeResetRedemptions: expiry salvage", () => {
	it("salvages at the inclusive five-minute boundary despite zero horizon, reserve, and zero usage", () => {
		const urgentInput = input({
			trigger: "sweep",
			settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 1, salvageHorizonMs: 0 },
			reports: [report({ fiveHourUsed: 0, weeklyUsed: 0, sonnetUsed: 0 })],
			statuses: [
				status({
					credit: {
						expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
						requiresLimit: false,
						blocking: [],
						usedFractions: {},
					},
				}),
			],
		});
		expect(planClaudeResetRedemptions(urgentInput).actions).toMatchObject([
			{
				reason: "expiring-credit",
				target: { credentialId: 11, creditId: "cedar-1" },
				expiresInMs: 5 * 60_000,
				salvageUsedFraction: 0,
				requiresLimit: false,
			},
		]);
		expect(
			planClaudeResetRedemptions({ ...urgentInput, settings: { ...urgentInput.settings, enabled: false } }).actions,
		).toEqual([]);
		for (const expiresInMs of [-1, 0, 5 * 60_000 + 1]) {
			expect(
				planClaudeResetRedemptions({
					...urgentInput,
					statuses: [
						status({
							credit: {
								...urgentInput.statuses[0]!.credits[0]!,
								expiresAt: new Date(NOW + expiresInMs).toISOString(),
							},
						}),
					],
				}).actions,
			).toEqual([]);
		}
		expect(
			planClaudeResetRedemptions({
				...urgentInput,
				nowMs: NOW + 5 * 60_000 - 1,
				reports: [report({ fiveHourUsed: 0, weeklyUsed: 0, sonnetUsed: 0 })],
			}).actions,
		).toHaveLength(1);
	});

	it("preserves reserve, usage, and horizon policies immediately outside the urgent window", () => {
		const outsideInput = input({
			trigger: "sweep",
			reports: [report({ fiveHourUsed: 0.1, weeklyUsed: 0.1, sonnetUsed: 0.1 })],
			statuses: [
				status({
					credit: {
						expiresAt: new Date(NOW + 5 * 60_000 + 1).toISOString(),
						requiresLimit: false,
						blocking: [],
						usedFractions: {},
					},
				}),
			],
		});
		const mostlyFree = planClaudeResetRedemptions(outsideInput);
		expect(mostlyFree.actions).toEqual([]);
		expect(mostlyFree.skipped[0]?.reason).toBe("window-mostly-free");
		const reserved = planClaudeResetRedemptions({
			...outsideInput,
			settings: { ...outsideInput.settings, keepCredits: 1 },
		});
		expect(reserved.actions).toEqual([]);
		expect(reserved.skipped[0]?.reason).toBe("reserve");
		const noHorizon = planClaudeResetRedemptions({
			...outsideInput,
			reports: [report()],
			settings: { ...outsideInput.settings, salvageHorizonMs: 0 },
		});
		expect(noHorizon.actions).toEqual([]);
	});

	it("uses urgent salvage rather than bypassing the blocked-recovery reserve", () => {
		const plan = planClaudeResetRedemptions(
			input({
				settings: { enabled: true, minBlockedMinutes: 60, keepCredits: 1, salvageHorizonMs: 0 },
				statuses: [status({ credit: { expiresAt: new Date(NOW + 60_000).toISOString() } })],
			}),
		);
		expect(plan.actions).toMatchObject([{ reason: "expiring-credit", requiresLimit: true }]);
		expect(plan.skipped).toContainEqual({
			accountKey: "anthropic|org-a|11",
			rule: "blocked-account",
			reason: "reserve",
		});
	});

	it("salvages only live eligible Juniper grants with supported five-hour exhaustion", () => {
		const juniper = status({
			credit: {
				id: "juniper_tide",
				program: "juniper_tide",
				clears: ["anthropic:5h"],
				blocking: [],
				usedFractions: {},
				requiresLimit: true,
				expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
			},
		});
		const juniperInput = input({
			trigger: "sweep",
			reports: [report({ fiveHourUsed: 1, weeklyUsed: 0.5 })],
			statuses: [juniper],
		});
		expect(planClaudeResetRedemptions(juniperInput).actions).toMatchObject([
			{
				reason: "expiring-credit",
				program: "juniper_tide",
				target: { creditId: "juniper_tide" },
				salvageWindow: "anthropic:5h",
				requiresLimit: true,
			},
		]);
		for (const [fiveHourUsed, weeklyUsed, reason] of [
			[0, 0, "no-blocked-window"],
			[1, 1, "incomplete-coverage"],
		] as const) {
			const plan = planClaudeResetRedemptions({
				...juniperInput,
				reports: [report({ fiveHourUsed, weeklyUsed })],
			});
			expect(plan.actions).toEqual([]);
			expect(plan.skipped[0]?.reason).toBe(reason);
		}
		expect(
			planClaudeResetRedemptions({ ...juniperInput, statuses: [{ ...juniper, eligible: false }] }).actions,
		).toEqual([]);
		const outside = planClaudeResetRedemptions({
			...juniperInput,
			statuses: [
				status({
					credit: { ...juniper.credits[0]!, expiresAt: new Date(NOW + 5 * 60_000 + 1).toISOString() },
				}),
			],
		});
		expect(outside.actions).toEqual([]);
		expect(outside.skipped[0]?.reason).toBe("unsupported-program");
	});

	it("never overrides live grant safety or provider constraints for imminent expiry", () => {
		const urgent = status({ credit: { expiresAt: new Date(NOW + 60_000).toISOString() } });
		const credit = urgent.credits[0]!;
		const cases: { live: ResetCreditAccountStatus; reason: ClaudeResetSkipReason }[] = [
			{ live: { ...urgent, eligible: false }, reason: "ineligible" },
			{ live: { ...urgent, error: "listing failed" }, reason: "credits-unknown" },
			{ live: { ...urgent, credentialId: Number.NaN }, reason: "no-identity" },
			{ live: { ...urgent, availableCount: 0 }, reason: "no-credits" },
			{ live: { ...urgent, redeemableCount: 0 }, reason: "no-credits" },
			{ live: { ...urgent, nextCreditId: "unselected" }, reason: "no-selected-credit" },
			{
				live: { ...urgent, cooldownUntil: new Date(NOW + 1).toISOString() },
				reason: "provider-cooldown",
			},
			{ live: { ...urgent, credits: [{ ...credit, usable: false }] }, reason: "credit-unusable" },
			{ live: { ...urgent, credits: [{ ...credit, remainingCount: 0 }] }, reason: "credit-unusable" },
			{ live: { ...urgent, credits: [{ ...credit, expiresAt: "invalid" }] }, reason: "credit-expired" },
			{ live: { ...urgent, credits: [{ ...credit, expiresAt: undefined }] }, reason: "no-expiring-credit" },
			{
				live: { ...urgent, credits: [{ ...credit, clears: ["anthropic:5h"] }] },
				reason: "incomplete-coverage",
			},
			{
				live: { ...urgent, credits: [{ ...credit, blocking: ["anthropic:unsupported"] }] },
				reason: "unsupported-window",
			},
		];
		for (const { live, reason } of cases) {
			const plan = planClaudeResetRedemptions(input({ trigger: "sweep", statuses: [live] }));
			expect(plan.actions).toEqual([]);
			expect(plan.skipped[0]?.reason).toBe(reason);
		}
		const limitGated = planClaudeResetRedemptions(
			input({
				trigger: "sweep",
				reports: [report({ fiveHourUsed: 0, weeklyUsed: 0, sonnetUsed: 0 })],
				statuses: [{ ...urgent, credits: [{ ...credit, blocking: [], usedFractions: {} }] }],
			}),
		);
		expect(limitGated.actions).toEqual([]);
		expect(limitGated.skipped[0]?.reason).toBe("no-blocked-window");
	});

	it("ignores long nonterminal deferrals only while urgent, retaining dedupe and the 60-second cooldown", () => {
		const urgentInput = input({
			trigger: "sweep",
			statuses: [status({ credit: { expiresAt: new Date(NOW + 5 * 60_000).toISOString() } })],
		});
		const action = planClaudeResetRedemptions(urgentInput).actions[0]!;
		expect(action).toBeDefined();
		for (const deferredKey of [action.attemptKey, `block|${action.accountKey}|previous-episode`]) {
			const deferredUntilByKey = new Map([[deferredKey, NOW + HOUR]]);
			expect(planClaudeResetRedemptions({ ...urgentInput, deferredUntilByKey }).actions).toHaveLength(1);
			const outside = planClaudeResetRedemptions({ ...urgentInput, nowMs: NOW - 1, deferredUntilByKey });
			expect(outside.actions).toEqual([]);
			expect(outside.skipped[0]?.reason).toBe("deferred");
			const attempted = planClaudeResetRedemptions({
				...urgentInput,
				deferredUntilByKey,
				attemptedKeys: new Set([action.attemptKey]),
			});
			expect(attempted.actions).toEqual([]);
			expect(attempted.skipped[0]?.reason).toBe("already-attempted");
			const cooling = planClaudeResetRedemptions({
				...urgentInput,
				deferredUntilByKey,
				lastAttemptAtByAccount: new Map([[action.accountKey, NOW - 60_000 + 1]]),
			});
			expect(cooling.actions).toEqual([]);
			expect(cooling.skipped[0]?.reason).toBe("cooldown");
			expect(
				planClaudeResetRedemptions({
					...urgentInput,
					deferredUntilByKey,
					lastAttemptAtByAccount: new Map([[action.accountKey, NOW - 60_000]]),
				}).actions,
			).toHaveLength(1);
		}
	});

	it("salvages an expiring early-use Cedar grant only for materially used covered quota", () => {
		const early = status({
			credit: {
				requiresLimit: false,
				blocking: [],
				clears: ["anthropic:7d"],
				usedFractions: { "anthropic:7d": 0.4 },
			},
		});
		const plan = planClaudeResetRedemptions(
			input({ trigger: "sweep", reports: [report({ weeklyUsed: 0.4 })], statuses: [early] }),
		);
		expect(plan.actions).toMatchObject([
			{
				reason: "expiring-credit",
				target: { provider: "anthropic", credentialId: 11, creditId: "cedar-1", orgId: "org-a" },
				salvageWindow: "anthropic:7d",
				salvageUsedFraction: 0.4,
				requiresLimit: false,
			},
		]);

		const mostlyFree = planClaudeResetRedemptions(
			input({
				trigger: "sweep",
				reports: [report({ weeklyUsed: 0.1 })],
				statuses: [status({ credit: { ...early.credits[0]!, usedFractions: { "anthropic:7d": 0.1 } } })],
			}),
		);
		expect(mostlyFree.actions).toEqual([]);
		expect(mostlyFree.skipped[0]?.reason).toBe("window-mostly-free");
	});

	it("requires actual exhaustion before salvaging a limit-gated Cedar grant", () => {
		const partial = status({
			credit: {
				requiresLimit: true,
				blocking: [],
				clears: ["anthropic:7d"],
				usedFractions: { "anthropic:7d": 0.8 },
			},
		});
		const plan = planClaudeResetRedemptions(
			input({ trigger: "sweep", reports: [report({ weeklyUsed: 0.8 })], statuses: [partial] }),
		);
		expect(plan.actions).toEqual([]);
		expect(plan.skipped[0]?.reason).toBe("no-blocked-window");
	});

	it("keeps same-email organizations and their attempt keys independent", () => {
		const firstStatus = status({ credentialId: 11, orgId: "org-a", active: true });
		const secondStatus = status({
			credentialId: 22,
			orgId: "org-b",
			active: false,
			credit: { id: "cedar-2" },
		});
		const plan = planClaudeResetRedemptions(
			input({
				trigger: "sweep",
				reports: [report({ orgId: "org-a" }), report({ orgId: "org-b" })],
				statuses: [firstStatus, secondStatus],
			}),
		);
		expect(plan.actions.map(action => action.accountKey)).toEqual(["anthropic|org-a|11", "anthropic|org-b|22"]);
		expect(new Set(plan.actions.map(action => action.attemptKey)).size).toBe(2);
		expect(plan.actions.map(action => action.target.credentialId)).toEqual([11, 22]);
	});
});

describe("claudeResetStatusesFromReports", () => {
	const legacy: OAuthAccountSummary = { position: 0, credentialId: 11, email: "user@example.com", active: true };
	const early = status({
		credit: { requiresLimit: false, blocking: [], clears: ["anthropic:7d"], usedFractions: { "anthropic:7d": 0.4 } },
	});

	function withInventory(usage: UsageReport): UsageReport {
		const { availableCount, redeemableCount, eligible, nextCreditId, credits } = early;
		return { ...usage, resetCredits: { availableCount, redeemableCount, eligible, nextCreditId, credits } };
	}

	it("finds a candidate for a credential stored without its organization under the one discovery stamped on its report", () => {
		const reports = [withInventory(report({ orgId: "org-a", weeklyUsed: 0.4 }))];
		const statuses = claudeResetStatusesFromReports([legacy], reports);
		const plan = planClaudeResetRedemptions(input({ trigger: "sweep", reports, statuses }));
		expect(plan.actions).toMatchObject([
			{
				reason: "expiring-credit",
				accountKey: "anthropic|org-a|11",
				target: { provider: "anthropic", credentialId: 11, creditId: "cedar-1", orgId: "org-a" },
			},
		]);
	});

	it("never hands a credential stored without its organization the report of a stored credential for the same account", () => {
		const sibling: OAuthAccountSummary = { ...legacy, position: 1, credentialId: 22, orgId: "org-a", active: false };
		const reports = [withInventory(report({ orgId: "org-a", weeklyUsed: 0.4 }))];
		const statuses = claudeResetStatusesFromReports([legacy, sibling], reports);
		const plan = planClaudeResetRedemptions(input({ trigger: "sweep", reports, statuses }));
		expect(plan.actions.map(action => action.target.credentialId)).toEqual([22]);
		expect(plan.skipped).toContainEqual({ accountKey: "anthropic|-|11", rule: "account", reason: "credits-unknown" });
	});

	it("keeps a credential stored without its organization apart from another member of that organization", () => {
		const member: OAuthAccountSummary = {
			position: 1,
			credentialId: 22,
			email: "member@example.com",
			orgId: "org-a",
			active: false,
		};
		const reports = [
			withInventory(report({ orgId: "org-a", weeklyUsed: 0.4 })),
			withInventory(report({ orgId: "org-a", email: "member@example.com", weeklyUsed: 0.4 })),
		];
		const statuses = claudeResetStatusesFromReports([legacy, member], reports);
		const plan = planClaudeResetRedemptions(input({ trigger: "sweep", reports, statuses }));
		expect(plan.actions.map(action => action.accountKey)).toEqual(["anthropic|org-a|11", "anthropic|org-a|22"]);
	});
});
