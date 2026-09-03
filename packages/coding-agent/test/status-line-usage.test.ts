import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

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
	options: {
		provider?: string;
		modelId?: string;
		activeIdentity?: { accountId?: string; email?: string; projectId?: string };
	} = {},
): StatusLineComponent {
	const component = new StatusLineComponent({
		state: { messages: [], model: { id: options.modelId, contextWindow: 1000, provider: options.provider } },
		model: { id: options.modelId, contextWindow: 1000, provider: options.provider },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
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

	it("selects one coherent scope for the active model", async () => {
		const reports = [
			{
				provider: "openai-codex",
				limits: [
					{
						scope: { windowId: "5h", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0 },
					},
					{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					{
						scope: { windowId: "7d", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0 },
					},
				],
			},
		];
		const component = makeComponent(reports, { provider: "openai-codex", modelId: "gpt-5.6-sol" });

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("spark");
		expect(content).not.toContain("5h");
		expect(content).toContain("7d");
		expect(content).toContain("8%");

		const sparkComponent = makeComponent(reports, {
			provider: "openai-codex",
			modelId: "gpt-5.3-codex-spark",
		});
		sparkComponent.refreshUsageInBackground();
		await flushUsageRefresh();
		const sparkContent = stripVTControlCharacters(sparkComponent.getTopBorder(200).content);

		expect(sparkContent).toContain("spark");
		expect(sparkContent).toContain("5h");
		expect(sparkContent).toContain("7d");
		expect(sparkContent).not.toContain("8%");
	});

	it("labels untiered windows with the report's plan tier (Z.AI planType)", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "zai",
					metadata: { planType: "pro" },
					limits: [
						{
							scope: { provider: "zai", windowId: "5h" },
							window: { resetsAt: now + 30 * 60_000 },
							amount: { usedFraction: 0.21 },
						},
						{
							scope: { provider: "zai", windowId: "7d" },
							window: { resetsAt: now + 141 * 3_600_000 },
							amount: { usedFraction: 0.05 },
						},
					],
				},
			],
			{ provider: "zai" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("pro");
		expect(content).toContain("5h");
		expect(content).toContain("21%");
		expect(content).toContain("7d");
		expect(content).toContain("5%");
	});

	it("keeps windows within the preferred untiered scope", async () => {
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

		expect(content).not.toContain("prolite");
		expect(content).not.toContain("stale");
		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).not.toContain("7d");
		expect(content).not.toContain("8%");
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
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
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

	it("invalidates cached usage when the active model changes within a provider", async () => {
		const model = { id: "gpt-5.6-sol", contextWindow: 1000, provider: "openai-codex" };
		const reports = [
			{
				provider: "openai-codex",
				metadata: { accountId: "active-account" },
				limits: [
					{ scope: { windowId: "7d" }, amount: { usedFraction: 0.08 } },
					{
						scope: { windowId: "5h", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0.42 },
					},
					{
						scope: { windowId: "7d", tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
						amount: { usedFraction: 0.11 },
					},
				],
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
					totalTokens: 0,
					orchestrationInput: 0,
					orchestrationOutput: 0,
					orchestrationCacheRead: 0,
					premiumRequests: 0,
					cost: 0,
				}),
			},
			fetchUsageReports: async () => reports,
			modelRegistry: {
				authStorage: {
					getOAuthAccountIdentity: (requestedProvider: string) =>
						requestedProvider === "openai-codex" ? { accountId: "active-account" } : undefined,
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
		const solContent = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(solContent).not.toContain("spark");
		expect(solContent).not.toContain("5h");
		expect(solContent).toContain("8%");

		model.id = "gpt-5.3-codex-spark";
		const immediate = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(immediate).not.toContain("8%");
		await flushUsageRefresh();
		const sparkContent = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(sparkContent).toContain("spark");
		expect(sparkContent).toContain("5h");
		expect(sparkContent).toContain("42%");
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

	it("renders monthly Cursor usage when five-hour and seven-day windows are absent", () => {
		const result = renderSegment("usage", {
			usage: { monthly: { percent: 1.88, resetHours: 743 } },
		} as unknown as SegmentContext);
		const content = stripVTControlCharacters(result.content);

		expect(result.visible).toBe(true);
		expect(content).toContain("mo");
		// Match Cursor web dashboard flooring (1.88 → 1%), not Math.round → 2%.
		expect(content).toContain("1%");
		expect(content).not.toContain("2%");
		expect(content).toContain("30d 23h");
		expect(content).not.toContain("5h");
		expect(content).not.toContain("7d");
	});

	it("keeps monthly Cursor personal usage from the active provider", async () => {
		const component = makeComponent(
			[
				{
					provider: "cursor",
					limits: [
						{
							id: "cursor:usd:individual-plan",
							scope: { windowId: "monthly" },
							window: { id: "monthly", resetsAt: Date.now() + 743 * 3_600_000 },
							amount: { usedFraction: 0.132 },
						},
					],
				},
			],
			{ provider: "cursor" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("mo");
		expect(content).toContain("13%");
	});

	it("prefers Cursor personal dashboard rails over legacy monthly request limits", async () => {
		const component = makeComponent(
			[
				{
					provider: "cursor",
					limits: [
						{
							id: "cursor:requests:gpt-4",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.9 },
						},
						{
							id: "cursor:usd:individual-auto",
							scope: { windowId: "monthly" },
							amount: { usedFraction: 0.0185 },
						},
					],
				},
			],
			{ provider: "cursor" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("mo");
		expect(content).toContain("1%");
		expect(content).not.toContain("90%");
	});

	it("renders all three OpenCode Go windows including monthly", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "opencode-go",
					limits: [
						{
							id: "rolling-5h",
							scope: { windowId: "5h" },
							window: { id: "5h", durationMs: 5 * 3_600_000, resetsAt: now + 90 * 60_000 },
							amount: { used: 12, usedFraction: 0.12, unit: "percent" },
						},
						{
							id: "weekly",
							scope: { windowId: "7d" },
							window: { id: "7d", durationMs: 7 * 86_400_000, resetsAt: now + 100 * 3_600_000 },
							amount: { used: 8, usedFraction: 0.08, unit: "percent" },
						},
						{
							id: "monthly",
							scope: { windowId: "monthly" },
							window: { id: "monthly", resetsAt: now + 160 * 3_600_000 },
							amount: { used: 42, usedFraction: 0.42, unit: "percent" },
						},
					],
				},
			],
			{ provider: "opencode-go" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("12%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
		expect(content).toContain("mo");
		expect(content).toContain("42%");
	});

	it("does not render monthly usage for providers outside the single-bucket gate", async () => {
		const component = makeComponent(
			[
				{
					provider: "github-copilot",
					limits: [{ id: "copilot:premium", scope: { windowId: "monthly" }, amount: { usedFraction: 0.42 } }],
				},
			],
			{ provider: "github-copilot" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("mo");
		expect(content).not.toContain("42%");
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

	it("maps non-canonical window ids onto subscription windows by reported span", async () => {
		// Kimi-shaped rows: the burst window reports duration/timeUnit instead
		// of a canonical id, and rows written before canonicalization keep the
		// old id. The reported span still identifies the window.
		const now = Date.now();
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "300time_unit_minute" },
						window: { durationMs: 5 * 3_600_000, resetsAt: now + 30 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						scope: { windowId: "weekly" },
						window: { durationMs: 7 * 86_400_000, resetsAt: now + 141 * 3_600_000 },
						amount: { usedFraction: 0.08 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).toContain("7d");
		expect(content).toContain("8%");
	});

	it("renders Google Antigravity daily usage", async () => {
		const now = Date.now();
		const component = makeComponent(
			[
				{
					provider: "google-antigravity",
					limits: [
						{
							label: "Usage (Google)",
							scope: { provider: "google-antigravity", windowId: "daily" },
							window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 11 * 60_000 },
							amount: { usedFraction: 0.054 },
						},
					],
				},
			],
			{ provider: "google-antigravity" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("1d");
		expect(content).toContain("5%");
		expect(content).toContain("11m");
	});

	it("scopes Antigravity usage to the active model's backend counter", async () => {
		const now = Date.now();
		const reports = [
			{
				provider: "google-antigravity",
				limits: [
					{
						id: "google-antigravity:default:default:daily",
						label: "Usage",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 5 * 60_000 },
						amount: { usedFraction: 0.99 },
					},
					{
						id: "google-antigravity:google:default:daily",
						label: "Usage (Google)",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 11 * 60_000 },
						amount: { usedFraction: 0.91 },
					},
					{
						id: "google-antigravity:anthropic:default:daily",
						label: "Usage (Anthropic)",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 40 * 60_000 },
						amount: { usedFraction: 0.24 },
					},
					{
						id: "google-antigravity:openai:default:daily",
						label: "Usage (OpenAI)",
						scope: { provider: "google-antigravity", windowId: "daily" },
						window: { id: "daily", label: "Daily", durationMs: 86_400_000, resetsAt: now + 25 * 60_000 },
						amount: { usedFraction: 0.63 },
					},
				],
			},
		];

		const claude = makeComponent(reports, { provider: "google-antigravity", modelId: "claude-opus-4-6" });
		claude.refreshUsageInBackground();
		await flushUsageRefresh();
		const claudeContent = stripVTControlCharacters(claude.getTopBorder(200).content);
		expect(claudeContent).toContain("1d");
		expect(claudeContent).toContain("24%");
		expect(claudeContent).not.toContain("91%");
		expect(claudeContent).not.toContain("99%");

		const gemini = makeComponent(reports, { provider: "google-antigravity", modelId: "gemini-3-pro" });
		gemini.refreshUsageInBackground();
		await flushUsageRefresh();
		const geminiContent = stripVTControlCharacters(gemini.getTopBorder(200).content);
		expect(geminiContent).toContain("1d");
		expect(geminiContent).toContain("91%");
		expect(geminiContent).not.toContain("24%");
		expect(geminiContent).not.toContain("99%");

		const gptOss = makeComponent(reports, { provider: "google-antigravity", modelId: "gpt-oss-120b" });
		gptOss.refreshUsageInBackground();
		await flushUsageRefresh();
		const gptOssContent = stripVTControlCharacters(gptOss.getTopBorder(200).content);
		expect(gptOssContent).toContain("1d");
		expect(gptOssContent).toContain("63%");
		expect(gptOssContent).not.toContain("91%");
		expect(gptOssContent).not.toContain("99%");
		for (const modelId of ["tab_flash_lite_preview", "tab_jump_flash_lite_preview"]) {
			const tabModel = makeComponent(reports, { provider: "google-antigravity", modelId });
			tabModel.refreshUsageInBackground();
			await flushUsageRefresh();
			const tabContent = stripVTControlCharacters(tabModel.getTopBorder(200).content);
			expect(tabContent).toContain("1d");
			expect(tabContent).toContain("91%");
			expect(tabContent).not.toContain("24%");
			expect(tabContent).not.toContain("99%");
		}
	});

	it("falls back to legacy default Antigravity usage when the model counter is absent", async () => {
		const component = makeComponent(
			[
				{
					provider: "google-antigravity",
					limits: [
						{
							id: "google-antigravity:default:default:daily",
							label: "Usage",
							scope: { provider: "google-antigravity", windowId: "daily" },
							window: { id: "daily", label: "Daily", durationMs: 86_400_000 },
							amount: { usedFraction: 0.42 },
						},
					],
				},
			],
			{ provider: "google-antigravity", modelId: "claude-opus-4-6" },
		);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);
		expect(content).toContain("1d");
		expect(content).toContain("42%");
	});

	it("ignores non-canonical windows without a reported span", async () => {
		const component = makeComponent([
			{
				limits: [
					{ scope: { windowId: "default" }, window: {}, amount: { usedFraction: 0.24 } },
					{
						scope: { windowId: "monthly" },
						window: { durationMs: 30 * 86_400_000 },
						amount: { usedFraction: 0.5 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).not.toContain("24%");
		expect(content).not.toContain("50%");
	});

	it("prefers canonical window ids over a conflicting reported span", async () => {
		const component = makeComponent([
			{
				limits: [
					{
						scope: { windowId: "5h" },
						window: { durationMs: 7 * 86_400_000 },
						amount: { usedFraction: 0.24 },
					},
				],
			},
		]);

		component.refreshUsageInBackground();
		await flushUsageRefresh();
		const content = stripVTControlCharacters(component.getTopBorder(200).content);

		expect(content).toContain("5h");
		expect(content).toContain("24%");
		expect(content).not.toContain("7d");
	});
});
