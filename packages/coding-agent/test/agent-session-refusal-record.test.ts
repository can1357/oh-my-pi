import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { PROVIDER_REFUSAL_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/provider-refusal";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const REFUSED_THINKING = "Planning entr.rs around the watcher core";

function refusal(thinking?: string): MockResponse {
	return {
		content: thinking ? [{ type: "thinking", thinking }] : [],
		stopReason: "error",
		stopDetails: {
			type: "refusal",
			category: "reasoning_extraction",
			explanation: "Blocked.",
			fallback_credit_token: "credit-token",
		},
		errorMessage: "Refusal (reasoning_extraction): Blocked.",
	};
}

describe("AgentSession reasoning_extraction refusals", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-refusal-record-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	async function run(responses: MockResponse[]) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const mock = createMockModel({ responses });
		const contexts: Context[] = [];
		const agent = new Agent({
			getApiKey: agentModel => `${agentModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (streamModel, context, options) => {
				contexts.push(structuredClone(context));
				return mock.stream(streamModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		await session.prompt("Implement entr");
		await session.waitForIdle();
		const records = sessionManager
			.getEntries()
			.flatMap(entry =>
				entry.type === "custom" && entry.customType === PROVIDER_REFUSAL_CUSTOM_TYPE ? [entry] : [],
			);
		const last = agent.state.messages.at(-1);
		return { contexts, records, last };
	}

	it("resamples a mid-stream refusal on the same model without replaying it, and records it on disk", async () => {
		const { contexts, records, last } = await run([refusal(REFUSED_THINKING), { content: ["Done"] }]);

		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1]?.messages)).not.toContain(REFUSED_THINKING);
		expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(records).toHaveLength(1);
		expect(records[0]?.data).toMatchObject({
			stopType: "refusal",
			category: "reasoning_extraction",
			explanation: "Blocked.",
			content: [{ type: "thinking", thinking: REFUSED_THINKING }],
		});
		expect(JSON.stringify(records[0]?.data)).not.toContain("credit-token");
	});

	it("resamples only once per turn", async () => {
		const { contexts, records } = await run([refusal(REFUSED_THINKING), refusal(REFUSED_THINKING)]);

		expect(contexts).toHaveLength(2);
		expect(records).toHaveLength(2);
	});

	it("does not resample a refusal of the request itself", async () => {
		const { contexts, records } = await run([refusal(), { content: ["Done"] }]);

		expect(contexts).toHaveLength(1);
		expect(records).toHaveLength(1);
	});
});
