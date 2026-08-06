/**
 * Coverage for the `display.showUsageModels` opt-out.
 *
 * The setting defaults to `true`, so `/usage` keeps listing every model mapped
 * to a provider's live usage data. Turning it off must drop the "Models with
 * usage data" heading and its indented selector lines, and change nothing else
 * in the report.
 *
 * Both `/usage` surfaces resolve the list through `resolveUsageModelSelectors`:
 * the fullscreen TUI dashboard (`selector-controller.showUsageDashboard`, whose
 * detail pane is `renderUsageReports`) and the ACP text builder in
 * `usage-report.ts`.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";
import { resolveUsageModelSelectors, type UsageModelListSettings } from "@oh-my-pi/pi-coding-agent/utils/usage-display";

const SELECTORS = ["test-provider/gpt-5.6", "test-provider/claude-sonnet-4.6"];

/** `display.showUsageModels` is the only setting either `/usage` path reads. */
function settingsDouble(showUsageModels: boolean): UsageModelListSettings {
	return { get: () => showUsageModels };
}

function usageReport(): UsageReport {
	return {
		provider: "test-provider",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "daily",
				label: "Daily",
				scope: { provider: "test-provider", accountId: "acct-1" },
				window: { id: "daily", label: "daily" },
				amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				status: "ok",
			},
		],
		metadata: { email: "user@example.test" },
	};
}

async function buildAcpText(showUsageModels: boolean): Promise<string> {
	return await buildUsageReportText({
		settings: settingsDouble(showUsageModels),
		session: {
			model: undefined,
			fetchUsageReports: async () => [usageReport()],
			getUsageReportingModelSelectors: () => SELECTORS,
		},
	} as never);
}

/** The dashboard detail pane: same resolver call as `showUsageDashboard`. */
async function buildTuiText(showUsageModels: boolean): Promise<string> {
	const reports = [usageReport()];
	const usageModelSelectors = resolveUsageModelSelectors(reports, settingsDouble(showUsageModels), () => SELECTORS);
	return stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120, undefined, usageModelSelectors));
}

describe("display.showUsageModels", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	for (const [label, build] of [
		["ACP text", buildAcpText],
		["TUI dashboard detail", buildTuiText],
	] as const) {
		it(`${label}: enabled lists every model mapped to live usage data`, async () => {
			const text = await build(true);
			expect(text).toContain("Models with usage data");
			for (const selector of SELECTORS) expect(text).toContain(selector);
		});

		it(`${label}: disabled drops the block and nothing else`, async () => {
			const enabled = await build(true);
			const disabled = await build(false);

			expect(disabled).not.toContain("Models with usage data");
			for (const selector of SELECTORS) expect(disabled).not.toContain(selector);

			// Everything the opt-out removed is exactly the heading plus one line per
			// selector; the surrounding report survives line-for-line.
			const removed = enabled
				.split("\n")
				.filter(line => line.includes("Models with usage data") || SELECTORS.some(s => line.includes(s)));
			expect(removed).toHaveLength(SELECTORS.length + 1);
			expect(
				enabled
					.split("\n")
					.filter(line => !removed.includes(line))
					.join("\n"),
			).toBe(disabled);
		});
	}

	it("skips the registry walk entirely when opted out", () => {
		let walks = 0;
		const selectors = resolveUsageModelSelectors([usageReport()], settingsDouble(false), () => {
			walks++;
			return SELECTORS;
		});
		expect(selectors).toEqual([]);
		expect(walks).toBe(0);
	});
});
