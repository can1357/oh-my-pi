import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { submitShortcut } from "./helpers/submit-shortcut";

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
		authStorage.keys.setRuntime("anthropic", "test-key");
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

	async function createManualRetrySession(
		responses: MockResponse[],
		options?: {
			compactionKeepRecentTokens?: number;
			extensionRunner?: ExtensionRunner;
		},
	): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const manualSession = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				...(options?.compactionKeepRecentTokens === undefined
					? {}
					: { "compaction.keepRecentTokens": options.compactionKeepRecentTokens }),
			}),
			modelRegistry,
			extensionRunner: options?.extensionRunner,
		});
		session = manualSession;
		manualSession.subscribe(() => undefined);
		return { session: manualSession, sessionManager };
	}

	const shorthandCases: {
		name: string;
		shortcut: "." | "c";
		responses: MockResponse[];
		output: string;
		originalOutput?: string;
		discardedOutput?: string;
	}[] = [
		{
			name: "retries a plain provider error",
			shortcut: ".",
			responses: [
				{ throw: "plain provider failure" },
				{ content: ["recovered after plain failure"], stopReason: "stop" },
			],
			output: "recovered after plain failure",
		},
		{
			name: "retries an errored tool-placeholder tail",
			shortcut: "c",
			responses: [
				{
					content: [{ type: "toolCall", name: "write", arguments: { path: "plan.md", content: "x" } }],
					stopReason: "error",
					errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				},
				{ content: ["recovered after tool-call failure"], stopReason: "stop" },
			],
			output: "recovered after tool-call failure",
		},
		{
			name: "retries a reasonless non-user abort",
			shortcut: ".",
			responses: [
				{ content: [], stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["recovered after reasonless abort"], stopReason: "stop" },
			],
			output: "recovered after reasonless abort",
		},
		{
			name: "retries a partial generic provider abort",
			shortcut: ".",
			responses: [
				{
					content: ["partial output from failed attempt"],
					stopReason: "aborted",
					errorMessage: "Request was aborted",
				},
				{ content: ["recovered after partial abort"], stopReason: "stop" },
			],
			output: "recovered after partial abort",
			discardedOutput: "partial output from failed attempt",
		},
		{
			name: "continues after a successful stop",
			shortcut: "c",
			responses: [
				{ content: ["the first task is complete"], stopReason: "stop" },
				{ content: ["continued after success"], stopReason: "stop" },
			],
			output: "continued after success",
			originalOutput: "the first task is complete",
		},
		{
			name: "continues after a deliberate user interrupt",
			shortcut: ".",
			responses: [
				{
					content: ["the first response was interrupted"],
					stopReason: "aborted",
					errorMessage: USER_INTERRUPT_LABEL,
				},
				{ content: ["continued after user interrupt"], stopReason: "stop" },
			],
			output: "continued after user interrupt",
			originalOutput: "the first response was interrupted",
		},
	];

	for (const scenario of shorthandCases) {
		it(`${scenario.shortcut} ${scenario.name}`, async () => {
			const { session, sessionManager } = await createManualRetrySession(scenario.responses);
			await session.prompt("start a task");
			await session.waitForIdle();

			await submitShortcut(session, sessionManager, scenario.shortcut);
			const messages = session.agent.state.messages;
			if (scenario.discardedOutput) {
				expect(lastAgentMessage(session).content).not.toContainEqual({
					type: "text",
					text: scenario.discardedOutput,
				});
			}
			if (scenario.originalOutput) {
				expect(messages.map(message => message.role)).toEqual(["user", "assistant", "developer", "assistant"]);
				const assistants = messages.filter((message): message is AssistantMessage => message.role === "assistant");
				expect(assistants[0]?.content).toContainEqual({
					type: "text",
					text: scenario.originalOutput,
				});
				expect(messages.find(message => message.role === "developer")).toMatchObject({
					synthetic: true,
					userInitiated: true,
				});
			} else {
				expect(messages.map(message => message.role)).toEqual(["user", "assistant"]);
			}
			expect(lastAgentMessage(session).stopReason).toBe("stop");
			expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: scenario.output });
		});
	}

	it("continues after cancelling a SessionTools custom tool without replaying it", async () => {
		const toolName = "mcp__probe_cancel";
		let executions = 0;
		const { session, sessionManager } = await createManualRetrySession([
			{
				content: [{ type: "toolCall", id: "cancelled-tool", name: toolName, arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["Cancellation settled"], stopReason: "stop" },
			{ content: ["continued after cancelled custom tool"], stopReason: "stop" },
		]);
		const customTool: CustomTool = {
			name: toolName,
			label: "probe/cancel",
			description: "Cancel this operation",
			parameters: type({}),
			mcpServerName: "probe",
			mcpToolName: "cancel",
			async execute(_toolCallId, _params, _onUpdate, context) {
				executions++;
				context.abort();
				return { content: [{ type: "text", text: "Cancellation requested" }], details: {} };
			},
		};
		await session.refreshMCPTools([customTool]);

		await session.prompt("Start the cancellable operation");
		await session.waitForIdle();
		expect(lastAgentMessage(session).stopReason).toBe("aborted");
		expect(session.hasFailedAssistantTurn).toBe(false);
		expect(executions).toBe(1);

		await submitShortcut(session, sessionManager, "c");

		expect(executions).toBe(1);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({
			type: "text",
			text: "continued after cancelled custom tool",
		});
		expect(session.agent.state.messages.find(message => message.role === "developer")).toMatchObject({
			synthetic: true,
			userInitiated: true,
		});
	});

	it("continues a failed-tail shortcut submitted during manual compaction", async () => {
		const compactEntered = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_compact",
			emit: async (event: Parameters<ExtensionRunner["emit"]>[0]) => {
				if (event.type !== "session_before_compact" || !("preparation" in event)) return undefined;
				const preparation = event.preparation;
				if (!preparation) return undefined;
				compactEntered.resolve();
				await releaseCompaction.promise;
				return {
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = await createManualRetrySession(
			[
				{ content: ["the first task is underway"], stopReason: "stop" },
				{ throw: "provider failed" },
				{ content: ["continued after compaction"], stopReason: "stop" },
			],
			{ compactionKeepRecentTokens: 1, extensionRunner },
		);
		await session.prompt("start a task");
		await session.waitForIdle();
		await session.prompt("continue the task");
		await session.waitForIdle();
		expect(session.hasFailedAssistantTurn).toBe(true);

		const compaction = session.compact();
		let shortcut: Promise<void> | undefined;
		try {
			await compactEntered.promise;
			expect(session.isCompacting).toBe(true);
			shortcut = submitShortcut(session, sessionManager, ".");
		} finally {
			releaseCompaction.resolve();
			await compaction;
		}

		await shortcut;

		expect(session.agent.state.messages.find(message => message.role === "developer")).toMatchObject({
			synthetic: true,
			userInitiated: true,
		});
		expect(lastAgentMessage(session).content).toContainEqual({
			type: "text",
			text: "continued after compaction",
		});
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

		// Provider context dropped the failed turn, so both predicates use the persisted display transcript.
		expect(session.hasAbortedToolCallTail).toBe(true);
		expect(session.hasFailedAssistantTurn).toBe(true);
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
