import { describe, expect, it } from "bun:test";
import type { PaidUsageView, UsageReport } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

function usageRuntime(
	reports: UsageReport[],
	paidUsage: readonly (PaidUsageView | undefined)[] = [],
	usageModelSelectors: readonly string[] = [],
): never {
	return {
		session: {
			model: undefined,
			fetchUsageReports: async () => reports,
			getUsageReportingModelSelectors: () => usageModelSelectors,
			modelRegistry: {
				authStorage: {
					usage: { paidUsage: () => paidUsage },
					oauth: { identity: () => undefined },
				},
			},
		},
		settings: Settings.isolated(),
	} as never;
}

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
		const text = await buildUsageReportText(usageRuntime([report], [], ["test-provider/coding-plan-model"]));

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
		const text = await buildUsageReportText(usageRuntime([report]));
		expect(text).toContain("user@example.test · plan: prolite forged: 1 saved rate-limit reset");
		expect(text).toContain("user@example.test · plan: prolite forged: 20.00% used");
		expect(text).not.toContain("prolite\nforged");
		expect(text).not.toContain("(free)");
		expect(text).not.toContain("workspace-id");
	});

	it("renders the ACP paid block instead of treating a paid row as an unknown limit", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1_800_000_000_000,
			metadata: { email: "paid@example.test" },
			limits: [
				{
					id: "anthropic:5h",
					label: "Claude 5 Hour",
					scope: { provider: "anthropic", windowId: "5h" },
					amount: { usedFraction: 0.2, unit: "percent" },
					status: "ok",
				},
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 46, remaining: 4, limit: 50, usedFraction: 0.92, unit: "usd" },
					status: "warning",
				},
			],
		};
		const paid: PaidUsageView = {
			limitId: "anthropic:extra",
			unit: "usd",
			capacity: "spend-cap",
			state: "available",
			used: 46,
			cap: 50,
			remaining: 4,
			headroom: 4,
			boundBy: "provider",
			uncapped: false,
			floorIgnored: false,
			unbounded: false,
			stale: false,
		};

		const text = await buildUsageReportText(usageRuntime([report], [paid]));

		expect(text).toContain("Paid usage");
		expect(text).toContain("Paid figures are provider-reported and refresh about every 5 minutes");
		expect(text).toContain("paid@example.test: $4.00 left of $50.00 cap");
		expect(text).not.toContain("Claude Extra Usage");
		expect(text).not.toContain("unknown used");
	});
});
