import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	AuthStorage,
	type OAuthCredential,
	SqliteAuthCredentialStore,
	type UsageReport,
	type UsageResetCredit,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir, withFileLock } from "@oh-my-pi/pi-utils";
import {
	buildRedactionMap,
	collectHistoryIdentityStrings,
	computeProviderWindowStats,
	formatUsageBreakdown,
	formatUsageHistory,
	runUsageCommand,
	type UsagePolicyDiagnosticsOptions,
	type UsageResetExpiryOptions,
} from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { resetAccountLockKey } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { formatResetExpiryNotice } from "@oh-my-pi/pi-coding-agent/session/reset-expiry";
import { resetLockPath } from "@oh-my-pi/pi-coding-agent/session/reset-fence";
import {
	collectUnreportedAccounts,
	type UsageAccountIdentity,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-accounts";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

function makeLimit(opts: {
	id: string;
	label?: string;
	usedFraction: number;
	durationMs?: number;
	windowId?: string;
	tier?: string;
	accountId?: string;
	provider?: string;
	notes?: string[];
	shared?: boolean;
	sharedGroup?: string;
	status?: UsageReport["limits"][number]["status"];
}): UsageReport["limits"][number] {
	return {
		id: opts.id,
		label: opts.label ?? opts.id,
		scope: {
			provider: opts.provider ?? "anthropic",
			windowId: opts.windowId,
			tier: opts.tier,
			accountId: opts.accountId,
			...(opts.shared !== undefined ? { shared: opts.shared } : {}),
			...(opts.sharedGroup !== undefined ? { shared: true, sharedGroup: opts.sharedGroup } : {}),
		},
		window:
			opts.durationMs !== undefined
				? { id: opts.windowId ?? opts.id, label: opts.windowId ?? opts.id, durationMs: opts.durationMs }
				: undefined,
		amount: { unit: "percent", usedFraction: opts.usedFraction },
		...(opts.notes ? { notes: opts.notes } : {}),
		...(opts.status ? { status: opts.status } : {}),
	};
}

function makeReport(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, ...(notes ? { notes } : {}), metadata: { email } };
}

function codexResetReport(opts: {
	nowMs: number;
	accountId: string;
	email?: string;
	weeklyUsed: number;
	expiresInMs: number[];
}): UsageReport {
	return {
		provider: "openai-codex",
		fetchedAt: opts.nowMs,
		limits: [
			makeLimit({
				id: "openai-codex:primary",
				label: "5 hours",
				provider: "openai-codex",
				usedFraction: 0.1,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "openai-codex:secondary",
				label: "7 days",
				provider: "openai-codex",
				usedFraction: opts.weeklyUsed,
				durationMs: SEVEN_DAYS,
				windowId: "7d",
			}),
		],
		metadata: {
			email: opts.email ?? "codex@example.test",
			accountId: opts.accountId,
			orgId: opts.accountId,
			planType: "team",
		},
		resetCredits: {
			availableCount: opts.expiresInMs.length,
			credits: opts.expiresInMs.map(ms => ({
				expiresAt: new Date(opts.nowMs + ms).toISOString(),
				status: "available",
			})),
		},
	};
}

/** A Cedar grant clearing the 5h and weekly windows, spendable now unless overridden. */
function cedarGrant(
	nowMs: number,
	id: string,
	expiresInMs: number,
	overrides: Partial<UsageResetCredit> = {},
): UsageResetCredit {
	return {
		id,
		program: "cedar_ember",
		remainingCount: 1,
		usable: true,
		requiresLimit: false,
		clears: ["anthropic:5h", "anthropic:7d"],
		blocking: [],
		usedFractions: {},
		expiresAt: new Date(nowMs + expiresInMs).toISOString(),
		status: "available",
		...overrides,
	};
}

/** Claude usage whose first grant is the server-selected one; every grant's remaining resets count as banked. */
function claudeResetReport(nowMs: number, usage: Record<string, number>, grants: UsageResetCredit[]): UsageReport {
	const selected = grants[0];
	return {
		provider: "anthropic",
		fetchedAt: nowMs,
		limits: Object.entries(usage).map(([id, usedFraction]) =>
			makeLimit({ id, label: id, usedFraction, durationMs: id === "anthropic:5h" ? FIVE_HOURS : SEVEN_DAYS }),
		),
		metadata: { email: "claude@example.test", accountId: "claude-account", orgId: "claude-org" },
		resetCredits: {
			availableCount: grants.reduce((sum, grant) => sum + (grant.remainingCount ?? 0), 0),
			redeemableCount: selected?.usable ? (selected.remainingCount ?? 0) : 0,
			nextCreditId: selected?.id,
			eligible: true,
			credits: grants,
		},
	};
}

function resetExpiryOptions(overrides: Record<string, unknown> = {}): UsageResetExpiryOptions {
	return { settings: Settings.isolated(overrides), accounts: () => [] };
}

describe("buildRedactionMap", () => {
	it("masks everything past a two-char anchor when the anchor is unique", () => {
		const map = buildRedactionMap(["alpha@example.test", "bravo@example.test"]);
		expect(map.get("alpha@example.test")).toBe("al*");
		expect(map.get("bravo@example.test")).toBe("br*");
	});

	it("reveals a minimal middle-out differentiator instead of growing the prefix", () => {
		const values = ["dum.my@example.org", "dum.my9@example.net", "dummy@example.net"];
		const map = buildRedactionMap(values);
		const masks = values.map(value => map.get(value)!);
		// Masks must be pairwise distinct so accounts stay tellable-apart.
		expect(new Set(masks).size).toBe(masks.length);
		for (const mask of masks) {
			// Never leak the whole local part the way prefix growth would ("dummy@*").
			expect(mask).not.toContain("dummy");
			// anchor + at most a two-char differentiator.
			expect(mask).toMatch(/^du\*(.{1,2}\*)?$/);
		}
		// The "89" account is distinguished by a digit only it contains.
		expect(map.get("dum.my9@example.net")).toBe("du*9*");
	});

	it("gives duplicate identities the same mask", () => {
		const map = buildRedactionMap(["user@example.test", "user@example.test"]);
		expect(map.size).toBe(1);
		expect(map.get("user@example.test")).toBe("us*");
	});
});

describe("computeProviderWindowStats", () => {
	it("buckets by window duration, binds each account to its worst limit, and reports remaining capacity", () => {
		const reports = [
			makeReport("anthropic", "account-a@example.test", [
				makeLimit({ id: "5h", usedFraction: 0.9, durationMs: FIVE_HOURS, windowId: "5h" }),
				makeLimit({ id: "7d", usedFraction: 0.1, durationMs: SEVEN_DAYS, windowId: "7d" }),
				// A model-scoped cap on the same window holds its own pool: it must not be read as
				// the umbrella window's burn, and the umbrella must not hide it either.
				makeLimit({ id: "7d-opus", usedFraction: 0.4, durationMs: SEVEN_DAYS, windowId: "7d", tier: "opus" }),
			]),
			makeReport("anthropic", "account-b@example.test", [
				makeLimit({ id: "5h", usedFraction: 0.4, durationMs: FIVE_HOURS, windowId: "5h" }),
				makeLimit({ id: "7d", usedFraction: 0.2, durationMs: SEVEN_DAYS, windowId: "7d" }),
			]),
		];
		const stats = computeProviderWindowStats(reports);
		expect(stats.map(stat => [stat.window, stat.meter])).toEqual([
			["5h", undefined],
			["7d", undefined],
			["7d", "opus"],
		]);
		const [fiveHour, sevenDay, scoped] = stats;
		// Sorted shortest window first, then by meter.
		expect(fiveHour.accounts).toBe(2);
		expect(fiveHour.usedAccounts).toBeCloseTo(1.3);
		expect(fiveHour.remainingAccounts).toBeCloseTo(0.7);
		expect(sevenDay.accounts).toBe(2);
		expect(sevenDay.usedAccounts).toBeCloseTo(0.3);
		expect(sevenDay.remainingAccounts).toBeCloseTo(1.7);
		expect(scoped.accounts).toBe(1);
		expect(scoped.usedAccounts).toBeCloseTo(0.4);
		expect(scoped.remainingAccounts).toBeCloseTo(0.6);
	});

	it("keeps a spent model-scoped cap visible next to the shared window it caps", () => {
		// Anthropic reports the umbrella weekly window as shared and the Fable cap as a tier with
		// no shared flag, so a spent Fable cap must not read as a partly-spent weekly window.
		const report = makeReport("anthropic", "scoped@example.test", [
			makeLimit({ id: "anthropic:7d", usedFraction: 0.51, durationMs: SEVEN_DAYS, windowId: "7d", shared: true }),
			makeLimit({
				id: "anthropic:7d:fable",
				usedFraction: 1,
				durationMs: SEVEN_DAYS,
				windowId: "7d",
				tier: "fable",
			}),
		]);
		const stats = computeProviderWindowStats([report]);
		expect(stats.map(stat => [stat.window, stat.meter, stat.usedAccounts, stat.remainingAccounts])).toEqual([
			["7d", undefined, 0.51, 0.49],
			["7d", "fable", 1, 0],
		]);

		const text = stripVTControlCharacters(formatUsageBreakdown([report], [], Date.now()));
		expect(text).toContain("7d → 0.51/1");
		expect(text).toContain("7d (Fable) → 1.00/1");
	});

	it("does not meter routing copies of one shared upstream pool", () => {
		// Antigravity reports one third-party pool once per model family; the shared group keeps
		// them one pool with the worst fraction binding, not one meter per copy.
		const report = makeReport("google-antigravity", "shared@example.test", [
			makeLimit({
				id: "google-antigravity:anthropic:default:5h",
				label: "Claude & GPT (shared)",
				provider: "google-antigravity",
				usedFraction: 0.4,
				durationMs: FIVE_HOURS,
				windowId: "5h",
				sharedGroup: "third-party:5h",
			}),
			makeLimit({
				id: "google-antigravity:openai:default:5h",
				label: "Claude & GPT (shared)",
				provider: "google-antigravity",
				usedFraction: 0.7,
				durationMs: FIVE_HOURS,
				windowId: "5h",
				sharedGroup: "third-party:5h",
			}),
		]);
		const stats = computeProviderWindowStats([report]);
		expect(stats.map(stat => [stat.window, stat.meter])).toEqual([["5h", undefined]]);
		expect(stats[0].accounts).toBe(1);
		expect(stats[0].usedAccounts).toBeCloseTo(0.7);
		expect(stats[0].remainingAccounts).toBeCloseTo(0.3);
	});

	it("does not split one window by subscription plan", () => {
		// Copilot, Devin, and Muse Code carry the plan name in `scope.tier`; accounts on different
		// plans still burn the same window, so they stay one capacity bucket.
		const monthly = 30 * 24 * HOUR;
		const reports = [
			makeReport("github-copilot", "individual@example.test", [
				makeLimit({
					id: "copilot:premium",
					provider: "github-copilot",
					tier: "individual",
					usedFraction: 0.3,
					durationMs: monthly,
					windowId: "monthly",
				}),
			]),
			makeReport("github-copilot", "business@example.test", [
				makeLimit({
					id: "copilot:premium",
					provider: "github-copilot",
					tier: "business",
					usedFraction: 0.5,
					durationMs: monthly,
					windowId: "monthly",
				}),
			]),
		];
		const stats = computeProviderWindowStats(reports);
		expect(stats.map(stat => [stat.window, stat.meter, stat.accounts])).toEqual([["30d", undefined, 2]]);
		expect(stats[0].usedAccounts).toBeCloseTo(0.8);
		expect(stats[0].remainingAccounts).toBeCloseTo(1.2);
	});

	it("reports Spark-only capacity instead of dropping the meter", () => {
		const report = makeReport("openai-codex", "spark@example.test", [
			makeLimit({
				id: "openai-codex:spark:primary",
				provider: "openai-codex",
				tier: "spark",
				usedFraction: 0.75,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "openai-codex:spark:secondary",
				provider: "openai-codex",
				tier: "spark",
				usedFraction: 0.25,
				durationMs: SEVEN_DAYS,
				windowId: "7d",
			}),
		]);
		const stats = computeProviderWindowStats([report]);
		expect(stats.map(stat => [stat.window, stat.meter])).toEqual([
			["5h", "spark"],
			["7d", "spark"],
		]);
		expect(stats[0]).toMatchObject({ accounts: 1, usedAccounts: 0.75, remainingAccounts: 0.25 });
	});

	it("keeps mixed Codex meters separate when they share a window duration", () => {
		const report = makeReport("openai-codex", "mixed@example.test", [
			makeLimit({
				id: "openai-codex:primary",
				provider: "openai-codex",
				usedFraction: 0.2,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "openai-codex:secondary",
				provider: "openai-codex",
				usedFraction: 0.4,
				durationMs: SEVEN_DAYS,
				windowId: "7d",
			}),
			makeLimit({
				id: "openai-codex:spark:primary",
				provider: "openai-codex",
				tier: "spark",
				usedFraction: 0.8,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "openai-codex:spark:secondary",
				provider: "openai-codex",
				tier: "spark",
				usedFraction: 0.1,
				durationMs: SEVEN_DAYS,
				windowId: "7d",
			}),
		]);
		const stats = computeProviderWindowStats([report]);
		expect(stats.map(stat => [stat.window, stat.meter])).toEqual([
			["5h", "chat"],
			["5h", "spark"],
			["7d", "chat"],
			["7d", "spark"],
		]);
		expect(stats.find(stat => stat.window === "5h" && stat.meter === "chat")?.usedAccounts).toBe(0.2);
		expect(stats.find(stat => stat.window === "5h" && stat.meter === "spark")?.usedAccounts).toBe(0.8);

		const text = stripVTControlCharacters(formatUsageBreakdown([report], [], Date.now()));
		expect(text).toContain("5h (Chat) → 0.20/1");
		expect(text).toContain("5h (Spark) → 0.80/1");
	});

	it("ignores limits without a resolvable fraction", () => {
		const reports = [
			makeReport("anthropic", "account-a@example.test", [
				{
					id: "mystery",
					label: "mystery",
					scope: { provider: "anthropic" },
					amount: { unit: "unknown" },
				},
			]),
		];
		expect(computeProviderWindowStats(reports)).toHaveLength(0);
	});
});

