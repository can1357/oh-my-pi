import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgRetryMaxRetries } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const FAILURE = "503 service unavailable";

interface RetryProbe {
	session: AgentSession;
	model: MockModel;
}

describe("subagent session retry budget", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-subagent-retry-budget-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function parentSettings(overrides: Record<string, unknown> = {}): Settings {
		return Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"advisor.enabled": false,
			...overrides,
		});
	}

	async function run(settings: Settings, failures: number): Promise<RetryProbe> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const scripted = createMockModel({
			responses: [
				...Array.from({ length: failures }, () => ({ throw: FAILURE })),
				{ content: ["Recovered"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => scripted.stream(requestedModel, context, options),
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		});
		sessions.push(session);
		await session.prompt("Complete the task after the provider recovers");
		await session.waitForIdle();
		return { session, model: scripted };
	}

	it("fails a zero-retry child immediately while the parent can still recover", async () => {
		const settings = parentSettings({ "task.maxRetries": 0 });
		const child = await run(createSubagentSettings(settings), 1);
		expect(child.model.calls).toHaveLength(1);
		expect(child.session.getLastAssistantMessage()?.stopReason).toBe("error");
		expect(child.session.isRetrying).toBe(false);

		const parent = await run(settings, 1);
		expect(parent.model.calls).toHaveLength(2);
		expect(parent.session.getLastAssistantMessage()?.stopReason).toBe("stop");
	});

	it("caps nested workers but lets an explicit spawn override use a larger budget", async () => {
		const settings = parentSettings({ "task.maxRetries": 1 });
		const childSettings = createSubagentSettings(settings, { "retry.maxRetries": 2 });
		const child = await run(childSettings, 2);
		expect(child.model.calls).toHaveLength(3);
		expect(child.session.getLastAssistantMessage()?.stopReason).toBe("stop");

		const grandchild = await run(createSubagentSettings(childSettings), 2);
		expect(grandchild.model.calls).toHaveLength(2);
		expect(grandchild.session.getLastAssistantMessage()?.stopReason).toBe("error");
		expect(grandchild.session.isRetrying).toBe(false);
	});

	it("keeps inherited retry settings live when no child budget is configured", async () => {
		const settings = parentSettings({ "retry.maxRetries": 0 });
		const childSettings = createSubagentSettings(settings);
		cfgRetryMaxRetries.override(settings, 1);
		const child = await run(childSettings, 1);
		expect(child.model.calls).toHaveLength(2);
		expect(child.session.getLastAssistantMessage()?.stopReason).toBe("stop");
	});
});
