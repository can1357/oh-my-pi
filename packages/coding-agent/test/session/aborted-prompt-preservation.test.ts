import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ContentBlock, SimpleStreamResult } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function isTextBlock(block: ContentBlock): block is { type: "text"; text: string } {
	return block.type === "text";
}

describe("AgentSession ZYS-1905: preserve aborted zero-output user prompts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-aborted-prompt-preservation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
	});

	it("prepends M1 text when M1 was aborted with zero output within 120s and M2 is not a cancellation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const promptsReceived: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (_model, context) => {
				const lastUser = context.messages.findLast(m => m.role === "user");
				if (lastUser) {
					const text = typeof lastUser.content === "string"
						? lastUser.content
						: lastUser.content.filter(isTextBlock).map(c => c.text).join("");
					promptsReceived.push(text);
				}
				return {
					async *[Symbol.asyncIterator]() {},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop" as const,
						timestamp: Date.now(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}),
				} as unknown as SimpleStreamResult;
			},
		});

		const settings = Settings.isolated({
			"retry.enabled": false,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Simulate M1 aborted turn in session history:
		// User M1 at t = 1000
		const t1 = Date.now();
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Please investigate the memory leak in worker pool" }],
			timestamp: t1,
		});
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Please investigate the memory leak in worker pool" }],
			timestamp: t1,
		});

		// Assistant M1 aborted with 0 output at t1 + 500ms
		const assistantAborted: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: t1 + 500,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.agent.appendMessage(assistantAborted);
		session.sessionManager.appendMessage(assistantAborted);

		// Now user submits M2 within 120s
		await session.prompt("Also check cpu usage");

		expect(promptsReceived.length).toBe(1);
		expect(promptsReceived[0]).toContain("Please investigate the memory leak in worker pool");
		expect(promptsReceived[0]).toContain("Also check cpu usage");
	});

	it("does not prepend M1 text when M2 starts with cancellation cue", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const promptsReceived: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (_model, context) => {
				const lastUser = context.messages.findLast(m => m.role === "user");
				if (lastUser) {
					const text = typeof lastUser.content === "string"
						? lastUser.content
						: lastUser.content.filter(isTextBlock).map(c => c.text).join("");
					promptsReceived.push(text);
				}
				return {
					async *[Symbol.asyncIterator]() {},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop" as const,
						timestamp: Date.now(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}),
				} as unknown as SimpleStreamResult;
			},
		});

		const settings = Settings.isolated({
			"retry.enabled": false,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const t1 = Date.now();
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Please investigate the memory leak in worker pool" }],
			timestamp: t1,
		});
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Please investigate the memory leak in worker pool" }],
			timestamp: t1,
		});

		const assistantAborted: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: t1 + 500,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.agent.appendMessage(assistantAborted);
		session.sessionManager.appendMessage(assistantAborted);

		// User submits M2 with cancellation cue: "never mind, do something else"
		await session.prompt("never mind, do something else");

		expect(promptsReceived.length).toBe(1);
		expect(promptsReceived[0]).not.toContain("Please investigate the memory leak in worker pool");
		expect(promptsReceived[0]).toBe("never mind, do something else");
	});

	it("does not prepend M1 text if M1 had visible assistant text", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const promptsReceived: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (_model, context) => {
				const lastUser = context.messages.findLast(m => m.role === "user");
				if (lastUser) {
					const text = typeof lastUser.content === "string"
						? lastUser.content
						: lastUser.content.filter(isTextBlock).map(c => c.text).join("");
					promptsReceived.push(text);
				}
				return {
					async *[Symbol.asyncIterator]() {},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop" as const,
						timestamp: Date.now(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}),
				} as unknown as SimpleStreamResult;
			},
		});

		const settings = Settings.isolated({
			"retry.enabled": false,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const t1 = Date.now();
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Please investigate the memory leak" }],
			timestamp: t1,
		});
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Please investigate the memory leak" }],
			timestamp: t1,
		});

		const assistantAbortedWithText: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "I'll start checking the code..." }],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: t1 + 500,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.agent.appendMessage(assistantAbortedWithText);
		session.sessionManager.appendMessage(assistantAbortedWithText);

		await session.prompt("Here is more info");

		expect(promptsReceived.length).toBe(1);
		expect(promptsReceived[0]).not.toContain("Please investigate the memory leak");
		expect(promptsReceived[0]).toBe("Here is more info");
	});

	it("does not prepend M1 text if M1 was aborted > 120s ago", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const promptsReceived: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (_model, context) => {
				const lastUser = context.messages.findLast(m => m.role === "user");
				if (lastUser) {
					const text = typeof lastUser.content === "string"
						? lastUser.content
						: lastUser.content.filter(isTextBlock).map(c => c.text).join("");
					promptsReceived.push(text);
				}
				return {
					async *[Symbol.asyncIterator]() {},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop" as const,
						timestamp: Date.now(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}),
				} as unknown as SimpleStreamResult;
			},
		});

		const settings = Settings.isolated({
			"retry.enabled": false,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// 150 seconds ago
		const t1 = Date.now() - 150_000;
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Old prompt from minutes ago" }],
			timestamp: t1,
		});
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Old prompt from minutes ago" }],
			timestamp: t1,
		});

		const assistantAborted: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: t1 + 500,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.agent.appendMessage(assistantAborted);
		session.sessionManager.appendMessage(assistantAborted);

		await session.prompt("New task");

		expect(promptsReceived.length).toBe(1);
		expect(promptsReceived[0]).not.toContain("Old prompt from minutes ago");
		expect(promptsReceived[0]).toBe("New task");
	});

	it("does not prepend M1 text if M1 had a completed tool execution", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const promptsReceived: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: async (_model, context) => {
				const lastUser = context.messages.findLast(m => m.role === "user");
				if (lastUser) {
					const text = typeof lastUser.content === "string"
						? lastUser.content
						: lastUser.content.filter(isTextBlock).map(c => c.text).join("");
					promptsReceived.push(text);
				}
				return {
					async *[Symbol.asyncIterator]() {},
					result: async () => ({
						role: "assistant" as const,
						content: [{ type: "text", text: "Done" }],
						stopReason: "stop" as const,
						timestamp: Date.now(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}),
				} as unknown as SimpleStreamResult;
			},
		});

		const settings = Settings.isolated({
			"retry.enabled": false,
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const t1 = Date.now();
		session.agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Run the build" }],
			timestamp: t1,
		});
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Run the build" }],
			timestamp: t1,
		});

		const assistantWithTool: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
			stopReason: "toolUse",
			timestamp: t1 + 100,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.agent.appendMessage(assistantWithTool);
		session.sessionManager.appendMessage(assistantWithTool);

		// Tool result completed (executed: true / normal result)
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "build succeeded" }],
			isError: false,
			timestamp: t1 + 200,
		});

		// Then aborted next turn
		const assistantAborted: AssistantMessage = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			timestamp: t1 + 500,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		session.agent.appendMessage(assistantAborted);
		session.sessionManager.appendMessage(assistantAborted);

		await session.prompt("Deploy now");

		expect(promptsReceived.length).toBe(1);
		expect(promptsReceived[0]).not.toContain("Run the build");
		expect(promptsReceived[0]).toBe("Deploy now");
	});
});