describe("collectUnreportedAccounts", () => {
	const accounts: UsageAccountIdentity[] = [
		{ provider: "anthropic", type: "oauth", email: "seen@example.test" },
		{ provider: "anthropic", type: "oauth", email: "missing@example.test" },
		{ provider: "anthropic", type: "api_key" },
		{ provider: "cerebras", type: "api_key" },
	];
	const reports = [makeReport("anthropic", "seen@example.test", [])];

	it("flags providers without reports and identified accounts missing from reports", () => {
		const unreported = collectUnreportedAccounts(reports, accounts);
		expect(unreported).toEqual([
			{ provider: "anthropic", type: "oauth", email: "missing@example.test" },
			{ provider: "cerebras", type: "api_key" },
		]);
	});

	it("does not claim unattributable credentials are missing when reports carry no identity", () => {
		const anonymous = [{ ...makeReport("anthropic", "seen@example.test", []), metadata: {} }];
		const unreported = collectUnreportedAccounts(anonymous, accounts);
		expect(unreported).toEqual([{ provider: "cerebras", type: "api_key" }]);
	});

	it("attributes org-decisively when either side carries an org", () => {
		const shared = "shared@example.test";
		const orgAccounts: UsageAccountIdentity[] = [
			{ provider: "anthropic", type: "oauth", email: shared, orgId: "org-team" },
			{ provider: "anthropic", type: "oauth", email: shared, orgId: "org-max" },
			{ provider: "anthropic", type: "oauth", email: shared },
		];
		const teamReport = {
			...makeReport("anthropic", shared, []),
			metadata: { email: shared, orgId: "org-team" },
		};
		// Only the Team org reported: Max and the org-less legacy row must both
		// surface as unreported despite the shared email.
		const unreported = collectUnreportedAccounts([teamReport], orgAccounts);
		expect(unreported).toEqual([
			{ provider: "anthropic", type: "oauth", email: shared, orgId: "org-max" },
			{ provider: "anthropic", type: "oauth", email: shared },
		]);
		// Both sides org-less: the email fallback still covers the account.
		const orglessReport = { ...makeReport("anthropic", shared, []), metadata: { email: shared } };
		const orglessAccounts: UsageAccountIdentity[] = [{ provider: "anthropic", type: "oauth", email: shared }];
		expect(collectUnreportedAccounts([orglessReport], orglessAccounts)).toEqual([]);
	});

	it("gates same-org coverage on the member's own identity", () => {
		const org = "org-team";
		const alice: UsageAccountIdentity = {
			provider: "anthropic",
			type: "oauth",
			email: "alice@example.test",
			accountId: "account-alice",
			orgId: org,
		};
		const bob: UsageAccountIdentity = {
			provider: "anthropic",
			type: "oauth",
			email: "bob@example.test",
			accountId: "account-bob",
			orgId: org,
		};
		const orgOnly: UsageAccountIdentity = { provider: "anthropic", type: "oauth", orgId: org };
		const aliceReport = {
			...makeReport("anthropic", alice.email!, []),
			metadata: { email: alice.email, accountId: alice.accountId, orgId: org },
		};
		// Alice reported, Bob not: the sibling's same-org report must not count
		// as Bob's coverage — two Team members share the org id but draw on
		// per-user pools. An org-only account (no base identifiers to gate on)
		// stays covered by any same-org report.
		expect(collectUnreportedAccounts([aliceReport], [alice, bob, orgOnly])).toEqual([bob]);
	});

	it("does not let one Antigravity account's report cover a sibling on the same Google project", () => {
		const project = "aicode-consumers";
		const alice: UsageAccountIdentity = {
			provider: "google-antigravity",
			type: "oauth",
			email: "alice@example.test",
			projectId: project,
		};
		const bob: UsageAccountIdentity = { ...alice, email: "bob@example.test" };
		const aliceReport = {
			...makeReport("google-antigravity", alice.email!, []),
			metadata: { email: alice.email, projectId: project },
		};
		expect(collectUnreportedAccounts([aliceReport], [alice, bob])).toEqual([bob]);
	});

	it("keeps an org-less account covered by its own org-less report when org-scoped siblings exist", () => {
		// Live incident shape: legacy org-less rows (pre-org-capture logins)
		// beside fresh org-scoped logins. Every account fetched successfully —
		// nobody may be duplicated into a "no usage data" row.
		const legacy: UsageAccountIdentity = {
			provider: "anthropic",
			type: "oauth",
			email: "legacy@example.test",
			accountId: "account-legacy",
		};
		const fresh: UsageAccountIdentity = {
			provider: "anthropic",
			type: "oauth",
			email: "fresh@example.test",
			accountId: "account-fresh",
			orgId: "org-fresh",
		};
		const legacyReport = {
			...makeReport("anthropic", legacy.email!, []),
			metadata: { email: legacy.email, accountId: legacy.accountId },
		};
		const freshReport = {
			...makeReport("anthropic", fresh.email!, []),
			metadata: { email: fresh.email, accountId: fresh.accountId, orgId: "org-fresh" },
		};
		expect(collectUnreportedAccounts([legacyReport, freshReport], [legacy, fresh])).toEqual([]);
		// The org-attributed sibling alone still does NOT cover the legacy row.
		expect(collectUnreportedAccounts([freshReport], [legacy, fresh])).toEqual([legacy]);
	});
});

