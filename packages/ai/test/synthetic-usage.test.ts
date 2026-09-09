import { describe, expect, it } from "bun:test";

import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { syntheticUsageProvider } from "@oh-my-pi/pi-ai/usage/synthetic";

const FULL_FIXTURE = {
	subscription: { limit: 500, requests: 12, renewsAt: "2026-07-10T11:33:46.399Z" },
	search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-07-10T07:33:46.399Z" } },
	freeToolCalls: { limit: 0, requests: 0, renewsAt: "2026-07-11T06:33:46.405Z" },
	weeklyTokenLimit: {
		nextRegenAt: "2026-07-10T08:17:04.000Z",
		percentRemaining: 7.615,
		maxCredits: "$24.00",
		remainingCredits: "$1.82",
		nextRegenCredits: "$0.48",
	},
	rollingFiveHourLimit: {
		nextTickAt: "2026-07-10T06:46:05.000Z",
		tickPercent: 0.05,
		remaining: 500,
		max: 500,
		limited: false,
	},
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

describe("synthetic usage provider", () => {
	it("happy path: full fixture returns exactly 2 limits — 5h rolling and weekly credits", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx(FULL_FIXTURE),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(2);
		expect(report!.limits.map(l => l.id)).toEqual(["synthetic:requests:5h", "synthetic:usd:7d"]);
		expect(report!.limits.map(l => l.label)).toEqual(["Synthetic Requests", "Synthetic Credits"]);
		expect(report!.limits.map(l => l.scope.windowId)).toEqual(["5h", "7d"]);
		expect(report!.limits.map(l => l.window?.durationMs)).toEqual([5 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000]);
	});

	it("5h rolling limit: used/remaining math (500 max, 500 remaining → 0 used, status ok)", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx(FULL_FIXTURE),
		);

		const fiveHour = report!.limits.find(l => l.id === "synthetic:requests:5h")!;
		expect(fiveHour.amount.remaining).toBe(500);
		expect(fiveHour.amount.limit).toBe(500);
		expect(fiveHour.amount.used).toBe(0);
		expect(fiveHour.amount.usedFraction).toBe(0);
		expect(fiveHour.status).toBe("ok");
	});

	it("5h rolling limit: regen rate folded into window label, tick time drives resetsAt", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx(FULL_FIXTURE),
		);

		const fiveHour = report!.limits.find(l => l.id === "synthetic:requests:5h")!;
		// Single-line rendering: no notes; tickPercent 0.05 → "5%" in the window label.
		expect(fiveHour.notes).toBeUndefined();
		expect(fiveHour.window?.label).toBe("5h · regen 5%/tick");
		// nextTickAt drives the countdown, rendered as "tick in …" (not a window reset).
		expect(fiveHour.window?.resetsAt).toBe(Date.parse("2026-07-10T06:46:05.000Z"));
		expect(fiveHour.window?.resetLabel).toBe("tick");
	});

	it("weekly USD limit: parses dollar amounts, uses percentRemaining for usedFraction", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx(FULL_FIXTURE),
		);

		const weekly = report!.limits.find(l => l.id === "synthetic:usd:7d")!;
		expect(weekly.amount.limit).toBeCloseTo(24.0);
		expect(weekly.amount.remaining).toBeCloseTo(1.82);
		// usedFraction = 1 - 7.615/100 ≈ 0.92385
		expect(weekly.amount.usedFraction).toBeCloseTo(1 - 7.615 / 100, 5);
		expect(weekly.amount.unit).toBe("usd");
		// usedFraction ~0.924 ≥ 0.9 → "warning"
		expect(weekly.status).toBe("warning");
		// Weekly credits regenerate incrementally too: "regen in …" + $/tick in the label.
		expect(weekly.window?.resetLabel).toBe("regen");
		expect(weekly.window?.label).toBe("7d · regen $0.48/tick");
		expect(weekly.window?.resetsAt).toBe(Date.parse("2026-07-10T08:17:04.000Z"));
	});

	it("docs-minimal response (subscription-only) → null (no surfaceable limits)", async () => {
		const minimal = {
			subscription: { limit: 100, requests: 5, renewsAt: "2026-08-01T00:00:00.000Z" },
		};
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx(minimal),
		);
		// subscription is dropped; no 5h or weekly data → nothing to show
		expect(report).toBeNull();
	});

	it("limited: true on rollingFiveHourLimit → status is exhausted", async () => {
		const payload = {
			...FULL_FIXTURE,
			rollingFiveHourLimit: { ...FULL_FIXTURE.rollingFiveHourLimit, remaining: 0, limited: true },
		};
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx(payload),
		);

		const fiveHour = report!.limits.find(l => l.id === "synthetic:requests:5h")!;
		expect(fiveHour.status).toBe("exhausted");
	});

	it("non-synthetic provider → returns null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "openai", credential: makeCredential(), signal: undefined },
			makeCtx(FULL_FIXTURE),
		);
		expect(report).toBeNull();
	});

	it("non-api_key credential → returns null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: { type: "oauth" } as UsageFetchParams["credential"], signal: undefined },
			makeCtx(FULL_FIXTURE),
		);
		expect(report).toBeNull();
	});

	it("HTTP error response → returns null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx({ message: "Unauthorized" }, 401),
		);
		expect(report).toBeNull();
	});

	it("network error / thrown fetch → returns null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtxThrow(),
		);
		expect(report).toBeNull();
	});

	it("malformed JSON payload → returns null", async () => {
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

	it("empty object payload → returns null", async () => {
		const report = await syntheticUsageProvider.fetchUsage!(
			{ provider: "synthetic", credential: makeCredential(), signal: undefined },
			makeCtx({}),
		);
		expect(report).toBeNull();
	});
});
