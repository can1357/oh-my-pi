import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Contract: a turn that an idle `sendCustomMessage(..., { triggerTurn: true })` starts is prepared
// like a prompt, so the system prompt `before_agent_start` returns reaches the provider for that turn.

const OVERRIDE = "OVERRIDE-FROM-BEFORE-AGENT-START";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("AgentSession turn started by a triggered custom message", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("applies the before_agent_start system prompt, then drops it after the turn", async () => {
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const systemPrompts: string[][] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: createModel(), systemPrompt: ["base"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (model, context, streamOptions) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(model, context, streamOptions);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				emitBeforeAgentStart: async () => ({ systemPrompt: [OVERRIDE] }),
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["base"] }),
		});

		await session.sendCustomMessage({ customType: "wake", content: "hello", display: true }, { triggerTurn: true });
		await session.waitForIdle();

		expect(systemPrompts).toEqual([[OVERRIDE]]);
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt).toEqual(["base"]);
	});
});
