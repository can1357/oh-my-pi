import { describe, expect, it } from "bun:test";
import { consumeClaudeResetCredit, listClaudeResetCredits, type UsageResetCredit } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

interface CapturedCall {
	url: string;
	method: string;
	body?: unknown;
}

function json(status: number, payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function recordingFetch(handler: (url: URL, init?: RequestInit) => Response): {
	fetch: FetchImpl;
	calls: CapturedCall[];
} {
	const calls: CapturedCall[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({
			url: rawUrl,
			method: init?.method ?? "GET",
			...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
		});
		return handler(new URL(rawUrl), init);
	}) as FetchImpl;
	return { fetch, calls };
}

const CEDAR_CREDIT: UsageResetCredit = {
	id: "grant_1",
	program: "cedar_ember",
	remainingCount: 2,
	usable: true,
	requiresLimit: false,
	clears: ["anthropic:5h", "anthropic:7d:opus"],
	blocking: [],
	usedFractions: { "anthropic:5h": 1 },
};

function cedarPayload() {
	return {
		five_hour: null,
		cedar_ember: {
			eligible: true,
			at_limit: true,
			exhausted: ["five_hour"],
			grants: [
				{
					id: "grant_1",
					label: "Anytime reset",
					resets_total: 3,
					resets_left: 2,
					starts_at: "2026-09-01T00:00:00Z",
					ends_at: "2099-10-01T00:00:00Z",
					clears: ["five_hour", "seven_day_opus", "seven_day_cowork"],
					paused: false,
					usable_now: true,
					use_requires_limit: false,
					percent_used: { five_hour: 100, seven_day_cowork: 81 },
					blocking: ["seven_day"],
				},
			],
			next_grant_id: "grant_1",
			weekly_resets_at: "2099-09-28T00:00:00Z",
			cooldown_until: null,
		},
	};
}

describe("listClaudeResetCredits", () => {
	it("prefers Cedar and normalizes counts, eligibility, expiry, and covered windows", async () => {
		const { fetch, calls } = recordingFetch(() => json(200, cedarPayload()));
		const result = await listClaudeResetCredits({ accessToken: "token", orgId: "org_1", fetch });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
		expect(result).toEqual({
			availableCount: 2,
			redeemableCount: 2,
			nextCreditId: "grant_1",
			eligible: true,
			credits: [
				{
					id: "grant_1",
					title: "Anytime reset",
					program: "cedar_ember",
					remainingCount: 2,
					usable: true,
					requiresLimit: false,
					clears: ["anthropic:5h", "anthropic:7d:opus", "anthropic:reset:seven_day_cowork"],
					blocking: ["anthropic:7d"],
					usedFractions: { "anthropic:5h": 1, "anthropic:reset:seven_day_cowork": 0.81 },
					grantedAt: "2026-09-01T00:00:00.000Z",
					expiresAt: "2099-10-01T00:00:00.000Z",
					status: "available",
				},
			],
			orgId: "org_1",
			baseUrl: "https://api.anthropic.com/api/oauth",
		});
	});

	it("falls back to the Juniper reset arm without claiming a weekly reset exists", async () => {
		const { fetch, calls } = recordingFetch(url => {
			if (url.searchParams.has("cedar_ember")) {
				return json(200, {
					five_hour: null,
					cedar_ember: { eligible: false, ineligible_reason: "no_grant", grants: [] },
				});
			}
			return json(200, {
				five_hour: null,
				juniper_tide: {
					eligible: true,
					in_experiment: true,
					arm: "reset",
					available: true,
					next_available_at: null,
					weekly_resets_at: "2099-09-28T00:00:00Z",
					resets_per_week: 1,
				},
			});
		});
		const result = await listClaudeResetCredits({ accessToken: "token", orgId: "org_1", fetch });

		expect(calls.map(call => new URL(call.url).search)).toEqual([
			"?cedar_ember=1&skip_spend=1",
			"?at_wall=1&skip_spend=1",
		]);
		expect(result).toMatchObject({
			availableCount: 1,
			redeemableCount: 1,
			nextCreditId: "juniper_tide",
			eligible: true,
			credits: [
				{
					id: "juniper_tide",
					program: "juniper_tide",
					remainingCount: 1,
					usable: true,
					requiresLimit: true,
					clears: ["anthropic:5h"],
					expiresAt: "2099-09-28T00:00:00.000Z",
				},
			],
		});
	});

	it("keeps authoritative empty and malformed discovery distinguishable", async () => {
		const empty = recordingFetch(() => json(200, { five_hour: null }));
		expect(await listClaudeResetCredits({ accessToken: "token", fetch: empty.fetch })).toMatchObject({
			availableCount: 0,
			redeemableCount: 0,
			eligible: false,
			credits: [],
		});

		const malformed = recordingFetch(url =>
			url.searchParams.has("cedar_ember")
				? json(200, { cedar_ember: { eligible: true, grants: [{ id: "broken" }] } })
				: json(200, { juniper_tide: { eligible: "yes" } }),
		);
		expect(await listClaudeResetCredits({ accessToken: "token", fetch: malformed.fetch })).toBeNull();
	});
});

