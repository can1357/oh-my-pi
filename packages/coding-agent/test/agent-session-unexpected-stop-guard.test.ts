import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const recordToolSchema = type({ value: type("string") });

type Harness = {
	session: AgentSession;
	tempDir: TempDir;
};
type SettingsOverrides = Partial<Record<SettingPath, unknown>>;

const activeHarnesses: Harness[] = [];
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.setRuntimeApiKey("mock", "test-key");
sharedAuthStorage.setRuntimeApiKey("anthropic", "test-key");
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage);

afterAll(() => {
	sharedAuthStorage.close();
});

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

function recordCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "record", arguments: { value } }],
		stopReason: "toolUse",
	};
}

function unexpectedStop(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

function thinkingOnlyStop(thinking: string): MockResponse {
	return {
		content: [{ type: "thinking", thinking, thinkingSignature: "reasoning_content" }],
		stopReason: "stop",
	};
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-unexpected-stop-guard-");

	const mock = createMockModel({ responses });
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

	const model = getBundledModel("anthropic", "claude-sonnet-4-5") ?? mock;
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [recordTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		getToolChoice: () => session?.nextToolChoiceDirective(),
		streamFn: mock.stream,
	});

	const agentSession = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const session = agentSession;
	const harness = { session: agentSession, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message =>
			Array.isArray(message.content)
				? message.content.flatMap(content => (content.type === "text" ? [content.text] : []))
				: [],
		)
		.join("\n");
}

function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter((message): message is Extract<AgentMessage, { role: "developer" }> => {
		if (message.role !== "developer") return false;
		const text =
			(typeof message.content === "string"
				? message.content
				: message.content.find((content): content is { type: "text"; text: string } => content.type === "text")
						?.text) ?? "";
		return text.includes("You said you would continue");
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of activeHarnesses) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	activeHarnesses.length = 0;
});

describe("AgentSession unexpected stop guard", () => {
	it("does not retry or classify when the mode is none", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness(
			[unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now.")],
			{
				"features.unexpectedStopDetection": "none",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("defaults to mechanical mode and retries on thinking-only stops without classification", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness([
			thinkingOnlyStop("思考中..."),
			{ content: ["done now"], stopReason: "stop" },
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("done now");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("does not retry in mechanical mode when text message was delivered", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness([
			unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now."),
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("does not retry after a forced tool call", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness([
			recordCall("alpha", "call-record-forced"),
			{ content: ["recorded"], stopReason: "stop" },
		]);
		session.setForcedToolChoice("record");

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(mock.calls.map(call => call.options?.toolChoice)).toEqual([{ type: "tool", name: "record" }, "none"]);
		expect(spy).not.toHaveBeenCalled();
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("schedules a continuation when the classifier returns true", async () => {
		let calls = 0;
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockImplementation(async () => {
			calls++;
			return calls === 1;
		});
		const { session, mock } = await createHarness(
			[
				unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now."),
				{ content: ["done now"], stopReason: "stop" },
			],
			{
				"features.unexpectedStopDetection": "smart",
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).toHaveBeenCalledTimes(2);
		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("done now");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("retries a thinking-only stop directly in smart mode", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness(
			[thinkingOnlyStop(" 响应"), { content: ["done now"], stopReason: "aborted" }],
			{
				"features.unexpectedStopDetection": "smart",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(assistantText(session.agent.state.messages)).toContain("done now");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("does not continue when the classifier returns false", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness(
			[unexpectedStop("I should apply the same fix to the JS eval worker. Doing that now.")],
			{
				"features.unexpectedStopDetection": "smart",
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("caps unexpected stop retries at three attempts", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness(
			[
				unexpectedStop("I should fix this next."),
				unexpectedStop("I should fix this next."),
				unexpectedStop("I should fix this next."),
				unexpectedStop("I should fix this next."),
			],
			{
				"features.unexpectedStopDetection": "smart",
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).toHaveBeenCalledTimes(4);
		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(3);
		expect(warnSpy).toHaveBeenCalled();
	});

	it("does not classify a message that contains a tool call", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness(
			[recordCall("alpha", "call-record-alpha"), { content: ["tool path complete"], stopReason: "aborted" }],
			{
				"features.unexpectedStopDetection": "smart",
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(2);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});

	it("does not classify a stop whose reason is not stop", async () => {
		const spy = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness(
			[{ content: ["I should continue but hit the length limit"], stopReason: "length" }],
			{
				"features.unexpectedStopDetection": "smart",
				"providers.unexpectedStopModel": "online",
			},
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(spy).not.toHaveBeenCalled();
		expect(mock.calls).toHaveLength(1);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
	});
});
