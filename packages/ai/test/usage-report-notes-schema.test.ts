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
import { usageReportSchema } from "@pk-nerdsaver-ai/pi-ai";
import { usageResponseSchema } from "@pk-nerdsaver-ai/pi-ai/auth-broker/wire-schemas";
import { type } from "arktype";

const DISCLAIMER = "OMP-observed spend only; OpenCode usage outside OMP is not included.";

function reportWithNotes() {
	return {
		provider: "opencode-go",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "rolling-5h",
				label: "5 Hour limit",
				scope: { provider: "opencode-go", windowId: "rolling-5h" },
				window: { id: "rolling-5h", label: "5 Hour", durationMs: 5 * 3_600_000 },
				amount: { used: 3, limit: 12, remaining: 9, usedFraction: 0.25, remainingFraction: 0.75, unit: "usd" },
				status: "ok",
			},
		],
		notes: [DISCLAIMER],
		metadata: { planType: "OpenCode Go" },
	};
}

describe("usage report notes wire schema", () => {
	it("usageReportSchema accepts report-level notes and preserves them", () => {
		const validated = usageReportSchema(reportWithNotes());
		expect(validated).not.toBeInstanceOf(type.errors);
		expect(validated).toHaveProperty("notes", [DISCLAIMER]);
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
		expect(reports[0]).toHaveProperty("notes", [DISCLAIMER]);
	});
});
