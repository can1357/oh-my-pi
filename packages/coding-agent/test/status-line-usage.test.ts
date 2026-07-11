import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function makeComponent(
	reports: unknown,
	options: { provider?: string; activeIdentity?: { accountId?: string; email?: string; projectId?: string } } = {},
): StatusLineComponent {
	const component = new StatusLineComponent({
		state: { messages: [], model: { contextWindow: 1000, provider: options.provider } },
		model: { contextWindow: 1000, provider: options.provider },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		fetchUsageReports: async () => reports,
		modelRegistry: {
			authStorage: {
				getOAuthAccountIdentity: (provider: string) =>
					provider === options.provider ? options.activeIdentity : undefined,
			},
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: ["usage"],
		sessionAccent: false,
	});
	return component;
}

async function flushUsageRefresh(): Promise<void> {
	const timer = Promise.withResolvers<void>();
	setTimeout(timer.resolve, 0);
	await timer.promise;
	await Promise.resolve();
	await Promise.resolve();
}

describe("usage status-line segment", () => {
	it("renders untiered five-hour and seven-day limits", () => {
		const result = renderSegment("usage", {
			usage: { fiveHour: { percent: 24, resetMinutes: 30 }, sevenDay: { percent: 8, resetHours: 141 } },
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("30m");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
		expect(content).toContain("5d 21h");
	});

	it("renders tiered usage fetched from provider reports", async () => {
		const now = Date.now();
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "5h", tier: "prolite" },
						window: { resetsAt: now + 30 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						scope: { windowId: "7d", tier: "prolite" },
						window: { resetsAt: now + 141 * 3_600_000 },
						amount: { usedFraction: 0.08 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("prolite");
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("prefers untiered windows and labels the displayed tiered window", async () => {
		const component = makeComponent([
			{
				limits: [
					{ scope: { windowId: "5h", tier: "stale" }, amount: { usedFraction: 0.5 } },
					{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
					{ scope: { windowId: "7d", tier: "prolite" }, amount: { usedFraction: 0.08 } },
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("prolite");
		expect(content).not.toContain("stale");
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("scopes fetched usage reports to the active provider and account", async () => {
		const component = makeComponent(
			[
				{
					provider: "anthropic",
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.99 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.98 } },
					],
				},
				{
					provider: "openai-codex",
					metadata: { accountId: "other-account" },
					limits: [{ scope: { windowId: "5h", tier: "other" }, amount: { usedFraction: 0.66 } }],
				},
				{
					provider: "openai-codex",
					metadata: { accountId: "active-account" },
					limits: [
						{ scope: { windowId: "5h", tier: "prolite" }, amount: { usedFraction: 0.24 } },
						{ scope: { windowId: "7d", tier: "prolite" }, amount: { usedFraction: 0.08 } },
					],
				},
			],
			{ provider: "openai-codex", activeIdentity: { accountId: "active-account" } },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("prolite");
		expect(content).toContain("24%");
		expect(content).toContain("8%");
		expect(content).not.toContain("99%");
		expect(content).not.toContain("98%");
		expect(content).not.toContain("66%");
		expect(content).not.toContain("other");
	});

	it("invalidates cached usage when the active provider changes", async () => {
		let provider = "openai-codex";
		const model = { contextWindow: 1000, provider };
		const reports = [
			{
				provider: "anthropic",
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } }],
			},
			{
				provider: "openai-codex",
				metadata: { accountId: "active-account" },
				limits: [{ scope: { windowId: "5h", tier: "prolite" }, amount: { usedFraction: 0.8 } }],
			},
		];
		const session = {
			state: { messages: [], model },
			model,
			sessionManager: {
				getUsageStatistics: () => ({
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			fetchUsageReports: async () => reports,
			modelRegistry: {
				authStorage: {
					getOAuthAccountIdentity: (requestedProvider: string) =>
						requestedProvider === provider && provider === "openai-codex"
							? { accountId: "active-account" }
							: undefined,
				},
			},
			getAsyncJobSnapshot: () => ({ running: [] }),
			getContextUsage: () => undefined,
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
		const component = new StatusLineComponent(session);
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["usage"],
			sessionAccent: false,
		});

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		expect(stripVTControlCharacters(component.getTopBorder(200).content)).toContain("80%");

		provider = "anthropic";
		model.provider = provider;

		const immediate = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(immediate).not.toContain("80%");
		await flushUsageRefresh();
		const refreshed = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(refreshed).toContain("24%");
	});

	it("keeps active-provider rate-limit header reports with account metadata", async () => {
		const component = makeComponent(
			[
				{
					provider: "anthropic",
					metadata: { source: "ratelimit-headers", accountId: "other-account" },
					limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.66 } }],
				},
				{
					provider: "anthropic",
					metadata: { source: "ratelimit-headers", accountId: "active-account" },
					limits: [
						{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } },
						{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					],
				},
			],
			{ provider: "anthropic", activeIdentity: { accountId: "active-account" } },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
		expect(content).not.toContain("66%");
	});

	it("renders tiered limits with the tier label", () => {
		const result = renderSegment("usage", {
			usage: {
				tier: "prolite",
				fiveHour: { percent: 50, resetMinutes: 120 },
				sevenDay: { percent: 10, resetHours: 48 },
			},
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("prolite");
		expect(content).toContain("5h");
		expect(content).toContain("50%");
		expect(content).toContain("7d");
		expect(content).toContain("10%");
	});

	it("sanitizes tier labels before rendering", () => {
		const result = renderSegment("usage", {
			usage: {
				tier: "\u001b[31mbad\t tier\nvalue\u001b[0m",
				fiveHour: { percent: 50 },
			},
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("bad tier value");
		expect(result.content).not.toContain("\u001b[31m");
		expect(result.content).not.toContain("\t");
		expect(result.content).not.toContain("\n");
	});

	it("hides null usage", () => {
		const result = renderSegment("usage", { usage: null } as unknown as SegmentContext);

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("hides usage without visible windows", () => {
		const result = renderSegment("usage", { usage: {} } as unknown as SegmentContext);

		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});

	it("renders five-hour usage without seven-day usage", () => {
		const result = renderSegment("usage", { usage: { fiveHour: { percent: 80 } } } as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("5h");
		expect(content).toContain("80%");
		expect(content).not.toContain("7d");
	});

	it("uses a distinct error color at the eighty-percent threshold", () => {
		const high = renderSegment("usage", { usage: { fiveHour: { percent: 80 } } } as unknown as SegmentContext);
		const low = renderSegment("usage", { usage: { fiveHour: { percent: 24 } } } as unknown as SegmentContext);
		const highWithoutValue = high.content.replace("80%", "PCT");
		const lowWithoutValue = low.content.replace("24%", "PCT");

		expect(high.visible).toBe(true);
		expect(low.visible).toBe(true);
		expect(stripVTControlCharacters(highWithoutValue)).toBe(stripVTControlCharacters(lowWithoutValue));
		expect(highWithoutValue).not.toBe(lowWithoutValue);
	});
});
