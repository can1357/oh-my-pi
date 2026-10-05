/**
 * Regression tests for the Copilot usage provider's billing units (#13849).
 *
 * Copilot moved individual plans to usage-based billing on 2026-06-01, where a
 * plan's allowance is AI credits rather than premium requests. GitHub's billing
 * API names the unit per usage item in `unitType`, and `BillingUsageItem`
 * declares that field — but nothing ever read it, so every plan rendered as
 * "Premium Requests" with unit `requests`. A Copilot Pro account with a 1,500
 * AI credit allowance and 375 left was reported as 1,125 premium requests used:
 * a number that happens to be right and a unit that is wrong, which reads worse
 * than either being wrong on its own.
 *
 * Contract pinned here: the allowance row and each model row take their unit
 * from the item that reports it, and an unrecognised or absent `unitType` keeps
 * the established "Premium Requests" wording rather than guessing.
 */

import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { githubCopilotUsageProvider } from "../src/usage/github-copilot";

/** One billing usage item; `unitType` is the field the fix reads. */
interface BillingItem {
	sku: string;
	unitType?: string;
	/** Present on per-model rows; absent on the account-level allowance row. */
	model?: string;
	grossQuantity: number;
	netQuantity?: number;
	limit?: number;
}

/**
 * The Copilot Pro account from the report: a 1,500 AI credit allowance with 375
 * left, so 1,125 spent.
 */
const CREDIT_ITEM: BillingItem = {
	sku: "Copilot Premium Request",
	unitType: "AI_CREDITS",
	grossQuantity: 1125,
	netQuantity: 1125,
	limit: 1500,
};

/** The same spend on a legacy annual plan, which is still metered in requests. */
const REQUEST_ITEM: BillingItem = {
	sku: "Copilot Premium Request",
	unitType: "REQUESTS",
	grossQuantity: 1125,
	netQuantity: 1125,
	limit: 300,
};

function billingPayload(items: BillingItem[]): Record<string, unknown> {
	return { timePeriod: { year: 2026, month: 10 }, user: "octocat", usageItems: items };
}

/** Answers the billing endpoint, and 404s everything else so the internal path cannot answer. */
function billingFetch(payload: unknown): FetchImpl {
	const fn = async (input: string | URL | Request) => {
		if (!String(input).includes("/settings/billing/premium_request/usage")) {
			return new Response("not found", { status: 404 });
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

/** Run the provider against one billing payload and return its report. */
async function reportFor(payload: unknown) {
	const report = await githubCopilotUsageProvider.fetchUsage(
		{
			provider: "github-copilot",
			credential: { type: "api_key", apiKey: "gh-test", accountId: "octocat" },
		},
		{ fetch: billingFetch(payload) },
	);
	expect(report).not.toBeNull();
	return report!;
}

describe("github copilot usage provider — billing units", () => {
	it("reports an AI-credit allowance as credits, not premium requests", async () => {
		// On main both assertions below fail: label "Premium Requests", unit
		// "requests", so 1,125 AI credits of a 1,500 allowance reads as 1,125 of
		// 1,500 premium requests used.
		const report = await reportFor(billingPayload([CREDIT_ITEM]));
		const allowance = report.limits.find(limit => limit.id === "copilot:premium");
		expect(allowance).toBeDefined();
		expect(allowance?.label).toBe("AI Credits");
		expect(allowance?.amount.unit).toBe("credits");
		// The numbers are unchanged by the fix and must stay that way: 1,125 of
		// 1,500, 375 remaining.
		expect(allowance?.amount.used).toBe(1125);
		expect(allowance?.amount.limit).toBe(1500);
		expect(allowance?.amount.remaining).toBe(375);
	});

	it("gives a model row the unit that item reports", async () => {
		const report = await reportFor(
			billingPayload([{ ...CREDIT_ITEM, model: "grok-4.6", sku: "Copilot AI Credits" }]),
		);
		const model = report.limits.find(limit => limit.id === "copilot:model:grok-4.6");
		expect(model).toBeDefined();
		expect(model?.label).toBe("Model grok-4.6");
		// On main this is "requests".
		expect(model?.amount.unit).toBe("credits");
		expect(model?.amount.used).toBe(1125);
	});

	it("keeps the premium-request wording for a plan billed in requests", async () => {
		// The legacy path must be unchanged by the fix: same label, same unit,
		// same arithmetic.
		const report = await reportFor(billingPayload([REQUEST_ITEM]));
		const allowance = report.limits.find(limit => limit.id === "copilot:premium");
		expect(allowance?.label).toBe("Premium Requests");
		expect(allowance?.amount.unit).toBe("requests");
		expect(allowance?.amount.used).toBe(1125);
		expect(allowance?.amount.limit).toBe(300);
	});

	it("keeps a request-billed model row on requests", async () => {
		const report = await reportFor(
			billingPayload([{ ...REQUEST_ITEM, model: "grok-4.6", sku: "Copilot Premium Request Model Detail" }]),
		);
		const model = report.limits.find(limit => limit.id === "copilot:model:grok-4.6");
		expect(model?.amount.unit).toBe("requests");
	});

	it("falls back to requests when an item names no unit", async () => {
		// An absent unitType is not evidence about billing, so the established
		// name stands rather than a guess being presented as authoritative.
		const report = await reportFor(
			billingPayload([{ sku: "Copilot Premium Request", grossQuantity: 40, netQuantity: 40, limit: 300 }]),
		);
		const allowance = report.limits.find(limit => limit.id === "copilot:premium");
		expect(allowance?.label).toBe("Premium Requests");
		expect(allowance?.amount.unit).toBe("requests");
		expect(allowance?.amount.used).toBe(40);
	});

	it("falls back to requests for a unit type it does not recognise", async () => {
		const report = await reportFor(
			billingPayload([{ ...CREDIT_ITEM, unitType: "SOME_FUTURE_UNIT" }]),
		);
		const allowance = report.limits.find(limit => limit.id === "copilot:premium");
		expect(allowance?.label).toBe("Premium Requests");
		expect(allowance?.amount.unit).toBe("requests");
	});

	it("reads a mixed-case unit name as credits", async () => {
		const report = await reportFor(billingPayload([{ ...CREDIT_ITEM, unitType: "ai-credits" }]));
		const allowance = report.limits.find(limit => limit.id === "copilot:premium");
		expect(allowance?.label).toBe("AI Credits");
		expect(allowance?.amount.unit).toBe("credits");
	});
});