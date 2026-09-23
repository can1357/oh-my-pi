import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ThinkingContent } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const recordToolSchema = type({ value: type("string") });

type Harness = {
	session: AgentSession;
	tempDir: TempDir;
};
type SettingsOverrides = Partial<Record<SettingPath, unknown>>;

const activeHarnesses: Harness[] = [];
const sharedDir = TempDir.createSync("@pi-empty-stop-guard-shared-");
const sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
sharedAuthStorage.keys.setRuntime("mock", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));

afterAll(() => {
	sharedAuthStorage.close();
	sharedDir.removeSync();
});

/** Every value `record` was executed with, in order. Proves a call ran once. */
const recordToolExecutions: string[] = [];

/** Narrowing guard for an `empty-stop attempt discarded` log payload. */
function isEmptyStopDiagnosticRow(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && "dropSeq" in value;
}

const recordTool: AgentTool<typeof recordToolSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: recordToolSchema,
	async execute(_toolCallId, params) {
		recordToolExecutions.push(params.value);
		return {
			content: [{ type: "text", text: `recorded:${params.value}` }],
			details: { value: params.value },
		};
	},
};

function recordCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "record", arguments: { value } }],
		stopReason: "toolUse",
	};
}

function emptyStop(): MockResponse {
	return {
		content: [],
		stopReason: "stop",
		usage: { output: 0, cacheRead: 100 },
	};
}

// A zero-block `stop` for which the provider still billed output tokens: content
// was generated and dropped downstream (e.g. a filter/refusal flattened to
// `finish_reason: "stop"` by a proxy), so the context/`/shake images` hint is wrong.
function filteredEmptyStop(): MockResponse {
	return {
		content: [],
		stopReason: "stop",
		usage: { output: 126, cacheRead: 100 },
	};
}

function reasoningOnlyEmptyStop(): MockResponse {
	return {
		content: [],
		stopReason: "stop",
		usage: { output: 126, reasoningTokens: 126, cacheRead: 100 },
	};
}

function orphanedToolUseStop(): MockResponse {
	return {
		content: [{ type: "thinking", thinking: "I should call a tool next." }],
		stopReason: "toolUse",
		usage: { output: 1, cacheRead: 100 },
	};
}