describe("formatUsageBreakdown", () => {
	const reports = [
		makeReport("anthropic", "dummy.primary@example.test", [
			makeLimit({ id: "Claude 5 Hour", usedFraction: 0.84, durationMs: FIVE_HOURS, windowId: "5h" }),
		]),
		makeReport("anthropic", "dummy.secondary@example.test", [
			makeLimit({ id: "Claude 5 Hour", usedFraction: 0.5, durationMs: FIVE_HOURS, windowId: "5h" }),
		]),
	];
	const accounts: UsageAccountIdentity[] = [
		{ provider: "anthropic", type: "oauth", email: "dummy.primary@example.test" },
		{ provider: "anthropic", type: "oauth", email: "dummy.secondary@example.test" },
		{ provider: "cerebras", type: "api_key" },
	];

	it("renders used-only USD spend without fabricating quota data", () => {
		const spendReport = makeReport("anthropic", "spend@example.test", [
			{
				id: "anthropic:extra",
				label: "Claude Extra Usage",
				scope: { provider: "anthropic", windowId: "extra" },
				amount: { used: 123.45, unit: "usd" },
			},
		]);

		const text = stripVTControlCharacters(formatUsageBreakdown([spendReport], [], Date.now()));

		expect(text).toContain("$123.45 used");
		expect(text).not.toContain("no data");
		expect(text).not.toContain("%");
		expect(text).not.toContain("resets");
	});
	it("renders every account: reported ones with limits, credential-only ones as no-data rows", () => {
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, accounts, Date.now()));
		expect(text).toContain("dummy.primary@example.test");
		expect(text).toContain("84.0% used");
		expect(text).toContain("Cerebras");
		expect(text).toContain("API key — no usage data");
		expect(text).toContain("capacity: 5h → 1.34/2 accounts used (0.66× quota left)");
		expect(text).not.toContain("policy:");
	});

	it("shows an explicit priority and reserve override with the observed eligibility reason", () => {
		const report = makeReport("openai-codex", "protected@example.test", [
			makeLimit({
				id: "5h",
				provider: "openai-codex",
				usedFraction: 0.2,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
		]);
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 10,
			getAccountPolicy: (_provider, identity) =>
				identity.email === "protected@example.test"
					? {
							provider: "openai-codex",
							account: { email: "protected@example.test" },
							priority: 100,
							reservePct: 50,
						}
					: undefined,
		};

		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], Date.now(), undefined, [], policyOptions),
		);

		expect(text).toContain("policy: priority 100 · reserve 50% (override) · eligible · 80.0% left");
	});

	it("shows the inherited global reserve for an unconfigured sibling in a policy-enabled provider", () => {
		const reports = [
			makeReport("openai-codex", "preferred@example.test", [
				makeLimit({
					id: "5h",
					provider: "openai-codex",
					usedFraction: 0.2,
					durationMs: FIVE_HOURS,
					windowId: "5h",
				}),
			]),
			makeReport("openai-codex", "inherited@example.test", [
				makeLimit({
					id: "5h",
					provider: "openai-codex",
					usedFraction: 0.95,
					durationMs: FIVE_HOURS,
					windowId: "5h",
				}),
			]),
		];
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 10,
			getAccountPolicy: (_provider, identity) =>
				identity.email === "preferred@example.test"
					? {
							provider: "openai-codex",
							account: { email: "preferred@example.test" },
							priority: 20,
						}
					: undefined,
		};

		const text = stripVTControlCharacters(
			formatUsageBreakdown(reports, [], Date.now(), undefined, [], policyOptions),
		);
		const inheritedSection = text.slice(text.indexOf("inherited@example.test"));
		expect(inheritedSection).toContain("policy: priority 0 · reserve 10% (global) · inside reserve · 5.0% left");
	});

	it("reports an exhausted account as exhausted rather than inside a 0% reserve", () => {
		const report = makeReport("openai-codex", "team@example.test", [
			makeLimit({ id: "5h", provider: "openai-codex", usedFraction: 1, durationMs: FIVE_HOURS, windowId: "5h" }),
		]);
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 10,
			getAccountPolicy: () => ({
				provider: "openai-codex",
				account: { email: "team@example.test" },
				priority: 10,
				reservePct: 0,
			}),
		};

		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], Date.now(), undefined, [], policyOptions),
		);

		expect(text).toContain("policy: priority 10 · reserve 0% (override) · exhausted · 0.0% left");
	});

	it("reports an account sitting exactly on its reserve as inside reserve", () => {
		const reports = [
			makeReport("openai-codex", "boundary@example.test", [
				makeLimit({
					id: "5h",
					provider: "openai-codex",
					usedFraction: 0.7,
					durationMs: FIVE_HOURS,
					windowId: "5h",
				}),
			]),
		];
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 10,
			getAccountPolicy: () => ({
				provider: "openai-codex",
				account: { email: "boundary@example.test" },
				reservePct: 30,
			}),
		};

		const text = stripVTControlCharacters(
			formatUsageBreakdown(reports, [], Date.now(), undefined, [], policyOptions),
		);
		const policyLine = text.split("\n").find(line => line.includes("policy:"));
		expect(policyLine).toContain("· inside reserve ·");
		expect(policyLine).toContain("30.0% left");
	});

	it("reports a provider-flagged exhausted window as exhausted even with fractional quota left", () => {
		const report = makeReport("anthropic", "flagged@example.test", [
			makeLimit({ id: "5h", usedFraction: 0.995, durationMs: FIVE_HOURS, windowId: "5h", status: "exhausted" }),
		]);
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 0,
			getAccountPolicy: () => ({ provider: "anthropic", account: { email: "flagged@example.test" }, priority: 0 }),
		};

		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], Date.now(), undefined, [], policyOptions),
		);

		expect(text).toContain("policy: priority 0 · reserve 0% (global) · exhausted · 0.5% left");
	});

	it("marks reserve state unknown when a configured account has no transient usage report", () => {
		const accounts: UsageAccountIdentity[] = [
			{ provider: "anthropic", type: "oauth", email: "offline@example.test" },
		];
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: 10,
			getAccountPolicy: (_provider, identity) =>
				identity.email === "offline@example.test"
					? {
							provider: "anthropic",
							account: { email: "offline@example.test" },
							priority: -5,
							reservePct: 40,
						}
					: undefined,
		};

		const text = stripVTControlCharacters(
			formatUsageBreakdown([], accounts, Date.now(), undefined, [], policyOptions),
		);

		expect(text).toContain("offline@example.test — no usage data");
		expect(text).toContain("policy: priority -5 · reserve 40% (override) · reserve unknown");
	});

	it("shows the live Codex plan without exposing an ID for one account", () => {
		const codex = makeReport("openai-codex", "user@example.test", [
			makeLimit({ id: "7d", provider: "openai-codex", usedFraction: 0.81, durationMs: SEVEN_DAYS }),
		]);
		codex.metadata = { email: "user@example.test", orgId: "workspace-id", orgName: "free", planType: "prolite" };

		const text = stripVTControlCharacters(formatUsageBreakdown([codex], [], Date.now()));
		expect(text).toContain("user@example.test · plan: prolite");
		expect(text).not.toContain("workspace-id");
		expect(text).not.toContain(" · free");
	});

	it("qualifies colliding Codex emails but never falls back to the stale plan", () => {
		const reports = ["workspace-one", "workspace-two"].map((orgId, index) => ({
			...makeReport("openai-codex", "shared@example.test", [
				makeLimit({ id: "7d", provider: "openai-codex", usedFraction: 0.2, durationMs: SEVEN_DAYS }),
			]),
			metadata: {
				email: "shared@example.test",
				orgId,
				orgName: "free",
				...(index === 0 ? { planType: "prolite" } : {}),
			},
		}));
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));
		expect(text).toContain("shared@example.test · workspace-one · plan: prolite");
		expect(text).toContain("shared@example.test · workspace-two");
		expect(text).not.toContain(" · free");
	});

	it("keeps other providers' live plan tier in the account header", () => {
		const report = makeReport("devin", "user@example.test", []);
		report.metadata = { email: "user@example.test", planType: "team" };
		const text = stripVTControlCharacters(formatUsageBreakdown([report], [], Date.now()));
		expect(text).toContain("user@example.test · plan: team");
	});

	it("renders marked Antigravity shared quotas once per account", () => {
		const antigravity = makeReport("google-antigravity", "user@example.test", [
			makeLimit({
				id: "google-antigravity:google:default:gemini-5h",
				label: "Gemini",
				provider: "google-antigravity",
				usedFraction: 0.25,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "google-antigravity:google:default:gemini-weekly",
				label: "Gemini",
				provider: "google-antigravity",
				usedFraction: 0.25,
				durationMs: SEVEN_DAYS,
				windowId: "weekly",
			}),
			...(["5h", "weekly"] as const).flatMap((windowId, index) =>
				(["anthropic", "openai"] as const).map(counter =>
					makeLimit({
						id: `google-antigravity:${counter}:default:3p-${windowId}`,
						label: "Claude & GPT (shared)",
						provider: "google-antigravity",
						usedFraction: 0.25,
						durationMs: index === 0 ? FIVE_HOURS : SEVEN_DAYS,
						windowId,
						sharedGroup: `3p-${windowId}`,
					}),
				),
			),
		]);

		const text = stripVTControlCharacters(formatUsageBreakdown([antigravity], [], Date.now()));

		expect(text.match(/Claude & GPT \(shared\)/g)).toHaveLength(2);
		expect(text.match(/Gemini/g)).toHaveLength(2);
		expect(text).not.toContain("Usage (Anthropic)");
		expect(text).not.toContain("Usage (OpenAI)");
	});

	it("keeps near-exhausted capacity fractional instead of rounding it to an exact need", () => {
		const nearReports = [
			makeReport("anthropic", "near-a@example.test", [
				makeLimit({ id: "Claude 5 Hour", usedFraction: 1, durationMs: FIVE_HOURS, windowId: "5h" }),
			]),
			makeReport("anthropic", "near-b@example.test", [
				makeLimit({ id: "Claude 5 Hour", usedFraction: 0.99, durationMs: FIVE_HOURS, windowId: "5h" }),
			]),
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(nearReports, [], Date.now()));
		expect(text).toContain("capacity: 5h → 1.99/2 accounts used (0.01× quota left)");
		expect(text).not.toContain("need:");
	});

	it("marks sibling provider limits that an account did not report", () => {
		const providerReports = [
			makeReport("anthropic", "account-a@example.test", [
				makeLimit({ id: "Claude 5 Hour", usedFraction: 0.2, durationMs: FIVE_HOURS, windowId: "5 Hour" }),
				makeLimit({ id: "Claude 7 Day", usedFraction: 0.4, durationMs: SEVEN_DAYS, windowId: "7 Day" }),
			]),
			makeReport("anthropic", "account-b@example.test", [
				makeLimit({ id: "Claude 5 Hour", usedFraction: 0.3, durationMs: FIVE_HOURS, windowId: "5 Hour" }),
				makeLimit({ id: "Claude 7 Day", usedFraction: 0.5, durationMs: SEVEN_DAYS, windowId: "7 Day" }),
				makeLimit({
					id: "Claude 7 Day (Fable)",
					usedFraction: 0.6,
					durationMs: SEVEN_DAYS,
					windowId: "7 Day (Fable)",
				}),
			]),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(providerReports, [], Date.now()));

		const accountAStart = text.indexOf("account-a@example.test");
		const accountBStart = text.indexOf("account-b@example.test");
		expect(text).toContain("Anthropic");
		expect(accountAStart).toBeGreaterThan(-1);
		expect(accountBStart).toBeGreaterThan(accountAStart);

		const accountASection = text.slice(accountAStart, accountBStart);
		const accountBSection = text.slice(accountBStart);
		expect(accountASection).toContain("Claude 7 Day (Fable)");
		expect(accountASection).toContain("not reported");
		expect(accountBSection).toContain("Claude 7 Day (Fable)");
		expect(accountBSection).toContain("60.0% used");
	});

	it("aligns rows by window when accounts report the same window under different limit ids", () => {
		// A Codex account without a 5-hour window reports its 7-day one as `primary`.
		const codexLimit = (key: "primary" | "secondary", window: "5 hours" | "7 days", usedFraction: number) =>
			makeLimit({
				id: `openai-codex:${key}`,
				label: window,
				provider: "openai-codex",
				usedFraction,
				durationMs: window === "5 hours" ? FIVE_HOURS : SEVEN_DAYS,
				windowId: window,
			});
		const providerReports = [
			makeReport("openai-codex", "weekly-only@example.test", [codexLimit("primary", "7 days", 0.07)]),
			makeReport("openai-codex", "both-windows@example.test", [
				codexLimit("primary", "5 hours", 1),
				codexLimit("secondary", "7 days", 0.16),
			]),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(providerReports, [], Date.now()));
		const limitRows = text
			.split("\n")
			.map(line =>
				line
					.trim()
					.replace(/\s+[█░·]+\s+/, " ")
					.replace(/\s+/g, " "),
			)
			.filter(line => /^[●○] /.test(line) && !line.includes("@"));
		expect(limitRows).toEqual([
			// weekly-only@example.test
			"○ 5 hours not reported",
			"● 7 days 7.0% used",
			// both-windows@example.test
			"● 5 hours 100.0% used",
			"● 7 days 16.0% used",
		]);
	});

	it("keeps one row per window for accounts on different plans", () => {
		const dailyQuota = (tier: string, usedFraction: number) => ({
			...makeLimit({ id: "devin:quota:daily", label: "Daily Quota", provider: "devin", usedFraction }),
			window: { id: "1d", label: "Daily Quota", durationMs: 24 * HOUR },
			scope: { provider: "devin", windowId: "1d", tier },
		});
		const providerReports = [
			makeReport("devin", "free@example.test", [dailyQuota("Free", 0.1)]),
			makeReport("devin", "pro@example.test", [dailyQuota("Pro", 0.2)]),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(providerReports, [], Date.now()));
		expect(text).toContain("Daily Quota (Free)");
		expect(text).toContain("Daily Quota (Pro)");
		expect(text).not.toContain("not reported");
	});

	it("keeps one row per tier when a report repeats a meter per tier in the same window", () => {
		const tierUsage = (tier: string, usedFraction: number) => ({
			...makeLimit({ id: `antigravity:${tier}`, label: "Usage", provider: "google-antigravity", usedFraction }),
			window: { id: "5h", label: "5 hours", durationMs: FIVE_HOURS },
			scope: { provider: "google-antigravity", windowId: "5h", tier },
		});
		const providerReports = [
			makeReport("google-antigravity", "both@example.test", [tierUsage("Pro", 0.1), tierUsage("Longer Tier", 0.2)]),
			makeReport("google-antigravity", "one@example.test", [tierUsage("Longer Tier", 0.3)]),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(providerReports, [], Date.now()));
		const rows = text.split("\n").filter(line => /^\s+[●○] /.test(line) && !line.includes("@"));
		expect(
			rows.map(line =>
				line
					.trim()
					.replace(/\s+[█░·]+\s+/, " ")
					.replace(/\s+/g, " "),
			),
		).toEqual([
			"● Usage (Pro) (5 hours) 10.0% used",
			"● Usage (Longer Tier) (5 hours) 20.0% used",
			"○ Usage (Pro) (5 hours) not reported",
			"● Usage (Longer Tier) (5 hours) 30.0% used",
		]);
		// Bars start in the same column on every row.
		expect(new Set(rows.map(line => line.search(/[█░·]/))).size).toBe(1);
	});

	it("redacts account labels through the provided map without leaking the originals", () => {
		const redaction = buildRedactionMap(["dummy.primary@example.test", "dummy.secondary@example.test"]);
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, accounts, Date.now(), redaction));
		expect(text).not.toContain("dummy.primary@example.test");
		expect(text).not.toContain("dummy.secondary@example.test");
		for (const mask of redaction.values()) expect(text).toContain(mask);
	});

	it("renders auto-disabled tombstones with the upstream error_description and hides lifecycle noise", () => {
		const now = Date.now();
		const disabled = [
			{
				id: 26,
				provider: "anthropic",
				type: "oauth" as const,
				email: "dead@example.test",
				cause: 'oauth refresh failed: OAuthError: refresh request failed; body={"error": "invalid_grant", "error_description": "Refresh token expired"}',
				disabledAtMs: now - 4 * HOUR,
			},
			{
				id: 27,
				provider: "anthropic",
				type: "oauth" as const,
				email: "rotated@example.test",
				cause: "replaced by newer credential",
			},
			{
				id: 28,
				provider: "fireworks",
				type: "api_key" as const,
				cause: "oauth refresh failed: whatever",
			},
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, accounts, now, undefined, disabled));
		// Auto-disabled OAuth row: identity, age, shortened upstream cause, and the fix.
		expect(text).toContain("✗ dead@example.test — disabled 4h ago: Refresh token expired (re-login to restore)");
		// User-driven replacement and api_key tombstones are lifecycle noise, not lost capacity.
		expect(text).not.toContain("rotated@example.test");
		expect(text).not.toContain("Fireworks");
	});
	it("suppresses auto-disabled tombstones when an active account exists with the same identity", () => {
		const now = Date.now();
		const activeAccounts: UsageAccountIdentity[] = [
			{
				provider: "anthropic",
				type: "oauth",
				email: "active@example.test",
			},
		];
		const disabled = [
			{
				id: 30,
				provider: "anthropic",
				type: "oauth" as const,
				email: "active@example.test",
				cause: "oauth refresh failed: Refresh token expired",
			},
			{
				id: 31,
				provider: "anthropic",
				type: "oauth" as const,
				email: "truly-dead@example.test",
				cause: "oauth refresh failed: Refresh token expired",
			},
		];
		const text = stripVTControlCharacters(formatUsageBreakdown([], activeAccounts, now, undefined, disabled));
		expect(text).not.toContain("active@example.test — disabled");
		expect(text).toContain("✗ truly-dead@example.test — disabled");
	});

	it("renders a tombstone-only provider section even when no active credential remains", () => {
		const disabled = [
			{
				id: 50,
				provider: "anthropic",
				type: "oauth" as const,
				email: "last@example.test",
				cause: "oauth refresh failed: token endpoint said no",
			},
		];
		const text = stripVTControlCharacters(formatUsageBreakdown([], [], Date.now(), undefined, disabled));
		expect(text).toContain("Anthropic");
		expect(text).toContain("✗ last@example.test — disabled: token endpoint said no (re-login to restore)");
	});

	it("warns about Anthropic's ~30d grant lifetime only inside the final week", () => {
		const now = Date.now();
		const DAY = 24 * HOUR;
		const withAge = (email: string, ageDays: number): UsageAccountIdentity => ({
			provider: "anthropic",
			type: "oauth",
			email,
			authorizedAt: now - ageDays * DAY,
		});
		const text = stripVTControlCharacters(
			formatUsageBreakdown(
				[],
				[withAge("fresh@example.test", 10), withAge("closing@example.test", 27), withAge("dead@example.test", 31)],
				now,
			),
		);
		// 10d-old grant: no countdown noise.
		expect(text).not.toContain("fresh@example.test — re-login");
		// 27d-old grant: 3 days left.
		expect(text).toContain("⚠ closing@example.test — re-login within 3d");
		// Past the lifetime: hard warning.
		expect(text).toContain("⚠ dead@example.test — grant is past Anthropic's ~30d lifetime; re-login now");
	});

	it("renders provider-level notes once per provider, not duplicated per account or limit", () => {
		const providerNote = "Usage data can be delayed by up to five minutes.";
		const multiAccount = [
			makeReport(
				"anthropic",
				"acct-a@example.test",
				[makeLimit({ id: "5 Hour", usedFraction: 0.3, durationMs: FIVE_HOURS, windowId: "5h" })],
				[providerNote],
			),
			makeReport(
				"anthropic",
				"acct-b@example.test",
				[makeLimit({ id: "5 Hour", usedFraction: 0.6, durationMs: FIVE_HOURS, windowId: "5h" })],
				[providerNote],
			),
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(multiAccount, [], Date.now()));
		// The provider note appears exactly once, not once per account or limit.
		const occurrences = text.split(providerNote).length - 1;
		expect(occurrences).toBe(1);
		// It appears above the per-account rows, not inline with a limit line.
		const noteIdx = text.indexOf(providerNote);
		const firstLimitIdx = text.indexOf("5 Hour");
		expect(noteIdx).toBeLessThan(firstLimitIdx);
	});

	it("renders Antigravity weekly windows in the usage breakdown", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports: UsageReport[] = [
			{
				provider: "google-antigravity",
				fetchedAt: now,
				metadata: { email: "ag@example.test", projectId: "proj-1" },
				limits: [
					{
						id: "google-antigravity:google:default:weekly",
						label: "Usage (Google)",
						scope: { provider: "google-antigravity", projectId: "proj-1", windowId: "weekly" },
						window: {
							id: "weekly",
							label: "Weekly",
							durationMs: SEVEN_DAYS,
							resetsAt: now + SEVEN_DAYS,
						},
						amount: { unit: "percent", usedFraction: 0.6, remainingFraction: 0.4 },
						status: "ok",
					},
				],
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).toContain("Google Antigravity");
		expect(text).toContain("Usage (Google) (Weekly)");
		expect(text).toContain("60.0% used");
		expect(text).toContain("0.40× quota left");
	});

	it("renders Cursor request quotas in the usage breakdown", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				metadata: { email: "cursor@example.test" },
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: {
							id: "monthly",
							label: "Monthly",
							resetsAt: Date.parse("2026-02-01T00:00:00.000Z"),
						},
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).toContain("Cursor");
		expect(text).toContain("gpt-4 requests");
		expect(text).toContain("150 / 500 requests");
		expect(text).toContain("30.0% used");
		expect(text).toContain("resets in 31d");
	});
	it("renders saved reset expiry state for future and expired credits", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "future@example.test" },
				resetCredits: {
					availableCount: 1,
					credits: [{ expiresAt: "2026-01-03T00:00:00.000Z" }],
				},
			},
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "expired@example.test" },
				resetCredits: {
					availableCount: 1,
					credits: [{ expiresAt: "2025-12-30T00:00:00.000Z" }],
				},
			},
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { email: "claude@example.test" },
				resetCredits: {
					availableCount: 3,
					redeemableCount: 0,
					reason: "weekly cooldown",
					credits: [
						{
							id: "cedar",
							title: "Claude reset",
							program: "cedar_ember",
							remainingCount: 3,
							usable: false,
							requiresLimit: true,
							clears: ["anthropic:5h", "anthropic:7d"],
							blocking: [],
							usedFractions: {},
							expiresAt: "2026-01-04T00:00:00.000Z",
						},
					],
				},
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).toContain("future@example.test");
		expect(text).toContain("soonest expires in 2d (2026-01-03)");
		expect(text).toContain("expired@example.test");
		expect(text).toContain("expired (2025-12-30)");
		expect(text).toContain("claude@example.test");
		expect(text).toContain("3 saved resets");
		expect(text).toContain("0 usable now");
		expect(text).toContain("unavailable: weekly cooldown");
	});

	it.each([
		{ name: "highlights a reset exactly 7 days out", expiresInMs: SEVEN_DAYS, used: 0.5, tier: "soon", due: "7d" },
		{ name: "keeps a reset just past 7 days plain", expiresInMs: SEVEN_DAYS + 60_000, used: 0.5, due: "7d" },
		{
			name: "raises the banner exactly 24 hours out",
			expiresInMs: 24 * HOUR,
			used: 0.5,
			tier: "imminent",
			due: "1d",
		},
		{
			name: "only highlights a reset just past 24 hours",
			expiresInMs: 24 * HOUR + 60_000,
			used: 0.5,
			tier: "soon",
			due: "1d",
		},
		{ name: "escalates an account at 25% used", expiresInMs: 6 * HOUR, used: 0.25, tier: "imminent", due: "6h" },
		{ name: "keeps an account below 25% used plain", expiresInMs: 6 * HOUR, used: 0.24, due: "6h" },
	])("$name", ({ expiresInMs, used, tier, due }) => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const report = codexResetReport({
			nowMs: now,
			accountId: "ws-team",
			weeklyUsed: used,
			expiresInMs: [expiresInMs],
		});
		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], now, undefined, [], undefined, resetExpiryOptions()),
		);
		const date = new Date(now + expiresInMs).toISOString().slice(0, 10);
		if (tier === undefined) {
			expect(text).toContain(`soonest expires in ${due} (${date})`);
			expect(text).not.toContain("▲");
		} else if (tier === "soon") {
			expect(text).toContain(`▲ 1 expires in ${due} (${date})`);
			expect(text).not.toContain("within 24h");
		} else {
			expect(text).toContain(`▲ 1 expires in ${due}`);
			expect(text).not.toContain(`▲ 1 expires in ${due} (`);
			expect(text).toContain("▲ 1 saved reset expires within 24h");
			expect(text).toContain(`7 days (7d) ${Math.round(used * 100)}% used`);
		}
	});

	it("measures a Claude grant only against the windows it clears", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		// The Opus weekly cap is nearly spent, but this grant does not clear it.
		const report = claudeResetReport(now, { "anthropic:5h": 0.1, "anthropic:7d": 0.2, "anthropic:7d:opus": 0.9 }, [
			cedarGrant(now, "cedar", 6 * HOUR),
		]);
		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], now, undefined, [], undefined, resetExpiryOptions()),
		);
		expect(text).toContain("soonest expires in 6h");
		expect(text).not.toContain("▲");
	});

	it("warns about a later Claude grant when the soonest one clears only a quiet window", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const report = claudeResetReport(now, { "anthropic:5h": 0.1, "anthropic:7d": 0.8 }, [
			cedarGrant(now, "juniper", 1 * HOUR, { program: "juniper_tide", clears: ["anthropic:5h"] }),
			cedarGrant(now, "cedar", 6 * HOUR, { clears: ["anthropic:7d"] }),
		]);
		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], now, undefined, [], undefined, resetExpiryOptions()),
		);
		expect(text).toContain("▲ 1 saved reset expires within 24h");
		expect(text).toContain("1 expires in 6h");
		expect(text).toContain("anthropic:7d 80% used");
	});

	it.each([
		{ name: "the account is not eligible", inventory: { eligible: false } },
		{ name: "nothing is redeemable", inventory: { redeemableCount: 0 } },
		{ name: "the server selected another grant", inventory: { nextCreditId: "other" } },
	])("offers no spend command when $name", ({ inventory }) => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const base = claudeResetReport(now, { "anthropic:5h": 0.6 }, [cedarGrant(now, "cedar", 6 * HOUR)]);
		const report = { ...base, resetCredits: { ...base.resetCredits!, ...inventory } };
		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], now, undefined, [], undefined, resetExpiryOptions()),
		);
		expect(text).toContain("▲ 1 saved reset expires within 24h");
		expect(text).not.toContain("/usage reset");
	});

	it("strips terminal controls and line breaks from the account in the TUI notice", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const base = claudeResetReport(now, { "anthropic:5h": 0.6 }, [cedarGrant(now, "cedar", 6 * HOUR)]);
		const report = { ...base, metadata: { email: "evil\u001b[2J\n\tname@example.test" } };
		const notice = formatResetExpiryNotice([report], now);
		expect(notice).toBe("Saved Claude reset on evil name@example.test expires in 6h · /usage");
	});

	it("does not count a later Claude grant that clears only a quiet window", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const report = claudeResetReport(now, { "anthropic:5h": 0.1, "anthropic:7d": 0.8 }, [
			cedarGrant(now, "cedar", 1 * HOUR, { clears: ["anthropic:7d"] }),
			cedarGrant(now, "juniper", 6 * HOUR, { program: "juniper_tide", clears: ["anthropic:5h"] }),
		]);
		const text = stripVTControlCharacters(
			formatUsageBreakdown([report], [], now, undefined, [], undefined, resetExpiryOptions()),
		);
		expect(text).toContain("▲ 1 saved reset expires within 24h");
		expect(text).toContain("1 expires in 1h");
	});

	it("cuts a long account in the TUI notice without splitting a character", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const base = claudeResetReport(now, { "anthropic:5h": 0.6 }, [cedarGrant(now, "cedar", 6 * HOUR)]);
		const report = { ...base, metadata: { email: `${"a".repeat(78)}😀😀@example.test` } };
		const notice = formatResetExpiryNotice([report], now)!;
		expect(notice.isWellFormed()).toBe(true);
		expect(notice).toContain("…");
		expect(notice).toEndWith(" expires in 6h · /usage");
	});

	it.each([
		{
			mode: "yes",
			verdict: "→ an open interactive omp session spends it by its last 5 min if eligible then",
			lost: false,
		},
		{ mode: "unset", verdict: "→ an open interactive omp session asks before spending it", lost: false },
		{ mode: "no", verdict: "→ not spent automatically", lost: true },
	])("says what codexResets.autoRedeem=$mode does with an expiring reset", ({ mode, verdict, lost }) => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const report = codexResetReport({ nowMs: now, accountId: "ws-team", weeklyUsed: 1, expiresInMs: [6 * HOUR] });
		const text = stripVTControlCharacters(
			formatUsageBreakdown(
				[report],
				[],
				now,
				undefined,
				[],
				undefined,
				resetExpiryOptions({ "codexResets.autoRedeem": mode }),
			),
		);
		expect(text).toContain(`${verdict}  (codexResets.autoRedeem: ${mode})\n`);
		expect(text.includes("within 24h and will be lost")).toBe(lost);
		expect(text).toContain(lost ? "spend it:  /usage reset" : "or now:  /usage reset");
	});

	it("decides each provider's expiring reset by its own setting", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports = [
			codexResetReport({ nowMs: now, accountId: "ws-team", weeklyUsed: 1, expiresInMs: [6 * HOUR] }),
			claudeResetReport(now, { "anthropic:5h": 0.1, "anthropic:7d": 0.6 }, [cedarGrant(now, "cedar", 3 * HOUR)]),
		];
		const options = resetExpiryOptions({ "codexResets.autoRedeem": "yes", "claudeResets.autoRedeem": "no" });
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now, undefined, [], undefined, options));
		expect(text).toContain("▲ 2 saved resets expire within 24h\n");
		expect(text).toContain("(codexResets.autoRedeem: yes)");
		expect(text).toContain("→ not spent automatically  (claudeResets.autoRedeem: no)");
	});

	it.each([
		{
			name: "an unavailable grant behind the selected one",
			grants: (now: number) => [
				cedarGrant(now, "selected", 20 * 24 * HOUR),
				cedarGrant(now, "behind", 6 * HOUR, { remainingCount: 2, usable: false, status: "unavailable" }),
			],
			header: "✦ 3 saved resets · 1 usable now · ▲ 2 expire, soonest in 6h",
			title: "▲ 2 saved resets expire within 24h\n",
			eligibleNow: false,
		},
		{
			name: "a paused grant",
			grants: (now: number) => [cedarGrant(now, "paused", 6 * HOUR, { usable: false, status: "paused" })],
			header: "✦ 1 saved reset · 0 usable now · ▲ 1 expires in 6h",
			title: "▲ 1 saved reset expires within 24h\n",
			eligibleNow: false,
		},
		{
			name: "the selected grant among several",
			grants: (now: number) => [
				cedarGrant(now, "selected", 6 * HOUR),
				cedarGrant(now, "next", 10 * HOUR, { usable: false, status: "unavailable" }),
				cedarGrant(now, "later", 30 * 24 * HOUR, { usable: false, status: "unavailable" }),
			],
			header: "✦ 3 saved resets · 1 usable now · ▲ 2 expire, soonest in 6h",
			title: "▲ 2 saved resets expire within 24h\n",
			eligibleNow: true,
		},
	])("counts $name among the expiring Claude resets", ({ grants, header, title, eligibleNow }) => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const report = claudeResetReport(now, { "anthropic:5h": 0.1, "anthropic:7d": 0.5 }, grants(now));
		const options = resetExpiryOptions({ "claudeResets.autoRedeem": "yes" });
		const text = stripVTControlCharacters(formatUsageBreakdown([report], [], now, undefined, [], undefined, options));
		expect(text).toContain(header);
		expect(text).toContain(title);
		expect(text).toContain(
			`→ an open interactive omp session spends it by its last 5 min if eligible then  (claudeResets.autoRedeem: yes)${eligibleNow ? "" : " · not eligible now"}\n`,
		);
		// Only a reset the provider lets omp spend now gets a command that spends it.
		expect(text.includes("/usage reset")).toBe(eligibleNow);
	});

	it.each<{
		name: string;
		usage: Record<string, number>;
		grant: Partial<UsageResetCredit>;
		fetchedAgoMs: number;
		eligibleNow: boolean;
	}>([
		{
			name: "keeps the spend conditional when the exhausted window that makes a grant usable may reset first",
			usage: { "anthropic:5h": 1, "anthropic:7d": 0.5 },
			grant: { requiresLimit: true },
			fetchedAgoMs: 0,
			eligibleNow: true,
		},
		{
			name: "marks a grant not eligible now, not lost, while a window it does not clear is exhausted",
			usage: { "anthropic:5h": 0.5, "anthropic:7d": 0.5, "anthropic:7d:sonnet": 1 },
			grant: {},
			fetchedAgoMs: 0,
			eligibleNow: false,
		},
		{
			name: "leaves eligibility unmarked on a report too old for the planner",
			usage: { "anthropic:5h": 0.5, "anthropic:7d": 0.5, "anthropic:7d:sonnet": 1 },
			grant: {},
			fetchedAgoMs: 20 * 60_000,
			eligibleNow: true,
		},
	])("$name", ({ usage, grant, fetchedAgoMs, eligibleNow }) => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const report = {
			...claudeResetReport(now, usage, [cedarGrant(now, "cedar", 6 * HOUR, grant)]),
			fetchedAt: now - fetchedAgoMs,
		};
		const options = resetExpiryOptions({
			"claudeResets.autoRedeem": "yes",
			"claudeResets.salvageHorizonHours": 0,
		});
		const text = stripVTControlCharacters(formatUsageBreakdown([report], [], now, undefined, [], undefined, options));
		const verdict =
			"→ an open interactive omp session spends it by its last 5 min if eligible then  (claudeResets.autoRedeem: yes)";
		expect(text).toContain(eligibleNow ? `${verdict}\n` : `${verdict} · not eligible now\n`);
		expect(text).not.toContain("will be lost");
		expect(text).toContain("or now:  /usage reset");
	});

	it("deduplicates identical per-limit notes across accounts sharing a window", () => {
		const note = "Overage requests: 5";
		const reports = [
			makeReport("github-copilot", "acct-a@example.test", [
				makeLimit({ id: "Copilot", usedFraction: 0.8, windowId: "monthly", notes: [note] }),
			]),
			makeReport("github-copilot", "acct-b@example.test", [
				makeLimit({ id: "Copilot", usedFraction: 0.9, windowId: "monthly", notes: [note] }),
			]),
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));
		// CLI renders per-limit, so each account shows its own note — that's
		// correct for the CLI path (one limit at a time). The dedup contract
		// lives in the TUI aggregate path (command-controller), tested separately.
		// Here we assert the CLI doesn't add spurious duplicates beyond one-per-limit.
		const occurrences = text.split(note).length - 1;
		expect(occurrences).toBe(2);
	});
});

