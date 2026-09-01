import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
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

function makeCtx(payload: unknown, status = 200): UsageFetchContext {
	const fetch: FetchImpl = async () => {
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
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

	it("raw response preserved, endpoint recorded in metadata", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx(FULL_FIXTURE));
		expect(report?.raw).toEqual(FULL_FIXTURE);
		expect(report?.metadata?.endpoint).toBe("https://ollama.com/api/usage");
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
		expect(report?.notes?.length).toBeGreaterThan(0);
	});

	it("HTTP error response → returns null", async () => {
		const report = await ollamaCloudUsageProvider.fetchUsage(makeParams(), makeCtx({}, 401));
		expect(report).toBeNull();
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
