import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai/usage";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "@oh-my-pi/pi-ai/usage/ollama";

const FULL_FIXTURE = {
	activity: {
		cost: "1.68054",
		period: {
			type: "last_4_weeks",
			starting_at: "2026-08-10T00:00:00Z",
			ending_at: "2026-09-01T22:06:52.617643296Z",
		},
		models: [{ name: "kimi-k3", request_count: 47, cost: "1.68054" }],
	},
	limits: {
		monthly: {
			usage: 0.004,
			models: [{ name: "glm-5.3-flash", request_count: 147 }],
		},
	},
};

function makeCredential(overrides: Partial<UsageFetchParams["credential"]> = {}): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "ollama-test-key",
		...overrides,
	};
}

function makeParams(overrides: Partial<UsageFetchParams> = {}): UsageFetchParams {
	return {
		provider: "ollama-cloud",
		credential: makeCredential(),
		...overrides,
	};
}

interface RecordedRequest {
	url: string;
	init: RequestInit;
}

function makeCtx(payload: unknown, status = 200): UsageFetchContext & { requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetch: FetchImpl = async (input, init) => {
		requests.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
			init: init ?? {},
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, requests };
}

function makeCtxThrow(): UsageFetchContext {
	const fetch: FetchImpl = async () => {
		throw new Error("Network error");
	};
	return { fetch };
}

