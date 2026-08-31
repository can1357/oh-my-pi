import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

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

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
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

async function buildTuiText(showZeroUsageMeters: boolean, reports = usageReports()): Promise<string> {
	const present = vi.fn();
	const ctx = {
		settings: settingsDouble(showZeroUsageMeters),
		session: { getUsageReportingModelSelectors: () => [] },
		ui: { terminal: { columns: 100 } },
		presentCommandOutput: present,
		showWarning: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleUsageCommand(reports);
	const blocks = present.mock.calls[0]?.[0];
	const rendered = (Array.isArray(blocks) ? blocks : [blocks])
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
	return stripVTControlCharacters(rendered);
}

describe("display.showZeroUsageMeters", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
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
