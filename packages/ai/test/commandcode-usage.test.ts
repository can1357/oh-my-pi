import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resolveUsedFraction, type UsageFetchContext, type UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { commandCodeUsageProvider } from "@oh-my-pi/pi-ai/usage/commandcode";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";

/** Payloads mirror live answers from api.commandcode.ai (2026-09-18, GOAT plan). */
const CREDITS_PAYLOAD = {
	credits: {
		belowThreshold: false,
		creditThreshold: 0,
		monthlyCredits: 3.8699544985,
		purchasedCredits: 0,
		freeCredits: 0,
	},
	windowLimits: {
		limited: true,
		exceeded: null,
		fiveHour: { used: 0.035461188, cap: 14, exceeded: false, resetAt: 1789715985486 },
		weekly: { used: 0.20421366, cap: 35, exceeded: false, resetAt: 1790261658795 },
	},
};

const SUBSCRIPTION_PAYLOAD = {
	success: true,
	data: {
		id: "sub_test",
		status: "active",
		planId: "individual-goat",
		cancelAtPeriodEnd: false,
		currentPeriodStart: "2026-08-19T03:16:26.000Z",
		currentPeriodEnd: "2026-09-19T03:16:26.000Z",
	},
};

const WHOAMI_PAYLOAD = {
	success: true,
	user: { id: "c5f15105-1d38-4b6b-a7a2-64ae33d49f95", name: "tester", email: "user@example.com", userName: "tester" },
	org: null,
};

type Route = { path: string; body: unknown; status?: number };

const ROUTES: Route[] = [
	{ path: "/alpha/whoami", body: WHOAMI_PAYLOAD },
	{ path: "/alpha/billing/credits", body: CREDITS_PAYLOAD },
	{ path: "/alpha/billing/subscriptions", body: SUBSCRIPTION_PAYLOAD },
];

type SeenRequest = { url: string; headers: Record<string, string> };

