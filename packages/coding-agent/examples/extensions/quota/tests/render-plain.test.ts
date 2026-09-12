import { describe, expect, it } from "bun:test";
import { buildQuotaDashboardModel, type LocalUsageLimit, type LocalUsageReport } from "../src/hierarchy";
import { renderQuotaSnapshot } from "../src/render-plain";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

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

describe("renderQuotaSnapshot", () => {
	it("renders a clean plain-text snapshot with provider -> account -> pool -> window hierarchy", () => {
		const reports = [
			report({
				provider: "anthropic",
				metadata: { email: "alice@example.com" },
				limits: [
					limit({
						id: "5h",
						label: "5 Hour",
						amount: { unit: "percent", remainingFraction: 0.93 },
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
				metadata: { email: "carol@example.com" },
				limits: [
					limit({
						id: "google-antigravity:google:default:weekly",
						label: "Usage (Google)",
						window: { id: "weekly", label: "Weekly", resetsAt: NOW + 6 * 24 * HOUR },
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
		const snapshot = renderQuotaSnapshot(model);

		expect(snapshot).toContain("Quota");
		expect(snapshot).toContain("Anthropic");
		expect(snapshot).toContain("● alice@example.com   ACTIVE");
		expect(snapshot).toContain("5 Hour");
		expect(snapshot).toContain("93% ✓ ↻4h");
		expect(snapshot).toContain("7 Day");
		expect(snapshot).toContain("29% ⚠ ↻2d");
		expect(snapshot).toContain("Google Antigravity");
		expect(snapshot).toContain("carol@example.com");
		expect(snapshot).toContain("Google");
		expect(snapshot).toContain("Weekly");
		expect(snapshot).toContain("0% ✕ ↻6d");
		expect(snapshot).toContain("Daily");
		expect(snapshot).toContain("100% ✓");
	});
});
