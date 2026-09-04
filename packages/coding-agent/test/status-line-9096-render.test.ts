import { afterEach, beforeEach, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const originalProfile = getActiveProfile();
let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	// Profile is process-wide; restore it after settings-state cleanup because
	// restoring the captured agent dir resets the active profile.
	setProfile(originalProfile);
});

test("renders profile plus compact metric status line", () => {
	setProfile("work");
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "GPT-5.6-Sol", contextWindow: 100000 } },
		messages: [],
		model: { name: "GPT-5.6-Sol", contextWindow: 100000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "status demo",
			getUsageStatistics: () => ({
				input: 25000,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 25005,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => ({ tokens: 9100, contextWindow: 100000, percent: 9.1 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);

	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "profile"],
		rightSegments: ["token_total", "context_pct"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
		segmentOptions: {
			token_total: { breakdown: true },
			context_pct: { compact: true },
		},
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(120).content);
	expect(rendered).toContain("GPT-5.6-Sol");
	expect(rendered).toContain("p:work");
	expect(rendered).toContain("in:25K out:5");
	expect(rendered).toContain("ctx:9.1%");
	expect(rendered).not.toContain("100K");
});

test("compact context percentage preserves an explicitly configured context total", () => {
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "M", contextWindow: 100000 } },
		messages: [],
		model: { name: "M", contextWindow: 100000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "status demo",
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
		getContextUsage: () => ({ tokens: 8000, contextWindow: 100000, percent: 8 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);

	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "context_pct"],
		rightSegments: ["context_total", "session_name"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
		segmentOptions: { context_pct: { compact: true } },
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(80).content);
	expect(rendered).toContain("ctx:8%");
	expect(rendered).toContain("100K");
});

test("breakdown keeps orchestration usage out of in/out labels", () => {
	setProfile("work");
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "GPT-5.6-Sol", contextWindow: 100000 } },
		messages: [],
		model: { name: "GPT-5.6-Sol", contextWindow: 100000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "status demo",
			getUsageStatistics: () => ({
				input: 25000,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 37005,
				orchestrationInput: 7000,
				orchestrationOutput: 5000,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => ({ tokens: 9100, contextWindow: 100000, percent: 9.1 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);

	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "profile"],
		rightSegments: ["token_total", "context_pct"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
		segmentOptions: {
			token_total: { breakdown: true },
			context_pct: { compact: true },
		},
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(120).content);
	// in:/out: reflect only prompt input+cacheWrite / output, not orchestration.
	expect(rendered).toContain("in:25K out:5");
	// orchestration usage is surfaced under its own label, not folded in.
	expect(rendered).toContain("orch:12K");
});

test("keeps compact embedded context visible in a seven-cell gauge gap", () => {
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "M", contextWindow: 100000 } },
		messages: [],
		model: { name: "M", contextWindow: 100000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "status demo",
			getUsageStatistics: () => ({
				input: 25000,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 25005,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => ({ tokens: 8000, contextWindow: 100000, percent: 8 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);

	component.updateSettings({
		preset: "custom",
		leftSegments: ["model"],
		rightSegments: ["token_total", "context_pct"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
		segmentOptions: {
			context_pct: { compact: true },
		},
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(20).content);
	expect(rendered).toContain("ctx:8%");
	expect(rendered).toContain("25K");
});

test("renders compact embedded context in an exact-width six-cell gauge gap", () => {
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "M", contextWindow: 100000 } },
		messages: [],
		model: { name: "M", contextWindow: 100000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "status demo",
			getUsageStatistics: () => ({
				input: 25000,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 25005,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => ({ tokens: 8000, contextWindow: 100000, percent: 8 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);

	component.updateSettings({
		preset: "custom",
		leftSegments: ["context_pct"],
		rightSegments: ["token_total", "model"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
		segmentOptions: {
			context_pct: { compact: true },
		},
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(20).content);
	expect(rendered).toContain("ctx:8%");
	expect(rendered).toContain("25K");
});

test("keeps the embedded context percentage visible when every slot collides with a boundary marker", () => {
	// Narrow gauge (small window makes the "50K" label wide relative to the gap)
	// where the only legal label positions overlap the speculation/threshold
	// markers. Regression: the context percent is the primary readout, so it
	// must still render rather than being dropped when the placement search
	// finds no gap that clears both markers.
	const component = new StatusLineComponent({
		state: { messages: [], model: { name: "M", contextWindow: 50000 } },
		messages: [],
		model: { name: "M", contextWindow: 50000 },
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: {
			get: () => false,
			getGroup: (group: string) =>
				group === "compaction"
					? {
							enabled: true,
							strategy: "summarize",
							asyncEnabled: true,
							thresholdPercent: 30,
							methodOrder: ["soft"],
						}
					: {},
		},
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "s",
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
		getContextUsage: () => ({ tokens: 12500, contextWindow: 50000, percent: 25 }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.setAutoCompactEnabled(true);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["model", "context_pct"],
		rightSegments: ["model", "context_total"],
		separator: "pipe",
		sessionAccent: false,
		contextLine: "embedded",
	});

	const rendered = stripVTControlCharacters(component.getTopBorder(20).content);
	expect(rendered).toContain("25%");
	expect(rendered).toContain("50K");
});