describe("formatUsageHistory", () => {
	const NOW = Date.now();
	const SINCE = NOW - 7 * 24 * HOUR;

	function historyEntry(recordedAt: number, usedFraction: number | undefined, overrides?: Record<string, unknown>) {
		return {
			recordedAt,
			provider: "anthropic",
			accountKey: "oauth|email:dummy.primary@example.test",
			email: "dummy.primary@example.test",
			limitId: "anthropic:5h",
			label: "Session",
			windowLabel: "5 Hour",
			usedFraction,
			status: "ok" as const,
			...overrides,
		};
	}

	const entries = [
		historyEntry(SINCE + HOUR, 0.2),
		historyEntry(SINCE + 30 * HOUR, 0.95),
		historyEntry(NOW - HOUR, 0.4),
	];

	it("renders one series per account window with latest and peak percentages", () => {
		const text = stripVTControlCharacters(formatUsageHistory(entries, SINCE, NOW));
		expect(text).toContain("Anthropic");
		expect(text).toContain("dummy.primary@example.test");
		// Window label is appended when the limit label doesn't carry it.
		expect(text).toContain("Session (5 Hour)");
		expect(text).toContain("latest 40.0%");
		expect(text).toContain("peak 95.0%");
		expect(text).toContain("3 snapshots");
	});

	it("redacts account labels through the provided map", () => {
		const redaction = buildRedactionMap(["dummy.primary@example.test"]);
		const text = stripVTControlCharacters(formatUsageHistory(entries, SINCE, NOW, redaction));
		expect(text).not.toContain("dummy.primary@example.test");
		expect(text).toContain("du*");
	});

	it("qualifies Codex accounts that share an email the way the main view does", () => {
		const shared = { provider: "openai-codex", email: "dummy.shared@example.test", limitId: "openai-codex:primary" };
		const text = stripVTControlCharacters(
			formatUsageHistory(
				[
					historyEntry(NOW - HOUR, 0.1, { ...shared, accountKey: "codex|team", accountId: "acct-team" }),
					historyEntry(NOW - HOUR, 0.5, { ...shared, accountKey: "codex|pro", accountId: "acct-pro" }),
					// Anthropic multi-org logins share email and account uuid; the main view's qualifier is Codex-only.
					historyEntry(NOW - HOUR, 0.3, { accountKey: "anthropic|org-a", accountId: "uuid-user" }),
					historyEntry(NOW - HOUR, 0.4, { accountKey: "anthropic|org-b", accountId: "uuid-user" }),
				],
				SINCE,
				NOW,
			),
		);
		const accountLines = text.split("\n").filter(line => line.startsWith("  ") && !line.startsWith("    "));
		expect(accountLines.toSorted()).toEqual([
			"  dummy.primary@example.test",
			"  dummy.primary@example.test",
			"  dummy.shared@example.test · acct-pro",
			"  dummy.shared@example.test · acct-team",
		]);
	});

	it("redacts the Codex account ids shown as same-email qualifiers", () => {
		const shared = { provider: "openai-codex", email: "dummy.shared@example.test", limitId: "openai-codex:primary" };
		const history = [
			historyEntry(NOW - HOUR, 0.1, { ...shared, accountKey: "codex|team", accountId: "acct-team" }),
			historyEntry(NOW - HOUR, 0.5, { ...shared, accountKey: "codex|pro", accountId: "acct-pro" }),
		];
		const redaction = buildRedactionMap(collectHistoryIdentityStrings(history));
		const text = stripVTControlCharacters(formatUsageHistory(history, SINCE, NOW, redaction));
		for (const secret of ["dummy.shared@example.test", "acct-team", "acct-pro"]) expect(text).not.toContain(secret);
		for (const id of ["acct-team", "acct-pro"]) expect(text).toContain(redaction.get(id) ?? id);
	});
});

