import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

describe("AgentSession connection wait", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let starts: RetryStart[];
	let ends: RetryEnd[];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-connectivity-");
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});
	beforeEach(() => {
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		starts = [];
		ends = [];
	});
	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		handler: MockHandler,
		options: { settings?: Settings; tools?: AgentTool[]; model?: Model } = {},
	) {
		const selectedModel = options.model ?? model;
		const mock = createMockModel({ handler });
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: selectedModel, systemPrompt: ["Test"], tools: options.tools ?? [], messages: [] },
			streamFn: (requestedModel, context, streamOptions) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const settings =
			options.settings ??
			Settings.isolated({
				"compaction.enabled": false,
				"retry.modelFallback": false,
				"retry.maxRetries": 1,
				"retry.waitForConnection": true,
				"retry.baseDelayMs": 500,
			});
		settings.setModelRole("default", `${selectedModel.provider}/${selectedModel.id}`);
		session = new AgentSession({ agent, settings, modelRegistry, sessionManager: SessionManager.inMemory() });
		session.subscribe(event => {
			if (event.type === "auto_retry_start") starts.push(event);
			if (event.type === "auto_retry_end") ends.push(event);
		});
		return { active: session, mock, requestedModels };
	}

	function lastAssistant(active: AgentSession): AssistantMessage {
		const message = active.agent.state.messages.at(-1);
		if (message?.role !== "assistant") throw new Error("Expected final assistant message");
		return message;
	}

	it("survives a virtual hour offline, reconnects on the same model, and bounds outage history", async () => {
		let calls = 0;
		const { active, requestedModels } = createSession(() => {
			calls++;
			return calls <= 150 ? { throw: "ENETUNREACH: network is unreachable" } : { content: ["connection recovered"] };
		});
		mockSchedulerWaitWithClock();
		await active.prompt("Finish when the connection returns");
		await active.waitForIdle();
		expect(calls).toBe(151);
		expect(new Set(requestedModels)).toEqual(new Set([`${model.provider}/${model.id}`]));
		expect(starts).toHaveLength(150);
		expect(starts.every(event => event.connectivity === true && event.maxAttempts === 0)).toBe(true);
		expect(starts.reduce((sum, event) => sum + event.delayMs, 0)).toBeGreaterThan(3_600_000);
		expect(starts.every(event => event.delayMs > 0 && event.delayMs <= 30_000)).toBe(true);
		expect(ends).toEqual([expect.objectContaining({ success: true, attempt: 150 })]);
		expect(lastAssistant(active).content).toContainEqual({ type: "text", text: "connection recovered" });
		expect(active.sessionManager.getBranch().filter(entry => entry.type === "message")).toHaveLength(3);
		expect(active.isRetrying).toBe(false);
	});

	it("does not reset or spend the existing HTTP retry budget during a connection outage", async () => {
		let calls = 0;
		const { active } = createSession(() => {
			calls++;
			return { throw: calls === 1 || calls === 13 ? "503 overloaded" : "EAI_AGAIN: getaddrinfo failed" };
		});
		mockSchedulerWaitWithClock();
		await active.prompt("Exercise independent budgets");
		await active.waitForIdle();
		expect(calls).toBe(13);
		expect(starts.filter(event => event.connectivity)).toHaveLength(11);
		expect(starts.filter(event => !event.connectivity)).toHaveLength(1);
		expect(ends).toContainEqual(expect.objectContaining({ success: false }));
		expect(active.isRetrying).toBe(false);
	});

	it.each(["401 invalid API key", "429 quota exceeded", "500 internal error", "Request timed out"])(
		"keeps normal finite handling for %s",
		async error => {
			const { active, mock } = createSession(() => ({ throw: error }));
			mockSchedulerWaitWithClock();
			await active.prompt("Fail normally");
			await active.waitForIdle();
			expect(starts.some(event => event.connectivity)).toBe(false);
			expect(mock.calls.length).toBeLessThanOrEqual(2);
			expect(lastAssistant(active).stopReason).toBe("error");
		},
	);

	it.each(["retry.enabled", "retry.waitForConnection"] as const)("honors %s=false", async setting => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.maxRetries": 0,
			"retry.waitForConnection": true,
			[setting]: false,
		});
		const { active, mock } = createSession(() => ({ throw: "fetch failed" }), { settings });
		mockSchedulerWaitWithClock();
		await active.prompt("Do not park");
		await active.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(starts).toHaveLength(0);
	});

	it("cancels the real backoff promptly without another request", async () => {
		const { active, mock } = createSession(() => ({ throw: "fetch failed" }));
		const waiting = Promise.withResolvers<void>();
		active.subscribe(event => {
			if (event.type === "auto_retry_start") waiting.resolve();
		});
		const running = active.prompt("Wait for the provider");
		await waiting.promise;
		await active.abort();
		await running;
		await active.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(ends).toContainEqual(expect.objectContaining({ success: false, finalError: "Retry cancelled" }));
		expect(active.isRetrying).toBe(false);
	});

	it("disposal cancels a waiting session without reconnecting", async () => {
		const { active, mock } = createSession(() => ({ throw: "ENETDOWN" }));
		const waiting = Promise.withResolvers<void>();
		active.subscribe(event => {
			if (event.type === "auto_retry_start") waiting.resolve();
		});
		const running = active.prompt("Wait until cancelled");
		await waiting.promise;
		await active.dispose();
		await running;
		expect(mock.calls).toHaveLength(1);
		expect(active.isRetrying).toBe(false);
	});

	it("a reconnect revealing a terminal authentication error ends the wait", async () => {
		let calls = 0;
		const { active } = createSession(() => ({ throw: ++calls === 1 ? "fetch failed" : "401 invalid API key" }));
		mockSchedulerWaitWithClock();
		await active.prompt("Reconnect, then fail authentication normally");
		await active.waitForIdle();
		expect(calls).toBe(2);
		expect(starts).toHaveLength(1);
		expect(ends).toContainEqual(expect.objectContaining({ success: false }));
		expect(active.isRetrying).toBe(false);
	});

	it("closes and evicts retained Responses transport state before reconnecting", async () => {
		let calls = 0;
		const responsesModel: Model = { ...model, api: "openai-responses" };
		const { active } = createSession(
			() => (++calls === 1 ? { throw: "ECONNRESET" } : { content: ["fresh transport"] }),
			{ model: responsesModel },
		);
		const close = vi.fn();
		active.providerSessionState.set(`openai-responses:${model.provider}`, { close });
		mockSchedulerWaitWithClock();
		await active.prompt("Retire the stale connection");
		await active.waitForIdle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(active.providerSessionState.has(`openai-responses:${model.provider}`)).toBe(false);
		expect(calls).toBe(2);
	});

	it("preserves a completed tool result and executes its side effect exactly once across reconnects", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "record",
			label: "Record",
			description: "Record a side effect",
			parameters: type({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "recorded once" }], details: {} };
			},
		};
		let calls = 0;
		let resumedWithResult = false;
		const { active } = createSession(
			context => {
				calls++;
				if (calls === 1) return { content: [{ type: "toolCall", id: "record-1", name: "record", arguments: {} }] };
				if (calls < 15) return { throw: "ECONNRESET: Connection reset" };
				resumedWithResult = context.messages.some(
					message => message.role === "toolResult" && message.toolCallId === "record-1",
				);
				return { content: ["finished using the recorded result"] };
			},
			{ tools: [tool] },
		);
		mockSchedulerWaitWithClock();
		await active.prompt("Record once, then finish");
		await active.waitForIdle();
		expect(executions).toBe(1);
		expect(calls).toBe(15);
		expect(resumedWithResult).toBe(true);
	});

	it("keeps committed partial text and resumes rather than replaying it", async () => {
		let calls = 0;
		let preservedPartial = false;
		let sawResumeInstruction = false;
		const { active } = createSession(context => {
			calls++;
			if (calls === 1) return { content: ["visible prefix"], stopReason: "error", errorMessage: "Connection error" };
			preservedPartial = context.messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "text" && block.text === "visible prefix"),
			);
			sawResumeInstruction = context.messages.some(message => message.role === "developer");
			return { content: ["remaining suffix"] };
		});
		mockSchedulerWaitWithClock();
		active.setTextOutputCommitted(true);
		await active.prompt("Return an answer");
		await active.waitForIdle();
		expect(calls).toBe(2);
		expect(preservedPartial).toBe(true);
		expect(sawResumeInstruction).toBe(true);
		expect(starts[0]?.connectivity).toBe(true);
	});

	it("a dead endpoint retains finite failure behavior without an explicit connection-wait opt-in", async () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 1,
		});
		const { active, mock } = createSession(() => ({ throw: "fetch failed" }), { settings });
		mockSchedulerWaitWithClock();
		await active.prompt("Fail finitely for a dead endpoint");
		await active.waitForIdle();
		expect(mock.calls).toHaveLength(3);
		expect(starts.every(event => !event.connectivity)).toBe(true);
		expect(ends).toContainEqual(expect.objectContaining({ success: false, attempt: 2 }));
	});

	it("explicit connection waiting preserves the chosen model even when a fallback chain is configured", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		authStorage.keys.setRuntime("openai", "test-key");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.waitForConnection": true,
			"retry.modelFallback": true,
			"retry.maxRetries": 1,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { default: [`${fallback.provider}/${fallback.id}`] },
		});
		let calls = 0;
		const { active, requestedModels } = createSession(
			() => (++calls <= 5 ? { throw: "fetch failed" } : { content: ["primary recovered"] }),
			{ settings },
		);
		const fallbackEvents: string[] = [];
		active.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event.to);
		});
		mockSchedulerWaitWithClock();
		await active.prompt("Wait for this model instead of falling back");
		await active.waitForIdle();
		expect(calls).toBe(6);
		expect(new Set(requestedModels)).toEqual(new Set([`${model.provider}/${model.id}`]));
		expect(fallbackEvents).toEqual([]);
	});

	it("repeated committed partial-text drops stop at the existing three-resume cap", async () => {
		let calls = 0;
		const { active } = createSession(() => {
			calls++;
			if (calls >= 8) return { content: ["unexpected extra continuation"] };
			return {
				content: [`visible prefix ${calls}`],
				stopReason: "error",
				errorMessage: "The socket connection was closed unexpectedly",
			};
		});
		active.setTextOutputCommitted(true);
		mockSchedulerWaitWithClock();
		await active.prompt("Bound repeated partial-output continuation");
		await active.waitForIdle();
		expect(calls).toBe(4);
		expect(starts).toHaveLength(3);
		expect(active.agent.state.messages.filter(message => message.role === "developer")).toHaveLength(3);
		expect(lastAssistant(active).stopReason).toBe("error");
		expect(ends).toContainEqual(expect.objectContaining({ success: false }));
	});
});
