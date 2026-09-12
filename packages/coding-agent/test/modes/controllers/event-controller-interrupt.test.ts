import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function createContext() {
	const setWorkingMessage = vi.fn();
	const sessionState = { isAborting: false };
	const ctx = createInteractiveModeContext({
		setWorkingMessage,
		session: {
			get isAborting() {
				return sessionState.isAborting;
			},
		},
	});
	return { ctx, setWorkingMessage, sessionState };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;

/** A `tool_execution_start` that drives the intent-to-working-message path. */
function toolStartWithIntent(toolCallId: string, intent: string): AgentSessionEvent {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName: "grep",
		args: {},
		intent,
	} as unknown as AgentSessionEvent;
}

describe("EventController aborted-turn working messages", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("preserves playback across internal continuations and clears it for a user message", async () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "turn_start" });
		expect(clear).not.toHaveBeenCalled();

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "new prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});
		expect(clear).toHaveBeenCalledTimes(1);
	});

	it("suppresses late intent-driven working-message updates while aborting", async () => {
		const { ctx, setWorkingMessage, sessionState } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();
		sessionState.isAborting = true;
		await controller.handleEvent(toolStartWithIntent("late-call", "Reticulating splines"));

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});

	it("lets intent updates drive the loader when not aborting", async () => {
		const { ctx, setWorkingMessage } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		setWorkingMessage.mockClear();
		await controller.handleEvent(toolStartWithIntent("call-1", "Searching files"));

		expect(setWorkingMessage).toHaveBeenCalledTimes(1);
		expect(setWorkingMessage.mock.calls[0]?.[0]).toContain("Searching files");
	});

	it("resumes intent updates once aborting clears", async () => {
		const { ctx, setWorkingMessage, sessionState } = createContext();
		const controller = new EventController(ctx);
		await controller.handleEvent(AGENT_START);
		sessionState.isAborting = true;

		await controller.handleEvent(toolStartWithIntent("late-call", "Reticulating splines"));
		setWorkingMessage.mockClear();
		sessionState.isAborting = false;
		await controller.handleEvent(toolStartWithIntent("call-2", "Editing module"));

		expect(setWorkingMessage).toHaveBeenCalledTimes(1);
		expect(setWorkingMessage.mock.calls[0]?.[0]).toContain("Editing module");
	});
});
