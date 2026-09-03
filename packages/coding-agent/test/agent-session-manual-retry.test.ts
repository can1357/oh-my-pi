import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function lastAgentMessage(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

describe("AgentSession manual retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-manual-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("removes the failed assistant turn and continues with a fresh attempt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "manual retry test failure" },
				{ content: ["recovered after manual retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("fail once");
		await session.waitForIdle();
		expect(lastAgentMessage(session).stopReason).toBe("error");

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "recovered after manual retry" });
	});

	it("returns false when the trailing assistant turn succeeded", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [{ content: ["already done"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("succeed");
		await session.waitForIdle();

		await expect(session.retry()).resolves.toBe(false);
		expect(mock.calls.length).toBe(1);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "already done" });
	});

	it("retries past synthetic tool results left by a mid-tool-call stream stall", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// First turn stalls mid-tool-call: the assistant emits a `write` tool call
		// but the stream ends with an error before it runs, so `stopReason: "error"`.
		// The agent loop then appends a synthetic tool_result for the un-run call,
		// which trails the failed assistant turn in agent state.
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "write", arguments: { path: "plan.md", content: "x" } }],
					stopReason: "error",
					errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				},
				{ content: ["recovered after stalled tool call"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("write the plan");
		await session.waitForIdle();

		// The failed assistant turn is shadowed by a trailing synthetic tool_result.
		const messages = session.agent.state.messages;
		expect(messages.at(-1)?.role).toBe("toolResult");
		const failedAssistant = messages.findLast(m => m.role === "assistant") as AssistantMessage;
		expect(failedAssistant.stopReason).toBe("error");
		expect(session.hasAbortedToolCallTail).toBe(true);

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({
			type: "text",
			text: "recovered after stalled tool call",
		});
	});

	it("reports an aborted tool-call tail only when the failed turn ended on a tool call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({ responses: [] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const user = { role: "user", content: "run the tool", timestamp: Date.now() } as const;
		const toolTurn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const abortedBoundary: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "aborted",
			errorMessage: "Stopped before model call",
			timestamp: Date.now(),
		};
		const toolResult = (isError: boolean) => ({
			role: "toolResult" as const,
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text" as const, text: isError ? "aborted" : "ok" }],
			isError,
			timestamp: Date.now(),
		});

		// Esc landed during tool execution: errored result right before the boundary.
		agent.replaceMessages([user, toolTurn, toolResult(true), abortedBoundary]);
		expect(session.hasAbortedToolCallTail).toBe(true);

		// The tool completed; the abort only killed the next model call.
		agent.replaceMessages([user, toolTurn, toolResult(false), abortedBoundary]);
		expect(session.hasAbortedToolCallTail).toBe(false);

		// Abort with no tool activity in the turn at all.
		agent.replaceMessages([user, abortedBoundary]);
		expect(session.hasAbortedToolCallTail).toBe(false);
	});

	it("re-executes the aborted tool call instead of re-issuing it via the model", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const toolSchema = type({ value: type("string") });
		const executed: string[] = [];
		const probeTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		// One response only: the retry must re-run the tool directly, spending the
		// single model call on the continuation after the fresh result.
		const mock = createMockModel({ responses: [{ content: ["done after replay"], stopReason: "stop" }] });
		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		// Esc landed during tool execution: complete tool-calling turn, errored
		// result, aborted boundary.
		const toolTurn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [probeTool],
				messages: [
					{ role: "user", content: "run the probe", timestamp: Date.now() },
					toolTurn,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "probe",
						content: [{ type: "text", text: "Execution interrupted" }],
						isError: true,
						timestamp: Date.now(),
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "aborted",
						errorMessage: "Interrupted by user",
						timestamp: Date.now(),
					},
				],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const replayResult = messages[2];
		if (replayResult.role !== "toolResult") throw new Error("Expected replayed tool result");
		expect(replayResult.isError).not.toBe(true);
		expect(replayResult.content).toContainEqual({ type: "text", text: "ok:again" });
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "done after replay" });
	});

	it("retries a persisted failed turn after rebuilding provider context", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "write", arguments: { path: "plan.md", content: "x" } }],
					stopReason: "error",
					errorMessage: "stream stalled before the tool ran",
				},
				{ content: ["recovered after session reopen"], stopReason: "stop" },
			],
		});
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("write before reopen");
		await session.waitForIdle();
		const failedAssistant = session.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(failedAssistant?.stopReason).toBe("error");

		const reopenedManager = SessionManager.inMemory();
		reopenedManager.restoreState(sessionManager.captureState());
		await session.dispose();
		session = undefined;

		const restoredMessages = reopenedManager.buildSessionContext().messages;
		// The failed tool-call turn AND its paired synthetic tool result are both
		// dropped from provider context — leaving a stranded tool result with no
		// preceding tool_use would be rejected by provider converters.
		expect(restoredMessages.map(message => message.role)).toEqual(["user"]);
		const transcriptMessages = reopenedManager.buildSessionContext({ transcript: true }).messages;
		expect(transcriptMessages.at(-1)?.role).toBe("toolResult");
		const transcriptAssistant = transcriptMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(transcriptAssistant?.stopReason).toBe("error");

		const reopenedAgent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: restoredMessages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent: reopenedAgent,
			sessionManager: reopenedManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		// Provider context dropped the failed turn, so the tail predicate must
		// fall back to the persisted display transcript (mirrors retry()).
		expect(session.hasAbortedToolCallTail).toBe(true);
		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();
		expect(session.agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({
			type: "text",
			text: "recovered after session reopen",
		});
	});
});
