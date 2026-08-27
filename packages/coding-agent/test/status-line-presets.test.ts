import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const EXPECTED_USAGE_OUTPUT = "5h 24%";
const ACCOUNT_ID = "test-account";

const USAGE_REPORTS: UsageReport[] = [
	{
		provider: "openai-codex",
		fetchedAt: Date.now(),
		metadata: { accountId: ACCOUNT_ID },
		limits: [
			{
				id: "openai-codex:primary",
				label: "5 Hour",
				scope: { provider: "openai-codex", accountId: ACCOUNT_ID, windowId: "5h" },
				amount: { usedFraction: 0.24, unit: "percent" },
			},
			{
				id: "openai-codex:secondary",
				label: "7 Day",
				scope: { provider: "openai-codex", accountId: ACCOUNT_ID, windowId: "7d" },
				amount: { usedFraction: 0.08, unit: "percent" },
			},
		],
	},
];

type TestedPreset = "default" | "full" | "nerd";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	settings.override("git.enabled", false);
	await initTheme();
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function makeComponent(): StatusLineComponent {
	const messages: unknown[] = [];
	const model = {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		contextWindow: 100_000,
		provider: "openai-codex",
	};
	const session = {
		state: { messages, model },
		messages,
		model,
		contextUsageRevision: 0,
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
		fetchUsageReports: async () => USAGE_REPORTS,
		modelRegistry: {
			isUsingOAuth: () => true,
			authStorage: {
				getOAuthAccountIdentity: (provider: string) =>
					provider === "openai-codex" ? { accountId: ACCOUNT_ID } : undefined,
			},
		},
		sessionManager: {
			getSessionName: () => undefined,
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
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	return new StatusLineComponent(session);
}

async function waitForUsageRefresh(component: StatusLineComponent): Promise<void> {
	const refreshed = Promise.withResolvers<void>();
	component.watchBranch(refreshed.resolve);
	component.getTopBorder(500);
	vi.advanceTimersByTime(0);
	await refreshed.promise;
}

async function renderPreset(preset: TestedPreset): Promise<string> {
	settings.override("statusLine.preset", preset);
	const component = makeComponent();
	vi.useFakeTimers();
	try {
		await waitForUsageRefresh(component);
		return stripVTControlCharacters(component.getTopBorder(500).content);
	} finally {
		component.dispose();
		vi.useRealTimers();
	}
}

describe("status line presets", () => {
	it("renders account usage in the full preset", async () => {
		const content = await renderPreset("full");

		expect(content).toContain(EXPECTED_USAGE_OUTPUT);
	});

	it("renders account usage in the nerd preset", async () => {
		const content = await renderPreset("nerd");

		expect(content).toContain(EXPECTED_USAGE_OUTPUT);
	});

	it("does not render account usage in the default preset", async () => {
		const content = await renderPreset("default");

		expect(content).not.toContain(EXPECTED_USAGE_OUTPUT);
	});
});
