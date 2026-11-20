import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

function agentTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ arg: type("string") }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function reply(requestControls?: AssistantMessage["requestControls"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...(requestControls && { requestControls }),
	};
}

describe("Agent — inactive tool definitions", () => {
	let previousDialect: string | undefined;
	beforeEach(() => {
		previousDialect = Bun.env.PI_DIALECT;
		delete Bun.env.PI_DIALECT;
	});
	afterEach(() => {
		if (previousDialect === undefined) delete Bun.env.PI_DIALECT;
		else Bun.env.PI_DIALECT = previousDialect;
	});

	it("re-supplies a withdrawn tool the latest request declared, as the main loop last sent it", async () => {
		const contexts: Context[] = [];
		// What the provider transform (where the request-size clamp runs) sees.
		const transformed: Context[] = [];
		const responses = [
			reply({
				messageIndex: 1,
				tools: { declared: ["read", "grep"], deferred: [], active: ["read", "grep"] },
			}),
			reply({ messageIndex: 3, tools: { declared: ["read", "grep"], deferred: [], active: ["read"] } }),
		];
		const agent = new Agent({
			initialState: {
				model: createMockModel({ responses: [] }),
				systemPrompt: ["system"],
				tools: [agentTool("read"), agentTool("grep")],
			},
			transformProviderContext: context => {
				transformed.push(context);
				return context;
			},
			streamFn: (_model, context) => {
				contexts.push(context);
				const message = responses[contexts.length - 1] ?? reply();
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
				return stream;
			},
		});

		await agent.prompt("first");
		agent.setTools([agentTool("read")]);
		await agent.prompt("second");

		const sentGrep = contexts[0]?.tools?.find(tool => tool.name === "grep");
		if (!sentGrep) throw new Error("expected grep in the first request");
		expect(contexts[0]?.inactiveTools).toBeUndefined();
		expect(contexts[1]?.tools?.map(tool => tool.name)).toEqual(["read"]);
		expect(contexts[1]?.inactiveTools).toEqual([sentGrep]);
		expect(transformed[1]?.inactiveTools).toEqual([sentGrep]);

		const messages = agent.state.messages.filter(
			(message): message is Message =>
				message.role === "user" || message.role === "assistant" || message.role === "toolResult",
		);
		const side = await agent.buildSideRequestContext(messages);
		expect(side.inactiveTools).toEqual([sentGrep]);
		expect(transformed[2]?.inactiveTools).toEqual([sentGrep]);
	});

	it("supplies a standby tool before the first declaration, then sends it once active as it was declared", async () => {
		const contexts: Context[] = [];
		const declared = { declared: ["read", "goal"], deferred: ["goal"], active: ["read"] };
		const responses = [reply({ messageIndex: 1, tools: declared }), reply({ messageIndex: 3, tools: declared })];
		const agent = new Agent({
			initialState: {
				model: createMockModel({ responses: [] }),
				systemPrompt: ["system"],
				tools: [agentTool("read")],
			},
			streamFn: (_model, context) => {
				contexts.push(context);
				const message = responses[contexts.length - 1] ?? reply();
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
				return stream;
			},
		});
		const goal = agentTool("goal");
		agent.setStandbyTools([goal]);

		await agent.prompt("first");
		await agent.prompt("second");
		agent.setTools([agentTool("read"), goal]);
		agent.setStandbyTools([]);
		await agent.prompt("third");

		const standby = contexts[0]?.inactiveTools?.[0];
		expect(contexts[0]?.inactiveTools?.map(tool => tool.name)).toEqual(["goal"]);
		// Declared by the first request: the definition comes from what it sent.
		expect(contexts[1]?.inactiveTools).toEqual(standby ? [standby] : []);
		expect(contexts[2]?.tools?.find(tool => tool.name === "goal")).toEqual(standby);
		expect(contexts[2]?.inactiveTools).toBeUndefined();
	});
});
