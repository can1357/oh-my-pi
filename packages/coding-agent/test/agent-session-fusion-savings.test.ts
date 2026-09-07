import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { AgentTurnEndContext } from "@pk-nerdsaver-ai/pi-agent-core/types";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

function makeTestModel(provider: string, id: string, name: string): Model<Api> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const defaultModel = makeTestModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet");
const taskModel = makeTestModel("anthropic", "claude-haiku", "Claude Haiku");
const slowModel = makeTestModel("anthropic", "claude-opus-4-8", "Claude Opus");

interface TestHarness {
	session: AgentSession;
	agent: Agent;
	onTurnEndFn: (messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void;
	cleanup: () => Promise<void>;
}

async function createSavingsHarness(fusionOverrides: Record<string, unknown> = {}): Promise<TestHarness> {
	const tempDir = TempDir.createSync("@savings-test-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry.getAvailable = () => [defaultModel, taskModel, slowModel];
	modelRegistry.hasConfiguredAuth = () => true;

	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));

	let capturedOnTurnEnd:
		| ((messages: AgentMessage[], signal?: AbortSignal, context?: AgentTurnEndContext) => Promise<void> | void)
		| undefined;

	const mockModel = createMockModel({ handler: { content: ["Done"] } });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: defaultModel,
			systemPrompt: ["You are a test assistant."],
			tools: [],
			messages: [],
		},
		streamFn: mockModel.stream,
	});

	const origSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
	agent.setOnTurnEnd = fn => {
		origSetOnTurnEnd(fn);
		if (fn) {
			capturedOnTurnEnd = fn;
		}
	};

	const settings = Settings.isolated({
		"fusion.enabled": true,
		"fusion.mode": "token-savings",
		"fusion.tokenSavingsDefaultCallLimit": 2,
		modelRoles: {
			default: "anthropic/claude-sonnet-4-5",
			task: "anthropic/claude-haiku",
			slow: "anthropic/claude-opus-4-8",
		},
		...fusionOverrides,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
	});

	return {
		session,
		agent,
		onTurnEndFn: async (messages, signal, context) => {
			if (capturedOnTurnEnd) {
				await capturedOnTurnEnd(messages, signal, context);
			}
		},
		cleanup: async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		if (fn) await fn();
	}
});

function makeContinuingContext(): AgentTurnEndContext {
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "file content" }],
		isError: false,
		timestamp: Date.now(),
	};
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "foo.txt" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.001, total: 0.003 },
		},
		timestamp: Date.now(),
	};
	return {
		message: assistantMessage,
		toolResults: [toolResult],
		willContinue: true,
	};
}

describe("AgentSession — Fusion Token Savings Mode call limit", () => {
	it("allows call 1 on the default model without switching", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);

		expect(harness.session.model?.id).toBe(defaultModel.id);
	});

	it("transitions to the task model after call 2 on a continuing turn", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();

		// Call 1
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(defaultModel.id);

		// Call 2
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		// Steered reminder injected
		const steeringQueue = harness.agent.peekSteeringQueue();
		expect(steeringQueue.length).toBeGreaterThan(0);
		const lastSteer = steeringQueue[steeringQueue.length - 1];
		const steerText =
			lastSteer && "content" in lastSteer && typeof lastSteer.content === "string" ? lastSteer.content : "";
		expect(steerText).toContain("Fusion Token Savings: The default model call limit");
	});
	it("restores the default model when a new user prompt begins", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();

		// Call 1 and 2 trigger switch to task model
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		// User submits a new prompt
		await harness.session.prompt("Next simple question", { userInitiated: true });

		// Model restored to default model
		expect(harness.session.model?.id).toBe(defaultModel.id);
	});

	it("enforces the call limit again after each next-prompt restoration", async () => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);
		const context = makeContinuingContext();

		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(taskModel.id);

		for (const prompt of ["Second question", "Third question"]) {
			// The preceding synthetic callbacks leave a reminder queued; a real
			// completed turn would already have consumed it on the task model.
			harness.agent.clearAllQueues();
			await harness.session.prompt(prompt, { userInitiated: true });
			expect(harness.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(harness.session.model?.id).toBe(defaultModel.id);

			// prompt() made the first default-model call; its next continuing
			// callback must hit the reset two-call limit, not latch a manual override.
			await harness.onTurnEndFn([context.message], undefined, context);
			expect(harness.session.model?.id).toBe(taskModel.id);
			expect(harness.agent.peekSteeringQueue()).toHaveLength(1);
		}
	});

	it.each(["before", "after"] as const)("preserves a manual model choice %s next-prompt restoration", async timing => {
		const harness = await createSavingsHarness();
		cleanups.push(harness.cleanup);
		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		harness.agent.clearAllQueues();

		if (timing === "before") await harness.session.setModelTemporary(slowModel);
		await harness.session.prompt("Next question", { userInitiated: true });
		expect(harness.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		if (timing === "after") {
			expect(harness.session.model?.id).toBe(defaultModel.id);
			await harness.session.setModelTemporary(slowModel);
		}
		expect(harness.session.model?.id).toBe(slowModel.id);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(slowModel.id);
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);

		// A detected manual override remains latched even if the user later
		// selects the default model again on another prompt.
		await harness.session.setModelTemporary(defaultModel);
		await harness.session.prompt("Keep my selected model", { userInitiated: true });
		expect(harness.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		expect(harness.session.model?.id).toBe(defaultModel.id);
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("does not enforce the limit when fusion.mode is off", async () => {
		const harness = await createSavingsHarness({
			"fusion.mode": "off",
		});
		cleanups.push(harness.cleanup);

		const context = makeContinuingContext();
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);
		await harness.onTurnEndFn([context.message], undefined, context);

		expect(harness.session.model?.id).toBe(defaultModel.id);
	});
});
