import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { formatUsageBreakdown } from "@oh-my-pi/pi-coding-agent/usage/usage-breakdown";

const HOUR = 3_600_000;

function limit(label: string, windowId: string, durationMs: number, frac: number, notes?: string[]) {
	return {
		id: windowId,
		label,
		scope: { provider: "github-copilot", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 0.8 ? "warning" : "ok",
		...(notes ? { notes } : {}),
	} satisfies UsageReport["limits"][number];
}

function report(provider: string, email: string, limits: UsageReport["limits"], notes?: string[]) {
	return {
		provider,
		fetchedAt: Date.now(),
		limits,
		...(notes ? { notes } : {}),
		metadata: { email },
	} satisfies UsageReport;
}

describe("formatUsageBreakdown provider details", () => {
	it("renders provider-wide UsageReport.notes exactly once for multiple accounts", () => {
		const providerNote = "Usage data can be delayed by up to five minutes.";
		const reports: UsageReport[] = [
			report(
				"github-copilot",
				"acct-a@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3)],
				[providerNote],
			),
			report(
				"github-copilot",
				"acct-b@example.test",
				[limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.6)],
				[providerNote],
			),
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));
		const occurrences = text.split(providerNote).length - 1;
		expect(occurrences).toBe(1);
	});

	it("lists every model mapped to the provider's live usage data", () => {
		const reports = [
			report("github-copilot", "acct@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.4)]),
		];
		const models = ["github-copilot/gpt-5.6", "github-copilot/claude-sonnet-4.6"];
		const text = stripVTControlCharacters(
			formatUsageBreakdown(reports, [], Date.now(), undefined, [], { usageModelSelectors: models }),
		);
		expect(text).toContain("Models with usage data");
		expect(text).toContain(models[0]);
		expect(text).toContain(models[1]);
	});

	it("renders per-account notes for every account that reports them", () => {
		const note = "Overage requests: 5";
		const reports: UsageReport[] = [
			report("github-copilot", "acct-a@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.8, [note])]),
			report("github-copilot", "acct-b@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.9, [note])]),
		];
		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));
		const occurrences = text.split(note).length - 1;
		expect(occurrences).toBe(2);
	});

	it("preserves organization suffixes when wide account columns can fit them", () => {
		const now = Date.now();
		const accountLimit = () => ({
			...limit("5 Hour limit", "rolling-5h", 5 * HOUR, 0.3),
			window: {
				id: "rolling-5h",
				label: "5 Hour limit",
				durationMs: 5 * HOUR,
				resetsAt: now + 2.5 * HOUR,
			},
		});
		const reports: UsageReport[] = [
			{
				...report("anthropic", "rae@example.com", [accountLimit()]),
				metadata: { email: "rae@example.com", orgId: "team-org", orgName: "Team Org" },
			},
			report("anthropic", "rae@example.com", [accountLimit()]),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], now));

		expect(text).toContain("rae@example.com · Team Org");
	});

	it("renders used-only absolute amounts with neutral status and no account summary", () => {
		const reports: UsageReport[] = [
			report("anthropic", "spend@example.test", [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 123.45, unit: "usd" },
				},
			]),
		];

		const text = stripVTControlCharacters(formatUsageBreakdown(reports, [], Date.now()));

		expect(text).toContain("$123.45 used");
		expect(text).not.toContain("1 accts");
	});
});

describe("formatUsageBreakdown session marker (#5691 org-qualified identity)", () => {
	it("suffixes the active org so same-email multi-org accounts are tellable apart", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			formatUsageBreakdown(reports, [], Date.now(), undefined, [], {
				resolveActiveAccount: provider =>
					provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined,
			}),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(`${email} (Team Org)`);
	});

	it("falls back to the bare base when the active identity carries no org", () => {
		const email = "solo@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			formatUsageBreakdown(reports, [], Date.now(), undefined, [], {
				resolveActiveAccount: provider => (provider === "anthropic" ? { email } : undefined),
			}),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(email);
		expect(marker).not.toContain("(");
	});
});