describe("usage command configuration", () => {
	it("uses PI_CONFIG_FILES account policies during auth discovery", async () => {
		using tempDir = TempDir.createSync("@omp-usage-overlay-");
		const overlayPath = tempDir.join("overlay.yml");
		await Promise.all([
			Bun.write(
				tempDir.join("config.yml"),
				[
					"auth:",
					"  accountPolicies:",
					"    - provider: openai-codex",
					"      account:",
					"        email: stale@example.test",
					"      unsupported: true",
					"",
				].join("\n"),
			),
			Bun.write(
				overlayPath,
				[
					"auth:",
					"  accountPolicies:",
					"    - provider: openai-codex",
					"      account:",
					"        email: overlay@example.test",
					"      priority: 20",
					"retry:",
					"  usageReservePct: 17",
					"",
				].join("\n"),
			),
		]);
		const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");
		const proc = Bun.spawn([process.execPath, cliEntry, "usage", "invalidate"], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: tempDir.path(),
				PI_CONFIG_FILES: overlayPath,
			},
		});
		const [exitCode, output, error] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(error).toBe("");
		expect(exitCode).toBe(0);
		expect(output).toBe("Invalidated cached usage reports for all providers.\n");
	});
});

describe("omp usage accounts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists the identity keys that restrict a session, and no token material", async () => {
		const authStorage = createInMemoryAuthStorage();
		const oauth = (
			suffix: string,
			identity: { email?: string; accountId?: string; orgId?: string; orgName?: string },
		) => ({
			type: "oauth" as const,
			access: `access-${suffix}`,
			refresh: `refresh-${suffix}`,
			expires: Date.now() + 60 * 60_000,
			...identity,
		});
		await authStorage.credentials.set("anthropic", [
			oauth("team", { email: "dev@example.com", orgId: "org-team", orgName: "Team" }),
			oauth("personal", { email: "dev@example.com", orgId: "org-personal" }),
			{ type: "api_key", key: "sk-stored" },
		]);
		await authStorage.credentials.set("openai-codex", oauth("codex", { accountId: "acct-codex" }));
		vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		// The command closes the storage it discovered; keep it open to check the keys after.
		vi.spyOn(authStorage, "close").mockImplementation(() => {});
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(String(chunk));
			return true;
		});

		try {
			await runUsageCommand({ action: "accounts", json: true });
			const listed = JSON.parse(output.join("")) as {
				accounts: Array<{ provider: string; identityKey: string; orgName?: string }>;
			};
			expect(listed.accounts).toEqual([
				{ provider: "anthropic", identityKey: "email:dev@example.com|org:org-team", orgName: "Team" },
				{ provider: "anthropic", identityKey: "email:dev@example.com|org:org-personal" },
				{ provider: "openai-codex", identityKey: "account:acct-codex" },
			]);

			// Each listed key, used as a pool, routes a session to exactly that account.
			for (const [index, account] of listed.accounts.entries()) {
				authStorage.sessions.restrict(account.provider, `pooled-${index}`, [account.identityKey]);
			}
			expect(await authStorage.keys.get("anthropic", "pooled-0")).toBe("access-team");
			expect(await authStorage.keys.get("anthropic", "pooled-1")).toBe("access-personal");

			output.length = 0;
			await runUsageCommand({ action: "accounts" });
			const text = stripVTControlCharacters(output.join(""));
			for (const account of listed.accounts) expect(text).toContain(account.identityKey);
			expect(text).not.toMatch(/access-|refresh-|sk-stored/);
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
		}
	});
});

