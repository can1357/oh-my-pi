import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function runningJob(type: AsyncJobType, index: number): AsyncJobSnapshotItem {
	const id = `${type}-${index}`;
	return {
		id,
		type,
		status: "running",
		label: `${type} ${index}`,
		startTime: index,
		agentId: type === "task" ? id : undefined,
	};
}

function makeComponent(running: AsyncJobSnapshotItem[]): StatusLineComponent {
	const messages: unknown[] = [];
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
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
		getAsyncJobSnapshot: () => ({ running }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
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
	const component = new StatusLineComponent(session);
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
	return component;
}

describe("status-line background-job badge", () => {
	it("counts non-task jobs without duplicating running task subagents", () => {
		const running = [runningJob("task", 0), runningJob("bash", 1), runningJob("eval", 2)];
		const component = makeComponent(running);
		component.setRunningSubagents(["task-0"]);

		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.agents} 1 agent`);
		expect(content).toContain(`${theme.icon.job} 2`);
	});

	it("counts queued task jobs before their subagent is registered", () => {
		const component = makeComponent([runningJob("task", 0)]);
		component.setRunningSubagents([]);
		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.job} 1`);
	});
});
