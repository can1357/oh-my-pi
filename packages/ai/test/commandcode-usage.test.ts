import { describe, expect, it } from "bun:test";

import { type } from "@oh-my-pi/omptype";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { isUsageLimitReached, scopedUsageLimits } from "../src/auth/usage-report";
import {
	type UsageFetchContext,
	type UsageFetchParams,
	type UsageLimit,
	type UsageReport,
	type UsageStatus,
	usageReportSchema,
} from "@oh-my-pi/pi-ai/usage";
import { commandCodeRankingStrategy, commandCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/commandcode";

function makeCredential(): UsageFetchParams["credential"] {
	return { type: "api_key", apiKey: "user_test" };
}

type Route = { status?: number; body: unknown };
type SeenRequest = { url: string; headers?: Record<string, string> };

function makeCtx(routes: Record<string, Route>, seen: SeenRequest[] = []): UsageFetchContext {
	const fetch: FetchImpl = async (url, init) => {
		const key = String(url);
		seen.push({ url: key, headers: init?.headers as Record<string, string> | undefined });
		const route = routes[new URL(key).pathname];
		if (!route) return new Response("{}", { status: 404 });
		const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
		return new Response(body, { status: route.status ?? 200, headers: { "content-type": "application/json" } });
	};
	return { fetch };
}

function makeParams(overrides: Partial<UsageFetchParams> = {}): UsageFetchParams {
	return { provider: "commandcode", credential: makeCredential(), ...overrides };
}

const FIVE_HOUR_RESET = 1_800_000_000_000;
const WEEKLY_RESET = 1_800_500_000_000;

const WINDOWED_ROUTES: Record<string, Route> = {
	"/alpha/whoami": {
		body: {
			success: true,
			data: {
				user: { id: "user_1", userName: "ada", email: "ada@example.com" },
				org: { id: "org_1", login: "acme" },
			},
		},
	},
	"/alpha/billing/credits": {
		body: {
			credits: { monthlyCredits: 12.5, purchasedCredits: 3, freeCredits: 0.5, planId: "individual-pro-v1" },
			windowLimits: {
				fiveHour: { used: 4, cap: 10, resetAt: FIVE_HOUR_RESET },
				weekly: { used: 3, cap: 100, exceeded: true, resetAt: WEEKLY_RESET },
			},
		},
	},
	"/alpha/billing/subscriptions": {
		body: {
			success: true,
			data: {
				status: "active",
				planId: "individual-goat",
				currentPeriodStart: "2026-10-15T05:10:24.000Z",
				currentPeriodEnd: "2026-11-15T05:10:24.000Z",
			},
		},
	},
};

describe("command code usage provider", () => {
	it("maps a windowed plan to 5-hour, weekly, monthly, and balance limits", async () => {
		const seen: SeenRequest[] = [];
		const report = await commandCodeUsageProvider.fetchUsage(makeParams(), makeCtx(WINDOWED_ROUTES, seen));

		expect(seen.map(request => request.url)).toEqual([
			"https://api.commandcode.ai/alpha/whoami",
			"https://api.commandcode.ai/alpha/billing/credits?orgId=org_1",
			"https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_1",
		]);
		for (const request of seen) {
			expect(request.headers?.Authorization).toBe("Bearer user_test");
			expect(request.headers?.Accept).toBe("application/json");
		}

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"commandcode:5h",
			"commandcode:7d",
			"commandcode:monthly",
			"commandcode:balance",
		]);

		const [fiveHour, weekly, monthly, balance] = report!.limits;
		expect(fiveHour).toMatchObject({
			label: "5-hour limit",
			scope: { provider: "commandcode", accountId: "user_1", orgId: "org_1", windowId: "5h", shared: true },
			window: { id: "5h", label: "5-hour", durationMs: 18_000_000, resetsAt: FIVE_HOUR_RESET },
			amount: { used: 4, limit: 10, usedFraction: 0.4, unit: "credits" },
			status: "ok",
		});
		expect(weekly).toMatchObject({
			label: "Weekly limit",
			scope: { orgId: "org_1", windowId: "7d" },
			window: { id: "7d", label: "Weekly", durationMs: 604_800_000, resetsAt: WEEKLY_RESET },
			amount: { used: 3, limit: 100, usedFraction: 0.03, unit: "credits" },
			status: "exhausted",
		});
		// 12.5 of the GOAT plan's 70-credit grant remains.
		expect(monthly).toMatchObject({
			label: "Monthly credits",
			scope: { provider: "commandcode", accountId: "user_1", orgId: "org_1", windowId: "monthly", shared: true },
			window: {
				id: "monthly",
				label: "Monthly",
				durationMs: Date.parse("2026-11-15T05:10:24.000Z") - Date.parse("2026-10-15T05:10:24.000Z"),
				resetsAt: Date.parse("2026-11-15T05:10:24.000Z"),
			},
			amount: { used: 57.5, limit: 70, remaining: 12.5, unit: "credits" },
			status: "ok",
		});
		expect(monthly!.amount.usedFraction).toBeCloseTo(57.5 / 70);
		expect(balance).toMatchObject({
			label: "Credit balance",
			scope: { provider: "commandcode", accountId: "user_1", orgId: "org_1", windowId: "balance", shared: true },
			amount: { remaining: 16, unit: "credits" },
		});
		expect(balance!.window).toBeUndefined();
		expect(report!.metadata).toMatchObject({
			accountId: "user_1",
			email: "ada@example.com",
			orgId: "org_1",
			orgName: "acme",
			planType: "individual-goat",
		});
	});

	it("sizes the monthly grant from monthlyCreditsGranted before the plan", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": { body: { credits: { monthlyCredits: 30, monthlyCreditsGranted: 120 } } },
			}),
		);
		const monthly = report!.limits.find(limit => limit.id === "commandcode:monthly");
		expect(monthly?.amount).toMatchObject({ used: 90, limit: 120, remaining: 30, usedFraction: 0.75 });
	});

	it("omits only the monthly limit when the grant or its billing period is unknown", async () => {
		const granted: Route = {
			body: {
				credits: { monthlyCredits: 30, monthlyCreditsGranted: 120 },
				windowLimits: { fiveHour: { used: 4, cap: 10 }, weekly: { used: 3, cap: 100 } },
			},
		};
		const cases: [name: string, routes: Record<string, Route>][] = [
			[
				"unknown plan",
				{
					...WINDOWED_ROUTES,
					"/alpha/billing/subscriptions": {
						body: {
							data: {
								planId: "individual-new-tier",
								currentPeriodStart: "2026-10-15T05:10:24.000Z",
								currentPeriodEnd: "2026-11-15T05:10:24.000Z",
							},
						},
					},
				},
			],
			[
				"subscription lookup fails",
				{ ...WINDOWED_ROUTES, "/alpha/billing/subscriptions": { status: 500, body: "{}" } },
			],
			[
				"subscription route denies the key",
				{ ...WINDOWED_ROUTES, "/alpha/billing/subscriptions": { status: 401, body: { success: false } } },
			],
			[
				"grant known but subscription lookup fails",
				{
					...WINDOWED_ROUTES,
					"/alpha/billing/credits": granted,
					"/alpha/billing/subscriptions": { status: 500, body: "{}" },
				},
			],
			[
				"grant known but no billing period",
				{
					...WINDOWED_ROUTES,
					"/alpha/billing/credits": granted,
					"/alpha/billing/subscriptions": { body: { data: { planId: "individual-goat" } } },
				},
			],
		];
		for (const [name, routes] of cases) {
			const report = await commandCodeUsageProvider.fetchUsage(makeParams(), makeCtx(routes));
			expect(
				report!.limits.map(limit => limit.id),
				name,
			).toEqual(["commandcode:5h", "commandcode:7d", "commandcode:balance"]);
		}
	});

	it("grades a window by used fraction when the API does not flag it exceeded", async () => {
		const cases: [used: number, expected: UsageStatus][] = [
			[8.9, "ok"],
			[9, "warning"],
			[10, "exhausted"],
		];
		for (const [used, expected] of cases) {
			const report = await commandCodeUsageProvider.fetchUsage(
				makeParams(),
				makeCtx({
					...WINDOWED_ROUTES,
					"/alpha/billing/credits": {
						body: {
							credits: { monthlyCredits: 1 },
							windowLimits: { fiveHour: { used, cap: 10 } },
						},
					},
				}),
			);
			expect(report!.limits[0]!.status, String(used)).toBe(expected);
		}
	});

	it("normalizes a seconds-precision reset timestamp to milliseconds", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": {
					body: {
						credits: { monthlyCredits: 1 },
						windowLimits: { fiveHour: { used: 1, cap: 10, resetAt: 1_790_000_000 } },
					},
				},
			}),
		);
		expect(report!.limits[0]!.window?.resetsAt).toBe(1_790_000_000_000);
	});

	it("emits a report the usage wire schema accepts when a window has no cap or reset time", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": {
					body: { credits: { monthlyCredits: 1 }, windowLimits: { fiveHour: { used: 1 } } },
				},
			}),
		);
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"commandcode:5h",
			"commandcode:monthly",
			"commandcode:balance",
		]);
		const validated = usageReportSchema(report);
		expect(validated instanceof type.errors ? validated.summary : "valid").toBe("valid");
	});

	it("reports only the balance for a pay-as-you-go account", async () => {
		const seen: SeenRequest[] = [];
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx(
				{
					"/alpha/whoami": { body: { user: { id: "user_2" } } },
					"/alpha/billing/credits": { body: { credits: { purchasedCredits: 5 } } },
				},
				seen,
			),
		);

		expect(seen.map(request => request.url)).toEqual([
			"https://api.commandcode.ai/alpha/whoami",
			"https://api.commandcode.ai/alpha/billing/credits",
		]);
		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]).toMatchObject({
			id: "commandcode:balance",
			amount: { remaining: 5, unit: "credits" },
		});
		expect(report!.metadata).toMatchObject({ accountId: "user_2" });
		expect(report!.limits[0]!.scope).not.toHaveProperty("orgId");
	});

	it("keeps a spent monthly grant from hard-blocking a credential with purchased credits", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({
				...WINDOWED_ROUTES,
				"/alpha/billing/credits": {
					body: {
						credits: { monthlyCredits: 0, monthlyCreditsGranted: 70, purchasedCredits: 25 },
						windowLimits: { fiveHour: { used: 4, cap: 10 }, weekly: { used: 3, cap: 100 } },
					},
				},
			}),
		);
		const monthly = report!.limits.find(limit => limit.id === "commandcode:monthly");
		expect(isUsageLimitReached(monthly ? [monthly] : [])).toBe(true);
		expect(isUsageLimitReached(scopedUsageLimits(commandCodeRankingStrategy, report!, {}))).toBe(false);
	});

	it("throws on a revoked key so the cached report is purged", async () => {
		await expect(
			commandCodeUsageProvider.fetchUsage(
				makeParams(),
				makeCtx({ "/alpha/whoami": { status: 401, body: { success: false, error: { code: "UNAUTHORIZED" } } } }),
			),
		).rejects.toMatchObject({ status: 401 });
	});

	it("keeps a key usable when a usage route answers 403", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ ...WINDOWED_ROUTES, "/alpha/billing/credits": { status: 403, body: { success: false } } }),
		);
		expect(report).toBeNull();
	});

	it("returns null when the credits endpoint fails transiently", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ ...WINDOWED_ROUTES, "/alpha/billing/credits": { status: 500, body: "{}" } }),
		);
		expect(report).toBeNull();
	});

	it("returns null when the identity or credit balance is missing", async () => {
		const cases: [name: string, routes: Record<string, Route>][] = [
			["no user id", { ...WINDOWED_ROUTES, "/alpha/whoami": { body: { user: {} } } }],
			["no balance fields", { ...WINDOWED_ROUTES, "/alpha/billing/credits": { body: { credits: {} } } }],
		];
		for (const [name, routes] of cases) {
			const report = await commandCodeUsageProvider.fetchUsage(makeParams(), makeCtx(routes));
			expect(report, name).toBeNull();
		}
	});

	it("sends every probe to the configured origin instead of the canonical host", async () => {
		const seen: SeenRequest[] = [];
		await commandCodeUsageProvider.fetchUsage(
			makeParams({ baseUrl: "https://proxy.example/provider/v1" }),
			makeCtx(WINDOWED_ROUTES, seen),
		);
		expect(seen.map(request => request.url)).toEqual([
			"https://proxy.example/alpha/whoami",
			"https://proxy.example/alpha/billing/credits?orgId=org_1",
			"https://proxy.example/alpha/billing/subscriptions?orgId=org_1",
		]);
	});

	it("returns null for credentials it has no bearer key for", async () => {
		const seen: SeenRequest[] = [];
		const oauth = await commandCodeUsageProvider.fetchUsage(
			makeParams({ credential: { type: "oauth" } as UsageFetchParams["credential"] }),
			makeCtx(WINDOWED_ROUTES, seen),
		);
		const keyless = await commandCodeUsageProvider.fetchUsage(
			makeParams({ credential: { type: "api_key" } }),
			makeCtx(WINDOWED_ROUTES, seen),
		);
		expect(oauth).toBeNull();
		expect(keyless).toBeNull();
		expect(seen).toHaveLength(0);
	});
});

describe("command code credential ranking", () => {
	it("picks the 5-hour and weekly limits by window id, not by position", () => {
		const limit = (windowId: string): UsageLimit => ({
			id: `commandcode:${windowId}`,
			label: windowId,
			scope: { provider: "commandcode", windowId },
			window: { id: windowId, label: windowId },
			amount: { unit: "credits" },
		});
		const report: UsageReport = {
			provider: "commandcode",
			fetchedAt: 0,
			limits: [limit("balance"), limit("7d"), limit("5h")],
		};
		const windows = commandCodeRankingStrategy.findWindowLimits(report);
		expect(windows.primary?.id).toBe("commandcode:5h");
		expect(windows.secondary?.id).toBe("commandcode:7d");
	});
});
