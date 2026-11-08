/**
 * Contract: while a question the host's person closed still waits on collab guests, the host's
 * collab status says on whom, since nothing else shows why the turn has not moved on; the text
 * goes once the wait ends, even though the participant count never changed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function fakeSession(): AgentSession {
	const model = { id: "test-model", name: "Test Model", contextWindow: 200_000 };
	const messages = [{ role: "user", content: "hi" }];
	return {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		settings: undefined,
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
			getSessionName: () => undefined,
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
		contextUsageRevision: 0,
	} as unknown as AgentSession;
}

/** The host's collab segment alone, through the real status-line pipeline. */
function collabBar(): { component: StatusLineComponent; raw(): string; text(): string } {
	const component = new StatusLineComponent(fakeSession(), statusLineHost);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["collab"],
		rightSegments: [],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	const raw = (): string => component.renderBottomBar(120, "full");
	return { component, raw, text: () => Bun.stripANSI(raw()) };
}

describe("host collab status while a closed question waits on guests", () => {
	it("names the guest it waits on, and drops the name once the wait ends", () => {
		const bar = collabBar();
		try {
			bar.component.setCollabStatus({ role: "host", participantCount: 2 });
			expect(bar.text()).toContain("collab:2");
			expect(bar.text()).not.toContain("waiting on");

			bar.component.setCollabStatus({ role: "host", participantCount: 2, waitingOn: ["alice"] });
			expect(bar.text()).toContain("collab:2 · waiting on alice");

			bar.component.setCollabStatus({ role: "host", participantCount: 2, waitingOn: [] });
			expect(bar.text()).not.toContain("waiting on");
		} finally {
			bar.component.dispose();
		}
	});

	it("counts several guests, and shows a guest's name without the terminal controls it carries", () => {
		const bar = collabBar();
		try {
			bar.component.setCollabStatus({ role: "host", participantCount: 3, waitingOn: ["alice", "bob"] });
			expect(bar.text()).toContain("waiting on 2 guests");

			bar.component.setCollabStatus({ role: "host", participantCount: 3, waitingOn: ["\x1b[2Jmallory\nx"] });
			expect(bar.text()).toContain("waiting on mallory x");
			// The bar's own styling stays; the name's screen clear and line break do not.
			expect(bar.raw()).not.toContain("\x1b[2J");
			expect(bar.raw()).not.toContain("\n");
		} finally {
			bar.component.dispose();
		}
	});
});
