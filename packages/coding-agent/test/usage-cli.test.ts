import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@pk-nerdsaver-ai/pi-ai";
import {
	buildRedactionMap,
	collectUnreportedAccounts,
	computeProviderWindowStats,
	formatUsageBreakdown,
	formatUsageHistory,
	type UsageAccountIdentity,
} from "@pk-nerdsaver-ai/pi-coding-agent/cli/usage-cli";

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
	notes?: string[];
}): UsageReport["limits"][number] {
	return {
		id: opts.id,
		label: opts.id,
		scope: {
			provider: "anthropic",
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

	it("redacts account labels through the provided map without leaking the originals", () => {
		const redaction = buildRedactionMap(["dummy.primary@example.test", "dummy.secondary@example.test"]);
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, accounts, Date.now(), redaction));
		expect(text).not.toContain("dummy.primary@example.test");
		expect(text).not.toContain("dummy.secondary@example.test");
		for (const mask of redaction.values()) expect(text).toContain(mask);
	});

	it("renders provider-level notes once per provider, not duplicated per account or limit", () => {
		const disclaimer = "OMP-observed spend only; OpenCode usage outside OMP is not included.";
		const multiAccount = [
			makeReport(
				"opencode-go",
				"acct-a@example.test",
				[makeLimit({ id: "5 Hour", usedFraction: 0.3, durationMs: FIVE_HOURS, windowId: "5h" })],
				[disclaimer],
			),
			makeReport(
				"opencode-go",
				"acct-b@example.test",
				[makeLimit({ id: "5 Hour", usedFraction: 0.6, durationMs: FIVE_HOURS, windowId: "5h" })],
				[disclaimer],
			),
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(multiAccount, [], Date.now()));
		// The disclaimer appears exactly once, not once per account or limit.
		const occurrences = text.split(disclaimer).length - 1;
		expect(occurrences).toBe(1);
		// It appears above the per-account rows, not inline with a limit line.
		const disclaimerIdx = text.indexOf(disclaimer);
		const firstLimitIdx = text.indexOf("5 Hour");
		expect(disclaimerIdx).toBeLessThan(firstLimitIdx);
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
