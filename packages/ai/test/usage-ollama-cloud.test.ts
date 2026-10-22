import { describe, expect, it } from "bun:test";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { ollamaCloudUsageProvider, ollamaUsageProvider } from "@oh-my-pi/pi-ai/usage/ollama";

function ctxWith(payload: unknown, status = 200): { ctx: UsageFetchContext; calls: () => number } {
	let calls = 0;
	return {
		ctx: {
			fetch: (async (_input: string | URL | Request) => {
				calls++;
				return new Response(status === 200 ? JSON.stringify(payload) : "nope", { status });
			}) as unknown as typeof fetch,
			logger: undefined,
		} as unknown as UsageFetchContext,
		calls: () => calls,
	};
}

function params(provider: "ollama" | "ollama-cloud", apiKey?: string): UsageFetchParams {
	return {
		provider,
		credential: { type: "api_key", apiKey: apiKey ?? "" },
	};
}

const PAYLOAD = {
	activity: { cost: "12.34", period: { type: "last_4_weeks" } },
	limits: {
		session: { usage: 0.352, models: [{ name: "glm-5.3-flash", request_count: 458 }] },
		weekly: { usage: 0.215, models: [{ name: "glm-5.3-flash", request_count: 458 }] },
	},
};

describe("ollama-cloud usage provider", () => {
	it("maps session/weekly fractions to percent limits", async () => {
		const { ctx, calls } = ctxWith(PAYLOAD);
		const report = await ollamaCloudUsageProvider.fetchUsage!(params("ollama-cloud", "ok-key"), ctx);
		expect(calls()).toBe(1);
		expect(report).not.toBeNull();
		const limits = report!.limits;
		expect(limits).toHaveLength(2);
		expect(limits[0].id).toBe("ollama-account:5h");
		expect(limits[0].label).toBe("Ollama 5 Hour");
		expect(limits[0].amount.usedFraction).toBeCloseTo(0.352);
		expect(limits[0].amount.unit).toBe("percent");
		expect(limits[0].status).toBe("ok");
		expect(limits[1].id).toBe("ollama-account:7d");
		expect(limits[1].label).toBe("Ollama 7 Day");
		expect(limits[1].amount.usedFraction).toBeCloseTo(0.215);
	});

	it("flags exhausted and warning statuses", async () => {
		const { ctx } = ctxWith({
			limits: {
				session: { usage: 1 },
				weekly: { usage: 0.93 },
			},
		});
		const report = await ollamaCloudUsageProvider.fetchUsage!(params("ollama-cloud", "k"), ctx);
		expect(report!.limits[0].status).toBe("exhausted");
		expect(report!.limits[1].status).toBe("warning");
	});

	it("keeps top consumers as notes", async () => {
		const { ctx } = ctxWith(PAYLOAD);
		const report = await ollamaCloudUsageProvider.fetchUsage!(params("ollama-cloud", "k"), ctx);
		expect(report!.limits[0].notes?.[0]).toContain("glm-5.3-flash x458");
	});

	it("returns null on non-2xx responses", async () => {
		const { ctx } = ctxWith(PAYLOAD, 401);
		const report = await ollamaCloudUsageProvider.fetchUsage!(params("ollama-cloud", "k"), ctx);
		expect(report).toBeNull();
	});

	it("does not hit the network for local ollama", async () => {
		const { ctx, calls } = ctxWith(PAYLOAD);
		const report = await ollamaUsageProvider.fetchUsage!(params("ollama", "k"), ctx);
		expect(calls()).toBe(0);
		expect(report!.limits).toHaveLength(0);
	});

	it("supports() routes by provider id", () => {
		expect(ollamaCloudUsageProvider.supports!(params("ollama-cloud", "k"))).toBe(true);
		expect(ollamaCloudUsageProvider.supports!(params("ollama", "k"))).toBe(false);
		expect(ollamaUsageProvider.supports!(params("ollama-cloud", "k"))).toBe(false);
	});
});
