import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingContent,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { withThinkingLoopGuard } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const LOOP_PARAGRAPHS = [
	"I am now verifying the test module to guarantee there are no compile errors and the code is completely safe.",
	"I am now verifying the test module once more to ensure there are no compile errors and the code stays completely safe.",
	"I am now re-verifying the test module to confirm there are no compile errors and the code remains completely safe.",
];

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function chunkedThinkingLoopStream(model: Model<Api>, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const inner = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const thinking: ThinkingContent = { type: "thinking", thinking: "" };
		const partial: AssistantMessage = {
			role: "assistant",
			content: [thinking],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		inner.push({ type: "start", partial });
		inner.push({ type: "thinking_start", contentIndex: 0, partial });
		for (let index = 0; index < 12; index++) {
			if (options?.signal?.aborted) return;
			const delta = `**Confirming Safety ${index}**\n\n${LOOP_PARAGRAPHS[index % LOOP_PARAGRAPHS.length]}\n\n\n`;
			thinking.thinking += delta;
			inner.push({ type: "thinking_delta", contentIndex: 0, delta, partial });
		}
		inner.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		inner.push({ type: "done", reason: "stop", message: partial });
	});
	return withThinkingLoopGuard(model, options, () => inner);
}

function successStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const text: TextContent = { type: "text", text: "Recovered after retry." };
		const partial: AssistantMessage = {
			role: "assistant",
			content: [text],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}

function errorIdOnlyThinkingLoopStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: "loop guard stopped repeated reasoning",
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

describe("AgentSession thinking-loop retry", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	it("drops a chunked thinking-loop error and retries the turn", async () => {
		const model = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" }).model;
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, _context: Context, options?: SimpleStreamOptions) => {
				calls.push(`${requestedModel.provider}/${requestedModel.id}`);
				return calls.length === 1
					? chunkedThinkingLoopStream(requestedModel, options)
					: successStream(requestedModel);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger thinking loop once");
		await session.waitForIdle();

		expect(calls).toEqual(["openrouter/google/gemini-3.5-flash", "openrouter/google/gemini-3.5-flash"]);
		expect(retryStartEvents).toHaveLength(1);
		expect(AIError.is(retryStartEvents[0].errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ type: "auto_retry_end", success: true, attempt: 1 });
		expect(retryEndEvents[0].retryErrors).toBeArray();
		const assistants = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].stopReason).toBe("stop");
		expect(assistants[0].content).toEqual([{ type: "text", text: "Recovered after retry." }]);
		expect(assistants[0].errorMessage).toBeUndefined();
	});

	it("starts retry for thinking-loop errorId even without transient wording", async () => {
		const model = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" }).model;
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				calls.push(`${requestedModel.provider}/${requestedModel.id}`);
				return calls.length === 1 ? errorIdOnlyThinkingLoopStream(requestedModel) : successStream(requestedModel);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger errorId-only loop once");
		await session.waitForIdle();

		expect(calls).toEqual(["openrouter/google/gemini-3.5-flash", "openrouter/google/gemini-3.5-flash"]);
		expect(retryStartEvents).toHaveLength(1);
		expect(AIError.is(retryStartEvents[0].errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		const assistants = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toEqual([{ type: "text", text: "Recovered after retry." }]);
	});

	it("injects a redirect notice into the retried turn after a thinking loop", async () => {
		const model = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" }).model;
		const calls: string[] = [];
		const contexts: Context[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: (requestedModel, context, _options?: SimpleStreamOptions) => {
				calls.push(`${requestedModel.provider}/${requestedModel.id}`);
				contexts.push(context);
				return calls.length === 1 ? errorIdOnlyThinkingLoopStream(requestedModel) : successStream(requestedModel);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Trigger redirect injection after thinking loop");
		await session.waitForIdle();
		const retryContext = contexts[1];
		const extractText = (content: string | Array<{ type: string; text?: string }>): string =>
			typeof content === "string"
				? content
				: content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
		const redirectDevMsgs = retryContext.messages.filter(
			message => message.role === "developer" && extractText(message.content).includes("thinking_loop_detected"),
		);
		expect(redirectDevMsgs).toHaveLength(1);

		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "thinking-loop-redirect",
		);
		expect(redirects).toHaveLength(1);
		expect(redirects[0].display).toBe(false);
		expect(redirects[0].attribution).toBe("agent");
		expect(typeof redirects[0].content).toBe("string");
		expect(redirects[0].content).toContain("thinking_loop_detected");

		const assistants = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toEqual([{ type: "text", text: "Recovered after retry." }]);
	});

	it("injects a redirect notice on each consecutive thinking-loop retry", async () => {
		const model = createMockModel({ provider: "openrouter", id: "google/gemini-3.5-flash" }).model;
		const calls: string[] = [];
		const contexts: Context[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: (requestedModel, context, _options?: SimpleStreamOptions) => {
				calls.push(`${requestedModel.provider}/${requestedModel.id}`);
				contexts.push(context);
				return calls.length <= 2 ? errorIdOnlyThinkingLoopStream(requestedModel) : successStream(requestedModel);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Trigger redirect injection after two thinking loops");
		await session.waitForIdle();

		expect(calls).toHaveLength(3);
		const redirects = session.agent.state.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "thinking-loop-redirect",
		);
		expect(redirects).toHaveLength(2);
		const extractText = (content: string | Array<{ type: string; text?: string }>): string =>
			typeof content === "string"
				? content
				: content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
		const thirdAttemptRedirectDevMsgs = contexts[2].messages.filter(
			message => message.role === "developer" && extractText(message.content).includes("thinking_loop_detected"),
		);
		expect(thirdAttemptRedirectDevMsgs).toHaveLength(2);

		const assistants = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].content).toEqual([{ type: "text", text: "Recovered after retry." }]);
	});
});
