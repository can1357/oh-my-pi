/**
 * Regression for #3268: provider-level `notes` on `UsageReport` must survive
 * the broker wire schema. The broker client validates `/v1/usage` responses
 * against `usageResponseSchema`, which uses `"+": "reject"` — unknown fields
 * at the envelope level are rejected, not silently stripped. Both the
 * `usage.ts` schema and the `auth-broker/wire-schemas.ts` copy must declare
 * `notes?: string[]` at the report level, or the field is lost on
 * deserialization. `usageReportSchema` (the non-broker copy) must also accept
 * the field so local `AuthStorage.fetchUsageReports` results type-check.
 */

import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { usageReportSchema } from "@oh-my-pi/pi-ai";
import { usageResponseSchema } from "@oh-my-pi/pi-ai/auth-broker/wire-schemas";

const PROVIDER_NOTE = "Usage data can be delayed by up to five minutes.";

function reportWithNotes() {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "anthropic:5h",
				label: "5 Hour",
				scope: { provider: "anthropic", windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000 },
				amount: { usedFraction: 0.25, remainingFraction: 0.75, unit: "percent" },
				status: "ok",
			},
		],
		notes: [PROVIDER_NOTE],
		metadata: { planType: "Pro" },
	};
}

describe("usage report notes wire schema", () => {
	it("usageReportSchema accepts report-level notes and preserves them", () => {
		const validated = usageReportSchema(reportWithNotes());
		expect(validated).not.toBeInstanceOf(type.errors);
		expect(validated).toHaveProperty("notes", [PROVIDER_NOTE]);
	});

	it("usageResponseSchema preserves report-level notes through the broker reject gate", () => {
		const response = {
			generatedAt: Date.now(),
			reports: [reportWithNotes()],
		};
		const validated = usageResponseSchema(response);
		expect(validated).not.toBeInstanceOf(type.errors);
		expect(validated).toHaveProperty("reports");
		if (validated instanceof type.errors) throw new Error("expected valid response");
		const reports = validated.reports;
		expect(reports[0]).toHaveProperty("notes", [PROVIDER_NOTE]);
	});

	it("both schema copies accept the credits unit (Z.AI GLM Coding Plan reports)", () => {
		// `usage.ts` and `wire-schemas.ts` keep separate copies of the unit enum;
		// a new unit added to only one copy makes broker `/v1/usage` responses
		// containing it fail the `"+": "reject"` gate client-side.
		const report = {
			provider: "zai",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "zai:credits:5h",
					label: "ZAI 5 Hours Credit Quota",
					scope: { provider: "zai", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hours", durationMs: 5 * 3_600_000 },
					amount: { used: 1438, limit: 12000, usedFraction: 0.11, unit: "credits" },
					status: "ok",
				},
			],
			metadata: { planType: "pro" },
		};

		const local = usageReportSchema(report);
		expect(local).not.toBeInstanceOf(type.errors);

		const brokered = usageResponseSchema({ generatedAt: Date.now(), reports: [report] });
		expect(brokered).not.toBeInstanceOf(type.errors);
	});

	it("both schema copies preserve normalized reset eligibility and credit metadata", () => {
		const report = {
			...reportWithNotes(),
			resetCredits: {
				availableCount: 2,
				redeemableCount: 2,
				nextCreditId: "grant_1",
				eligible: true,
				cooldownUntil: "2099-09-28T00:00:00.000Z",
				credits: [
					{
						id: "grant_1",
						title: "Anytime reset",
						program: "cedar_ember",
						remainingCount: 2,
						usable: true,
						requiresLimit: false,
						clears: ["anthropic:5h", "anthropic:7d:opus"],
						blocking: ["anthropic:7d"],
						usedFractions: { "anthropic:5h": 1, "anthropic:7d": 0.75 },
						grantedAt: "2026-09-01T00:00:00.000Z",
						expiresAt: "2099-10-01T00:00:00.000Z",
						status: "available",
					},
				],
			},
		};

		const local = usageReportSchema(report);
		expect(local).not.toBeInstanceOf(type.errors);
		if (local instanceof type.errors) throw new Error("expected valid local report");
		expect(local.resetCredits).toEqual(report.resetCredits);

		const brokered = usageResponseSchema({ generatedAt: Date.now(), reports: [report] });
		expect(brokered).not.toBeInstanceOf(type.errors);
		if (brokered instanceof type.errors) throw new Error("expected valid broker response");
		expect(brokered.reports[0]?.resetCredits).toEqual(report.resetCredits);
	});
});
