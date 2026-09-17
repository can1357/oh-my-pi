import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

function anonymousReport(limits: UsageReport["limits"]): UsageReport {
	return {
		provider: "test-provider",
		fetchedAt: Date.now(),
		limits,
		metadata: { endpoint: "https://example.test/api/usage" },
	};
}

function anonymousLimit(id: string, label: string): UsageReport["limits"][number] {
	return {
		id,
		label,
		scope: { provider: "test-provider" },
		amount: { used: 1, usedFraction: 0.1, unit: "requests" },
	};
}

async function render(reports: UsageReport[]): Promise<string> {
	return buildUsageReportText({
		session: {
			model: undefined,
			fetchUsageReports: async () => reports,
		},
	} as never);
}

describe("usage report anonymous account labels", () => {
	it("labels every limit of one anonymous report with the same account", async () => {
		// Regression (PR 10513 review): one Ollama Cloud credential reports a
		// monthly and an activity limit; the API exposes no account identity.
		// Indexing the fallback by the per-limit loop rendered this single
		// credential as `account 1` and `account 2`.
		const text = await render([
			anonymousReport([anonymousLimit("monthly", "Monthly"), anonymousLimit("activity", "Activity")]),
		]);

		expect(text).toContain("account 1: 1.00 requests used");
		expect(text).not.toContain("account 2");
	});

	it("keeps distinct labels for separate anonymous reports", async () => {
		const text = await render([
			anonymousReport([anonymousLimit("monthly", "Monthly")]),
			anonymousReport([anonymousLimit("monthly", "Monthly")]),
		]);

		expect(text).toContain("account 1: 1.00 requests used");
		expect(text).toContain("account 2: 1.00 requests used");
	});
});
