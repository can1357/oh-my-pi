import { describe, expect, it } from "bun:test";
import type { UsageFetchContext } from "../src/usage";
import { factoryDroidUsageProvider, parseFactoryDroidUsage } from "../src/usage/factory-droid";

/** Live shape captured from GET /api/billing/limits (droid 0.189.0 account). */
const LIVE_PAYLOAD = {
	usesTokenRateLimitsBilling: true,
	limits: {
		standard: {
			fiveHour: { usedPercent: 10, windowEnd: "2026-08-07T07:04:42.775Z", secondsRemaining: null },
			weekly: { usedPercent: 4, windowEnd: "2026-08-14T02:04:42.775Z", secondsRemaining: 551078 },
			monthly: { usedPercent: 1, windowEnd: "2026-09-06T02:04:42.775Z", secondsRemaining: 2538278 },
		},
		core: {
			fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
			weekly: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
			monthly: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
		},
	},
	extraUsageBalanceCents: 0,
	overagePreference: "droidCore",
	extraUsageAllowed: true,
};

describe("parseFactoryDroidUsage", () => {
	it("maps pool × window percent limits with reset timestamps", () => {
		// Pin the fetch time just after the payload's capture date so its
		// windowEnds are live (the parser treats past windowEnds as lapsed).
		const report = parseFactoryDroidUsage(LIVE_PAYLOAD, Date.parse("2026-08-07T06:00:00.000Z"));
		expect(report).not.toBeNull();
		expect(report?.provider).toBe("factory-droid");
		expect(report?.limits).toHaveLength(6); // 2 pools × 3 windows; no zero balance row

		const standard5h = report?.limits.find(limit => limit.id === "factory-droid:standard:5h");
		expect(standard5h?.amount).toMatchObject({ used: 10, limit: 100, unit: "percent" });
		expect(standard5h?.status).toBe("ok");
		expect(standard5h?.window?.resetsAt).toBe(Date.parse("2026-08-07T07:04:42.775Z"));

		const coreMonthly = report?.limits.find(limit => limit.id === "factory-droid:core:monthly");
		expect(coreMonthly?.amount.used).toBe(0);
		expect(coreMonthly?.window?.resetsAt).toBeUndefined(); // windowEnd was null
	});

	it("marks near-exhausted windows and includes a positive extra balance", () => {
		const fetchedAt = Date.parse("2026-08-25T12:00:00.000Z");
		const payload = {
			limits: {
				standard: {
					fiveHour: { usedPercent: 97, windowEnd: "2026-08-25T16:00:00.000Z", secondsRemaining: 14400 },
					weekly: { usedPercent: 100, windowEnd: "2026-08-29T12:00:00.000Z", secondsRemaining: 345600 },
					monthly: { usedPercent: 1, windowEnd: "2026-09-06T12:00:00.000Z", secondsRemaining: 1036800 },
				},
			},
			extraUsageBalanceCents: 1250,
		};
		const report = parseFactoryDroidUsage(payload, fetchedAt);
		const fiveHour = report?.limits.find(limit => limit.id === "factory-droid:standard:5h");
		const weekly = report?.limits.find(limit => limit.id === "factory-droid:standard:weekly");
		expect(fiveHour?.status).toBe("warning");
		expect(weekly?.status).toBe("exhausted");

		const balance = report?.limits.find(limit => limit.id === "factory-droid:extra-balance");
		expect(balance?.amount).toMatchObject({ limit: 12.5, remaining: 12.5, unit: "usd" });
	});

	it("reads lapsed windows as fresh, even when frozen at 100% used", () => {
		// Live shape captured 2026-08-25 (droid 0.203.0 account): the Droid
		// Core 5-hour and weekly windows ended 2026-08-14/15 but the API keeps
		// reporting their final usedPercent (100) with a past windowEnd; the
		// droid CLI (windowEnd >= now = active) and dashboard both show 0%.
		const fetchedAt = Date.parse("2026-08-25T20:30:00.000Z");
		const payload = {
			limits: {
				standard: {
					fiveHour: { usedPercent: 85, windowEnd: "2026-08-25T23:28:38.072Z", secondsRemaining: 10536 },
					weekly: { usedPercent: 29, windowEnd: "2026-09-01T18:28:38.072Z", secondsRemaining: 597336 },
					monthly: { usedPercent: 40, windowEnd: "2026-09-06T02:04:42.775Z", secondsRemaining: 970300 },
				},
				core: {
					fiveHour: { usedPercent: 100, windowEnd: "2026-08-14T05:41:54.205Z", secondsRemaining: null },
					weekly: { usedPercent: 100, windowEnd: "2026-08-15T02:53:13.005Z", secondsRemaining: null },
					monthly: { usedPercent: 38, windowEnd: "2026-09-07T02:53:13.005Z", secondsRemaining: 1059610 },
				},
			},
		};
		const report = parseFactoryDroidUsage(payload, fetchedAt);
		const core5h = report?.limits.find(limit => limit.id === "factory-droid:core:5h");
		const coreWeekly = report?.limits.find(limit => limit.id === "factory-droid:core:weekly");
		const coreMonthly = report?.limits.find(limit => limit.id === "factory-droid:core:monthly");
		for (const lapsed of [core5h, coreWeekly]) {
			expect(lapsed?.amount.used).toBe(0);
			expect(lapsed?.amount.remaining).toBe(100);
			expect(lapsed?.status).toBe("ok");
			expect(lapsed?.window?.resetsAt).toBeUndefined();
		}
		expect(coreMonthly?.amount.used).toBe(38);
		expect(coreMonthly?.window?.resetsAt).toBe(Date.parse("2026-09-07T02:53:13.005Z"));
		const standard5h = report?.limits.find(limit => limit.id === "factory-droid:standard:5h");
		expect(standard5h?.amount.used).toBe(85);
		expect(standard5h?.status).toBe("ok");
	});

	it("returns null for payloads without limit windows", () => {
		expect(parseFactoryDroidUsage({})).toBeNull();
		expect(parseFactoryDroidUsage({ limits: {} })).toBeNull();
		expect(parseFactoryDroidUsage("nope")).toBeNull();
	});
});

