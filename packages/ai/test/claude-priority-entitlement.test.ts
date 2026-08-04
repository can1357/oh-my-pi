import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

/** Anthropic answers `429 … Usage credits are required for fast mode` when extra usage is off. */
const WINDOWS = {
	five_hour: { utilization: 35, resets_at: new Date(Date.now() + 5 * 60_000).toISOString() },
};

function fetchReturning(payload: unknown): FetchImpl {
	return (async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as FetchImpl;
}

function params() {
	return {
		provider: "anthropic" as const,
		credential: {
			type: "oauth" as const,
			accessToken: "oat-test",
			accountId: "account_test",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		},
	};
}

async function entitlementFor(payload: unknown) {
	const ctx: UsageFetchContext = { fetch: fetchReturning(payload) };
	const report = await claudeUsageProvider.fetchUsage(params(), ctx);
	return report?.priorityEntitlement;
}

describe("Claude priority entitlement", () => {
	it("reports priority unavailable when usage credits are switched off", async () => {
		const entitlement = await entitlementFor({
			...WINDOWS,
			extra_usage: { is_enabled: false, user_disabled: true, credits_ever_enabled: true },
			spend: { enabled: false, used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null },
		});
		expect(entitlement).toEqual({ available: false, reason: "usage credits are disabled" });
	});

	it("names the spend limit when credits are enabled but capped out", async () => {
		const entitlement = await entitlementFor({
			...WINDOWS,
			extra_usage: { is_enabled: false, spend_limit_reached: true },
		});
		expect(entitlement).toEqual({ available: false, reason: "usage credit spend limit reached" });
	});

	it("reports priority available when the account has credits", async () => {
		const entitlement = await entitlementFor({
			...WINDOWS,
			spend: { enabled: true, used: { amount_minor: 250, currency: "USD", exponent: 2 }, limit: null },
		});
		expect(entitlement).toEqual({ available: true });
	});

	it("leaves the entitlement unknown when the payload reports neither block", async () => {
		expect(await entitlementFor(WINDOWS)).toBeUndefined();
	});
});
