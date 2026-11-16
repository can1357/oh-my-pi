/**
 * Producer contract: when a session_stop hook schedules a hidden continuation
 * turn, the extension agent_end for that intermediate settle must set
 * willContinue so Warp (and similar subscribers) do not emit a terminal stop
 * before the continuation runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession session_stop willContinue", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-session-stop-will-continue-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
	});

	it("marks extension agent_end willContinue when session_stop schedules a hidden turn", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		// First settle reaches session_stop; second is the terminal continuation turn.
		const mock = createMockModel({
			responses: [
				{ content: ["first settle"], stopReason: "stop" },
				{ content: ["after session_stop continuation"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const extensionEmits: Array<{
			type: string;
			messageId?: string;
			willContinue?: boolean;
			settle?: { entryId: string; messageId: string; isFinal: boolean; pendingContinuation: string | null };
		}> = [];
		let sessionStopCalls = 0;
		// Partial ExtensionRunner double — same pattern as sibling agent-session tests;
		// only the emit surfaces used on the session_stop continuation path are implemented.
		const extensionRunner = {
			emit: async (event: {
				type: string;
				messageId?: string;
				willContinue?: boolean;
				settle?: { entryId: string; messageId: string; isFinal: boolean; pendingContinuation: string | null };
			}) => {
				extensionEmits.push({
					type: event.type,
					messageId: event.messageId,
					willContinue: event.willContinue,
					settle: event.settle,
				});
			},
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) =>
				eventType === "session_stop" ||
				eventType === "message_start" ||
				eventType === "message_update" ||
				eventType === "message_end",
			emitSessionStop: async () => {
				sessionStopCalls++;
				// Only the first settle should schedule a continuation; later settles are terminal.
				if (sessionStopCalls === 1) {
					return { continue: true, additionalContext: "hook says continue" };
				}
				return undefined;
			},
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Trigger session_stop continuation");
		await session.waitForIdle();

		const agentEnds = extensionEmits.filter(event => event.type === "agent_end");
		const assistantEnds = extensionEmits.filter(event => event.type === "message_end" && event.messageId);
		// One intermediate settle (continuation scheduled) + one terminal settle.
		expect(sessionStopCalls).toBe(2);
		expect(agentEnds).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		expect(agentEnds[0]?.willContinue).toBe(true);
		expect(agentEnds[0]?.settle).toMatchObject({ isFinal: false, pendingContinuation: "related" });
		expect(agentEnds[0]?.settle?.entryId).toBeTruthy();
		expect(agentEnds[0]?.settle?.messageId).toBe(assistantEnds[0]?.messageId);
		expect(agentEnds[1]?.willContinue).toBeFalsy();
		expect(agentEnds[1]?.settle).toMatchObject({ isFinal: true, pendingContinuation: null });
		expect(agentEnds[1]?.settle?.entryId).toBeTruthy();
		expect(agentEnds[1]?.settle?.entryId).not.toBe(agentEnds[0]?.settle?.entryId);
		expect(agentEnds[1]?.settle?.messageId).toBe(assistantEnds[1]?.messageId);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			expect(last.stopReason).toBe("stop");
		}
	});

	it("keeps the ended assistant identity on delayed message updates", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled OpenAI test model to exist");
		const mock = createMockModel({ responses: [{ content: ["settled answer"], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const events: Array<{ type: string; messageId?: string; settleMessageId?: string }> = [];
		const lateUpdate = Promise.withResolvers<void>();
		let awaitingLateUpdate = false;
		const extensionRunner = {
			emit: async (event: { type: string; messageId?: string; settle?: { messageId: string } }) => {
				events.push({ type: event.type, messageId: event.messageId, settleMessageId: event.settle?.messageId });
				if (awaitingLateUpdate && event.type === "message_update") lateUpdate.resolve();
			},
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) =>
				eventType === "message_start" || eventType === "message_update" || eventType === "message_end",
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("answer once");
		await session.waitForIdle();
		const ended = session.getLastAssistantMessage();
		if (!ended) throw new Error("Expected settled assistant message");
		awaitingLateUpdate = true;
		agent.emitExternalEvent({
			type: "message_update",
			message: { ...ended },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: ended },
		});
		await lateUpdate.promise;

		const start = events.find(event => event.type === "message_start" && event.messageId);
		const end = events.find(event => event.type === "message_end" && event.messageId);
		const late = events.findLast(event => event.type === "message_update" && event.messageId);
		const settle = events.find(event => event.type === "agent_end");
		expect(start?.messageId).toBeTruthy();
		expect(end?.messageId).toBe(start?.messageId);
		expect(late?.messageId).toBe(start?.messageId);
		expect(settle?.settleMessageId).toBe(start?.messageId);
	});
});