describe("omp usage reset", () => {
	interface ResetRequest {
		method: string;
		path: string;
		bearer: string | null;
		body?: Record<string, unknown>;
	}
	const soon = new Date(Date.now() + 2 * 24 * HOUR).toISOString();
	const late = new Date(Date.now() + 20 * 24 * HOUR).toISOString();
	const oauth = (access: string, identity: Partial<OAuthCredential>): OAuthCredential => ({
		type: "oauth",
		access,
		refresh: `refresh-${access}`,
		expires: Date.now() + HOUR,
		...identity,
	});

	let requests: ResetRequest[];
	/** Codex consume answer; an Error stands in for a dropped connection, `stall` for one that never answers. */
	let codexConsume: { status: number; body: unknown } | Error | "stall";
	/** Codex listing faults by bearer: `unavailable` fails upstream, `stall` never answers. */
	let codexListFaults: Record<string, "unavailable" | "stall">;
	/** Title Anthropic gives the Claude grant. */
	let claudeGrantLabel: string;
	let authStorage: AuthStorage;
	let stdout: string;
	let stderr: string;
	/** Settles once the command has listed the Codex accounts. */
	let listed: PromiseWithResolvers<void>;
	let tempDir: TempDir;
	const originalEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		OMP_PROFILE: process.env.OMP_PROFILE,
		PI_PROFILE: process.env.PI_PROFILE,
	};

	/** A response that never arrives; it rejects once the request's signal aborts. */
	const stall = (init?: RequestInit): Promise<Response> => {
		const stalled = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => stalled.reject(init.signal?.reason));
		return stalled.promise;
	};

	/** Codex and Claude reset endpoints: `codex-team` banks two credits, `codex-spare` none, Claude one grant. */
	const handleReset = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const bearer = new Headers(init?.headers).get("authorization");
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		requests.push({ method, path: url.pathname, bearer, ...(body ? { body } : {}) });
		if (url.pathname.endsWith("/wham/rate-limit-reset-credits/consume")) {
			if (codexConsume instanceof Error) throw codexConsume;
			if (codexConsume === "stall") return stall(init);
			return Response.json(codexConsume.body, { status: codexConsume.status });
		}
		if (url.pathname.endsWith("/wham/rate-limit-reset-credits")) {
			listed.resolve();
			const fault = bearer ? codexListFaults[bearer] : undefined;
			if (fault === "unavailable") return new Response("upstream unavailable", { status: 503 });
			if (fault === "stall") return stall(init);
			const credits =
				bearer === "Bearer codex-team" || bearer === "Bearer broker-codex"
					? [
							{ id: "credit-late", status: "available", expires_at: late },
							{
								id: "credit-soon",
								status: "available",
								expires_at: soon,
								description: "Banked for dev@example.test",
							},
						]
					: [];
			return Response.json({ credits, available_count: credits.length });
		}
		if (url.pathname.endsWith("/reset_rate_limits")) {
			return Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour"] });
		}
		if (url.pathname.endsWith("/api/oauth/usage")) {
			return Response.json({
				five_hour: { utilization: 100, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
				seven_day: { utilization: 40, resets_at: new Date(Date.now() + 72 * HOUR).toISOString() },
				cedar_ember: {
					eligible: true,
					at_limit: true,
					exhausted: ["five_hour"],
					next_grant_id: "saved-reset",
					grants: [
						{
							id: "saved-reset",
							label: claudeGrantLabel,
							resets_total: 1,
							resets_left: 1,
							starts_at: new Date(Date.now() - HOUR).toISOString(),
							ends_at: soon,
							clears: ["five_hour"],
							paused: false,
							usable_now: true,
							use_requires_limit: true,
							percent_used: { five_hour: 100 },
							blocking: [],
						},
					],
				},
			});
		}
		return new Response("not found", { status: 404 });
	};
	const usageFetch = Object.assign(handleReset, { preconnect: fetch.preconnect });

	const consumes = () => requests.filter(request => request.method === "POST");

	beforeEach(async () => {
		requests = [];
		listed = Promise.withResolvers<void>();
		tempDir = TempDir.createSync("@omp-usage-reset-");
		setAgentDir(tempDir.path());
		codexConsume = { status: 200, body: { code: "reset" } };
		codexListFaults = {};
		claudeGrantLabel = "Reset for dev@example.test (Acme Corp)";
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), { usageFetch });
		await authStorage.credentials.set("openai-codex", [
			oauth("codex-team", { email: "dev@example.test", accountId: "acct-team" }),
			oauth("codex-spare", { email: "spare@example.test", accountId: "acct-spare" }),
		]);
		await authStorage.credentials.set(
			"anthropic",
			oauth("claude-max", { email: "dev@example.test", orgId: "org-claude", orgName: "Acme Corp" }),
		);
		vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		stdout = "";
		stderr = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += String(chunk);
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr += String(chunk);
			return true;
		});
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		tempDir.removeSync();
	});

	function codexTeamLockPath(): string {
		const lockKey = resetAccountLockKey({ provider: "openai-codex", accountId: "acct-team" });
		if (!lockKey) throw new Error("expected a reset lock key");
		return resetLockPath(lockKey);
	}

	function credentialIds() {
		const [team, spare] = authStorage.oauth.accounts("openai-codex").map(account => account.credentialId);
		const [claude] = authStorage.oauth.accounts("anthropic").map(account => account.credentialId);
		return { team, spare, claude };
	}

	it("lists every stored Codex and Claude account by credential id and spends nothing", async () => {
		const { team, spare, claude } = credentialIds();
		await runUsageCommand({ action: "reset", noExtensions: true });

		const text = stripVTControlCharacters(stdout);
		expect(text).toContain(`[Codex · openai-codex/${team}]: 2 saved, 2 usable now, expires ${soon}`);
		expect(text).toContain(`spare@example.test [Codex · openai-codex/${spare}]: 0 saved, 0 usable now`);
		expect(text).toContain(`dev@example.test · Acme Corp [Claude · anthropic/${claude}]: 1 saved, 1 usable now`);
		expect(text).toContain("omp usage reset <provider>/<credential id>");
		expect(consumes()).toEqual([]);
		expect(process.exitCode).toBe(0);
	});

	it("prints credential ids, credit ids and expiries as JSON", async () => {
		const { team, spare, claude } = credentialIds();
		await runUsageCommand({ action: "reset", json: true, noExtensions: true });

		const { accounts } = JSON.parse(stdout) as {
			accounts: Array<{
				provider: string;
				credentialId: number;
				redeemableCount: number;
				nextCreditId?: string;
				soonestExpiry?: string;
				credits: Array<{ id: string; expiresAt?: string }>;
			}>;
		};
		expect(
			accounts.map(account => [
				account.provider,
				account.credentialId,
				account.redeemableCount,
				account.nextCreditId,
				account.soonestExpiry,
				account.credits.map(credit => [credit.id, credit.expiresAt]),
			]),
		).toEqual([
			[
				"openai-codex",
				team,
				2,
				undefined,
				soon,
				[
					["credit-late", late],
					["credit-soon", soon],
				],
			],
			["openai-codex", spare, 0, undefined, undefined, []],
			["anthropic", claude, 1, "saved-reset", soon, [["saved-reset", soon]]],
		]);
		expect(consumes()).toEqual([]);
	});

	it("lists only the --provider alias's accounts", async () => {
		const { claude } = credentialIds();
		await runUsageCommand({ action: "reset", provider: "claude", json: true, noExtensions: true });

		const { accounts } = JSON.parse(stdout) as { accounts: Array<{ provider: string; credentialId: number }> };
		expect(accounts.map(account => [account.provider, account.credentialId])).toEqual([["anthropic", claude]]);
		expect(requests.some(request => request.path.includes("/wham/"))).toBe(false);
	});

	const identities = ["dev@example.test", "spare@example.test", "acct-team", "org-claude", "Acme Corp"];

	it.each([
		["text", false],
		["JSON", true],
	])("masks account identities in the --redact %s listing and keeps credential ids", async (_format, json) => {
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", json, redact: true, noExtensions: true });

		for (const identity of identities) expect(stdout).not.toContain(identity);
		expect(stripVTControlCharacters(stdout)).toContain(json ? `"credentialId": ${team}` : `openai-codex/${team}`);
	});

	it("spends on the stored account, not the masked label, under --redact", async () => {
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, redact: true, noExtensions: true });

		for (const identity of identities) expect(stdout).not.toContain(identity);
		expect(stripVTControlCharacters(stdout)).toContain("Reset applied for de* (Codex)");
		expect(consumes().map(request => [request.bearer, request.body?.account_id])).toEqual([
			["Bearer codex-team", "acct-team"],
		]);
	});

	it("masks identities inside a failed spend's reason under --redact", async () => {
		codexConsume = new Error("socket to dev@example.test closed");
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, redact: true, noExtensions: true });

		for (const identity of identities) expect(stderr).not.toContain(identity);
		expect(stripVTControlCharacters(stderr)).toContain("couldn't confirm whether the reset applied");
		expect(process.exitCode).toBe(1);
	});

	it.each([
		[
			"another letter case",
			{ email: "Dev@Example.test", orgName: "acme corp" },
			"Reset for dev@example.test (Acme Corp)",
			"Reset for De* (ac*)",
		],
		["non-ASCII letters", { email: "dev@example.test", orgName: "İstanbul" }, "Reset for İstanbul", "Reset for İs*"],
		[
			"the lowercase form of non-ASCII letters",
			{ email: "dev@example.test", orgName: "İstanbul" },
			"Reset for i\u0307stanbul",
			"Reset for İs*",
		],
	])("masks an identity written in %s inside provider text under --redact", async (_case, identity, label, title) => {
		claudeGrantLabel = label;
		await authStorage.credentials.set("anthropic", oauth("claude-case", { ...identity, orgId: "org-case" }));
		await runUsageCommand({ action: "reset", provider: "claude", json: true, redact: true, noExtensions: true });

		const { accounts } = JSON.parse(stdout) as { accounts: Array<{ credits: Array<{ title?: string }> }> };
		expect(accounts.map(account => account.credits.map(credit => credit.title))).toEqual([[title]]);
	});

	/** Organizations named like the `codex` alias (inside `openai-codex`) and like the Claude grant id. */
	async function storeIdentitiesMatchingIds(): Promise<void> {
		await authStorage.credentials.set("openai-codex", [
			oauth("codex-team", { email: "dev@example.test", accountId: "acct-team", orgName: "codex" }),
		]);
		await authStorage.credentials.set(
			"anthropic",
			oauth("claude-max", { email: "dev@example.test", orgId: "org-overlap", orgName: "saved-reset" }),
		);
	}

	it("spends under --redact when an account's identity matches a provider id", async () => {
		await storeIdentitiesMatchingIds();
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, redact: true, noExtensions: true });

		expect(stripVTControlCharacters(stdout)).toContain("Reset applied for de* · co* (Codex)");
		expect(consumes().map(request => [request.bearer, request.body?.account_id])).toEqual([
			["Bearer codex-team", "acct-team"],
		]);
		expect(process.exitCode).toBe(0);
	});

	it("keeps spend targets canonical in a --redact text listing when identities match them", async () => {
		await storeIdentitiesMatchingIds();
		const { team, claude } = credentialIds();
		await runUsageCommand({ action: "reset", redact: true, noExtensions: true });

		const text = stripVTControlCharacters(stdout);
		expect(text).toContain(`de* · co* [Codex · openai-codex/${team}]`);
		expect(text).toContain(`de* · sa* [Claude · anthropic/${claude}]`);
	});

	it("keeps provider, credit and grant ids canonical in a --redact JSON listing when identities match them", async () => {
		await storeIdentitiesMatchingIds();
		const { team, claude } = credentialIds();
		await runUsageCommand({ action: "reset", json: true, redact: true, noExtensions: true });

		const { accounts } = JSON.parse(stdout) as {
			accounts: Array<{
				provider: string;
				credentialId: number;
				orgName?: string;
				nextCreditId?: string;
				credits: Array<{ id: string; expiresAt?: string }>;
			}>;
		};
		expect(
			accounts.map(account => [
				account.provider,
				account.credentialId,
				account.orgName,
				account.nextCreditId,
				account.credits.map(credit => [credit.id, credit.expiresAt]),
			]),
		).toEqual([
			[
				"openai-codex",
				team,
				"co*",
				undefined,
				[
					["credit-late", late],
					["credit-soon", soon],
				],
			],
			["anthropic", claude, "sa*", "saved-reset", [["saved-reset", soon]]],
		]);
	});

	it("refuses to spend on an account whose login cannot be fenced", async () => {
		await authStorage.credentials.set("anthropic", oauth("claude-anon", { orgId: "org-anon" }));
		const { claude } = credentialIds();
		await runUsageCommand({ action: "reset", target: `claude/${claude}`, noExtensions: true });

		expect(consumes()).toEqual([]);
		expect(stripVTControlCharacters(stderr)).toContain("no account id or email to fence the spend");
		expect(process.exitCode).toBe(1);
	});

	it("waits for a session holding the account's reset lock and spends nothing after its reset", async () => {
		const { team } = credentialIds();
		const lockPath = codexTeamLockPath();
		let run: Promise<void> | undefined;
		await withFileLock(lockPath, async () => {
			run = runUsageCommand({ action: "reset", target: `codex/${team}`, noExtensions: true });
			await listed.promise;
			await Bun.write(lockPath, `reset:${Date.now()}`);
		});
		await run;

		expect(consumes()).toEqual([]);
		expect(stripVTControlCharacters(stderr)).toContain("another omp process spent a saved reset on this account");
		expect(process.exitCode).toBe(1);
	});

	it("spends the named Codex account's soonest-expiring credit", async () => {
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, noExtensions: true });

		expect(stripVTControlCharacters(stdout)).toContain("Reset applied for dev@example.test (Codex)");
		expect(consumes().map(request => [request.path, request.bearer, request.body?.credit_id])).toEqual([
			["/backend-api/wham/rate-limit-reset-credits/consume", "Bearer codex-team", "credit-soon"],
		]);
		expect(process.exitCode).toBe(0);
	});

	it("spends the listed Claude grant through the claude alias", async () => {
		const { claude } = credentialIds();
		await runUsageCommand({ action: "reset", target: `claude/${claude}`, noExtensions: true });

		expect(stripVTControlCharacters(stdout)).toContain("Reset applied for dev@example.test · Acme Corp (Claude)");
		expect(consumes().map(request => [request.path, request.bearer, request.body?.grant_id])).toEqual([
			["/api/organizations/org-claude/reset_rate_limits", "Bearer claude-max", "saved-reset"],
		]);
		expect(process.exitCode).toBe(0);
	});

	it.each([
		["codex/active", "no account is active"],
		["gemini/1", 'Unknown reset provider "gemini"'],
		["codex/999", 'No stored account matches "codex/999"'],
		["codex", "Choose an account with `omp usage reset <provider>/<credential id>`"],
	])("refuses %s without spending", async (target, message) => {
		await runUsageCommand({ action: "reset", target, noExtensions: true });

		expect(stripVTControlCharacters(stderr)).toContain(message);
		expect(stdout).toBe("");
		expect(consumes()).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("refuses an account with no usable reset without spending", async () => {
		const { spare } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${spare}`, noExtensions: true });

		expect(stripVTControlCharacters(stderr)).toContain(
			"spare@example.test [Codex]: no saved resets usable right now",
		);
		expect(consumes()).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("names a failed listing instead of reporting no usable resets", async () => {
		codexListFaults = { "Bearer codex-spare": "unavailable" };
		const { spare } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${spare}`, noExtensions: true });

		expect(stripVTControlCharacters(stderr)).toContain(
			"spare@example.test [Codex]: saved resets unavailable (Failed to load saved resets)",
		);
		expect(consumes()).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it("stops waiting on a Codex listing that never answers", async () => {
		codexListFaults = { "Bearer codex-team": "stall" };
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(Math.min(ms, 50)));
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, noExtensions: true });

		expect(stripVTControlCharacters(stderr)).toContain("saved resets unavailable (Failed to load saved resets)");
		expect(consumes()).toEqual([]);
		expect(process.exitCode).toBe(1);
	});

	it.each([
		["the credit was already redeemed", { status: 200, body: { code: "already_redeemed" } }, "already redeemed"],
		["nothing is constrained", { status: 200, body: { code: "nothing_to_reset" } }, "nothing to reset right now"],
		["the provider errors", { status: 500, body: {} }, "reset was not confirmed (http_500)"],
		["the connection drops", new Error("socket hang up"), "couldn't confirm whether the reset applied"],
	])("exits nonzero when %s", async (_name, answer, message) => {
		codexConsume = answer;
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, noExtensions: true });

		expect(stripVTControlCharacters(stderr)).toContain(message);
		expect(stdout).toBe("");
		expect(consumes()).toHaveLength(1);
		expect(process.exitCode).toBe(1);
	});

	it("stops waiting on a consume that never answers and reports the spend unconfirmed", async () => {
		codexConsume = "stall";
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => timeout(Math.min(ms, 50)));
		const { team } = credentialIds();
		await runUsageCommand({ action: "reset", target: `codex/${team}`, noExtensions: true });

		expect(stripVTControlCharacters(stderr)).toContain("couldn't confirm whether the reset applied");
		expect(consumes()).toHaveLength(1);
		expect(process.exitCode).toBe(1);
	});

	it("spends on an auth-broker client with the broker's token from this process", async () => {
		const brokerStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		const brokerStorage = new AuthStorage(brokerStore);
		await brokerStorage.credentials.set(
			"openai-codex",
			oauth("broker-codex", { email: "fleet@example.test", accountId: "acct-fleet" }),
		);
		const handle = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: ["reset-bearer"],
			disableRefresher: true,
		});
		const client = new AuthBrokerClient({ url: handle.url, token: "reset-bearer" });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected a broker snapshot");
		const remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		const clientStorage = new AuthStorage(remote, { usageFetch });
		try {
			await clientStorage.credentials.reload();
			vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(clientStorage);
			const [account] = clientStorage.oauth.accounts("openai-codex");
			await runUsageCommand({ action: "reset", target: `codex/${account?.credentialId}`, noExtensions: true });

			expect(stripVTControlCharacters(stdout)).toContain("Reset applied for fleet@example.test (Codex)");
			expect(consumes().map(request => [request.bearer, request.body?.credit_id])).toEqual([
				["Bearer broker-codex", "credit-soon"],
			]);
		} finally {
			clientStorage.close();
			remote.close();
			await handle.close();
			brokerStorage.close();
			brokerStore.close();
		}
	});
});