describe("factoryDroidUsageProvider.fetchUsage", () => {
	const ctx: UsageFetchContext = { fetch: async () => new Response(JSON.stringify(LIVE_PAYLOAD), { status: 200 }) };

	it("fetches and parses the billing limits endpoint with droid identity headers", async () => {
		let seenUrl = "";
		let seenHeaders: Record<string, string> = {};
		const capturingCtx: UsageFetchContext = {
			fetch: async (url, init) => {
				seenUrl = String(url);
				seenHeaders = Object.fromEntries(
					Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
				);
				return new Response(JSON.stringify(LIVE_PAYLOAD), { status: 200 });
			},
		};
		const report = await factoryDroidUsageProvider.fetchUsage(
			{ provider: "factory-droid", credential: { type: "oauth", accessToken: "workos-token" } },
			capturingCtx,
		);
		expect(report?.limits.length).toBeGreaterThan(0);
		expect(seenUrl).toBe("https://api.factory.ai/api/billing/limits");
		expect(seenHeaders.authorization).toBe("Bearer workos-token");
		expect(seenHeaders["x-factory-client"]).toBe("cli");
	});

	it("returns null on http errors and missing tokens", async () => {
		const failing: UsageFetchContext = { fetch: async () => new Response("nope", { status: 403 }) };
		await expect(
			factoryDroidUsageProvider.fetchUsage(
				{ provider: "factory-droid", credential: { type: "oauth", accessToken: "workos-token" } },
				failing,
			),
		).resolves.toBeNull();
		await expect(
			factoryDroidUsageProvider.fetchUsage(
				{ provider: "factory-droid", credential: { type: "oauth", accessToken: "" } },
				ctx,
			),
		).resolves.toBeNull();
	});
});
