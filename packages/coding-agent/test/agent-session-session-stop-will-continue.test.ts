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
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
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

		const extensionEmits: Array<{ type: string; willContinue?: boolean }> = [];
		let sessionStopCalls = 0;
		// Partial ExtensionRunner double — same pattern as sibling agent-session tests;
		// only the emit surfaces used on the session_stop continuation path are implemented.
		const extensionRunner = {
			emit: async (event: { type: string; willContinue?: boolean }) => {
				extensionEmits.push({ type: event.type, willContinue: event.willContinue });
			},
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: (eventType: string) => eventType === "session_stop",
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
		// One intermediate settle (continuation scheduled) + one terminal settle.
		expect(sessionStopCalls).toBe(2);
		expect(agentEnds).toHaveLength(2);
		expect(mock.calls).toHaveLength(2);
		// First settle scheduled the hidden session_stop turn.
		expect(agentEnds[0]?.willContinue).toBe(true);
		// Final settle is terminal.
		expect(agentEnds[1]?.willContinue).toBeFalsy();
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			expect(last.stopReason).toBe("stop");
		}
	});
});
