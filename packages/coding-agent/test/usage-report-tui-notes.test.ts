/**
 * Regression coverage for the TUI aggregate path in `command-controller.ts`.
 *
 * Three contracts that the CLI `formatUsageBreakdown` test cannot cover,
 * because the bug lives in the TUI cross-account grouping renderer
 * `renderUsageReports`:
 *
 *  1. Provider-wide `UsageReport.notes` render ONCE above the per-account
 *     sections, not once per account/window.
 *  2. Identical per-limit notes from multiple accounts that fall in the same
 *     `label|windowId` group are de-duplicated.
 *  3. Wide terminals preserve organization suffixes that distinguish accounts
 *     sharing an email address.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { loadTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { renderFractionBar } from "@oh-my-pi/pi-coding-agent/modes/utils/usage-bar";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

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

describe("renderUsageReports (#3268 TUI aggregate)", () => {
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
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(providerNote).length - 1;
		expect(occurrences).toBe(1);
	});

	it("lists every model mapped to the provider's live usage data", () => {
		const reports = [
			report("github-copilot", "acct@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.4)]),
		];
		const models = ["github-copilot/gpt-5.6", "github-copilot/claude-sonnet-4.6"];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, undefined, { usageModelSelectors: models }),
		);
		expect(text).toContain("Models with usage data");
		expect(text).toContain(models[0]);
		expect(text).toContain(models[1]);
	});

	it("deduplicates identical per-limit notes when accounts share one window group", () => {
		// Both accounts report the SAME label+windowId, so their limits land in
		// one aggregate group; both carry an identical per-limit note.
		const note = "Overage requests: 5";
		const reports: UsageReport[] = [
			report("github-copilot", "acct-a@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.8, [note])]),
			report("github-copilot", "acct-b@example.test", [limit("Copilot", "monthly", 30 * 24 * HOUR, 0.9, [note])]),
		];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		const occurrences = text.split(note).length - 1;
		// Deduped: appears once on the group note line. Pre-fix `flatMap(...).join`
		// would bullet-join it twice (one per account in the group).
		expect(occurrences).toBe(1);
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

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));

		expect(text).toContain("rae@example.com (Team Org)");
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

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));

		expect(text).toContain(theme.status.info);
		expect(text).not.toContain(theme.status.pending);
		expect(text).toContain("$123.45 used");
		expect(text).not.toContain("1 accts");
	});

	it("preserves capped aggregate status when a group mixes capped and used-only amounts", () => {
		const reports: UsageReport[] = [
			report("anthropic", "capped@example.test", [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: {
						used: 50,
						limit: 100,
						remaining: 50,
						usedFraction: 0.5,
						remainingFraction: 0.5,
						unit: "usd",
					},
					status: "ok",
				},
			]),
			report("anthropic", "spend@example.test", [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { used: 123.45, unit: "usd" },
				},
			]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));

		expect(text).toContain(theme.status.success);
		expect(text).toContain("$123.45 used");
		expect(text).toContain("2 accts");
	});
});

describe("renderUsageReports session marker (#5691 org-qualified identity)", () => {
	it("suffixes the active org so same-email multi-org accounts are tellable apart", () => {
		const email = "dev@example.test";
		const reports: UsageReport[] = [
			report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
		];
		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined,
			),
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
			renderUsageReports(reports, theme, Date.now(), 120, provider =>
				provider === "anthropic" ? { email } : undefined,
			),
		);
		const marker = text.split("\n").find(line => line.includes("in use by this session"));
		expect(marker).toContain(email);
		expect(marker).not.toContain("(");
	});
});

describe("renderUsageReports account privacy", () => {
	it("masks email identities across account rows and the active-session marker", () => {
		const email = "aiforall@ghostit.dev";
		const reports: UsageReport[] = [
			{
				...report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
				metadata: { email, orgId: "uuid-A", orgName: "Team Org" },
			},
		];
		const rendered = renderUsageReports(
			reports,
			theme,
			Date.now(),
			120,
			provider => (provider === "anthropic" ? { email, orgId: "uuid-A", orgName: "Team Org" } : undefined),
			{ maskAccountLabels: true },
		);
		const text = stripVTControlCharacters(rendered);

		expect(text).toContain("aif*** (Team Org)");
		expect(text).not.toContain(email);
		expect(text.split("\n").find(line => line.includes("in use by this session"))).toContain("aif*** (Team Org)");
		expect(rendered).toContain(theme.fg("warning", "***"));
	});

	it("shows the full email when masking is disabled", () => {
		const email = "aiforall@ghostit.dev";
		const reports = [report("anthropic", email, [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)])];

		const text = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, undefined, { maskAccountLabels: false }),
		);

		expect(text).toContain(email);
		expect(text).not.toContain("aif***");
	});
});

describe("renderUsageReports terminal width", () => {
	it("keeps every rendered line within the available width for many accounts", () => {
		const reports = Array.from({ length: 24 }, (_, index) =>
			report("github-copilot", `account-${index + 1}@example.test`, [
				limit("Copilot", "monthly", 30 * 24 * HOUR, (index + 1) / 25),
			]),
		);
		const availableWidth = 40;
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), availableWidth));

		for (const line of text.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(availableWidth);
		}
	});

	it("does not stretch account blocks across surplus terminal width", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			report("anthropic", "aiforall@ghostit.dev", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.4)]),
			report("anthropic", "ualexen92@gmail.com", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.2)]),
		];

		const compact = stripVTControlCharacters(renderUsageReports(reports, theme, now, 80));
		const wide = stripVTControlCharacters(renderUsageReports(reports, theme, now, 160));

		expect(wide).toBe(compact);
	});
	it("embeds each account's remaining usage in its bar and keeps the combined total on that row", () => {
		const reports: UsageReport[] = [
			report("anthropic", "aiforall@ghostit.dev", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.52)]),
			report("anthropic", "ualexen92@gmail.com", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0)]),
		];

		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const usageLine = text.split("\n").find(line => line.includes("48% free"));

		expect(usageLine).toContain("100% free");
		expect(usageLine).toContain("combined 74% free");
		expect(usageLine).toMatch(/[█▓▒░].*48% free/);
	});

	it("moves the embedded percentage toward the end as remaining usage grows", () => {
		const barLine = (usedFraction: number) => {
			const reports = [
				report("anthropic", "account@example.test", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, usedFraction)]),
			];
			return stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 80))
				.split("\n")
				.find(line => line.includes("% free"));
		};

		expect(barLine(0.2)?.indexOf("80% free")).toBeGreaterThan(barLine(0.8)?.indexOf("20% free") ?? Number.MAX_VALUE);
	});

	it("uses a gradual red-to-green fill and lets the boundary cross the label only near exhaustion", async () => {
		const truecolorTheme = await loadTheme("dark", { mode: "truecolor" });
		const renderBarLine = (usedFraction: number) => {
			const reports = [
				report("anthropic", "account@example.test", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, usedFraction)]),
			];
			return renderUsageReports(reports, truecolorTheme, Date.now(), 80)
				.split("\n")
				.find(line => line.includes("% free"));
		};
		const low = renderBarLine(0.9);
		const mid = renderBarLine(0.5);
		const high = renderBarLine(0.1);
		const rgb = (line: string | undefined) => {
			const match = line?.match(/\x1b\[(?:30;)?(?:38|48);2;(\d+);(\d+);(\d+)m/);
			return match ? match.slice(1).map(Number) : [];
		};
		const [lowRed = 0, lowGreen = 0] = rgb(low);
		const [midRed = 0, midGreen = 0, midBlue = 0] = rgb(mid);
		const [highRed = 0, highGreen = 0] = rgb(high);

		expect(lowRed).toBeGreaterThan(lowGreen);
		expect(midRed).toBeGreaterThan(midGreen);
		expect(midGreen).toBeGreaterThan(midBlue);
		expect(highGreen).toBeGreaterThan(highRed);
		expect(mid).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
		expect(mid).toMatch(/\x1b\[48;2;\d+;\d+;\d+m50% free\x1b\[39;49m/);
	});

	it("can anchor the embedded percentage at the right edge while the fill crosses through it", () => {
		const reports = [
			report("anthropic", "account@example.test", [limit("Claude 7 Day", "weekly", 7 * 24 * HOUR, 0.5)]),
		];
		const line = renderUsageReports(reports, theme, Date.now(), 80, undefined, { labelPlacement: "right" })
			.split("\n")
			.find(candidate => candidate.includes("% free"));
		expect(Bun.stripANSI(line ?? "")).toMatch(/50% free$/);
	});

	it("keeps a fully free narrow bar within its requested width", () => {
		for (const width of [1, 2, 9, 10, 12]) {
			const rendered = renderFractionBar(1, width, theme);
			expect(Bun.stringWidth(Bun.stripANSI(rendered))).toBe(width);
		}
	});
	it("uses ANSI-256 escapes for both bar foreground and inverse background", async () => {
		const ansi256Theme = await loadTheme("dark", { mode: "256color" });
		const rendered = renderFractionBar(0.5, 20, ansi256Theme);
		expect(rendered).toMatch(/\x1b\[38;5;\d+m/);
		expect(rendered).toMatch(/\x1b\[48;5;\d+m/);
		expect(rendered).not.toMatch(/\x1b\[(?:38|48);2;/);
	});
});
