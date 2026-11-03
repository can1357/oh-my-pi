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

	function createSession(beforeAgentStart: () => Promise<{ systemPrompt: string[] }>) {
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const systemPrompts: string[][] = [];
		let hookCalls = 0;
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
				emitBeforeAgentStart: async () => {
					hookCalls++;
					return beforeAgentStart();
				},
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["base"] }),
		});
		return { session, systemPrompts, hookCalls: () => hookCalls };
	}

	it("applies the before_agent_start system prompt to a user-attributed message, then drops it", async () => {
		const { session, systemPrompts } = createSession(async () => ({ systemPrompt: [OVERRIDE] }));

		await session.sendCustomMessage(
			{ customType: "relayed-user", content: "hello", display: true, attribution: "user" },
			{ triggerTurn: true },
		);
		await session.waitForIdle();

		expect(systemPrompts).toEqual([[OVERRIDE]]);
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt).toEqual(["base"]);
	});

	it("leaves an agent-attributed wake unprepared", async () => {
		const { session, systemPrompts, hookCalls } = createSession(async () => ({ systemPrompt: [OVERRIDE] }));

		await session.sendCustomMessage(
			{ customType: "wake", content: "job done", display: true },
			{ triggerTurn: true },
		);
		await session.waitForIdle();

		expect(hookCalls()).toBe(0);
		expect(systemPrompts).toEqual([["base"]]);
	});

	it("keeps the message without a turn when abort cancels its preparation", async () => {
		let entered!: () => void;
		const hookEntered = new Promise<void>(resolve => {
			entered = resolve;
		});
		const { session, systemPrompts } = createSession(async () => {
			entered();
			await Bun.sleep(50);
			return { systemPrompt: [OVERRIDE] };
		});

		const sent = session.sendCustomMessage(
			{ customType: "relayed-user", content: "kept", display: true, attribution: "user" },
			{ triggerTurn: true },
		);
		await hookEntered;
		await session.abort();
		await sent;
		await session.waitForIdle();

		expect(systemPrompts).toEqual([]);
		const kept = session.messages.filter(m => m.role === "custom" && m.customType === "relayed-user");
		expect(kept.map(m => (m as { content: unknown }).content)).toEqual(["kept"]);
	});
});
