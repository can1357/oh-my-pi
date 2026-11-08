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

function nextTitle(target: AgentSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = target.sessionManager.onSessionNameChanged(() => {
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("Issue #18177: Session title generation usage recording", () => {
	it("records model_usage entries for all online title generation attempts (including failed and successful)", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

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

	it("records usage for each attempt inside retryTransientCompletion when transient errors occur", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler: { content: ["Done"] } }).stream,
		});

		let attempt = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async requestModel => {
			attempt++;
			if (attempt === 1) {
				return {
					role: "assistant",
					content: [],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: {
						input: 80,
						output: 5,
						cacheWrite: 0,
						cacheRead: 0,
						totalTokens: 85,
						cost: { input: 0.005, output: 0.005, total: 0.01 },
					},
					stopReason: "error",
					errorStatus: 503,
					errorMessage: "Service Unavailable",
				};
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: "<title>Retry Succeeded</title>" }],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: {
					input: 90,
					output: 10,
					cacheWrite: 0,
					cacheRead: 0,
					totalTokens: 100,
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

		const title = await session.generateTitle("Fix transient issue");
		expect(title).toBe("Retry Succeeded");

		const entries = sessionManager.getEntries().filter(e => e.type === "model_usage" && e.purpose === "title");
		expect(entries.length).toBe(2);
		expect(entries[0].stopReason).toBe("error");
		expect(entries[0].usage.cost?.total).toBe(0.01);
		expect(entries[1].stopReason).toBe("stop");
		expect(entries[1].usage.cost?.total).toBe(0.02);

		const stats = session.getSessionStats();
		expect(stats.cost).toBeCloseTo(0.03, 4);
		expect(session.costGate.spent).toBeCloseTo(0.03, 4);
	});

	it("enforces cost cap between candidate model attempts", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const model1 = getBundledModel("anthropic", "claude-sonnet-4-5");
		const model2 = getBundledModel("anthropic", "claude-opus-4-5") ?? model1;
		if (!model1 || !model2) throw new Error("Expected models to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"session.maxCost": 0.01,
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

		let modelAttempts = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async requestModel => {
			modelAttempts++;
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

		const title = await session.generateTitle("Fix database cap");
		expect(title).toBeNull();
		// Candidate 2 must NOT be called because candidate 1 crossed session.maxCost
		expect(modelAttempts).toBe(1);

		const entries = sessionManager.getEntries().filter(e => e.type === "model_usage" && e.purpose === "title");
		expect(entries.length).toBe(1);
		expect(session.costGate.spent).toBeCloseTo(0.02, 4);
		expect(session.costGate.check()).toBeDefined();
	});

	it("enforces cost cap before transient retries", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"session.maxCost": 0.01,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler: { content: ["Done"] } }).stream,
		});

		let attempts = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(async requestModel => {
			attempts++;
			return {
				role: "assistant",
				content: [],
				api: requestModel.api,
				provider: requestModel.provider,
				model: requestModel.id,
				usage: {
					input: 100,
					output: 10,
					cacheWrite: 0,
					cacheRead: 0,
					totalTokens: 110,
					cost: { input: 0.01, output: 0.01, total: 0.02 },
				},
				stopReason: "error",
				errorStatus: 503,
				errorMessage: "Service Unavailable",
			};
		});

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		const title = await session.generateTitle("Fix transient cap");
		expect(title).toBeNull();
		// Retry attempt 2 must NOT be called because attempt 1 crossed session.maxCost
		expect(attempts).toBe(1);

		const entries = sessionManager.getEntries().filter(e => e.type === "model_usage" && e.purpose === "title");
		expect(entries.length).toBe(1);
		expect(session.costGate.spent).toBeCloseTo(0.02, 4);
	});

	it("records model_usage for default fork title generator", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"title.icons": "emoji",
			"title.generator": "fork",
		});

		const mainModel = createMockModel({
			responses: [
				{
					content: ["Working on park tests."],
					usage: {
						input: 500,
						output: 50,
						cacheWrite: 0,
						cacheRead: 0,
						totalTokens: 550,
						cost: { input: 0.01, output: 0.01, total: 0.02 },
					},
				},
			],
		});

		const sideModel = createMockModel({
			handler: {
				content: ['<title emoji="🧪" code="PARK">Fix flaky park tests</title>'],
				usage: {
					input: 300,
					output: 30,
					cacheWrite: 0,
					cacheRead: 0,
					totalTokens: 330,
					cost: { input: 0.005, output: 0.005, total: 0.01 },
				},
			},
		});

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mainModel.stream,
			}),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			sideStreamFn: sideModel.stream,
			autoTitle: true,
		});

		const titled = nextTitle(session);
		await session.prompt("Fix flaky park tests");
		await titled;

		expect(session.sessionName).toBe("🧪 PARK: Fix flaky park tests");

		const entries = sessionManager.getEntries().filter(e => e.type === "model_usage" && e.purpose === "title");
		expect(entries.length).toBe(1);
		expect(entries[0].usage.cost?.total).toBe(0.01);

		const usageStats = session.sessionManager.getUsageStatistics();
		// Usage statistics include both main turn and fork title spend
		expect(usageStats.cost).toBeCloseTo(0.03, 4);
		expect(usageStats.totalTokens).toBe(880);
		// Cost gate was charged with the fork title's spend
		expect(session.costGate.spent).toBeCloseTo(0.01, 4);
	});

	it("stale session on newSession charges the old session's cost gate, not the new session's gate", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			modelRoles: { tiny: `${model.provider}/${model.id}` },
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ handler: { content: ["Done"] } }).stream,
		});

		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<ai.AssistantMessage>();

		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			started.resolve();
			return response.promise;
		});

		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		const oldCostGate = session.costGate;
		const generation = session.generateTitle("Fix long running operation");
		await started.promise;

		// Session switches / new session created
		expect(await session.newSession()).toBe(true);
		const newCostGate = session.costGate;
		expect(newCostGate).not.toBe(oldCostGate);

		// Resolve the late completion with usage
		response.resolve({
			role: "assistant",
			content: [{ type: "text", text: "<title>Late Title</title>" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 10,
				cacheWrite: 0,
				cacheRead: 0,
				totalTokens: 110,
				cost: { input: 0.01, output: 0.01, total: 0.02 },
			},
			stopReason: "stop",
		});

		const titleResult = await generation;
		expect(titleResult).toBeNull();

		// Old cost gate charged:
		expect(oldCostGate.spent).toBeCloseTo(0.02, 4);
		// New session's cost gate must NOT be charged:
		expect(newCostGate.spent).toBe(0);

		// New session must have no title entries:
		const newEntries = sessionManager.getEntries().filter(e => e.type === "model_usage" && e.purpose === "title");
		expect(newEntries.length).toBe(0);
	});
});