describe("consumeClaudeResetCredit", () => {
	it("resolves the organization UUID and sends the Cedar idempotency body once", async () => {
		const { fetch, calls } = recordingFetch((url, init) => {
			if (url.pathname.endsWith("/profile")) {
				return json(200, {
					account: { uuid: "account_not_the_org" },
					organization: { uuid: "org_real" },
				});
			}
			expect(init?.method).toBe("POST");
			return json(200, { result: "reset", resets_left: 1 });
		});
		const result = await consumeClaudeResetCredit({
			accessToken: "token",
			fetch,
			credit: CEDAR_CREDIT,
			redeemRequestId: "request_123",
		});

		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toBe("https://api.anthropic.com/api/organizations/org_real/reset_rate_limits");
		expect(calls[1]?.body).toEqual({
			program: "cedar_ember",
			grant_id: "grant_1",
			request_id: "request_123",
		});
		expect(result).toMatchObject({
			ok: true,
			code: "reset",
			cleared: ["anthropic:5h", "anthropic:7d:opus"],
		});
	});

	it("sends Juniper without an idempotency key and reports its 5h-only clear", async () => {
		const { fetch, calls } = recordingFetch(() => json(200, { result: "reset" }));
		const result = await consumeClaudeResetCredit({
			accessToken: "token",
			orgId: "org_1",
			fetch,
			redeemRequestId: "must_not_be_sent",
			credit: {
				id: "juniper_tide",
				program: "juniper_tide",
				remainingCount: 1,
				usable: true,
				clears: ["anthropic:5h"],
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({ program: "juniper_tide" });
		expect(result).toMatchObject({ ok: true, code: "reset", cleared: ["anthropic:5h"] });
	});

	it("normalizes known business outcomes and preserves unknown future outcomes", async () => {
		const outcomes = ["already_used", "not_limited", "future_outcome"];
		const { fetch } = recordingFetch(() => json(200, { result: outcomes.shift(), reason: "server_reason" }));
		const alreadyUsed = await consumeClaudeResetCredit({
			accessToken: "token",
			orgId: "org_1",
			fetch,
			credit: CEDAR_CREDIT,
		});
		const notLimited = await consumeClaudeResetCredit({
			accessToken: "token",
			orgId: "org_1",
			fetch,
			credit: CEDAR_CREDIT,
		});
		const future = await consumeClaudeResetCredit({
			accessToken: "token",
			orgId: "org_1",
			fetch,
			credit: CEDAR_CREDIT,
		});

		expect(alreadyUsed).toMatchObject({ ok: false, code: "already_redeemed", reason: "server_reason" });
		expect(notLimited).toMatchObject({ ok: false, code: "nothing_to_reset", reason: "server_reason" });
		expect(future).toMatchObject({ ok: false, code: "future_outcome", reason: "server_reason" });
	});

	it("never reports success for malformed or non-2xx claim responses", async () => {
		const malformed = recordingFetch(() => json(200, {}));
		expect(
			await consumeClaudeResetCredit({
				accessToken: "token",
				orgId: "org_1",
				fetch: malformed.fetch,
				credit: CEDAR_CREDIT,
			}),
		).toMatchObject({ ok: false, code: "malformed_response", status: 200 });

		const failed = recordingFetch(() => json(503, { result: "reset" }));
		expect(
			await consumeClaudeResetCredit({
				accessToken: "token",
				orgId: "org_1",
				baseUrl: "https://mirror.example/claude/v1",
				fetch: failed.fetch,
				credit: CEDAR_CREDIT,
			}),
		).toMatchObject({ ok: false, code: "http_503", status: 503 });
		expect(failed.calls.map(call => call.url)).toEqual([
			"https://mirror.example/claude/api/organizations/org_1/reset_rate_limits",
		]);
	});
});

describe("Claude usage reset integration", () => {
	it("returns reset inventory even when Claude reports no usage limits", async () => {
		const { fetch } = recordingFetch(() => json(200, cedarPayload()));
		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "token",
					accountId: "account_1",
					email: "user@example.com",
					orgId: "org_1",
				},
			},
			{ fetch },
		);

		expect(report?.limits).toEqual([]);
		expect(report?.resetCredits).toMatchObject({ availableCount: 2, nextCreditId: "grant_1" });
	});

	it("populates resetCredits while retaining ordinary spend and model-scoped limits", async () => {
		const { fetch, calls } = recordingFetch(() =>
			json(200, {
				five_hour: { utilization: 25, resets_at: "2099-09-23T00:00:00Z" },
				limits: [
					{
						kind: "weekly_scoped",
						percent: 61,
						resets_at: "2099-09-28T00:00:00Z",
						scope: { model: { display_name: "Fable" } },
					},
				],
				spend: {
					enabled: true,
					used: { amount_minor: 1250, currency: "USD", exponent: 2 },
					limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
				},
				cedar_ember: cedarPayload().cedar_ember,
			}),
		);
		const context: UsageFetchContext = { fetch };
		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "token",
					accountId: "account_1",
					email: "user@example.com",
					orgId: "org_1",
				},
			},
			context,
		);

		expect(report?.resetCredits).toMatchObject({ availableCount: 2, nextCreditId: "grant_1" });
		expect(calls).toHaveLength(1);
		expect(report?.limits.find(limit => limit.id === "anthropic:extra")?.amount.used).toBe(12.5);
		expect(report?.limits.find(limit => limit.id === "anthropic:7d:fable")?.amount.usedFraction).toBe(0.61);
	});

	it("keeps the full usage report when reset discovery fails", async () => {
		const { fetch } = recordingFetch(url => {
			if (url.search !== "") return json(503, { error: "unavailable" });
			return json(200, {
				five_hour: { utilization: 25, resets_at: "2099-09-23T00:00:00Z" },
				spend: {
					enabled: true,
					used: { amount_minor: 1250, currency: "USD", exponent: 2 },
					limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
				},
			});
		});
		const report = await claudeUsageProvider.fetchUsage(
			{
				provider: "anthropic",
				credential: {
					type: "oauth",
					accessToken: "token",
					accountId: "account_1",
					email: "user@example.com",
				},
			},
			{ fetch },
		);

		expect(report?.resetCredits).toBeUndefined();
		expect(report?.limits.map(limit => limit.id)).toEqual(["anthropic:5h", "anthropic:extra"]);
	});
});