describe("omp usage saved-reset expiry banner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Two Codex workspaces under one email, each with a reset expiring within 24 hours. */
	async function runWithTwoWorkspaces(redact: boolean): Promise<{ lines: string[]; ids: Record<string, number> }> {
		const authStorage = createInMemoryAuthStorage();
		const workspace = (accountId: string) => ({
			type: "oauth" as const,
			access: `access-${accountId}`,
			refresh: `refresh-${accountId}`,
			expires: Date.now() + HOUR,
			email: "dev@example.com",
			accountId,
			orgId: accountId,
		});
		await authStorage.credentials.set("openai-codex", [workspace("ws-pro"), workspace("ws-team")]);
		const ids: Record<string, number> = {};
		for (const account of authStorage.oauth.accounts("openai-codex")) ids[account.accountId!] = account.credentialId;
		const now = Date.now();
		// Reports arrive in the opposite order to the stored accounts, so a positional match would swap them.
		vi.spyOn(authStorage.usage, "reports").mockResolvedValue([
			codexResetReport({
				nowMs: now,
				accountId: "ws-team",
				email: "dev@example.com",
				weeklyUsed: 1,
				expiresInMs: [6 * HOUR],
			}),
			codexResetReport({
				nowMs: now,
				accountId: "ws-pro",
				email: "dev@example.com",
				weeklyUsed: 0.5,
				expiresInMs: [3 * HOUR],
			}),
		]);
		vi.spyOn(Settings, "loadReadOnly").mockResolvedValue(Settings.isolated());
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output.push(String(chunk));
			return true;
		});
		await runUsageCommand({ noExtensions: true, redact });
		return { lines: stripVTControlCharacters(output.join("")).split("\n"), ids };
	}

	it("names the stored credential of each same-email Codex workspace", async () => {
		const { lines, ids } = await runWithTwoWorkspaces(false);
		expect(ids["ws-pro"]).not.toBe(ids["ws-team"]);
		expect(lines).toContain("▲ 2 saved resets expire within 24h");
		for (const workspace of ["ws-team", "ws-pro"]) {
			const entry = lines.findIndex(line => line.includes(`· ${workspace} ·`) && line.includes("expires in"));
			expect(entry).toBeGreaterThan(-1);
			expect(lines[entry + 2]).toContain(`/usage reset openai-codex/${ids[workspace]} `);
		}
	});

	it("masks the banner's account identities under --redact", async () => {
		const { lines } = await runWithTwoWorkspaces(true);
		const text = lines.join("\n");
		expect(text).toContain("▲ 2 saved resets expire within 24h");
		expect(text).not.toMatch(/dev@example\.com|ws-pro|ws-team/);
	});
});
