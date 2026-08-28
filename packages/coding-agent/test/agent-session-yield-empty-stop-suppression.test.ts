/**
 * Regression: a terminal `yield` must stop the current prompt loop before a
 * provider continuation can produce a trailing empty assistant `stop`.
 *
 * The session's executor treats a successful yield as the terminal result for
 * a scripted subagent run; if the loop continues after that tool result, the
 * already-yielded child resumes and can enter post-yield retries or tool calls
 * (see issues #3389 and #4963).
 */
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const yieldToolSchema = type({ result: type("unknown") });
const recordToolSchema = type({ value: type("string") });

type Harness = { session: AgentSession; tempDir: TempDir };
const activeHarnesses: Harness[] = [];
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("mock", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

const yieldTool: AgentTool<typeof yieldToolSchema, { value: unknown }> = {
	name: "yield",
	label: "Submit Result",
	description: "Finish the task with structured JSON output.",
	parameters: yieldToolSchema,
	async execute(_toolCallId, params) {
		const result = (params.result ?? {}) as Record<string, unknown>;
		return {
			content: [{ type: "text", text: "Result submitted." }],
			details: { value: result.data ?? null },
		};
	},
};

const recordTool: AgentTool<typeof recordToolSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: recordToolSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `recorded:${params.value}` }],
			details: { value: params.value },
		};
	},
};

function yieldCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "yield", arguments: { result: { data: { value } } } }],
		stopReason: "toolUse",
	};
}

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
		usage: { output: 1, cacheRead: 100 },
	};
}

async function createHarness(
	responses: MockResponse[],
	options?: { retryEnabled?: boolean },
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-yield-empty-stop-");

	const mock = createMockModel({ responses });
	const modelRegistry = sharedModelRegistry;
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": options?.retryEnabled ?? false,
		"retry.baseDelayMs": 5,
		"retry.maxDelayMs": 100,
		"retry.maxRetries": 1,
		"retry.modelFallback": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [yieldTool, recordTool] as AgentTool[];
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
	});
	const harness = { session, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
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

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message => message.content.flatMap(content => (content.type === "text" ? [content.text] : [])))
		.join("\n");
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession yield empty-stop suppression", () => {
	it("settles a successful retry that ends in a terminal yield", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { session, mock } = await createHarness(
			[{ throw: "503 service unavailable: overloaded_error" }, yieldCall("recovered", "call-yield-after-retry")],
			{ retryEnabled: true },
		);
		const retryEvents: Array<"auto_retry_start" | "auto_retry_end"> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
				retryEvents.push(event.type);
			}
		});

		const prompt = session.prompt("retry once then yield");
		const outcome = await Promise.race([
			prompt.then(() => "completed" as const),
			Bun.sleep(1_000).then(() => "stuck" as const),
		]);
		if (outcome === "stuck") {
			session.abortRetry();
			await prompt;
		}

		expect(outcome).toBe("completed");
		expect(mock.calls).toHaveLength(2);
		expect(retryEvents).toEqual(["auto_retry_start", "auto_retry_end"]);
		expect(session.isRetrying).toBe(false);
	});

	it("does not continue to a trailing empty assistant stop after a successful yield", async () => {
		const { session, mock } = await createHarness([yieldCall("done", "call-yield-done")]);

		await session.prompt("do work then yield");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("stops at the terminal yield instead of consuming scripted trailing empty stops", async () => {
		const { session, mock } = await createHarness([
			yieldCall("done", "call-yield-multi"),
			emptyStop(),
			emptyStop(),
			emptyStop(),
		]);

		await session.prompt("yield then maybe trail");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("clears yield-termination on the next prompt so empty stops retry normally", async () => {
		const { session, mock } = await createHarness([
			// Run 1: terminal yield stops without consuming a trailing provider response.
			yieldCall("first", "call-yield-first"),
			// Run 2: empty stop should retry as usual now that the flag has cleared.
			recordCall("alpha", "call-record-alpha"),
			emptyStop(),
			{ content: ["finished after retry"], stopReason: "stop" },
		]);

		await session.prompt("yield first");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);

		await session.prompt("now record");
		await session.waitForIdle();

		// Three additional calls (record, emptyStop, finished). Exactly one
		// empty-stop reminder injected on the second run.
		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("treats an idle IRC wake after a yielded run as a fresh turn for empty-stop retry", async () => {
		const { session, mock } = await createHarness([
			// Run 1: terminal yield stops without consuming a trailing provider response.
			yieldCall("first", "call-yield-before-irc"),
			// Run 2: an idle IRC wake is a fresh turn, so its empty stop should retry normally.
			emptyStop(),
			{ content: ["recovered after IRC retry"], stopReason: "stop" },
		]);

		await session.prompt("yield first");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);

		const observerEvents: string[] = [];
		const observerSettled = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "agent_end") observerEvents.push(`agent_end:${mock.calls.length}`);
		});
		session.setIrcWakeTurnObserver(() => {
			observerEvents.push("started");
			return () => {
				observerEvents.push(`finished:${mock.calls.length}`);
				observerSettled.resolve();
			};
		});

		const outcome = await session.deliverIrcMessage({
			id: "irc-empty-stop-after-yield",
			from: "peer",
			to: "me",
			body: "ping",
			ts: Date.now(),
		} as IrcMessage);
		expect(outcome).toBe("woken");
		await session.waitForIdle();
		await observerSettled.promise;

		expect(mock.calls).toHaveLength(3);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		expect(assistantText(session.agent.state.messages)).toContain("recovered after IRC retry");
		expect(observerEvents).toEqual(["started", "agent_end:3", "finished:3"]);
	});
});
