import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { clinePassUsageProvider } from "@oh-my-pi/pi-ai/usage/cline-pass";

const CREDENTIAL: UsageFetchParams["credential"] = {
	type: "api_key",
	apiKey: "cline-test-key",
};

const USAGE_PAYLOAD = {
	success: true,
	data: {
		limits: [
			{ type: "five_hour", percentUsed: 1, resetsAt: "2026-08-07T02:50:50.492Z" },
			{ type: "weekly", percentUsed: 92, resetsAt: "2026-08-13T21:50:50.494Z" },
			{ type: "monthly", percentUsed: 100, resetsAt: "2026-09-05T21:50:50.497Z" },
		],
	},
};

const IDENTITY_PAYLOAD = {
	success: true,
	data: {
		id: "usr-test",
		email: "user@example.com",
		displayName: "Cline User",
	},
};

function makeContext(
	payload: unknown,
	status = 200,
	requests: Array<{ url: string; init?: RequestInit }> = [],
	identityPayload: unknown = IDENTITY_PAYLOAD,
	identityStatus = 200,
): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		requests.push({ url, init });
		const isIdentityRequest = url.endsWith("/users/me");
		return new Response(JSON.stringify(isIdentityRequest ? identityPayload : payload), {
			status: isIdentityRequest ? identityStatus : status,
			headers: { "Content-Type": "application/json" },
		});
	};
	return { fetch };
}

function makeParams(overrides: Partial<UsageFetchParams> = {}): UsageFetchParams {
	return {
		provider: "cline-pass",
		credential: CREDENTIAL,
		...overrides,
	};
}

describe("ClinePass usage provider", () => {
	it("fetches and normalizes the subscription's rolling quota windows with an API key", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const report = await clinePassUsageProvider.fetchUsage(makeParams(), makeContext(USAGE_PAYLOAD, 200, requests));

		expect(requests).toHaveLength(2);
		expect(requests.map(request => request.url)).toEqual([
			"https://api.cline.bot/api/v1/users/me/plan/usage-limits",
			"https://api.cline.bot/api/v1/users/me",
		]);
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer cline-test-key");
		expect(report?.provider).toBe("cline-pass");
		expect(report?.metadata).toMatchObject({ email: "user@example.com", accountId: "usr-test" });
		expect(report?.limits.map(limit => limit.scope.windowId)).toEqual(["5h", "7d", "30d"]);
		expect(report?.limits.map(limit => limit.window?.label)).toEqual(["5 Hour", "Weekly", "Monthly"]);
		expect(report?.limits.map(limit => limit.amount.usedFraction)).toEqual([0.01, 0.92, 1]);
		expect(report?.limits.map(limit => limit.status)).toEqual(["ok", "warning", "exhausted"]);
		expect(report?.limits[0]?.amount).toMatchObject({
			used: 1,
			limit: 100,
			remaining: 99,
			remainingFraction: 0.99,
			unit: "percent",
		});
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse("2026-08-07T02:50:50.492Z"));
	});

	it("uses a configured provider base URL", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		await clinePassUsageProvider.fetchUsage(
			makeParams({ baseUrl: "https://cline.example/api/v1/" }),
			makeContext(USAGE_PAYLOAD, 200, requests),
		);

		expect(requests.map(request => request.url)).toEqual([
			"https://cline.example/api/v1/users/me/plan/usage-limits",
			"https://cline.example/api/v1/users/me",
		]);
	});

	it("ignores malformed and unknown quota windows", async () => {
		const report = await clinePassUsageProvider.fetchUsage(
			makeParams(),
			makeContext({
				data: {
					limits: [
						{ type: "daily", percentUsed: 25 },
						{ type: "weekly", percentUsed: "25" },
						{ type: "monthly", percentUsed: 7 },
					],
				},
			}),
		);

		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]?.scope.windowId).toBe("30d");
	});

	it("keeps quota reporting available when optional account identity lookup fails", async () => {
		const report = await clinePassUsageProvider.fetchUsage(
			makeParams(),
			makeContext(USAGE_PAYLOAD, 200, [], { error: "unavailable" }, 500),
		);

		expect(report?.limits).toHaveLength(3);
		expect(report?.metadata?.email).toBeUndefined();
		expect(report?.metadata?.accountId).toBeUndefined();
	});

	it("returns no report when the response contains no usable limits", async () => {
		const report = await clinePassUsageProvider.fetchUsage(makeParams(), makeContext({ data: { limits: [] } }));
		expect(report).toBeNull();
	});

	it("surfaces authentication failures for credential health checks", async () => {
		await expect(
			clinePassUsageProvider.fetchUsage(makeParams(), makeContext({ error: "unauthorized" }, 401)),
		).rejects.toThrow("ClinePass usage endpoint returned 401");
	});

	it("supports only ClinePass API-key credentials", () => {
		expect(clinePassUsageProvider.supports?.(makeParams())).toBe(true);
		expect(clinePassUsageProvider.supports?.(makeParams({ provider: "openai" }))).toBe(false);
		expect(
			clinePassUsageProvider.supports?.(makeParams({ credential: { type: "oauth", accessToken: "token" } })),
		).toBe(false);
		expect(clinePassUsageProvider.validatesCredentials).toBe(true);
	});
});
