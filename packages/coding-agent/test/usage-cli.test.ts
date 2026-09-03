import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildRedactionMap,
	collectUnreportedAccounts,
	computeProviderWindowStats,
	formatUsageBreakdown,
	formatUsageHistory,
	type UsageAccountIdentity,
} from "@oh-my-pi/pi-coding-agent/cli/usage-cli";

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

function makeLimit(opts: {
	id: string;
	usedFraction: number;
	durationMs?: number;
	windowId?: string;
	tier?: string;
	accountId?: string;
	provider?: string;
	notes?: string[];
}): UsageReport["limits"][number] {
	return {
		id: opts.id,
		label: opts.id,
		scope: {
			provider: opts.provider ?? "anthropic",
			windowId: opts.windowId,
			tier: opts.tier,
			accountId: opts.accountId,
		},
		window:
			opts.durationMs !== undefined
				? { id: opts.windowId ?? opts.id, label: opts.windowId ?? opts.id, durationMs: opts.durationMs }
				: undefined,
		amount: { unit: "percent", usedFraction: opts.usedFraction },
		...(opts.notes ? { notes: opts.notes } : {}),
	};
}

function makeReport(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, ...(notes ? { notes } : {}), metadata: { email } };
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
	it("buckets by window duration, binds each account to its worst meter, and reports remaining capacity", () => {
		const reports = [
			makeReport("anthropic", "account-a@example.test", [
				makeLimit({ id: "5h", usedFraction: 0.9, durationMs: FIVE_HOURS, windowId: "5h" }),
				makeLimit({ id: "7d", usedFraction: 0.1, durationMs: SEVEN_DAYS, windowId: "7d" }),
				// Tiered meter on the same window: higher burn must bind.
				makeLimit({ id: "7d-opus", usedFraction: 0.4, durationMs: SEVEN_DAYS, windowId: "7d", tier: "opus" }),
			]),
			makeReport("anthropic", "account-b@example.test", [
				makeLimit({ id: "5h", usedFraction: 0.4, durationMs: FIVE_HOURS, windowId: "5h" }),
				makeLimit({ id: "7d", usedFraction: 0.2, durationMs: SEVEN_DAYS, windowId: "7d" }),
			]),
		];
		const stats = computeProviderWindowStats(reports);
		expect(stats).toHaveLength(2);
		const [fiveHour, sevenDay] = stats;
		// Sorted shortest window first.
		expect(fiveHour.window).toBe("5h");
		expect(fiveHour.accounts).toBe(2);
		expect(fiveHour.usedAccounts).toBeCloseTo(1.3);
		expect(fiveHour.remainingAccounts).toBeCloseTo(0.7);
		expect(sevenDay.window).toBe("7d");
		expect(sevenDay.usedAccounts).toBeCloseTo(0.6); // 0.4 (opus binds) + 0.2
		expect(sevenDay.remainingAccounts).toBeCloseTo(1.4);
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
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).toContain("future@example.test");
		expect(text).toContain("soonest expires in 2d (2026-01-03)");
		expect(text).toContain("expired@example.test");
		expect(text).toContain("expired (2025-12-30)");
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
});
