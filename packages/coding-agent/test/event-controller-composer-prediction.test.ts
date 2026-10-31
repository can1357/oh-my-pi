import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { CustomEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;

function userMessage(content: string, timestamp: number): Message {
	return { role: "user", content, timestamp };
}

/** An idle session whose last turn finished, with one prediction ready in the composer. */
async function predictionReady(replyText: string) {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(userMessage("fix the bug", 1));
	const messages: AgentMessage[] = [userMessage("fix the bug", 1)];
	const reply = Promise.withResolvers<EphemeralTurnResult>();
	const ctx = createInteractiveModeContext({
		settings: Settings.isolated({ "composer.predictions": true }),
		sessionManager,
		session: {
			model: MODEL,
			isStreaming: false,
			isCompacting: false,
			messages,
			ephemeralMaxTokensPreservesRequest: () => true,
			runEphemeralTurn: () => reply.promise,
		},
	});
	const controller = new EventController(ctx);
	controller.composerPrediction.request();
	reply.resolve({
		replyText,
		assistantMessage: {
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: { input: 10, output: 5, cost: { total: 0.001 } },
			stopReason: "stop",
		} as unknown as EphemeralTurnResult["assistantMessage"],
	});
	// The prediction lands once the side turn's continuation runs.
	await Promise.resolve();
	const outcomes = () =>
		sessionManager
			.getEntries()
			.filter(
				(entry): entry is CustomEntry =>
					entry.type === "custom" && entry.customType === "composer_prediction_outcome",
			)
			.map(entry => (entry.data as { outcome: string }).outcome);
	return { controller, messages, outcomes };
}

describe("EventController composer prediction outcome", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	it("records the outcome when the run starts before the user's message", async () => {
		const { controller, messages, outcomes } = await predictionReady("now run the tests");
		expect(controller.composerPrediction.text).toBe("now run the tests");
		controller.composerPrediction.noteAccepted("now run the tests");

		// The agent loop emits `agent_start` before the input message's `message_start`.
		await controller.handleEvent({ type: "agent_start" });
		expect(controller.composerPrediction.text).toBeUndefined();
		const message = userMessage("now run the tests", 2);
		messages.push(message);
		await controller.handleEvent({ type: "message_start", message });

		expect(outcomes()).toEqual(["accepted"]);
	});
});
