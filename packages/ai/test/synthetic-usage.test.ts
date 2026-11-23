import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { syntheticUsageProvider } from "@oh-my-pi/pi-ai/usage/synthetic";

const PLAN_FIXTURE = {
	planWeeklyLimit: {
		nextRegenAt: "2026-07-10T08:17:04.000Z",
		percentRemaining: 7.615,
		nextRegenPercent: 2,
	},
};

const SUBSCRIPTION_FIXTURE = {
	subscription: { limit: 500, requests: 12, renewsAt: "2026-07-10T11:33:46.399Z" },
};

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "synthetic-test-key",
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

async function fetchUsage(payload: unknown) {
	return syntheticUsageProvider.fetchUsage!(
		{ provider: "synthetic", credential: makeCredential(), signal: undefined },
		makeCtx(payload),
	);
}

describe("synthetic usage provider", () => {
	it("planWeeklyLimit is the whole quota surface", async () => {
		const report = await fetchUsage(PLAN_FIXTURE);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		const weekly = report!.limits[0];
		expect(weekly.id).toBe("synthetic:usd:7d");
		expect(weekly.label).toBe("Synthetic Credits");
		expect(weekly.scope.windowId).toBe("7d");
		expect(weekly.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		// usedFraction = 1 - 7.615/100 ≈ 0.92385
		expect(weekly.amount.usedFraction).toBeCloseTo(1 - 7.615 / 100, 6);
		expect(weekly.amount.unit).toBe("percent");
		expect(weekly.status).toBe("warning");
		expect(weekly.window?.label).toBe("7d · regen 2%/tick");
		expect(weekly.window?.resetsAt).toBe(Date.parse("2026-07-10T08:17:04.000Z"));
		expect(weekly.window?.resetLabel).toBe("regen");
	});

	it("omits regen metadata when the plan does not report it", async () => {
		const report = await fetchUsage({ planWeeklyLimit: { percentRemaining: 50 } });

		const weekly = report!.limits[0];
		expect(weekly.id).toBe("synthetic:usd:7d");
		expect(weekly.window?.label).toBe("7d");
		expect(weekly.window?.resetsAt).toBeUndefined();
		expect(weekly.window?.resetLabel).toBeUndefined();
	});

	it("ignores the retired subscription counter", async () => {
		const report = await fetchUsage({ ...SUBSCRIPTION_FIXTURE, ...PLAN_FIXTURE });

		expect(report!.limits.map(l => l.id)).toEqual(["synthetic:usd:7d"]);
	});

	it("fully drained weekly credits (percentRemaining 0) → exhausted", async () => {
		const payload = { planWeeklyLimit: { ...PLAN_FIXTURE.planWeeklyLimit, percentRemaining: 0 } };
		const report = await fetchUsage(payload);

		const weekly = report!.limits[0];
		expect(weekly.amount.usedFraction).toBe(1);
		expect(weekly.status).toBe("exhausted");
	});

	it("payloads without a usable planWeeklyLimit → null", async () => {
		expect(await fetchUsage({})).toBeNull();
		expect(await fetchUsage(SUBSCRIPTION_FIXTURE)).toBeNull();
		expect(await fetchUsage({ planWeeklyLimit: { nextRegenAt: "2026-07-10T08:17:04.000Z" } })).toBeNull();
		expect(await fetchUsage({ planWeeklyLimit: "nope" })).toBeNull();
	});

	it("non-synthetic provider or non-api_key credential → null", async () => {
		const wrongProvider = await syntheticUsageProvider.fetchUsage!(
			{ provider: "openai", credential: makeCredential(), signal: undefined },
			makeCtx(PLAN_FIXTURE),
		);
		const wrongCredential = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: { type: "oauth" } as UsageFetchParams["credential"], signal: undefined },
			makeCtx(PLAN_FIXTURE),
		);

		expect(wrongProvider).toBeNull();
		expect(wrongCredential).toBeNull();
	});

	it("HTTP error response → null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx({ message: "Unauthorized" }, 401),
		);
		expect(report).toBeNull();
	});

	it("network error / thrown fetch → null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtxThrow(),
		);
		expect(report).toBeNull();
	});

	it("malformed JSON payload → null", async () => {
		const fetch: FetchImpl = async () => {
			return new Response("not-json{{{{", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			{ fetch },
		);
		expect(report).toBeNull();
	});
});
