import { describe, expect, it } from "bun:test";

import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { commandcodeUsageProvider } from "@oh-my-pi/pi-ai/usage/commandcode";

const FULL_WHOAMI = {
	org: { id: "org_123", login: "acme" },
	user: { userName: "jdoe", keyName: "my-key" },
};

const FULL_CREDITS = {
	credits: { monthlyCredits: 100, purchasedCredits: 25, freeCredits: 5 },
	windowLimits: {
		// Seconds on purpose: the provider must normalize to epoch milliseconds.
		fiveHour: { used: 30, cap: 100, resetAt: 1780000000 },
		weekly: { used: 200, cap: 500, resetAt: 1780000000000 },
	},
};

const FULL_SUBSCRIPTIONS = {
	data: {
		planId: "pro",
		status: "active",
		currentPeriodStart: "2026-08-10T00:00:00.000Z",
		currentPeriodEnd: "2026-09-10T00:00:00.000Z",
	},
};

const FULL_SUMMARY = {
	data: { totalCost: 42.5, totalCount: 1000, totalTokens: 123456 },
};

interface RouteConfig {
	whoami?: unknown;
	credits?: unknown;
	subscriptions?: unknown;
	summary?: unknown;
	whoamiStatus?: number;
	creditsStatus?: number;
	subscriptionsStatus?: number;
	summaryStatus?: number;
}

interface SeenRequest {
	url: string;
	authorization: string | null;
}

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "commandcode-test-key",
	};
}

function makeCtx(routes: RouteConfig = {}): { ctx: UsageFetchContext; seen: SeenRequest[] } {
	const seen: SeenRequest[] = [];
	const pick = (url: string): { payload: unknown; status: number } => {
		if (url.includes("/alpha/whoami")) {
			return { payload: routes.whoami ?? FULL_WHOAMI, status: routes.whoamiStatus ?? 200 };
		}
		if (url.includes("/alpha/billing/credits")) {
			return { payload: routes.credits ?? FULL_CREDITS, status: routes.creditsStatus ?? 200 };
		}
		if (url.includes("/alpha/billing/subscriptions")) {
			return {
				payload: routes.subscriptions ?? FULL_SUBSCRIPTIONS,
				status: routes.subscriptionsStatus ?? 200,
			};
		}
		if (url.includes("/alpha/usage/summary")) {
			return { payload: routes.summary ?? FULL_SUMMARY, status: routes.summaryStatus ?? 200 };
		}
		return { payload: { message: "not found" }, status: 404 };
	};
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		const headers = new Headers(init?.headers as HeadersInit | undefined);
		seen.push({ url, authorization: headers.get("authorization") });
		const { payload, status } = pick(url);
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { ctx: { fetch }, seen };
}

function makeCtxThrow(): UsageFetchContext {
	const fetch: FetchImpl = async () => {
		throw new Error("Network error");
	};
	return { fetch };
}

function fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext) {
	return commandcodeUsageProvider.fetchUsage!(
		params,
		ctx,
	);
}

