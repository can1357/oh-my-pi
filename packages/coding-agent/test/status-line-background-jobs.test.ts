import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { JobWidgetEntry, JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { StatusLineTestComponents } from "./helpers/status-line";

let settingsState: SettingsTestState | undefined;
const statusLines = new StatusLineTestComponents();

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	statusLines.dispose();
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

function makeComponent(
	running: AsyncJobSnapshotItem[],
	widgets: () => readonly JobWidgetEntry[] = () => [],
): StatusLineComponent {
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
		getRunningJobWidgets: widgets,
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
	const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
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
		expect(content).toContain(`${theme.icon.agents} 1`);
		expect(content).toContain(`${theme.icon.job} 2`);
	});

	it("appends the freshest widget's headline and spark, and redraws when its data moves", () => {
		const spark = (values: number[], last: string): JobWidgetView => ({
			title: "verb-bench",
			headline: { text: last, trend: { text: "▲ 15%", tone: "success" } },
			blocks: [{ kind: "spark", label: "tok/s", values, min: 0, max: 200, last }],
			state: "live",
			updatedAt: values.length,
		});
		let entries: JobWidgetEntry[] = [
			{ id: "bash-1", type: "bash", view: spark([100, 200], "200 tok/s") },
			{ id: "bash-2", type: "bash", view: { ...spark([10], "10 tok/s"), updatedAt: 0 } },
		];
		const component = makeComponent([runningJob("bash", 1), runningJob("bash", 2)], () => entries);
		const top = () => stripVTControlCharacters(component.getTopBorder(120).content);
		expect(top()).toContain(`${theme.icon.job} 2 200 tok/s ▲ 15% ▅█`);
		entries = [{ id: "bash-1", type: "bash", view: spark([100, 200, 50], "50 tok/s") }, entries[1]!];
		expect(top()).toContain(`${theme.icon.job} 2 50 tok/s ▲ 15% ▅█▃`);
	});

	it("counts queued task jobs before their subagent is registered", () => {
		const component = makeComponent([runningJob("task", 0)]);
		component.setRunningSubagents([]);
		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.job} 1`);
	});
});
