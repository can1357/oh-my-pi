import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// A stream that dies after the reply's text rendered used to end the session
// on the stall error: replay would duplicate the shown text and the stalled
// turn had no tool call to resume from. The session must keep the partial
// turn and continue after it.
describe("AgentSession text-only stream stall", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-text-stall-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("continues after committed text instead of stopping on the stall", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const mock = createMockModel({
			responses: [
				{
					content: ["Here is the first half of the answ"],
					stopReason: "error",
					errorMessage: "Anthropic stream stalled while waiting for the next event",
				},
				{ content: ["er, and the second half."], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("explain it");
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		const resumed = mock.calls[1]!.context.messages;
		const partial = resumed.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(partial.content).toContainEqual({ type: "text", text: "Here is the first half of the answ" });
		const reminder = JSON.stringify(resumed.at(-1));
		expect(reminder).toContain("Continue exactly where it stopped");

		const last = session.agent.state.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "er, and the second half." });
	});
});