function makeContext(routes: Route[] = ROUTES, seen: SeenRequest[] = []): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		const route = routes.find(candidate => url.includes(candidate.path));
		if (!route) throw new Error(`unexpected request: ${url}`);
		return new Response(JSON.stringify(route.body), {
			status: route.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

/** Same routes with one path replaced by a scenario-specific answer. */
function withRoute(path: string, body: unknown, status?: number): Route[] {
	return [...ROUTES.filter(route => route.path !== path), { path, body, ...(status !== undefined ? { status } : {}) }];
}

function makeParams(overrides: Partial<UsageFetchParams> = {}): UsageFetchParams {
	return {
		provider: "commandcode",
		credential: { type: "api_key", apiKey: "user_test_key" },
		...overrides,
	};
}

describe("Command Code usage provider", () => {
	it("maps the rolling windows and the monthly credit pool for the stored key", async () => {
		const seen: SeenRequest[] = [];
		const report = await commandCodeUsageProvider.fetchUsage(makeParams(), makeContext(ROUTES, seen));

		// Identity is read first so a team account's quota calls can be scoped.
		expect(seen.map(request => request.url)).toEqual([
			"https://api.commandcode.ai/alpha/whoami",
			"https://api.commandcode.ai/alpha/billing/credits",
			"https://api.commandcode.ai/alpha/billing/subscriptions",
		]);
		for (const request of seen) expect(request.headers.Authorization).toBe("Bearer user_test_key");

		expect(report?.provider).toBe("commandcode");
		expect(report?.metadata).toMatchObject({
			email: "user@example.com",
			accountId: "c5f15105-1d38-4b6b-a7a2-64ae33d49f95",
			planId: "individual-goat",
		});

		const fiveHour = report?.limits.find(limit => limit.id === "commandcode:5h");
		expect(fiveHour?.label).toBe("5 Hour");
		expect(fiveHour?.window).toMatchObject({
			id: "5h",
			label: "5 Hour",
			durationMs: 5 * 60 * 60 * 1000,
			resetsAt: 1789715985486,
		});
		expect(fiveHour?.amount).toEqual({
			used: 0.035461188,
			limit: 14,
			remaining: 13.964538812,
			usedFraction: 0.035461188 / 14,
			remainingFraction: 1 - 0.035461188 / 14,
			unit: "credits",
		});
		expect(fiveHour?.status).toBe("ok");

		// The weekly cap is half the monthly allowance, so it is not scaled from
		// the monthly balance — only the API's own number is reported.
		const weekly = report?.limits.find(limit => limit.id === "commandcode:7d");
		expect(weekly?.amount.limit).toBe(35);
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);

		// `monthlyCredits` is what remains; the allowance comes from the plan
		// table, and the billing period supplies the reset.
		const monthly = report?.limits.find(limit => limit.id === "commandcode:monthly");
		expect(monthly?.amount.limit).toBe(70);
		expect(monthly?.amount.remaining).toBe(3.8699544985);
		expect(monthly?.amount.used).toBeCloseTo(66.1300455015, 6);
		expect(resolveUsedFraction(monthly!)).toBeCloseTo(66.1300455015 / 70, 9);
		expect(monthly?.status).toBe("warning");
		expect(monthly?.window?.resetsAt).toBe(Date.parse("2026-09-19T03:16:26.000Z"));
		expect(monthly?.window?.durationMs).toBe(
			Date.parse("2026-09-19T03:16:26.000Z") - Date.parse("2026-08-19T03:16:26.000Z"),
		);
	});

	it("scopes the quota calls to the account's organization", async () => {
		const seen: SeenRequest[] = [];
		await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeContext(
				withRoute("/alpha/whoami", { ...WHOAMI_PAYLOAD, org: { id: "org_123", login: "acme", name: "Acme" } }),
				seen,
			),
		);

		expect(seen[1]?.url).toBe("https://api.commandcode.ai/alpha/billing/credits?orgId=org_123");
		expect(seen[2]?.url).toBe("https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_123");
	});

	it("folds purchased and free credits into the monthly pool", async () => {
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeContext(
				withRoute("/alpha/billing/credits", {
					credits: { belowThreshold: true, monthlyCredits: 5, purchasedCredits: 10, freeCredits: 2.5 },
					windowLimits: null,
				}),
			),
		);

		const monthly = report?.limits.find(limit => limit.id === "commandcode:monthly");
		expect(monthly?.amount).toMatchObject({ limit: 82.5, remaining: 17.5, used: 65 });
		expect(monthly?.notes).toEqual(["Includes 12.50 purchased/free credits", "Below the low-credit threshold"]);
	});

	it("reports a remaining-only monthly limit for a plan the table predates", async () => {
		// Inventing a cap here would draw a quota bar against an allowance the
		// account may not have; the balance is the only fact upstream states.
		const report = await commandCodeUsageProvider.fetchUsage(
			makeParams(),
			makeContext(
				withRoute("/alpha/billing/subscriptions", {
					success: true,
					data: { planId: "individual-future", currentPeriodEnd: "2026-10-19T03:16:26.000Z" },
				}),
			),
		);

		const monthly = report?.limits.find(limit => limit.id === "commandcode:monthly");
		expect(monthly?.amount).toEqual({ remaining: 3.8699544985, unit: "credits" });
		expect(resolveUsedFraction(monthly!)).toBeUndefined();
		expect(monthly?.status).toBe("unknown");
		expect(monthly?.window?.resetsAt).toBe(Date.parse("2026-10-19T03:16:26.000Z"));
	});

	it("purges the cached report when the key was revoked", async () => {
		const error = await commandCodeUsageProvider
			.fetchUsage(makeParams(), makeContext(withRoute("/alpha/billing/credits", {}, 401)))
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(ProviderHttpError);
		expect((error as ProviderHttpError).status).toBe(401);
	});

	it("ignores other providers, OAuth credentials, and a non-canonical base URL", async () => {
		const seen: SeenRequest[] = [];
		const ctx = makeContext(ROUTES, seen);

		expect(await commandCodeUsageProvider.fetchUsage(makeParams({ provider: "anthropic" }), ctx)).toBeNull();
		expect(
			await commandCodeUsageProvider.fetchUsage(
				makeParams({ credential: { type: "oauth", accessToken: "token" } }),
				ctx,
			),
		).toBeNull();
		// The configured base URL points at the inference host; sending the key
		// to `/alpha/*` there would fail and disclose it off-site.
		expect(
			await commandCodeUsageProvider.fetchUsage(makeParams({ baseUrl: "https://gateway.internal/provider" }), ctx),
		).toBeNull();
		expect(seen).toHaveLength(0);
	});
});
