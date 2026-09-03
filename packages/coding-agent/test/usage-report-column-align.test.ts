import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const HOUR = 3_600_000;

beforeAll(async () => {
	await initTheme();
});

function win(label: string, windowId: string, durationMs: number, frac: number) {
	return {
		id: windowId,
		label,
		scope: { provider: "kimi-code", windowId },
		window: { id: windowId, label, durationMs },
		amount: { unit: "percent", usedFraction: frac },
		status: frac >= 1 ? "exhausted" : frac >= 0.9 ? "warning" : "ok",
	} satisfies UsageReport["limits"][number];
}

function acct(email: string, total: number, fiveH: number): UsageReport {
	return {
		provider: "kimi-code",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			win("Total quota", "usage-window", 7 * 24 * HOUR, total),
			win("5h limit", "rolling-5h", 5 * HOUR, fiveH),
		],
	} satisfies UsageReport;
}

function spendAcct(email: string, used: number, limit?: number): UsageReport {
	const amount =
		limit === undefined
			? ({ used, unit: "usd" } as const)
			: ({
					used,
					unit: "usd",
					limit,
					remaining: Math.max(0, limit - used),
					usedFraction: used / limit,
					remainingFraction: Math.max(0, limit - used) / limit,
				} as const);
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { email },
		limits: [
			{
				id: "anthropic:extra",
				label: "Claude Extra Usage",
				scope: { provider: "anthropic", windowId: "extra" },
				amount,
				...(limit === undefined ? {} : { status: "ok" as const }),
			},
		],
	};
}

describe("renderUsageReports multi-account column alignment (#6067)", () => {
	it("keeps account columns in the same order across every window row", () => {
		// Account A: weekly exhausted, 5h free. Account B: weekly light, 5h exhausted.
		// A naive per-window sort by used fraction swaps the columns between rows.
		const reports: UsageReport[] = [acct("alice@example.test", 1.0, 0.0), acct("bob@example.test", 0.2, 1.0)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 160));
		const lines = text.split("\n");

		const columnOrder = (sectionLabel: string): string[] => {
			const headerIdx = lines.findIndex(l => l.includes(sectionLabel));
			expect(headerIdx).toBeGreaterThanOrEqual(0);
			// The account-label row is the line right after the section header.
			const labelRow = lines[headerIdx + 1];
			return ["alice@example.test", "bob@example.test"].sort((a, b) => labelRow.indexOf(a) - labelRow.indexOf(b));
		};

		const totalOrder = columnOrder("Total quota");
		const fiveHOrder = columnOrder("5h limit");
		expect(fiveHOrder).toEqual(totalOrder);
	});

	it("keeps all-used-only amount cells within four-column narrow widths", () => {
		const reports = [spendAcct("first@example.test", 123.45), spendAcct("second@example.test", 67.89)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 11));
		const lines = text.split("\n");
		const headerIdx = lines.findIndex(line => line.includes("Claude Extra Usage"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		const amountRow = lines[headerIdx + 2]!;
		const cells = amountRow.trim().split(/\s+/);

		expect(cells).toHaveLength(2);
		expect(cells.every(cell => Bun.stringWidth(cell) <= 4)).toBe(true);
		expect(Bun.stringWidth(amountRow)).toBeLessThanOrEqual(11);
	});

	it("keeps mixed capped and used-only amount cells aligned at narrow widths", () => {
		const reports = [spendAcct("capped@example.test", 50, 100), spendAcct("uncapped@example.test", 123.45)];
		const text = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 20));
		const lines = text.split("\n");
		const headerIdx = lines.findIndex(line => line.includes("Claude Extra Usage"));
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		const labelRow = lines[headerIdx + 1]!;
		const amountRow = lines[headerIdx + 2]!;
		const summaryStart = amountRow.lastIndexOf(" 2 accts");

		expect(summaryStart).toBeGreaterThanOrEqual(0);
		expect(Bun.stringWidth(labelRow)).toBe(11);
		expect(Bun.stringWidth(amountRow.slice(2, summaryStart))).toBe(9);
	});
});
