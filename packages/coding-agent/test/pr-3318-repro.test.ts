import { describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

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
			session: {
				model: undefined,
				fetchUsageReports: async () => [report],
				getUsageReportingModelSelectors: () => ["test-provider/coding-plan-model"],
			},
		} as never);

		expect(text).toContain("scoped-account: 1.00 requests used");
		expect(text).not.toContain("account 1: 1.00 requests used");
		expect(text).toContain("Models with usage data");
		expect(text).toContain("test-provider/coding-plan-model");
	});
	it("keeps Codex account and reset labels consistent with the live sanitized plan", async () => {
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: "workspace-id" },
					amount: { usedFraction: 0.2, unit: "percent" },
				},
			],
			metadata: { email: "user@example.test", orgName: "free", orgId: "workspace-id", planType: "prolite\nforged" },
			resetCredits: { availableCount: 1 },
		};
		const text = await buildUsageReportText({
			session: { model: undefined, fetchUsageReports: async () => [report] },
		} as never);
		expect(text).toContain("user@example.test · plan: prolite forged: 1 saved rate-limit reset");
		expect(text).toContain("user@example.test · plan: prolite forged: 20.00% used");
		expect(text).not.toContain("prolite\nforged");
		expect(text).not.toContain("(free)");
		expect(text).not.toContain("workspace-id");
	});

	it("formats remaining USD, fractional DIEM, and large credit balances in ACP usage", async () => {
		const report: UsageReport = {
			provider: "venice",
			fetchedAt: Date.now(),
			limits: [
				{ id: "usd", label: "USD balance", scope: { provider: "venice" }, amount: { remaining: 0, unit: "usd" } },
				{
					id: "diem",
					label: "DIEM balance",
					scope: { provider: "venice" },
					amount: { remaining: 0.03181079, unit: "credits" },
				},
				{
					id: "large",
					label: "Large credit balance",
					scope: { provider: "venice" },
					amount: { remaining: 1234, unit: "credits" },
				},
			],
		};
		const secondReport: UsageReport = {
			...report,
			limits: [
				{ id: "usd", label: "USD balance", scope: { provider: "venice" }, amount: { remaining: 5, unit: "usd" } },
			],
		};
		const text = await buildUsageReportText({
			session: { model: undefined, fetchUsageReports: async () => [report, secondReport] },
		} as never);
		expect(text).toContain("account 1: $0.00 left");
		expect(text).toContain("account 1: 0.032 credits left");
		expect(text).toContain("account 1: 1.2K credits left");
		expect(text).toContain("account 2: $5.00 left");
		expect(text).not.toContain("unknown used");
	});
});
