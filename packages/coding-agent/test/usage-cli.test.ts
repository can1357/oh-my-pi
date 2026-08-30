import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore, type UsageReport } from "@oh-my-pi/pi-ai";
import { buildRedactionMap, formatUsageHistory, runUsageCommand } from "@oh-my-pi/pi-coding-agent/cli/usage-cli";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import {
	collectUnreportedAccounts,
	computeProviderWindowStats,
	formatUsageBreakdown,
	hasRenderableUsageBreakdown,
	isActionableDisabledCredential,
	type UsageAccountIdentity,
} from "@oh-my-pi/pi-coding-agent/usage/usage-breakdown";
import {
	EXPECTED_USAGE_BREAKDOWN,
	USAGE_FIXTURE_ACCOUNTS,
	USAGE_FIXTURE_DISABLED,
	USAGE_FIXTURE_NOW,
	USAGE_FIXTURE_REPORTS,
} from "./helpers/usage-breakdown-fixture";

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

function makeLimit(opts: {
	id: string;
	usedFraction: number;
	durationMs?: number;
	windowId?: string;
	meter?: string;
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
			meter: opts.meter,
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

	it("reports scoped-meter capacity with opaque limit IDs", () => {
		const report = makeReport("openai-codex", "spark@example.test", [
			makeLimit({
				id: "opaque-primary-limit",
				provider: "openai-codex",
				meter: "spark",
				usedFraction: 0.75,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "opaque-secondary-limit",
				provider: "openai-codex",
				meter: "spark",
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

	it("keeps scoped meters separate when opaque limit IDs share a window duration", () => {
		const report = makeReport("openai-codex", "mixed@example.test", [
			makeLimit({
				id: "opaque-chat-short",
				provider: "openai-codex",
				meter: "chat",
				usedFraction: 0.2,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "opaque-chat-long",
				provider: "openai-codex",
				meter: "chat",
				usedFraction: 0.4,
				durationMs: SEVEN_DAYS,
				windowId: "7d",
			}),
			makeLimit({
				id: "opaque-spark-short",
				provider: "openai-codex",
				meter: "spark",
				usedFraction: 0.8,
				durationMs: FIVE_HOURS,
				windowId: "5h",
			}),
			makeLimit({
				id: "opaque-spark-long",
				provider: "openai-codex",
				meter: "spark",
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
	it("uses limit-scope organizations for same-email account attribution", () => {
		const email = "shared@example.test";
		const orgA: UsageAccountIdentity = { provider: "anthropic", type: "oauth", email, orgId: "org-a" };
		const orgB: UsageAccountIdentity = { provider: "anthropic", type: "oauth", email, orgId: "org-b" };
		const orgless: UsageAccountIdentity = { provider: "anthropic", type: "oauth", email };
		const report = makeReport("anthropic", email, [
			{
				id: "org-a-limit",
				label: "Org A quota",
				scope: { provider: "anthropic", orgId: "org-a" },
				amount: { unit: "percent", usedFraction: 0.25 },
			},
		]);

		expect(collectUnreportedAccounts([report], [orgA, orgB, orgless])).toEqual([orgB, orgless]);
		const rendered = stripVTControlCharacters(formatUsageBreakdown([report], [], Date.now()));
		expect(rendered).toContain(`${email} · org-a`);
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
describe("runUsageCommand", () => {
	it("renders the pinned detailed breakdown through the standalone command entry path", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			fetchUsageReports: async () => USAGE_FIXTURE_REPORTS,
		});
		await authStorage.reload();
		spyOn(authStorage, "getAll").mockReturnValue({
			anthropic: USAGE_FIXTURE_ACCOUNTS.map(account => ({
				type: account.type,
				email: account.email,
			})),
		} as never);
		spyOn(authStorage, "usageProviderFor").mockReturnValue({} as never);
		spyOn(authStorage, "revalidateCredentials").mockResolvedValue(undefined);
		spyOn(authStorage, "listDisabledCredentials").mockResolvedValue(USAGE_FIXTURE_DISABLED);
		const discoverSpy = spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		const nowSpy = spyOn(Date, "now").mockReturnValue(USAGE_FIXTURE_NOW);
		let output = "";
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		try {
			await runUsageCommand({});
		} finally {
			stdoutSpy.mockRestore();
			nowSpy.mockRestore();
			discoverSpy.mockRestore();
		}

		expect(stripVTControlCharacters(output)).toBe(`${EXPECTED_USAGE_BREAKDOWN}\n`);
	});

	it("redacts identifiers embedded in disabled causes in JSON output", async () => {
		const email = "account-123@example.test";
		const accountId = "account-123";
		const redaction = buildRedactionMap([email, accountId]);
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
			fetchUsageReports: async () => [],
		});
		await authStorage.reload();
		spyOn(authStorage, "getAll").mockReturnValue({} as never);
		spyOn(authStorage, "revalidateCredentials").mockResolvedValue(undefined);
		spyOn(authStorage, "listDisabledCredentials").mockResolvedValue([
			{
				id: 61,
				provider: "anthropic",
				type: "oauth",
				email,
				accountId,
				cause: `oauth refresh failed: ${email} was rejected for ${accountId}`,
			},
		]);
		const discoverSpy = spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		let output = "";
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		try {
			await runUsageCommand({ json: true, redact: true });
		} finally {
			stdoutSpy.mockRestore();
			discoverSpy.mockRestore();
		}

		const payload = JSON.parse(output) as { disabledCredentials: Array<{ cause: string }> };
		const cause = payload.disabledCredentials[0]?.cause;
		expect(cause).not.toContain(email);
		expect(cause).not.toContain(accountId);
		expect(cause).toContain(redaction.get(email)!);
		expect(cause).toContain(redaction.get(accountId)!);
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

	it("matches the pinned detailed multi-account breakdown", () => {
		const standalone = stripVTControlCharacters(
			formatUsageBreakdown(
				USAGE_FIXTURE_REPORTS,
				USAGE_FIXTURE_ACCOUNTS,
				USAGE_FIXTURE_NOW,
				undefined,
				USAGE_FIXTURE_DISABLED,
			),
		);

		expect(standalone).toBe(EXPECTED_USAGE_BREAKDOWN);
		expect(standalone).not.toContain("in use by this session");
		expect(standalone).not.toContain("Models with usage data");
	});
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
	it("falls back to limit-scope organizations for same-email account headers", () => {
		const email = "shared@example.test";
		const reports = [
			{
				...makeReport("anthropic", email, [
					{
						id: "org-a-quota",
						label: "Org A quota",
						scope: { provider: "anthropic", orgId: "org-a" },
						amount: { unit: "percent" as const, usedFraction: 0.25 },
					},
				]),
				metadata: { email, orgId: "" },
			},
			{
				...makeReport("anthropic", email, [
					{
						id: "org-b-quota",
						label: "Org B quota",
						scope: { provider: "anthropic", orgId: "org-b" },
						amount: { unit: "percent" as const, usedFraction: 0.5 },
					},
				]),
				metadata: { email, orgId: 42 },
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));

		expect(text).toContain(email + " · org-a");
		expect(text).toContain(email + " · org-b");
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

	it("redacts overlapping identifiers embedded in disabled causes", () => {
		const email = "account-123@example.test";
		const accountId = "account-123";
		const cause = `oauth refresh failed: ${email} was rejected for ${accountId}`;
		const disabled = [{ id: 60, provider: "anthropic", type: "oauth" as const, email, accountId, cause }];
		const redaction = new Map([
			[accountId, "short-mask"],
			[email, "long-mask"],
		]);

		const redacted = stripVTControlCharacters(formatUsageBreakdown([], [], Date.now(), redaction, disabled));
		const plain = stripVTControlCharacters(formatUsageBreakdown([], [], Date.now(), undefined, disabled));

		expect(redacted).not.toContain(email);
		expect(redacted).not.toContain(accountId);
		expect(redacted).toContain("long-mask was rejected for short-mask");
		expect(plain).toContain(`${email} was rejected for ${accountId}`);
	});

	it("redacts every active session identity component before formatting its label", () => {
		const email = "active@example.test";
		const orgName = "Secret Organization";
		const redaction = buildRedactionMap([email, orgName]);
		const text = stripVTControlCharacters(
			formatUsageBreakdown(reports, accounts, Date.now(), redaction, [], {
				resolveActiveAccount: provider => (provider === "anthropic" ? { email, orgName } : undefined),
			}),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(text).not.toContain(email);
		expect(text).not.toContain(orgName);
		expect(marker).toContain(redaction.get(email));
		expect(marker).toContain(redaction.get(orgName));
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

	it("exports the actionable-disabled predicate used by CLI JSON filtering", () => {
		expect(
			isActionableDisabledCredential({
				id: 28,
				provider: "anthropic",
				type: "oauth",
				cause: "oauth refresh failed: token expired",
				disabledAtMs: 0,
			}),
		).toBe(true);
		expect(
			isActionableDisabledCredential({
				id: 29,
				provider: "anthropic",
				type: "oauth",
				cause: "deleted by user",
				disabledAtMs: 0,
			}),
		).toBe(false);
	});
	it("treats an actionable tombstone as a renderable usage breakdown", () => {
		expect(
			hasRenderableUsageBreakdown(
				[],
				[],
				[
					{
						id: 30,
						provider: "anthropic",
						type: "oauth",
						email: "disabled@example.test",
						cause: "oauth refresh failed: token expired",
					},
				],
			),
		).toBe(true);
	});

	it("does not treat lifecycle-noise tombstones as a renderable usage breakdown", () => {
		expect(
			hasRenderableUsageBreakdown(
				[],
				[],
				[
					{
						id: 31,
						provider: "anthropic",
						type: "oauth",
						email: "replaced@example.test",
						cause: "replaced by newer credential",
					},
				],
			),
		).toBe(false);
	});

	it("keeps a same-email tombstone actionable when it belongs to a different organization", () => {
		const activeAccounts: UsageAccountIdentity[] = [
			{
				provider: "anthropic",
				type: "oauth",
				email: "member@example.test",
				orgId: "active-org",
			},
		];

		expect(
			isActionableDisabledCredential(
				{
					id: 32,
					provider: "anthropic",
					type: "oauth",
					email: "member@example.test",
					orgId: "disabled-org",
					cause: "oauth refresh failed: token expired",
				},
				activeAccounts,
			),
		).toBe(true);
	});

	it("suppresses a same-email tombstone when it belongs to the same organization", () => {
		const activeAccounts: UsageAccountIdentity[] = [
			{
				provider: "anthropic",
				type: "oauth",
				email: "member@example.test",
				orgId: "shared-org",
			},
		];

		expect(
			isActionableDisabledCredential(
				{
					id: 33,
					provider: "anthropic",
					type: "oauth",
					email: "member@example.test",
					orgId: "shared-org",
					cause: "oauth refresh failed: token expired",
				},
				activeAccounts,
			),
		).toBe(false);
	});

	it("suppresses an org-only active identity's tombstone in the same organization", () => {
		const activeAccounts: UsageAccountIdentity[] = [
			{
				provider: "anthropic",
				type: "oauth",
				orgId: "shared-org",
			},
		];

		expect(
			isActionableDisabledCredential(
				{
					id: 34,
					provider: "anthropic",
					type: "oauth",
					orgId: "shared-org",
					cause: "oauth refresh failed: token expired",
				},
				activeAccounts,
			),
		).toBe(false);
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

	it("keeps a disabled sibling visible when the active account only shares its organization", () => {
		const activeAccounts: UsageAccountIdentity[] = [
			{
				provider: "anthropic",
				type: "oauth",
				email: "bob@example.test",
				orgId: "shared-org",
			},
		];
		const disabled = [
			{
				id: 32,
				provider: "anthropic",
				type: "oauth" as const,
				email: "alice@example.test",
				orgId: "shared-org",
				cause: "oauth refresh failed: Refresh token expired",
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown([], activeAccounts, Date.now(), undefined, disabled));

		expect(text).toContain("✗ alice@example.test · shared-org — disabled");
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
	it("renders every saved reset expiry when one account mixes future and expired credits", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "mixed@example.test" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: "2026-01-03T00:00:00.000Z" }, { expiresAt: "2025-12-30T00:00:00.000Z" }],
				},
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).toContain("mixed@example.test · ✦ 2 saved resets");
		expect(text).toContain("expires in 2d (2026-01-03)");
		expect(text).toContain("expired (2025-12-30)");
	});
	it("does not render reset credit expiries when none are available", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "none@example.test" },
				resetCredits: {
					availableCount: 0,
					credits: [{ expiresAt: "2026-01-03T00:00:00.000Z", status: "available" }],
				},
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).not.toContain("expires in 2d (2026-01-03)");
	});

	it("does not render redeemed reset credit expiries", () => {
		const now = Date.parse("2026-01-01T00:00:00.000Z");
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "redeemed@example.test" },
				resetCredits: {
					availableCount: 1,
					credits: [
						{ expiresAt: "2026-01-03T00:00:00.000Z" },
						{ expiresAt: "2026-01-04T00:00:00.000Z", status: "redeemed" },
					],
				},
			},
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));
		expect(text).toContain("expires in 2d (2026-01-03)");
		expect(text).not.toContain("expires in 3d (2026-01-04)");
	});

	it("sanitizes per-limit notes into a single line before joining them", () => {
		const note = "safe\nFORGED\tcolumn\x1b[2Jcleared";
		const reports = [
			makeReport("github-copilot", "acct@example.test", [
				makeLimit({ id: "Copilot", usedFraction: 0.8, windowId: "monthly", notes: [note] }),
			]),
		];
		const raw = formatUsageBreakdown(reports, [], Date.now());
		const text = stripVTControlCharacters(raw);
		const noteLines = text.split("\n").filter(line => line.includes("safe") || line.includes("FORGED"));
		expect(raw).not.toContain("\x1b[2J");
		expect(noteLines).toHaveLength(1);
		expect(noteLines[0]?.trim()).toBe("safe FORGED  columncleared");
	});
	it("sanitizes every provider-controlled display field without sanitizing renderer ANSI", () => {
		const now = Date.now();
		const tainted = (field: string) => `safe-${field}\r\nFORGED_${field}\tvalue\x1b[2Jcleared`;
		const report: UsageReport = {
			provider: tainted("provider"),
			fetchedAt: now,
			metadata: {
				email: tainted("account"),
				orgName: tainted("organization"),
				planType: tainted("plan"),
			},
			notes: [tainted("provider_note")],
			limits: [
				{
					id: "tainted-limit",
					label: tainted("limit"),
					scope: {
						provider: tainted("provider"),
						tier: tainted("tier"),
						windowId: tainted("scope_window"),
					},
					window: {
						id: "tainted-window",
						label: tainted("window"),
						resetsAt: now + HOUR,
						resetLabel: tainted("reset"),
					},
					amount: { unit: "percent", usedFraction: 0.5 },
					notes: [tainted("limit_note")],
				},
			],
		};
		const codexReport = makeReport("openai-codex", "codex@example.test", [
			makeLimit({
				id: "openai-codex:tainted:primary",
				provider: "openai-codex",
				tier: tainted("meter"),
				windowId: tainted("capacity_window"),
				usedFraction: 0.5,
			}),
		]);
		const accounts: UsageAccountIdentity[] = [
			{
				provider: "stored-provider",
				type: "oauth",
				email: tainted("stored_account"),
				orgName: tainted("stored_org"),
			},
		];
		const disabled = [
			{
				id: 99,
				provider: "disabled-provider",
				type: "oauth" as const,
				email: tainted("disabled_account"),
				orgName: tainted("disabled_org"),
				cause: "safe-disabled_cause\tFORGED_disabled_cause\x1b[2Jcleared",
			},
		];

		const raw = formatUsageBreakdown([report, codexReport], accounts, now, undefined, disabled, {
			resolveActiveAccount: provider =>
				provider === "openai-codex"
					? { email: tainted("active_account"), orgName: tainted("active_org") }
					: undefined,
			usageModelSelectors: [`openai-codex/${tainted("selector")}`],
		});
		const text = stripVTControlCharacters(raw);
		const fields = [
			"provider",
			"account",
			"organization",
			"plan",
			"provider_note",
			"limit",
			"tier",
			"window",
			"reset",
			"limit_note",
			"meter",
			"capacity_window",
			"stored_account",
			"stored_org",
			"disabled_account",
			"disabled_org",
			"disabled_cause",
			"active_account",
			"active_org",
			"selector",
		];

		expect(raw).not.toContain("\x1b[2J");
		for (const field of fields) {
			const marker = `FORGED_${field}`;
			const markerLines = text.split("\n").filter(line => line.includes(marker));
			expect(markerLines.length).toBeGreaterThan(0);
			expect(markerLines.every(line => !line.trimStart().startsWith(marker))).toBe(true);
		}
	});
	it("renders identical per-limit notes for every account sharing a window", () => {
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
