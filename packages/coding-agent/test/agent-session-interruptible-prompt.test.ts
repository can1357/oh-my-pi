import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { createInMemoryAuthStorage, createAssistantMessage } from "./helpers/agent-session-setup";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A partial message whose only block is the thinking block being streamed. */
function thinkingPartial(thinking: string): AssistantMessage {
	return { ...createAssistantMessage(""), content: [{ type: "thinking", thinking }] };
}

/** Yield to the session's event handlers before reading the state they update. */
async function settle(): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) await Bun.sleep(2);
}

/**
 * `getInterruptiblePrompt()` is what the TUI hands back to the composer when
 * Escape stops a turn: the operator's own words, held while the turn is still
 * inside its first thinking block. A regression here is silent — the composer
 * simply comes back empty and the prompt has to be retyped.
 */
describe("AgentSession.getInterruptiblePrompt", () => {
	it("holds the prompt until the first thinking block ends, then drops it", async () => {
		using tempDir = TempDir.createSync("@pi-interruptible-prompt-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		authStorage.keys.setRuntime(model.provider, "test-key");

		// The test drives the stream itself, so every midpoint of the turn is
		// observable instead of racing a real provider.
		let push: ((event: AssistantMessageEvent) => void) | undefined;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				push = event => stream.push(event);
				return stream;
			},
		});
		// The settings write host prefs into the process's shared Settings singleton.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"autolearn.enabled": false,
			"composer.predictions": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		try {
			expect(session.getInterruptiblePrompt()).toBeUndefined();

			const turn = session.prompt("fix the failing test");
			// Setup (usage preflight, key resolution) is async; the prompt is
			// recorded at dispatch, right before the model is called.
			for (let attempt = 0; attempt < 200 && push === undefined; attempt++) await Bun.sleep(5);
			expect(push).toBeDefined();
			expect(session.getInterruptiblePrompt()).toEqual({ text: "fix the failing test", images: undefined });

			// Inside the first thinking block the prompt is still the operator's to edit.
			const emit = push as (event: AssistantMessageEvent) => void;
			// The loop forwards block deltas only for a message it has opened.
			emit({ type: "start", partial: thinkingPartial("") });
			emit({ type: "thinking_start", contentIndex: 0, partial: thinkingPartial("") });
			emit({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "considering",
				partial: thinkingPartial("considering"),
			});
			await settle();
			expect(session.getInterruptiblePrompt()).toEqual({ text: "fix the failing test", images: undefined });

			// That block ended: the turn has committed to an answer.
			emit({
				type: "thinking_end",
				contentIndex: 0,
				content: "considering",
				partial: thinkingPartial("considering"),
			});
			await settle();
			expect(session.getInterruptiblePrompt()).toBeUndefined();

			const message: AssistantMessage = createAssistantMessage("done");
			emit({ type: "text_start", contentIndex: 1, partial: message });
			emit({ type: "done", reason: "stop", message });
			await turn;
			expect(session.getInterruptiblePrompt()).toBeUndefined();
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
