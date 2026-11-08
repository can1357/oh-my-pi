import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let previousNoTitle: string | undefined;

beforeEach(() => {
	previousNoTitle = Bun.env.PI_NO_TITLE;
	delete Bun.env.PI_NO_TITLE;
});

afterEach(async () => {
	if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
	else Bun.env.PI_NO_TITLE = previousNoTitle;
	vi.restoreAllMocks();
	await session?.dispose();
	authStorage?.close();
	session = undefined;
	authStorage = undefined;
});

describe("Issue #18177: Session title generation usage recording", () => {
	it("records model_usage entries for all online title generation attempts (including failed and successful)", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const storage = authStorage;
		const modelRegistry = new ModelRegistry(storage);

		const model1 = getBundledModel("anthropic", "claude-sonnet-4-5");
		const model2 = getBundledModel("anthropic", "claude-opus-4-5") ?? model1;
		if (!model1 || !model2) throw new Error("Expected models to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			modelRoles: {
				tiny: `${model1.provider}/${model1.id}`,
				smol: `${model2.provider}/${model2.id}`,
			},
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: model1, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler: { content: ["Done"] } }).stream,
		});

		let callCount = 0;
		// Mock completeSimple:
		// Attempt 1 on model1: No title produced (costs $0.01)
		// Attempt 2 on model2: Valid title produced (costs $0.02)
		vi.spyOn(ai, "completeSimple").mockImplementation(async requestModel => {
			callCount++;
			if (callCount === 1) {
				return {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: {
						input: 100,
						output: 10,
						cacheWrite: 0,
						cacheRead: 0,
						totalTokens: 110,
						cost: { input: 0.005, output: 0.005, total: 0.01 },
					},
					stopReason: "stop",
				};
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: "<title>Generated Title</title>" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: {
					input: 200,
					output: 20,
					cacheWrite: 0,
					cacheRead: 0,
					totalTokens: 220,
					cost: { input: 0.01, output: 0.01, total: 0.02 },
				},
				stopReason: "stop",
			};
		});

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		const title = await session.generateTitle("Fix database index corruption");
		expect(title).toBe("Generated Title");

		const entries = sessionManager.getEntries();
		const modelUsageEntries = entries.filter(e => e.type === "model_usage" && e.purpose === "title");

		// Prior to fix, modelUsageEntries.length is 0 because usage is never recorded!
		expect(modelUsageEntries.length).toBe(2);
		expect(modelUsageEntries[0].usage.cost?.total).toBe(0.01);
		expect(modelUsageEntries[1].usage.cost?.total).toBe(0.02);
		expect(modelUsageEntries[0].purpose).toBe("title");
		expect(modelUsageEntries[1].purpose).toBe("title");

		const stats = session.getSessionStats();
		expect(stats.cost).toBeCloseTo(0.03, 4);
		expect(stats.tokens.total).toBe(330);
		expect(session.costGate.spent).toBeCloseTo(0.03, 4);
	});
});