describe("ollama-cloud usage provider", () => {
	it("happy path: full fixture returns exactly 2 limits — monthly allowance and trailing spend", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(FULL_FIXTURE));
		expect(report).not.toBeNull();
		expect(report?.limits).toHaveLength(2);
		expect(report?.limits.map(limit => limit.id).sort()).toEqual(["ollama-cloud:activity", "ollama-cloud:monthly"]);
	});

	it("wire contract: GET https://ollama.com/api/usage with Authorization: Bearer <key> and Accept: application/json", async () => {
		const ctx = makeCtx(FULL_FIXTURE);
		await ollamaCloudUsageProvider.fetchUsage(makeParams(), ctx);
		expect(ctx.requests).toHaveLength(1);
		expect(ctx.requests[0]?.url).toBe("https://ollama.com/api/usage");
		const headers = new Headers(ctx.requests[0]?.init.headers);
		expect(headers.get("authorization")).toBe("Bearer ollama-test-key");
		expect(headers.get("accept")).toBe("application/json");
	});

	it("legacy unmigrated plan: session/weekly fractions map to 5h/7d percent limits", async () => {
		// Shape recorded in PR #10101 for accounts not migrated to monthly billing.
		const legacyFixture = {
			activity: { cost: "0.42", period: { type: "last_4_weeks" } },
			limits: {
				session: { usage: 0.03, models: [{ name: "glm-5.3-flash", request_count: 54 }] },
				weekly: { usage: 0.005, models: [{ name: "glm-5.3-flash", request_count: 458 }] },
			},
		};
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(legacyFixture));
		expect(report).not.toBeNull();
		expect(report?.limits.map(limit => limit.id).sort()).toEqual([
			"ollama-cloud:5h",
			"ollama-cloud:7d",
			"ollama-cloud:activity",
		]);
		const session = report?.limits.find(limit => limit.id === "ollama-cloud:5h");
		expect(session?.label).toBe("Ollama 5 Hour");
		expect(session?.amount.usedFraction).toBeCloseTo(0.03);
		expect(session?.amount.unit).toBe("percent");
		expect(session?.window?.durationMs).toBe(5 * 60 * 60 * 1000);
		expect(session?.notes).toEqual(["54 requests this period"]);
		const weekly = report?.limits.find(limit => limit.id === "ollama-cloud:7d");
		expect(weekly?.label).toBe("Ollama 7 Day");
		expect(weekly?.amount.usedFraction).toBeCloseTo(0.005);
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it("legacy plan: session at >= 0.9 → warning, at 1 → exhausted", async () => {
		const warning = await ollamaCloudUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ limits: { session: { usage: 0.91 } } }),
		);
		expect(warning?.limits.find(limit => limit.id === "ollama-cloud:5h")?.status).toBe("warning");
		const exhausted = await ollamaCloudUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ limits: { session: { usage: 1 } } }),
		);
		expect(exhausted?.limits.find(limit => limit.id === "ollama-cloud:5h")?.status).toBe("exhausted");
	});
	it("monthly limit: usedFraction mirrors the API fraction, status ok at low usage", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(FULL_FIXTURE));
		const monthly = report?.limits.find(limit => limit.id === "ollama-cloud:monthly");
		expect(monthly?.amount.usedFraction).toBeCloseTo(0.004);
		expect(monthly?.amount.unit).toBe("percent");
		expect(monthly?.amount.used).toBeCloseTo(0.4);
		expect(monthly?.status).toBe("ok");
		expect(monthly?.window?.id).toBe("monthly");
		expect(monthly?.scope.shared).toBe(true);
	});

	it("monthly limit: per-model request counts are folded into notes", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(FULL_FIXTURE));
		const monthly = report?.limits.find(limit => limit.id === "ollama-cloud:monthly");
		expect(monthly?.notes).toEqual(["147 requests this period"]);
	});

	it("monthly limit at >= 0.9 fraction → status warning; >= 1 → exhausted", async () => {
		const warning = await ollamaCloudUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ limits: { monthly: { usage: 0.92, models: [] } } }),
		);
		expect(warning?.limits.find(limit => limit.id === "ollama-cloud:monthly")?.status).toBe("warning");

		const exhausted = await ollamaCloudUsageProvider.fetchUsage(
			makeParams(),
			makeCtx({ limits: { monthly: { usage: 1, models: [] } } }),
		);
		expect(exhausted?.limits.find(limit => limit.id === "ollama-cloud:monthly")?.status).toBe("exhausted");
	});

	it("activity limit: cost parsed from string, duration derived from period timestamps", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(FULL_FIXTURE));
		const activity = report?.limits.find(limit => limit.id === "ollama-cloud:activity");
		expect(activity?.amount.used).toBeCloseTo(1.68054);
		expect(activity?.amount.unit).toBe("usd");
		const duration = activity?.window?.durationMs ?? 0;
		expect(duration).toBeGreaterThan(20 * 24 * 60 * 60 * 1000);
		expect(duration).toBeLessThan(28 * 24 * 60 * 60 * 1000);
	});

	it("activity limit: missing period timestamps fall back to 28-day window", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx({ activity: { cost: "0.5" } }));
		const activity = report?.limits.find(limit => limit.id === "ollama-cloud:activity");
		expect(activity?.window?.durationMs).toBe(28 * 24 * 60 * 60 * 1000);
	});

	it("monthly limit feeds resolveUsedFraction — the shared ranking/probe consumer", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(FULL_FIXTURE));
		const monthly = report?.limits.find(limit => limit.id === "ollama-cloud:monthly");
		expect(monthly).toBeDefined();
		// The auth-storage probe, dashboard card, and status line all rank on this
		// helper; a wrong amount mapping would surface there as a lost or inverted
		// percentage rather than a parse error.
		expect(resolveUsedFraction(monthly!)).toBeCloseTo(0.004);
	});

	it("non-ollama-cloud provider → returns null", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(
			makeParams({ provider: "ollama" }),
			makeCtx(FULL_FIXTURE),
		);
		expect(report).toBeNull();
	});

	it("missing api_key credential → stub report without limits (keeps account visible)", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(
			makeParams({ credential: { type: "oauth", accessToken: "tok" } }),
			makeCtx(FULL_FIXTURE),
		);
		expect(report).not.toBeNull();
		expect(report?.limits).toHaveLength(0);
	});

	it("transient HTTP error (500) → returns null, never throws", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx({}, 500));
		expect(report).toBeNull();
	});

	it("401 → throws ProviderHttpError so auth storage purges the stale last-good report", async () => {
		await expect(ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx({}, 401))).rejects.toMatchObject({
			name: "ProviderHttpError",
			status: 401,
		});
	});

	it("403 → throws ProviderHttpError so auth storage purges the stale last-good report", async () => {
		await expect(ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx({}, 403))).rejects.toMatchObject({
			name: "ProviderHttpError",
			status: 403,
		});
	});

	it("network error / thrown fetch → returns null", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtxThrow());
		expect(report).toBeNull();
	});

	it("malformed payload → returns null", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx("not-json-object"));
		expect(report).toBeNull();
	});

	it("empty limits object → returns null", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx({}));
		expect(report).toBeNull();
	});
});

describe("ollama (local) usage provider", () => {
	it("returns stub report with no limits — local engines expose no quota endpoint", async () => {
		const report = await ollamaUsageProvider.fetchUsage(makeParams({ provider: "ollama" }), makeCtx(FULL_FIXTURE));
		expect(report).not.toBeNull();
		expect(report?.limits).toHaveLength(0);
	});

	it("non-ollama provider → returns null", async () => {
		const report = await ollamaUsageProvider.fetchUsage(makeParams({ provider: "zai" }), makeCtx(FULL_FIXTURE));
		expect(report).toBeNull();
	});
});
