import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Envelope tag spellings assembled at runtime: literal tag sequences corrupt
// the tool-call parameter transport.
const T = "<";
const envelope = (name: string) => `${T}function=${name}>${T}parameter=i>retry${T}/parameter>${T}/function>`;

const recordToolSchema = type({ value: type("string") });

type Harness = { session: AgentSession; tempDir: TempDir };
type SettingsOverrides = Record<string, unknown>;

const activeHarnesses: Harness[] = [];
const sharedAuthStorage = createInMemoryAuthStorage();
sharedAuthStorage.keys.setRuntime("mock", "test-key");
sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
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

function envelopeStop(text: string): MockResponse {
	return { content: [{ type: "text", text }], stopReason: "stop" };
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-text-channel-tool-call-");
	const mock = createMockModel({ responses });
	const modelRegistry = sharedModelRegistry;
	const getAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => (kind === "all" ? [mock] : getAvailable(kind)));
	const modelSelector = `${mock.provider}/${mock.id}`;
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
		...settingsOverrides,
		modelRoles: { default: modelSelector, judge: modelSelector },
		"retry.fallbackChains": { judge: [] },
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5") ?? mock;
	const sessionManager = SessionManager.inMemory(tempDir.path());
	const tools = [recordTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools, messages: [] },
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

function correctiveReminders(messages: AgentMessage[]): string[] {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "developer" }> => message.role === "developer")
		.map(
			message =>
				(typeof message.content === "string"
					? message.content
					: message.content.find((content): content is { type: "text"; text: string } => content.type === "text")
							?.text) ?? "",
		)
		.filter(text => text.includes("Text is not a call"));
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const harness of activeHarnesses) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	activeHarnesses.length = 0;
});

describe("text-channel tool call recovery", () => {
	it("reminds and continues when the only call is transcribed into text, without judging", async () => {
		const judge = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(false);
		const { session, mock } = await createHarness(
			[envelopeStop(`Doing the write now. ${envelope("write")}`), { content: ["done now"], stopReason: "stop" }],
			{ "features.unexpectedStopDetection": "smart" },
		);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const reminders = correctiveReminders(session.agent.state.messages);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("write");
		// Deterministic evidence supersedes the judge on the envelope turn; the
		// plain follow-up stop is the judge's business.
		expect(judge).toHaveBeenCalledTimes(1);
	});

	it("lists every unexecuted call once for a multi-envelope message", async () => {
		const { session, mock } = await createHarness([
			envelopeStop(`${envelope("write")} ${envelope("bash")} ${envelope("write")}`),
			{ content: ["done now"], stopReason: "stop" },
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const reminders = correctiveReminders(session.agent.state.messages);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("write");
		expect(reminders[0]).toContain("bash");
	});

	it("stays inert when the message also carries a real tool call", async () => {
		const judge = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness([
			{
				content: [
					{ type: "text", text: `Prose twin: ${envelope("write")}` },
					{ type: "toolCall", id: "call-twin", name: "record", arguments: { value: "x" } },
				],
				stopReason: "toolUse",
			},
			{ content: ["recorded"], stopReason: "stop" },
		]);

		await session.prompt("record x");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(correctiveReminders(session.agent.state.messages)).toHaveLength(0);
		expect(judge).not.toHaveBeenCalled();
	});

	it("ignores a truncated envelope and leaves the turn to the stop chain", async () => {
		const { session, mock } = await createHarness([
			envelopeStop(`Cut in transit: ${T}function=write>${T}parameter=i>retry`),
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		// No complete call: nothing to name, so no corrective note and no
		// auto-continue from this handler; the turn settles as a plain stop.
		expect(mock.calls).toHaveLength(1);
		expect(correctiveReminders(session.agent.state.messages)).toHaveLength(0);
	});

	it("names unknown tools in the reminder without dispatching anything", async () => {
		const { session, mock } = await createHarness([
			envelopeStop(`${envelope("nonexistent_tool")}`),
			{ content: ["done now"], stopReason: "stop" },
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const reminders = correctiveReminders(session.agent.state.messages);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("nonexistent_tool");
	});

	it("caps reminders at three attempts and warns", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { session, mock } = await createHarness([
			envelopeStop(envelope("write")),
			envelopeStop(envelope("write")),
			envelopeStop(envelope("write")),
			envelopeStop(envelope("write")),
		]);

		await session.prompt("do the thing");
		await session.waitForIdle();

		// Three corrective reminders, then the fourth turn settles terminally
		// past the cap — same contract as the sibling retry handlers.
		expect(mock.calls).toHaveLength(4);
		expect(correctiveReminders(session.agent.state.messages)).toHaveLength(3);
		expect(warn).toHaveBeenCalled();
	});

	it("does not fire when unexpected-stop detection is disabled", async () => {
		const judge = vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		const { session, mock } = await createHarness([envelopeStop(envelope("write"))], {
			"features.unexpectedStopDetection": "none",
		});

		await session.prompt("do the thing");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(correctiveReminders(session.agent.state.messages)).toHaveLength(0);
		expect(judge).not.toHaveBeenCalled();
	});
});