function thinkingOnlyStop(): MockResponse {
	return {
		content: [{ type: "thinking", thinking: "I should inspect the next file." }],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

function emptyProviderResponse(): MockResponse {
	return {
		content: [{ type: "thinking", thinking: "I finished reasoning but omitted the final answer." }],
		stopReason: "error",
		errorMessage: "Cloud Code Assist API returned a thought-only response without final output",
	};
}

function signedThinkingOnlyStop(): MockResponse {
	const content: ThinkingContent = { type: "thinking", thinking: "", thinkingSignature: "nonempty" };
	return {
		content: [content],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
	options: {
		persistSession?: boolean;
		extensionRunner?: ExtensionRunner;
		provider?: string;
		id?: string;
	} = {},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-empty-stop-guard-");
	const authStorage = sharedAuthStorage;

	const mock = createMockModel({ provider: options.provider, id: options.id, responses });
	authStorage.keys.setRuntime(mock.provider, "test-key");
	const modelRegistry = sharedModelRegistry;
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
		...settingsOverrides,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = options.persistSession
		? SessionManager.create(tempDir.path(), tempDir.path())
		: SessionManager.inMemory(tempDir.path());
	const tools = [recordTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		extensionRunner: options.extensionRunner,
	});
	const harness = { session, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message => message.content.flatMap(content => (content.type === "text" ? [content.text] : [])))
		.join("\n");
}

function emptyAssistantStops(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(
		message =>
			message.role === "assistant" &&
			message.stopReason === "stop" &&
			!message.content.some(content => {
				if (content.type === "text") return content.text.trim().length > 0;
				return content.type === "toolCall";
			}),
	);
}
function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	const isEmptyStopRetryReminder = (text: string): boolean =>
		text.includes("<system-reminder>") || text.includes("<system-injection>");

	return messages.filter(message => {
		if (message.role !== "developer") return false;
		return typeof message.content === "string"
			? isEmptyStopRetryReminder(message.content)
			: message.content.some(content => content.type === "text" && isEmptyStopRetryReminder(content.text));
	});
}

async function expectPromptCompletes(prompt: Promise<boolean>): Promise<void> {
	await withTimeout(prompt, 1_000, "Expected session prompt to settle after empty-stop retry cap");
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession empty stop guard", () => {
	it("retries an empty assistant stop after a tool result", async () => {
		const { session, mock } = await createHarness([
			recordCall("alpha", "call-record-alpha"),
			emptyStop(),
			{ content: ["finished after retry"], stopReason: "stop" },
		]);

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after retry");
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);

		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(0);
		// A discarded empty stop is physically removed from the journal, not just
		// reparented off the active branch: it must never be able to resurface as
		// the active leaf on reload (the loader rebuilds from the last physical
		// entry) if the process is killed before the recovery turn lands.
		expect(
			emptyAssistantStops(
				session.sessionManager
					.getEntries()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			),
		).toHaveLength(0);
	});

	it("retries a tool-use stop that has no tool call or text", async () => {
		const { session, mock } = await createHarness([
			recordCall("orphan", "call-record-orphan"),
			orphanedToolUseStop(),
			{ content: ["finished after orphaned tool-use retry"], stopReason: "stop" },
		]);

		await session.prompt("record orphan");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after orphaned tool-use retry");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("retries a stop that only contains thinking", async () => {
		const { session, mock } = await createHarness([
			recordCall("thinking", "call-record-thinking"),
			thinkingOnlyStop(),
			{ content: ["finished after thinking-only retry"], stopReason: "stop" },
		]);

		await session.prompt("record thinking");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after thinking-only retry");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
	});

	it("continues with an output reminder after a Cloud Code Assist empty response", async () => {
		const { session, mock } = await createHarness([
			emptyProviderResponse(),
			{ content: ["finished after provider-empty retry"], stopReason: "stop" },
		]);

		await session.prompt("finish the response");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("finished after provider-empty retry");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
	});

	it("caps provider-empty recovery without consuming generic retries and accepts the next prompt", async () => {
		mockSchedulerWaitWithClock();
		const { session, mock } = await createHarness(
			[emptyProviderResponse(), emptyProviderResponse(), emptyProviderResponse(), emptyProviderResponse()],
			{
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
				"retry.maxRetries": 2,
			},
		);
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await expectPromptCompletes(session.prompt("finish the response after reasoning"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
		});
		expect(retryEndEvents[0]?.finalError).toContain("no final output");
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);

		mock.push({ content: ["fresh final answer"], stopReason: "stop" });
		await expectPromptCompletes(session.prompt("continue"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.isRetrying).toBe(false);
		expect(assistantText(session.agent.state.messages)).toContain("fresh final answer");
	});

	it("requests another generation for a signed reasoning-only stop instead of reporting it delivered", async () => {
		const { session, mock } = await createHarness([
			signedThinkingOnlyStop(),
			{ content: ["must not be requested"], stopReason: "stop" },
		]);

		await session.prompt("finish with signed thinking");
		await session.waitForIdle();

		// A signature is replay metadata, not an answer: reasoning alone never
		// establishes delivery, so the turn needs another generation step.
		expect(mock.calls).toHaveLength(2);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		expect(assistantText(session.agent.state.messages)).toContain("must not be requested");
	});

	it("removes orphaned tool-use stops even when retry cap is hit", async () => {
		const { session, mock } = await createHarness([
			recordCall("gamma", "call-record-gamma"),
			orphanedToolUseStop(),
			orphanedToolUseStop(),
			orphanedToolUseStop(),
			orphanedToolUseStop(),
		]);
		await session.prompt("record gamma");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(5);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		const orphanedToolUseStops = activeBranchMessages.filter(
			message =>
				message.role === "assistant" &&
				message.stopReason === "toolUse" &&
				!message.content.some(content => content.type === "toolCall"),
		);
		expect(orphanedToolUseStops).toHaveLength(0);
	});
	it("caps empty stop retries at three attempts and discards the final empty turn", async () => {
		const { session, mock } = await createHarness([
			recordCall("beta", "call-record-beta"),
			emptyStop(),
			emptyStop(),
			emptyStop(),
			emptyStop(),
		]);

		await session.prompt("record beta");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(0);

		// The loader reconstructs the active branch from the last physical journal
		// entry. The empty stop is removed from history and a marker durably
		// selects its parent, so reload cannot reactivate the discarded turn.
		const journalMessages = session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(journalMessages)).toHaveLength(0);
		const lastJournalEntry = session.sessionManager.getEntries().at(-1);
		expect(lastJournalEntry).toMatchObject({
			type: "branch_summary",
			summary: "",
			details: { kind: "discarded-entry-branch" },
		});
	});

	it("does not revive capped empty responses through pending todo reminders", async () => {
		const { session, mock } = await createHarness(
			[
				emptyStop(),
				emptyStop(),
				emptyStop(),
				emptyStop(),
				{ content: ["Which task should I resume?"], stopReason: "stop" },
			],
			{ "todo.enabled": true, "todo.reminders": true, "todo.remindersMax": 3 },
		);
		session.setTodoPhases([
			{ name: "Work", tasks: [{ content: "Finish the pending change", status: "in_progress" }] },
		]);
		const retryEnds: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		const todoReminders: Array<Extract<AgentSessionEvent, { type: "todo_reminder" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
			if (event.type === "todo_reminder") todoReminders.push(event);
		});

		await expectPromptCompletes(session.prompt("continue the pending task"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEnds).toEqual([expect.objectContaining({ success: false, attempt: 3 })]);
		expect(todoReminders).toEqual([]);

		await session.prompt("I am ready to resume");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(5);
	});

	it("discards the capped empty stop durably without waiting on a stalled message_end hook", async () => {
		const releaseMessageEnd = Promise.withResolvers<void>();
		const finalMessageEndEntered = Promise.withResolvers<void>();
		let assistantMessageEnds = 0;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (event.type !== "message_end" || event.message?.role !== "assistant") return undefined;
				assistantMessageEnds++;
				if (assistantMessageEnds !== 4) return undefined;
				finalMessageEndEntered.resolve();
				await releaseMessageEnd.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const { session } = await createHarness(
			[emptyStop(), emptyStop(), emptyStop(), emptyStop()],
			{},
			{ extensionRunner },
		);

		// Persistence and the capped-stop cleanup run in emission order and must not
		// be owned by extension listeners: a held message_end hook cannot stall the
		// prompt, and the discard already waited for the final turn's persistence.
		const prompt = session.prompt("answer while the final hook is held");
		await finalMessageEndEntered.promise;
		await withTimeout(prompt, 2_000, "Prompt stalled behind a held message_end hook");
		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(0);
		expect(session.sessionManager.getEntries().at(-1)).toMatchObject({
			type: "branch_summary",
			details: { kind: "discarded-entry-branch" },
		});

		releaseMessageEnd.resolve();
		await session.waitForIdle();
		const settledBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(settledBranchMessages)).toHaveLength(0);
	});

	it("does not let a capped empty stop anchor the next context estimate", async () => {
		const billedEmptyStops = Array.from({ length: 4 }, (): MockResponse => ({
			content: [],
			stopReason: "stop",
			usage: { input: 172_000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 172_001 },
		}));
		const { session, mock } = await createHarness(billedEmptyStops);

		await expectPromptCompletes(session.prompt("answer from compacted context"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(session.getContextUsage()?.tokens).toBeLessThan(10_000);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
	});

	it("emits failed auto-retry end when repeated empty stops exhaust the retry cap", async () => {
		const { session, mock } = await createHarness([emptyStop(), emptyStop(), emptyStop(), emptyStop()]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("answer without tools"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
		});
		expect(retryEndEvents[0]?.finalError).toContain("no content blocks at all");
		// A zero-block stop is not evidence of archived frames; prescribing the
		// context fix here was the defect this message now reports around.
		expect(retryEndEvents[0]?.finalError).not.toContain("/shake images");
	});

	it("names billed output tokens instead of the context hint when a capped empty stop billed output", async () => {
		const { session, mock } = await createHarness([
			filteredEmptyStop(),
			filteredEmptyStop(),
			filteredEmptyStop(),
			filteredEmptyStop(),
		]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("answer that gets filtered"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]?.success).toBe(false);
		const finalError = retryEndEvents[0]?.finalError ?? "";
		expect(finalError).toContain("126 output tokens billed");
		expect(finalError).toContain("the reasoning/output split is unknown");
		expect(finalError).not.toContain("/shake images");
		// Billed non-reasoning output is positive: the drop hypothesis is allowed.
		expect(finalError).toContain("content may have been generated and dropped");
	});

	it("reports the reasoning split for a capped zero-block stop billed only reasoning tokens", async () => {
		const { session, mock } = await createHarness([
			reasoningOnlyEmptyStop(),
			reasoningOnlyEmptyStop(),
			reasoningOnlyEmptyStop(),
			reasoningOnlyEmptyStop(),
		]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("think without delivering an answer"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]?.success).toBe(false);
		const finalError = retryEndEvents[0]?.finalError ?? "";
		// The billed/reasoning split is reported rather than replaced by a context
		// prescription: reasoning-only output says nothing about archived frames.
		expect(finalError).toContain("no content blocks at all");
		expect(finalError).toContain("126 output tokens billed");
		expect(finalError).toContain("126 of them reasoning");
		expect(finalError).not.toContain("/shake images");
		// All billed output is known reasoning: nothing was generated and dropped.
		expect(finalError).not.toContain("content may have been generated and dropped");
	});

	it("does not assert a drop cause for a capped zero-block stop that billed nothing", async () => {
		const { session, mock } = await createHarness([emptyStop(), emptyStop(), emptyStop(), emptyStop()]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("answer without tools"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]?.success).toBe(false);
		const finalError = retryEndEvents[0]?.finalError ?? "";
		expect(finalError).toContain("no content blocks at all");
		// Nothing was billed, so nothing can have been generated and dropped.
		expect(finalError).not.toContain("content may have been generated and dropped");
	});

	it("reports a capped thinking-only stop as reasoning-only even though it billed output", async () => {
		const { session, mock } = await createHarness([
			thinkingOnlyStop(),
			thinkingOnlyStop(),
			thinkingOnlyStop(),
			thinkingOnlyStop(),
		]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("think without answering"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]?.success).toBe(false);
		const finalError = retryEndEvents[0]?.finalError ?? "";
		expect(finalError).toContain("reasoning-only stop");
		expect(finalError).toContain("1 output token billed");
		expect(finalError).not.toContain("/shake images");
	});

	it("ends auto-retry state when empty stop retries hit the cap", async () => {
		mockSchedulerWaitWithClock();
		const { session, mock } = await createHarness(
			[{ throw: "503 service unavailable: overloaded_error" }, emptyStop(), emptyStop(), emptyStop(), emptyStop()],
			{
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
				"retry.maxRetries": 2,
			},
		);
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("recover from transient error"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.attempt).toBe(1);
		expect(retryEndEvents.filter(event => event.success)).toEqual([]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
		});
		expect(retryEndEvents[0]?.finalError).toContain("empty stop");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		mock.push({ content: ["fresh unrelated success"], stopReason: "stop" });
		await session.prompt("start unrelated turn after cap");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(6);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);
		expect(assistantText(session.agent.state.messages)).toContain("fresh unrelated success");

		mock.push({ throw: "503 service unavailable: overloaded_error" });
		mock.push({ content: ["fresh retry success"], stopReason: "stop" });
		await expectPromptCompletes(session.prompt("recover with fresh retry budget"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(8);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents[1]?.attempt).toBe(1);
		expect(retryEndEvents).toHaveLength(2);
		expect(retryEndEvents[1]).toMatchObject({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);
	});

	it("preserves auto-retry budget across empty stop continuations", async () => {
		mockSchedulerWaitWithClock();
		const { session, mock } = await createHarness(
			[
				{ throw: "503 service unavailable: overloaded_error" },
				emptyStop(),
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
			],
			{
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
				"retry.maxRetries": 2,
			},
		);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("recover without replenishing retries"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents.filter(event => event.success)).toEqual([]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
		});
		expect(session.isRetrying).toBe(false);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("preserves Codex commentary when discarding a colliding empty final stop", async () => {
		const timestamp = 1_725_287_000_000;
		vi.spyOn(Date, "now").mockReturnValue(timestamp);
		const commentary = "Codex commentary before the empty final answer.";
		const recovered = "Recovered after the empty final-answer retry.";
		const { session, mock } = await createHarness(
			[{ content: [commentary], stopReason: "stop" }, emptyStop(), { content: [recovered], stopReason: "stop" }],
			{},
			{ provider: "openai-codex", id: "gpt-5.5-codex" },
		);

		await session.prompt("produce commentary");
		await session.waitForIdle();
		// Persisted identity must win regardless of branch enumeration order. The
		// coarse matcher otherwise selects the commentary when it is encountered first.
		const getBranch = session.sessionManager.getBranch.bind(session.sessionManager);
		const branchSpy = vi
			.spyOn(session.sessionManager, "getBranch")
			.mockImplementation(() => getBranch().slice().reverse());
		await session.followUp("continue after commentary");
		await session.waitForIdle();
		branchSpy.mockRestore();

		const assistantTexts = (messages: AgentMessage[]): string[] =>
			messages
				.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
				.flatMap(message => message.content.flatMap(block => (block.type === "text" ? [block.text] : [])));

		expect(mock.calls).toHaveLength(3);
		expect(assistantTexts(session.agent.state.messages)).toEqual([commentary, recovered]);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		const persistedMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(assistantTexts(persistedMessages)).toEqual([commentary, recovered]);
		expect(emptyAssistantStops(persistedMessages)).toHaveLength(0);
	});

	it("does not retry normal stop or tool-use turns", async () => {
		const normal = await createHarness([{ content: ["already done"], stopReason: "stop" }]);

		await normal.session.prompt("answer normally");
		await normal.session.waitForIdle();

		expect(normal.mock.calls).toHaveLength(1);
		expect(reminderMessages(normal.session.agent.state.messages)).toHaveLength(0);

		const withTool = await createHarness([
			recordCall("gamma", "call-record-gamma"),
			{ content: ["tool path complete"], stopReason: "stop" },
		]);

		await withTool.session.prompt("record gamma");
		await withTool.session.waitForIdle();

		expect(withTool.mock.calls).toHaveLength(2);
		expect(reminderMessages(withTool.session.agent.state.messages)).toHaveLength(0);
		expect(assistantText(withTool.session.agent.state.messages)).toContain("tool path complete");
	});
});

/**
 * What the running agent does with a response: which turns count as an answer.
 * These go through the real `AgentSession` recovery path, not just the
 * diagnostic helper — a predicate test alone cannot show the turn being kept,
 * retried, or discarded.
 */
describe("delivered-output contract", () => {
	it("completes normally when non-whitespace answer text survives finalization", async () => {
		const { session, mock } = await createHarness([{ content: ["Done. The answer is 4."], stopReason: "stop" }]);

		await session.prompt("answer");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(assistantText(session.agent.state.messages)).toContain("Done. The answer is 4.");
	});

	it("executes a valid tool call exactly once and keeps its result paired", async () => {
		recordToolExecutions.length = 0;
		const { session, mock } = await createHarness([
			recordCall("alpha", "call-record-alpha"),
			{ content: ["tool path complete"], stopReason: "stop" },
		]);

		await session.prompt("record alpha");
		await session.waitForIdle();

		// Two generations and one execution: the tool result must not re-run the call.
		expect(mock.calls).toHaveLength(2);
		expect(recordToolExecutions).toEqual(["alpha"]);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		const toolCallIds: string[] = [];
		for (const message of session.agent.state.messages) {
			if (message.role !== "assistant") continue;
			for (const content of message.content) {
				if (content.type === "toolCall") toolCallIds.push(content.id);
			}
		}
		expect(toolCallIds).toEqual(["call-record-alpha"]);
		expect(assistantText(session.agent.state.messages)).toContain("tool path complete");
	});

	it("does not accept empty or whitespace-only text as a delivered answer", async () => {
		const whitespaceOnly = (): MockResponse => ({
			content: [{ type: "text", text: "   \n\t " }],
			stopReason: "stop",
			usage: { output: 40, cacheRead: 100 },
		});
		const { session, mock } = await createHarness([
			whitespaceOnly(),
			whitespaceOnly(),
			whitespaceOnly(),
			whitespaceOnly(),
		]);

		await expectPromptCompletes(session.prompt("answer with padding"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(assistantText(session.agent.state.messages).trim()).toBe("");
	});

	it("does not treat reasoning alone as delivery, with or without a signature", async () => {
		const { session, mock } = await createHarness([
			thinkingOnlyStop(),
			signedThinkingOnlyStop(),
			thinkingOnlyStop(),
			signedThinkingOnlyStop(),
		]);

		await expectPromptCompletes(session.prompt("reason without answering"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toBe("");
	});

	it("keeps a user-interrupted turn an interruption and gives it no empty-stop retry", async () => {
		const { session, mock } = await createHarness([
			{ content: [{ type: "thinking", thinking: "cut off mid-sen" }], stopReason: "aborted" },
		]);

		await expectPromptCompletes(session.prompt("work until interrupted"));
		await session.waitForIdle();

		// An abort is a failure, not an empty completion. It must not be retried as
		// one, and it must not be discarded as though it had never existed.
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(
			session.agent.state.messages.some(message => message.role === "assistant" && message.stopReason === "aborted"),
		).toBe(true);
	});

	it("stops after one terminal failure once the retry budget is exhausted", async () => {
		const { session, mock } = await createHarness([emptyStop(), emptyStop(), emptyStop(), emptyStop()]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await expectPromptCompletes(session.prompt("answer without tools"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		// Exactly one terminal failure reaches the caller...
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]?.success).toBe(false);
		expect(retryEndEvents[0]?.finalError).toBeTruthy();

		// ...and no further request starts after the budget is gone.
		mock.push({ content: ["must not be requested"], stopReason: "stop" });
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
	});

	it("records one correlated evidence row per discarded attempt, including the capped one", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
		try {
			const { session, mock } = await createHarness([emptyStop(), emptyStop(), emptyStop(), emptyStop()]);

			await expectPromptCompletes(session.prompt("answer that never arrives"));
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(4);
			// Retries log at debug; only the cap reaches warn. The per-attempt
			// sequence is what explains why recovery could not converge, so
			// only-the-last-attempt is not enough.
			const debugRows = debugSpy.mock.calls.map(call => call[1]).filter(isEmptyStopDiagnosticRow);
			const warnRows = warnSpy.mock.calls.map(call => call[1]).filter(isEmptyStopDiagnosticRow);
			const rows = [...debugRows, ...warnRows];

			expect(rows.map(row => row.dropSeq)).toEqual([1, 2, 3, 4]);
			expect(rows.map(row => row.decision)).toEqual([
				"retry-scheduled",
				"retry-scheduled",
				"retry-scheduled",
				"cap-reached",
			]);
			// The cap row carries the finalError text so it survives the drop.
			const capRow = warnRows.find(row => row.decision === "cap-reached");
			expect(capRow?.finalError).toBeDefined();
			for (const row of rows) {
				expect(row.maxRetries).toBe(3);
				expect(row.blockKinds).toEqual([]);
				expect(row.blockLengths).toEqual([]);
				expect(row.deliveredBlocks).toBe(0);
				expect(row.signedThinkingBlocks).toBe(0);
				expect(row.unsignedThinkingBlocks).toBe(0);
				expect(row.redactedThinkingBlocks).toBe(0);
				// Absent usage stays unknown rather than reading as a zero split.
				expect(row.reasoningTokens).toBeNull();
				expect(typeof row.sessionId).toBe("string");
				expect(typeof row.promptGeneration).toBe("number");
				expect(typeof row.model).toBe("string");
				expect(typeof row.provider).toBe("string");
				expect(typeof row.api).toBe("string");
			}
		} finally {
			warnSpy.mockRestore();
			debugSpy.mockRestore();
		}
	});
});
