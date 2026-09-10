import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import { filterUsageReportsForDisplay } from "@oh-my-pi/pi-coding-agent/utils/usage-display";

let priorTheme: Theme | undefined;

function limit(id: string, label: string, usedFraction: number | undefined, scope: UsageLimit["scope"]): UsageLimit {
	return {
		id,
		label,
		scope,
		window: { id, label: "quota window" },
		amount: { usedFraction, unit: "percent" },
		status: "ok",
	};
}

function usageReports(): UsageReport[] {
	const provider = "meter-provider";
	const accountId = "account-1";
	return [
		{
			provider,
			fetchedAt: 1_700_000_000_000,
			limits: [
				limit("base", "Base quota", 0.2, { provider, accountId }),
				limit("zero-model-short", "Unused model short", 0, { provider, accountId, modelId: "unused-model" }),
				limit("zero-model-long", "Unused model long", 0, { provider, accountId, modelId: "unused-model" }),
				limit("zero-tier", "Unused tier", 0, { provider, accountId, tier: "unused-tier" }),
				limit("active-model", "Active model", 0.1, { provider, accountId, modelId: "active-model" }),
				limit("unknown-tier", "Unknown tier", undefined, { provider, accountId, tier: "unknown-tier" }),
			],
			metadata: { email: "user@example.test" },
		},
	];
}

function settingsDouble(showZeroUsageMeters: boolean) {
	return {
		get: (key: string) => {
			if (key === "display.showZeroUsageMeters") return showZeroUsageMeters;
			return undefined;
		},
	};
}

async function buildAcpText(showZeroUsageMeters: boolean, reports = usageReports()): Promise<string> {
	return await buildUsageReportText({
		settings: settingsDouble(showZeroUsageMeters),
		session: {
			model: undefined,
			fetchUsageReports: async () => reports,
			getUsageReportingModelSelectors: () => [],
		},
	} as never);
}

/** Mirrors `showUsageDashboard`: the detail view renders the filtered reports. */
function buildTuiText(showZeroUsageMeters: boolean, reports = usageReports()): string {
	const displayReports = filterUsageReportsForDisplay(reports, { showZeroUsageMeters });
	return stripVTControlCharacters(renderUsageReports(displayReports, theme, Date.now(), 120));
}

describe("display.showZeroUsageMeters", () => {
	beforeAll(async () => {
		priorTheme = theme;
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});
	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	for (const [label, build] of [
		["ACP text", buildAcpText],
		["TUI aggregate", buildTuiText],
	] as const) {
		it(`${label}: disabled hides only zero supplemental model and tier meters`, async () => {
			const text = await build(false);
			expect(text).toContain("Base quota");
			expect(text).toContain("Active model");
			expect(text).toContain("Unknown tier");
			expect(text).not.toContain("Unused model short");
			expect(text).not.toContain("Unused model long");
			expect(text).not.toContain("Unused tier");
		});

		it(`${label}: enabled preserves zero supplemental meters`, async () => {
			const text = await build(true);
			expect(text).toContain("Unused model short");
			expect(text).toContain("Unused model long");
			expect(text).toContain("Unused tier");
		});

		it(`${label}: disabled preserves a provider's sole scoped meter`, async () => {
			const provider = "scoped-provider";
			const reports: UsageReport[] = [
				{
					provider,
					fetchedAt: 1_700_000_000_000,
					limits: [limit("only", "Only quota", 0, { provider, tier: "core" })],
				},
			];
			expect(await build(false, reports)).toContain("Only quota");
		});
	}
});
