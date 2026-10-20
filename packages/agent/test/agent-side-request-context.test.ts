import { describe, expect, it, mock } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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

const cursorModel = buildModel({
	id: "cursor-test",
	name: "Cursor Test",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
});

describe("Agent — buildSideRequestContext", () => {
	const model = createMockModel({ responses: [] });
	const tool: AgentTool = {
		name: "test_tool",
		label: "Test Tool",
		description: "a cool tool",
		parameters: type({ arg: type("string") }) as unknown as AgentTool["parameters"],
		execute: async () => ({ content: [{ type: "text", text: "success" }], details: { value: "success" } }),
	};

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

	it("adds mounted Cursor tools to main and side provider contexts", async () => {
		await withNativeDialectEnv(async () => {
			const mountedTool: AgentTool = {
				...tool,
				name: "mcp__fixture_report",
				label: "Fixture Report",
			};
			let mainContext: Context | undefined;
			const agent = new Agent({
				initialState: {
					model: cursorModel,
					systemPrompt: ["system"],
					tools: [tool],
				},
				getCursorTools: () => [tool, mountedTool],
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
			const sideContext = await agent.buildSideRequestContext([
				{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
			]);

			expect(mainContext?.tools?.map(entry => entry.name)).toEqual(["test_tool", "mcp__fixture_report"]);
			expect(sideContext.tools?.map(entry => entry.name)).toEqual(["test_tool", "mcp__fixture_report"]);
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

	it("reads a pinned side-request prompt after the before-side-request hooks ran", async () => {
		// A host that refreshes the prompt in a hook (a pending system-prompt
		// rebuild, say) must be seen by the request even when the caller pins a
		// prompt of its own — so a pinned prompt provided by a callback is read
		// after the hooks, not at call time.
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
		});
		let base: string[] = ["stale"];
		agent.addBeforeSideRequestHook(async () => {
			base = ["fresh"];
		});

		const pinned = await agent.buildSideRequestContext(
			[{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() }],
			["pinned"],
		);
		expect(pinned.systemPrompt).toEqual(["pinned"]);

		// The pinned call above already ran the hook, so the base is stale again:
		// the callback below sees the fresh value only if it is read after the
		// hooks ran.
		base = ["stale"];
		const provided = await agent.buildSideRequestContext(
			[{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() }],
			() => base,
		);
		expect(provided.systemPrompt).toEqual(["fresh"]);
	});

	it("forwards the caller's signal to the before-side-request hooks", async () => {
		// A cancelled side request must reach the hooks, so a hook that waits on
		// something slow (a pending prompt rebuild) can unwind instead of blocking
		// the caller forever.
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
		});
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		agent.addBeforeSideRequestHook(async signal => {
			seen = signal;
		});

		await agent.buildSideRequestContext(
			[{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() }],
			undefined,
			controller.signal,
		);

		expect(seen).toBe(controller.signal);
	});

	it("rejects a side request whose caller was cancelled before the hooks ran", async () => {
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
		});
		const controller = new AbortController();
		controller.abort();
		let hookRan = false;
		agent.addBeforeSideRequestHook(async () => {
			hookRan = true;
		});

		await expect(
			agent.buildSideRequestContext(
				[{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() }],
				undefined,
				controller.signal,
			),
		).rejects.toThrow();
		expect(hookRan).toBe(false);
	});

	it("keeps the call-time model when a before-side-request hook switches models", async () => {
		// The caller converted its history for the model that was active when it
		// called, so a `/model` change landing while the hook waits must not
		// re-normalize the request for the new model.
		const otherModel = createMockModel({ id: "other-mock-model" });
		let normalizedFor: unknown;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["system"],
				tools: [tool],
			},
			transformProviderContext: (ctx: Context, m: typeof model) => {
				normalizedFor = m;
				return ctx;
			},
		});
		agent.addBeforeSideRequestHook(async () => {
			agent.setModel(otherModel);
		});

		await agent.buildSideRequestContext([
			{ role: "user", content: [{ type: "text", text: "Q?" }], timestamp: Date.now() },
		]);

		expect(agent.state.model).toBe(otherModel);
		expect(normalizedFor).toBe(model);
	});
});
