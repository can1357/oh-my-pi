import { describe, expect, it, mock } from "bun:test";
import { type AssistantMessage, type Context, z } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { Agent } from "../src/agent";
import type { AgentTool } from "../src/types";

async function withNativeDialectEnv<T>(fn: () => T | Promise<T>): Promise<T> {
	const previous = Bun.env.PI_DIALECT;
	delete Bun.env.PI_DIALECT;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete Bun.env.PI_DIALECT;
		} else {
			Bun.env.PI_DIALECT = previous;
		}
	}
}

function testAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

describe("Agent — buildSideRequestContext", () => {
	const model = createMockModel({ responses: [] });
	const tool: AgentTool = {
		name: "test_tool",
		label: "Test Tool",
		description: "a cool tool",
		parameters: z.object({ arg: z.string() }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "success" }], details: { value: "success" } }),
	};

	it("forwards the tool catalog for native providers", async () => {
		await withNativeDialectEnv(async () => {
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["system"],
					tools: [tool],
				},
			});

			const context = await agent.buildSideRequestContext([
				{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
			]);

			expect(context.tools).toBeDefined();
			expect(context.tools!.length).toBe(1);
			expect(context.tools![0].name).toBe("test_tool");
			expect(context.systemPrompt).toEqual(["system"]);
		});
	});

	it("matches the main loop's native stable prefix", async () => {
		await withNativeDialectEnv(async () => {
			let mainContext: Context | undefined;
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["system"],
					tools: [tool],
				},
				streamFn: (_model, context) => {
					mainContext = context;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message = testAssistantMessage("ok");
						stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			});

			await agent.prompt("Q?");

			const sideAgent = new Agent({
				initialState: {
					model,
					systemPrompt: ["system"],
					tools: [tool],
				},
			});
			const sideContext = await sideAgent.buildSideRequestContext([
				{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
			]);

			expect(JSON.stringify(sideContext.systemPrompt)).toBe(JSON.stringify(mainContext?.systemPrompt));
			expect(JSON.stringify(sideContext.tools)).toBe(JSON.stringify(mainContext?.tools));
		});
	});

	it("returns empty tools when owned dialect is active", async () => {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
			dialect: "glm",
		});

		const context = await agent.buildSideRequestContext([
			{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
		]);

		expect(context.tools).toEqual([]);
		expect(context.systemPrompt).toEqual(["system"]);
	});

	it("invokes transformProviderContext filter if present", async () => {
		const transformSpy = mock((ctx: Context): Context => {
			return {
				...ctx,
				systemPrompt: ["transformed-system"],
			};
		});

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
			transformProviderContext: transformSpy,
		});

		const context = await agent.buildSideRequestContext([
			{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
		]);

		expect(transformSpy).toHaveBeenCalledTimes(1);
		expect(context.systemPrompt).toEqual(["transformed-system"]);
	});
});
