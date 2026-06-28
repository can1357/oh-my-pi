import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@pk-nerdsaver-ai/pi-ai";
import { buildUsageReportText } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/usage-report";

describe("PR 3318 repro", () => {
	it("falls back to scoped account when metadata identities are empty strings", async () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "daily",
					label: "Daily",
					scope: { provider: "test-provider", accountId: "scoped-account", projectId: "scoped-project" },
					amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				},
			],
			metadata: { email: "", accountId: "", projectId: "" },
		};
		const text = await buildUsageReportText({
			session: { model: undefined, fetchUsageReports: async () => [report] },
		} as never);

		expect(text).toContain("scoped-account: 1.00 requests used");
		expect(text).not.toContain("account 1: 1.00 requests used");
	});
});
