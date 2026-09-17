import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => resetSettingsForTest());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function fixture() {
	const model: Model = getBundledModel("deepseek", "deepseek-v4-flash");
	const state: { model: Model; messages: [] } = { model, messages: [] };
	const session = {
		state,
		get model() {
			return state.model;
		},
		messages: state.messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		modelRegistry: { isUsingOAuth: () => false },
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
				cost: 1.25,
			}),
			getSessionName: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => undefined,
		contextUsageRevision: 0,
	} as unknown as AgentSession;
	const component = new StatusLineComponent(session);
	const showCost = () =>
		component.updateSettings({
			preset: "custom",
			leftSegments: [],
			rightSegments: ["cost"],
			sessionAccent: false,
		});
	showCost();
	return {
		component,
		state,
		showCost,
		render: () => stripVTControlCharacters(component.renderBottomBar(80, "full")),
		useFlatModel: () => {
			const { timeBased: _schedule, ...cost } = model.cost;
			state.model = { ...model, provider: "openrouter", cost };
			component.invalidate();
		},
	};
}

describe("status line tariff boundary wakeup", () => {
	it("repaints and rearms while idle without polling or changing recorded dollars", () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-10T03:59:59Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const timers = vi.spyOn(globalThis, "setTimeout");
		const { component, render } = fixture();
		const paints: string[] = [];
		try {
			component.watchBranch(() => paints.push(render()));
			expect(render()).toContain("$1.25 ↑");
			const revision = component.getTopBorder(80).revision;
			component.invalidate();
			render();
			expect(timers).toHaveBeenCalledTimes(1);
			const timer = timers.mock.results[0]!.value as NodeJS.Timeout;
			expect(timer.hasRef()).toBe(false);

			now += 1000;
			vi.advanceTimersByTime(1000);
			expect(paints).toHaveLength(1);
			expect(paints[0]).toContain("$1.25 ↓");
			expect(component.getTopBorder(80).revision).toBeGreaterThan(revision);
			expect(timers).toHaveBeenCalledTimes(2);

			now += 2 * 60 * 60 * 1000;
			vi.advanceTimersByTime(2 * 60 * 60 * 1000);
			expect(paints).toHaveLength(2);
			expect(paints[1]).toContain("$1.25 ↑");
			expect(timers).toHaveBeenCalledTimes(3);
		} finally {
			component.dispose();
		}
	});

	it("removes the arrow immediately and cancels idle wakeups when the active model becomes unscheduled", () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-10T03:59:59Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { component, render, useFlatModel } = fixture();
		const repaint = vi.fn();
		try {
			component.watchBranch(repaint);
			expect(render()).toContain("$1.25 ↑");
			useFlatModel();
			const flat = render();
			expect(flat).toContain("$1.25");
			expect(flat).not.toMatch(/[↑↓]/);
			now += 1000;
			vi.advanceTimersByTime(1000);
			expect(repaint).not.toHaveBeenCalled();
		} finally {
			component.dispose();
		}
	});

	it("cancels when cost is hidden, resumes when shown, and stays stopped after disposal", () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-10T03:59:59Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { component, render, showCost } = fixture();
		const repaint = vi.fn();
		try {
			component.watchBranch(repaint);
			expect(render()).toContain("$1.25 ↑");
			component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: [] });
			expect(render()).not.toContain("$1.25");
			now += 1000;
			vi.advanceTimersByTime(1000);
			expect(repaint).not.toHaveBeenCalled();

			showCost();
			expect(render()).toContain("$1.25 ↓");
			now += 2 * 60 * 60 * 1000;
			vi.advanceTimersByTime(2 * 60 * 60 * 1000);
			expect(repaint).toHaveBeenCalledTimes(1);
			component.dispose();
			component.invalidate();
			render();
			now += 4 * 60 * 60 * 1000;
			vi.advanceTimersByTime(4 * 60 * 60 * 1000);
			expect(repaint).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});
});
