import { describe, expect, it } from "bun:test";
import { buildQuotaDashboardModel, type LocalUsageLimit, type LocalUsageReport } from "../src/hierarchy";
import { type DashboardViewState, renderDashboard } from "../src/render-dashboard";

const NOW = Date.now();
const HOUR = 3_600_000;

const mockTheme = {
	fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
	bold: (text: string) => `[bold]${text}[/bold]`,
};

function limit(overrides: Partial<LocalUsageLimit> = {}): LocalUsageLimit {
	return {
		id: "test:limit",
		label: "7 Day",
		scope: {},
		amount: { unit: "percent", remainingFraction: 1.0 },
		...overrides,
	};
}

function report(overrides: Partial<LocalUsageReport> = {}): LocalUsageReport {
	return {
		provider: "test-provider",
		fetchedAt: NOW,
		limits: [limit()],
		metadata: { email: "user@example.com" },
		...overrides,
	};
}

describe("renderDashboard", () => {
	it("renders full dashboard with header, attention section, providers and footer", () => {
		const reports = [
			report({
				provider: "anthropic",
				metadata: { email: "alice@example.com", orgName: "alice@example.com's Organization" },
				limits: [
					limit({
						id: "5h",
						label: "5 Hour",
						amount: { unit: "percent", remainingFraction: 0.96 },
						window: { resetsAt: NOW + 4 * HOUR },
					}),
					limit({
						id: "7d",
						label: "7 Day",
						amount: { unit: "percent", remainingFraction: 0.29 },
						window: { resetsAt: NOW + 48 * HOUR },
					}),
				],
			}),
			report({
				provider: "google-antigravity",
				metadata: { email: "bob@example.com" },
				limits: [
					limit({
						id: "google-antigravity:google:default:weekly",
						label: "Usage (Google)",
						window: { id: "weekly", label: "Weekly" },
						amount: { unit: "percent", remainingFraction: 0 },
					}),
					limit({
						id: "google-antigravity:google:default:daily",
						label: "Usage (Google)",
						window: { id: "daily", label: "Daily" },
						amount: { unit: "percent", remainingFraction: 1.0 },
					}),
				],
			}),
		];

		const model = buildQuotaDashboardModel(reports, NOW, new Map([["anthropic", { email: "alice@example.com" }]]));
		const viewState: DashboardViewState = {
			selectedIndex: 0,
			collapsedAccounts: new Set(),
			collapsedPools: new Set(),
			attentionOnly: false,
			hideHealthy: false,
		};

		const lines = renderDashboard(model, viewState, mockTheme, 80);
		const fullText = lines.join("\n");

		// Header
		expect(fullText).toContain("[bold][accent]QUOTA[/accent][/bold]");
		expect(fullText).toContain("refreshed now");
		expect(fullText).toContain("[success]✓ 2 healthy[/success]");
		expect(fullText).toContain("[warning]⚠ 1 low[/warning]");
		expect(fullText).toContain("[error]✕ 1 exhausted[/error]");

		// Attention section
		expect(fullText).toContain("[bold][error]ATTENTION[/error][/bold]");
		expect(fullText).toContain("Anthropic · alice@example.com · 7 Day");
		expect(fullText).toContain("Google Antigravity · bob@example.com · Google · Weekly");

		// Provider headings
		expect(fullText).toContain("[bold][accent]ANTHROPIC[/accent][/bold]");
		expect(fullText).toContain("[bold][accent]GOOGLE ANTIGRAVITY[/accent][/bold]");

		// Active marker
		expect(fullText).toContain("[accent]● [/accent]");
		expect(fullText).toContain("[accent][bold]ACTIVE[/bold][/accent]");

		// Organization cleanup
		expect(fullText).toContain("Organization");
		expect(fullText).not.toContain("alice@example.com's Organization");

		// Footer
		expect(fullText).toContain("↑↓ navigate   enter expand   a attention   h healthy   r refresh   q close");
	});

	it("omits attention section when all reported quotas are healthy", () => {
		const reports = [
			report({
				provider: "anthropic",
				metadata: { email: "healthy@example.com" },
				limits: [limit({ id: "7d", label: "7 Day", amount: { unit: "percent", remainingFraction: 1.0 } })],
			}),
		];

		const model = buildQuotaDashboardModel(reports, NOW, new Map());
		const viewState: DashboardViewState = {
			selectedIndex: 0,
			collapsedAccounts: new Set(),
			collapsedPools: new Set(),
			attentionOnly: false,
			hideHealthy: false,
		};

		const lines = renderDashboard(model, viewState, mockTheme, 80);
		const fullText = lines.join("\n");

		expect(fullText).toContain("✓ All reported quotas healthy");
		expect(fullText).not.toContain("ATTENTION");
	});

	it("renders collapsed account with summary badge and hides inner pools", () => {
		const reports = [
			report({
				provider: "google-antigravity",
				metadata: { email: "bob@example.com" },
				limits: [
					limit({
						id: "google-antigravity:google:default:weekly",
						label: "Usage (Google)",
						amount: { unit: "percent", remainingFraction: 0 },
					}),
				],
			}),
		];

		const model = buildQuotaDashboardModel(reports, NOW, new Map());
		const accountId = model.providers[0]!.accounts[0]!.id;

		const viewState: DashboardViewState = {
			selectedIndex: 0,
			collapsedAccounts: new Set([accountId]),
			collapsedPools: new Set(),
			attentionOnly: false,
			hideHealthy: false,
		};

		const lines = renderDashboard(model, viewState, mockTheme, 80);
		const fullText = lines.join("\n");

		// Collapsed disclosure icon and summary
		expect(fullText).toContain("▸ ");
		expect(fullText).toContain("[error]1 exhausted[/error]");
		// Inner window rows should be hidden
		expect(fullText).not.toContain("0%   ✕");
	});

	it("supports attention-only mode and hide-healthy mode", () => {
		const reports = [
			report({
				provider: "anthropic",
				metadata: { email: "healthy@example.com" },
				limits: [limit({ id: "h1", label: "Healthy Limit", amount: { unit: "percent", remainingFraction: 1.0 } })],
			}),
			report({
				provider: "openai-codex",
				metadata: { email: "issues@example.com" },
				limits: [limit({ id: "i1", label: "Exhausted Limit", amount: { unit: "percent", remainingFraction: 0 } })],
			}),
		];

		const model = buildQuotaDashboardModel(reports, NOW, new Map());

		// Attention only
		const attentionState: DashboardViewState = {
			selectedIndex: 0,
			collapsedAccounts: new Set(),
			collapsedPools: new Set(),
			attentionOnly: true,
			hideHealthy: false,
		};

		const attentionText = renderDashboard(model, attentionState, mockTheme, 80).join("\n");
		expect(attentionText).toContain("ATTENTION ONLY MODE");
		expect(attentionText).toContain("issues@example.com");
		expect(attentionText).not.toContain("healthy@example.com");

		// Hide healthy
		const hideHealthyState: DashboardViewState = {
			selectedIndex: 0,
			collapsedAccounts: new Set(),
			collapsedPools: new Set(),
			attentionOnly: false,
			hideHealthy: true,
		};

		const hideHealthyText = renderDashboard(model, hideHealthyState, mockTheme, 80).join("\n");
		expect(hideHealthyText).toContain("HIDING HEALTHY");
		expect(hideHealthyText).not.toContain("Healthy Limit");
		expect(hideHealthyText).toContain("Exhausted Limit");
	});

	it("adapts layout on narrow terminal widths without embedding newlines inside rows", () => {
		const reports = [
			report({
				provider: "openai-codex",
				metadata: { email: "user@example.com" },
				limits: [
					limit({
						id: "7d",
						label: "7 Day",
						amount: { unit: "percent", remainingFraction: 0.5 },
						window: { resetsAt: NOW + 5 * HOUR },
					}),
				],
			}),
		];

		const model = buildQuotaDashboardModel(reports, NOW, new Map());
		const viewState: DashboardViewState = {
			selectedIndex: 0,
			collapsedAccounts: new Set(),
			collapsedPools: new Set(),
			attentionOnly: false,
			hideHealthy: false,
		};

		const narrowLines = renderDashboard(model, viewState, mockTheme, 45);
		expect(narrowLines.length).toBeGreaterThan(0);
		// Invariant: no physical row element returned by render() may contain an embedded \n
		expect(narrowLines.every(line => !line.includes("\n"))).toBe(true);
	});
});
