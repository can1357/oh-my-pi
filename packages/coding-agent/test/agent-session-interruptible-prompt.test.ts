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
import type { DroppedPrompt } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { INTERRUPTED_THINKING_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
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

	/**
	 * A session whose first turn is driven event by event, so the test can put
	 * the interrupt at an exact point of the stream instead of racing a provider.
	 */
	async function drivenTurn() {
		const tempDir = TempDir.createSync("@pi-interruptible-prompt-drive-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		authStorage.keys.setRuntime(model.provider, "test-key");

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
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"autolearn.enabled": false,
			"composer.predictions": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		const dropped: DroppedPrompt[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt));

		const start = async (): Promise<{
			emit: (event: AssistantMessageEvent) => void;
			turn: Promise<unknown>;
		}> => {
			const turn = session.prompt("fix the failing test");
			for (let attempt = 0; attempt < 200 && push === undefined; attempt++) await Bun.sleep(5);
			if (!push) throw new Error("The turn never reached the provider");
			return { emit: push, turn };
		};
		const dispose = async (): Promise<void> => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		};
		return { session, sessionManager, sessionDir, dropped, start, dispose };
	}

	it("takes the turn back off the transcript when an interrupt lands inside the window", async () => {
		const harness = await drivenTurn();
		try {
			const { emit, turn } = await harness.start();
			emit({ type: "start", partial: thinkingPartial("") });
			emit({ type: "thinking_start", contentIndex: 0, partial: thinkingPartial("") });
			emit({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "considering",
				partial: thinkingPartial("considering"),
			});
			await settle();

			await harness.session.abort({ reason: USER_INTERRUPT_LABEL });
			await turn;
			await settle();

			expect(harness.dropped).toEqual([{ text: "fix the failing test", images: undefined, retractedTurn: true }]);
			// The turn is gone from the live context and from the branch, so nothing
			// replays the question nobody meant to send — and no continuity quote of
			// the retracted reasoning is left behind either.
			expect(harness.session.messages).toEqual([]);
			expect(harness.session.sessionManager.getBranch().filter(entry => entry.type === "message")).toEqual([]);
			expect(
				harness.session.sessionManager
					.getBranch()
					.some(
						entry => entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING_MESSAGE_TYPE,
					),
			).toBe(false);

			// The cut has to survive a reload: without an entry capturing the new
			// leaf, reopening the file would replay the retracted turn.
			await harness.sessionManager.ensureOnDisk();
			await harness.sessionManager.flush();
			const file = harness.sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session file");
			const reopened = await SessionManager.open(file, harness.sessionDir);
			expect(reopened.buildSessionContext().messages).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("keeps the turn once the first thinking block has ended", async () => {
		const harness = await drivenTurn();
		try {
			const { emit, turn } = await harness.start();
			emit({ type: "start", partial: thinkingPartial("") });
			emit({ type: "thinking_start", contentIndex: 0, partial: thinkingPartial("") });
			emit({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "considering",
				partial: thinkingPartial("considering"),
			});
			emit({
				type: "thinking_end",
				contentIndex: 0,
				content: "considering",
				partial: thinkingPartial("considering"),
			});
			await settle();

			await harness.session.abort({ reason: USER_INTERRUPT_LABEL });
			await turn;
			await settle();

			expect(harness.dropped).toEqual([]);
			expect(harness.session.messages.some(message => message.role === "user")).toBe(true);
		} finally {
			await harness.dispose();
		}
	});
});