describe("commandcode usage provider", () => {
	it("happy path: full fixture returns 5h + 7d + remaining limits", async () => {
		const { ctx } = makeCtx();
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(l => l.id)).toEqual([
			"commandcode:credits:5h",
			"commandcode:credits:7d",
			"commandcode:credits:remaining",
		]);
		expect(report!.limits.map(l => l.label)).toEqual([
			"Command Code 5h Credit Quota",
			"Command Code Weekly Credit Quota",
			"Command Code Credits",
		]);
		expect(report!.limits.map(l => l.scope.windowId)).toEqual(["5h", "7d", "billing-period"]);
		expect(report!.limits.map(l => l.window?.durationMs)).toEqual([
			5 * 60 * 60 * 1000,
			7 * 24 * 60 * 60 * 1000,
			31 * 24 * 60 * 60 * 1000,
		]);
	});

	it("5h window: used/limit math, seconds resetAt normalized to ms", async () => {
		const { ctx } = makeCtx();
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		const fiveHour = report!.limits.find(l => l.id === "commandcode:credits:5h")!;
		expect(fiveHour.amount.used).toBe(30);
		expect(fiveHour.amount.limit).toBe(100);
		expect(fiveHour.amount.remaining).toBe(70);
		expect(fiveHour.amount.usedFraction).toBeCloseTo(0.3, 10);
		expect(fiveHour.amount.remainingFraction).toBeCloseTo(0.7, 10);
		expect(fiveHour.amount.unit).toBe("credits");
		expect(fiveHour.status).toBe("ok");
		// resetAt arrived in seconds; OMP windows use epoch milliseconds.
		expect(fiveHour.window?.resetsAt).toBe(1780000000000);
	});

	it("7d window: used/limit math, millisecond resetAt passes through", async () => {
		const { ctx } = makeCtx();
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		const weekly = report!.limits.find(l => l.id === "commandcode:credits:7d")!;
		expect(weekly.amount.used).toBe(200);
		expect(weekly.amount.limit).toBe(500);
		expect(weekly.amount.remaining).toBe(300);
		expect(weekly.amount.usedFraction).toBeCloseTo(0.4, 10);
		expect(weekly.amount.unit).toBe("credits");
		expect(weekly.status).toBe("ok");
		expect(weekly.window?.resetsAt).toBe(1780000000000);
	});

	it("remaining pool: dollar balance + summary spend, windowed by the billing period", async () => {
		const { ctx } = makeCtx();
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		const remaining = report!.limits.find(l => l.id === "commandcode:credits:remaining")!;
		// 100 monthly + 25 purchased + 5 free = 130 remaining; 42.5 spent.
		expect(remaining.amount.remaining).toBe(130);
		expect(remaining.amount.used).toBe(42.5);
		expect(remaining.amount.limit).toBe(172.5);
		expect(remaining.amount.usedFraction).toBeCloseTo(42.5 / 172.5, 10);
		expect(remaining.amount.unit).toBe("usd");
		expect(remaining.status).toBe("ok");
		expect(remaining.window?.resetsAt).toBe(Date.parse("2026-09-10T00:00:00.000Z"));
	});

	it("metadata carries endpoint, credential identity, and org/plan details", async () => {
		const { ctx } = makeCtx();
		const report = await fetchUsage(
			{
				provider: "commandcode",
				credential: { type: "api_key", apiKey: "k", accountId: "acc-1", email: "jdoe@acme.test" },
				signal: undefined,
			},
			ctx,
		);

		expect(report!.metadata).toMatchObject({
			endpoint: "https://api.commandcode.ai",
			accountId: "acc-1",
			email: "jdoe@acme.test",
			login: "acme",
			orgId: "org_123",
			keyName: "my-key",
			planType: "pro",
		});
	});

	it("orgId and billing-period start ride the downstream queries", async () => {
		const { ctx, seen } = makeCtx();
		await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		const credits = seen.find(r => r.url.includes("/alpha/billing/credits"))!;
		expect(credits.url).toContain("orgId=org_123");
		const summary = seen.find(r => r.url.includes("/alpha/usage/summary"))!;
		expect(summary.url).toContain("orgId=org_123");
		expect(summary.url).toContain("since=2026-08-10T00%3A00%3A00.000Z");
	});
	it("whoami without orgId still fetches billing endpoints", async () => {
		const { ctx, seen } = makeCtx({
			whoami: { user: { userName: "solo" }, org: null },
		});
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		expect(report).not.toBeNull();
		expect(seen.some(r => r.url.includes("/alpha/billing/credits"))).toBe(true);
		expect(seen.find(r => r.url.includes("/alpha/billing/credits"))!.url).not.toContain("orgId=");
		expect(report!.metadata?.login).toBe("solo");
	});



	it("whoami 401 throws ProviderHttpError so bad keys flag as invalid", async () => {
		const { ctx } = makeCtx({ whoamiStatus: 401 });
		const error = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		).then(
			() => null,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(401);
	});

	it("credits 403 is fatal like whoami", async () => {
		const { ctx } = makeCtx({ creditsStatus: 403 });
		const error = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		).then(
			() => null,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(403);
	});

	it("non-commandcode provider → returns null", async () => {
		const { ctx } = makeCtx();
		const report = await fetchUsage(
			{ provider: "openai", credential: makeCredential(), signal: undefined },
			ctx,
		);
		expect(report).toBeNull();
	});

	it("missing token → returns null", async () => {
		const { ctx } = makeCtx();
		const noKey = await fetchUsage(
			{
				provider: "commandcode",
				credential: { type: "api_key" } as UsageFetchParams["credential"],
				signal: undefined,
			},
			ctx,
		);
		expect(noKey).toBeNull();

		const noBearer = await fetchUsage(
			{
				provider: "commandcode",
				credential: { type: "oauth" } as UsageFetchParams["credential"],
				signal: undefined,
			},
			ctx,
		);
		expect(noBearer).toBeNull();
	});

	it("network error / thrown fetch → returns null", async () => {
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			makeCtxThrow(),
		);
		expect(report).toBeNull();
	});

	it("credits 500 but summary ok → null when nothing surfaceable remains", async () => {
		const { ctx, seen } = makeCtx({ creditsStatus: 500 });
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		// The credits outage skips windows and the remaining pool; the summary
		// fetch still ran rather than aborting the report.
		expect(seen.some(r => r.url.includes("/alpha/usage/summary"))).toBe(true);
		expect(report).toBeNull();
	});

	it("empty windows (used=0 cap=0) are skipped but the remaining pool survives", async () => {
		const { ctx } = makeCtx({
			credits: {
				credits: { monthlyCredits: 50 },
				windowLimits: { fiveHour: { used: 0, cap: 0 }, weekly: {} },
			},
		});
		const report = await fetchUsage(
			{ provider: "commandcode", credential: makeCredential(), signal: undefined },
			ctx,
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(l => l.id)).toEqual(["commandcode:credits:remaining"]);
		expect(report!.limits[0].amount.remaining).toBe(50);
		expect(report!.limits[0].amount.used).toBe(42.5);
		expect(report!.limits[0].amount.limit).toBe(92.5);
	});

	it("oauth accessToken is used as the Bearer token", async () => {
		const { ctx, seen } = makeCtx();
		const report = await fetchUsage(
			{
				provider: "commandcode",
				credential: { type: "oauth", accessToken: "oauth-token" },
				signal: undefined,
			},
			ctx,
		);

		expect(report).not.toBeNull();
		expect(seen.length).toBeGreaterThan(0);
		for (const request of seen) {
			expect(request.authorization).toBe("Bearer oauth-token");
		}
	});

	it("baseUrl with /provider/v1 still hits the origin /alpha endpoints", async () => {
		const { ctx, seen } = makeCtx();
		const report = await fetchUsage(
			{
				provider: "commandcode",
				credential: makeCredential(),
				baseUrl: "https://api.commandcode.ai/provider/v1",
				signal: undefined,
			},
			ctx,
		);

		expect(report).not.toBeNull();
		expect(seen[0].url).toBe("https://api.commandcode.ai/alpha/whoami");
	});

	it("supports() gates on provider plus a usable token", async () => {
		expect(
			commandcodeUsageProvider.supports!({
				provider: "commandcode",
				credential: makeCredential(),
			}),
		).toBe(true);
		expect(
			commandcodeUsageProvider.supports!({
				provider: "commandcode",
				credential: { type: "oauth", accessToken: "oauth-token" },
			}),
		).toBe(true);
		expect(
			commandcodeUsageProvider.supports!({
				provider: "commandcode",
				credential: { type: "oauth" } as UsageFetchParams["credential"],
			}),
		).toBe(false);
		expect(
			commandcodeUsageProvider.supports!({
				provider: "openai",
				credential: makeCredential(),
			}),
		).toBe(false);
	});
});
