import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const failingToolSchema = type({ value: type("string") });
const failingTool: AgentTool<typeof failingToolSchema, Record<string, never>> = {
	name: "boom",
	label: "Boom",
	description: "Always fails",
	parameters: failingToolSchema,
	async execute() {
		return { content: [{ type: "text", text: "invalid javascript" }], isError: true };
	},
};

type Harness = { session: AgentSession; tempDir: TempDir };
const activeHarnesses: Harness[] = [];
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("mock", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
});

async function createHarness(responses: MockResponse[]): Promise<Harness & { sessionManager: SessionManager }> {
	const tempDir = TempDir.createSync("@pi-terminal-error-persistence-");
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const tools = [failingTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
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
	return { ...harness, sessionManager };
}

function persistedErrorTurns(sessionManager: SessionManager): AssistantMessage[] {
	return sessionManager
		.getEntries()
		.filter(entry => entry.type === "message")
		.map(entry => entry.message as AgentMessage)
		.filter((message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error");
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession terminal error persistence", () => {
	// #6249: a non-retriable provider error on the continuation turn after a failed
	// tool result ended the run, but #persistSessionMessageIfMissing dropped the
	// empty error turn, so the session JSONL stopped at the tool result and the
	// provider errorMessage was lost with no durable record of why the run stopped.
	it("persists the terminal empty error turn that ends the run after a failed tool result", async () => {
		const { session, sessionManager } = await createHarness([
			{
				content: [{ type: "toolCall", id: "call-1", name: "boom", arguments: { value: "x" } }],
				stopReason: "toolUse",
			},
			{ content: [], stopReason: "error", errorMessage: "provider rejected the continuation" },
		]);

		await session.prompt("run the tool then fail");
		await session.waitForIdle();

		const errorTurns = persistedErrorTurns(sessionManager);
		expect(errorTurns).toHaveLength(1);
		expect(errorTurns[0]?.errorMessage).toBe("provider rejected the continuation");
	});

	it("records the terminal error turn without a phantom retry when retry is disabled", async () => {
		const retryEvents: string[] = [];
		const { session, sessionManager } = await createHarness([
			{ content: [], stopReason: "error", errorMessage: "hard provider failure" },
		]);
		session.subscribe(event => {
			if (event.type === "auto_retry_start" || event.type === "auto_retry_end") retryEvents.push(event.type);
		});

		await session.prompt("fail immediately");
		await session.waitForIdle();

		expect(retryEvents).toHaveLength(0);
		const errorTurns = persistedErrorTurns(sessionManager);
		expect(errorTurns).toHaveLength(1);
		expect(errorTurns[0]?.errorMessage).toBe("hard provider failure");
	});

	it("does not persist a terminal error turn that carried real text", async () => {
		const { session, sessionManager } = await createHarness([
			{
				content: [{ type: "text", text: "partial answer before the error" }],
				stopReason: "error",
				errorMessage: "stream cut",
			},
		]);

		await session.prompt("stream then error");
		await session.waitForIdle();

		// The turn streamed substantive text, so #persistSessionMessageIfMissing
		// keeps it via the normal path (one persisted copy, not two).
		expect(persistedErrorTurns(sessionManager)).toHaveLength(1);
	});
});
