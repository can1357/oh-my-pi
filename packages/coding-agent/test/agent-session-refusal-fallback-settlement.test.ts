import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgRetryRefusalFallbackRevertPolicy } from "@oh-my-pi/pi-coding-agent/session/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnRecovery } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let session: AgentSession | undefined;

function streamResponses(responses: MockResponse[], requestedModels: string[]): StreamFn {
	let next = 0;
	return (model, context, options) => {
		requestedModels.push(`${model.provider}/${model.id}`);
		const response = responses[next++];
		if (!response) throw new Error("Unexpected model request");
		return createMockModel({ provider: model.provider, id: model.id, responses: [response] }).stream(
			model,
			context,
			options,
		);
	};
}

async function createExtensionRunner(
	name: string,
	sessionManager: SessionManager,
	register: (api: ExtensionAPI) => void,
): Promise<ExtensionRunner> {
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(register, tempDir.path(), new EventBus(), runtime, name);
	return new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
}

describe("AgentSession refusal fallback response settlement", () => {
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-refusal-fallback-settlement-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("restores the captured primary when policy changes during fallback tool execution", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled fallback test models");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		settings.setModelRole("default", primary);
		const parameters = type({});
		const tool: AgentTool<typeof parameters> = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect the fixture",
			parameters,
			async execute() {
				settings.writeValue(cfgRetryRefusalFallbackRevertPolicy, "default", "override");
				return { content: [{ type: "text", text: "Inspection complete" }], details: {} };
			},
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: streamResponses(
				[
					{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
					{ content: [{ type: "toolCall", id: "inspect-1", name: "inspect", arguments: {} }] },
					{ content: ["Continued on the original model"] },
				],
				requestedModels,
			),
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Inspect the fixture");

		expect(requestedModels).toEqual([primary, fallback, primary]);
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it.each(["thinking-only", "incomplete-text"] as const)(
		"keeps the fallback active during unexpected-stop recovery for %s output",
		async output => {
			const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const fallbackModel = getBundledModel("anthropic", "claude-opus-4-8")!;
			const primary = `${primaryModel.provider}/${primaryModel.id}`;
			const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
			const requestedModels: string[] = [];
			vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop")
				.mockResolvedValue(false)
				.mockResolvedValueOnce(true);
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.maxRetries": 0,
				"retry.fallbackChains": { [primary]: [fallback] },
				"retry.refusalFallbackRevertPolicy": "after-success",
				"features.unexpectedStopDetection": output === "thinking-only" ? "mechanical" : "smart",
			});
			const parameters = type({});
			let inspections = 0;
			const tool: AgentTool<typeof parameters> = {
				name: "inspect",
				label: "Inspect",
				description: "Inspect the fixture",
				parameters,
				async execute() {
					inspections++;
					return { content: [{ type: "text", text: "Inspection complete" }], details: {} };
				},
			};
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
				streamFn: streamResponses(
					[
						{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
						output === "thinking-only"
							? {
									content: [
										{ type: "thinking", thinking: "Inspect the fixture next", thinkingSignature: "signed" },
									],
									stopReason: "stop",
								}
							: { content: ["I will inspect the fixture next."], stopReason: "stop" },
						{ content: [{ type: "toolCall", id: "inspect-recovered", name: "inspect", arguments: {} }] },
						{ content: ["Completed using the inspection result"] },
					],
					requestedModels,
				),
			});
			session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

			await session.prompt("Inspect the fixture and report the result");
			await session.waitForIdle();

			expect(requestedModels).toEqual([primary, fallback, fallback, primary]);
			expect(inspections).toBe(1);
			expect(session.model?.id).toBe(primaryModel.id);
		},
	);

	it("restores the primary when unexpected-stop recovery reaches its cap", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-8")!;
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 0,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
			"features.unexpectedStopDetection": "mechanical",
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestedModels.length > 16) throw new Error("Unexpected-stop recovery exceeded the fixture budget");
				const response: MockResponse =
					requestedModels.length === 1
						? { stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" }
						: model.id === fallbackModel.id
							? {
									content: [
										{
											type: "thinking",
											thinking: "Still considering the request",
											thinkingSignature: "signed",
										},
									],
									stopReason: "stop",
								}
							: { content: ["The primary handles the next request"] };
				return createMockModel({ provider: model.provider, id: model.id, responses: [response] }).stream(
					model,
					context,
					options,
				);
			},
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Handle a request that exhausts unexpected-stop recovery");
		await session.waitForIdle();

		expect(new Set(requestedModels.slice(1))).toEqual(new Set([fallback]));
		expect(session.getLastAssistantMessage()?.stopReason).toBe("stop");
		expect(session.model?.id).toBe(primaryModel.id);
		await session.prompt("Start a new request after recovery stops");
		await session.waitForIdle();
		expect(requestedModels.at(-1)).toBe(primary);
	});

	it.each([
		["restores the primary before a queued steer", "steer", false],
		["restores the primary before a queued follow-up", "follow-up", false],
		["continues incomplete queued work on the fallback without an extra retry", "follow-up", true],
	] as const)("%s", async (_name, queue, unexpected) => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-8")!;
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop")
			.mockResolvedValue(false)
			.mockResolvedValueOnce(unexpected);
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 0,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
			"features.unexpectedStopDetection": "smart",
		});
		const stream = streamResponses(
			[
				{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
				{ content: [unexpected ? "I will finish the request next." : "The original request is complete"] },
				{ content: ["Completed the queued request"] },
			],
			requestedModels,
		);
		const queuedText = "Handle the queued request";
		let queued = false;
		let delivered = false;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				if (!queued && model.id === fallbackModel.id) {
					queued = true;
					const message: AgentMessage = {
						role: "user",
						content: [{ type: "text", text: queuedText }],
						timestamp: Date.now(),
					};
					if (queue === "steer") agent.steer(message);
					else agent.followUp(message);
				}
				delivered ||= context.messages.some(
					message =>
						message.role === "user" &&
						(typeof message.content === "string"
							? message.content === queuedText
							: message.content.some(content => content.type === "text" && content.text === queuedText)),
				);
				return stream(model, context, options);
			},
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Handle the original request");
		await session.waitForIdle();

		expect(requestedModels).toEqual([primary, fallback, unexpected ? fallback : primary]);
		expect(delivered).toBe(true);
		expect(session.model?.id).toBe(primaryModel.id);
	});

	it("waits for a complete-stop verdict before restoring the primary", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-8")!;
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		const judging = Promise.withResolvers<void>();
		const releaseVerdict = Promise.withResolvers<void>();
		const classifyStop = vi
			.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop")
			.mockResolvedValue(true)
			.mockImplementationOnce(async () => {
				judging.resolve();
				await releaseVerdict.promise;
				return false;
			});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 0,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
			"features.unexpectedStopDetection": "smart",
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: streamResponses(
				[
					{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
					{ content: ["The fixture is already correct"] },
					{ content: ["The primary handles the next request"] },
				],
				requestedModels,
			),
		});
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const prompt = session.prompt("Inspect the fixture");
		try {
			await judging.promise;
			expect(requestedModels).toEqual([primary, fallback]);
			expect(session.model?.id).toBe(fallbackModel.id);
			releaseVerdict.resolve();
			await prompt;
			await session.waitForIdle();
			expect(session.model?.id).toBe(primaryModel.id);
			expect(requestedModels).toEqual([primary, fallback]);
			classifyStop.mockResolvedValue(false);
			await session.prompt("Continue");
			await session.waitForIdle();
			expect(requestedModels).toEqual([primary, fallback, primary]);
		} finally {
			releaseVerdict.resolve();
			await prompt;
		}
	});

	it("does not hold ordinary completion behind a message_end observer", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled primary test model");
		const requestedModels: string[] = [];
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		const manager = SessionManager.inMemory();
		const extensionRunner = await createExtensionRunner("held-ordinary-message-end", manager, pi => {
			pi.on("message_end", async event => {
				if (event.message.role !== "assistant") return;
				reached.resolve();
				await release.promise;
			});
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: streamResponses([{ content: ["Ordinary response"] }], requestedModels),
		});
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry, extensionRunner });

		const prompt = session.prompt("Complete despite a held observer");
		try {
			await reached.promise;
			await prompt;
			expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
			expect(session.isStreaming).toBe(false);
		} finally {
			release.resolve();
		}
	});

	it("does not hold ordinary completion behind a turn_end observer", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled primary test model");
		const requestedModels: string[] = [];
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		const manager = SessionManager.inMemory();
		const extensionRunner = await createExtensionRunner("held-ordinary-turn-end", manager, pi => {
			pi.on("turn_end", async () => {
				reached.resolve();
				await release.promise;
			});
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: streamResponses([{ content: ["Ordinary response"] }], requestedModels),
		});
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry, extensionRunner });

		const prompt = session.prompt("Complete despite a held observer");
		try {
			await reached.promise;
			await prompt;
			expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
			expect(session.isStreaming).toBe(false);
		} finally {
			release.resolve();
		}
	});

	it("restores and continues while an unrelated extension notification is held", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled fallback test models");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		settings.setModelRole("default", primary);
		const manager = SessionManager.inMemory();
		const extensionRunner = await createExtensionRunner("held-unrelated-tool-end", manager, pi => {
			pi.on("tool_execution_end", async () => {
				reached.resolve();
				await release.promise;
			});
		});
		const parameters = type({});
		const tool: AgentTool<typeof parameters> = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect the fixture",
			parameters,
			async execute() {
				return { content: [{ type: "text", text: "Inspection complete" }], details: {} };
			},
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: streamResponses(
				[
					{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
					{ content: [{ type: "toolCall", id: "inspect-1", name: "inspect", arguments: {} }] },
					{ content: ["Continued on the original model"] },
				],
				requestedModels,
			),
		});
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry, extensionRunner });

		const prompt = session.prompt("Inspect the fixture");
		try {
			await reached.promise;
			await prompt;
			expect(requestedModels).toEqual([primary, fallback, primary]);
			expect(session.model?.id).toBe(primaryModel.id);
		} finally {
			release.resolve();
		}
	});

	it("does not hold restoration behind retry_fallback_succeeded observers", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled fallback test models");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		settings.setModelRole("default", primary);
		const manager = SessionManager.inMemory();
		const extensionRunner = await createExtensionRunner("held-fallback-succeeded", manager, pi => {
			pi.on("retry_fallback_succeeded", async () => {
				reached.resolve();
				await release.promise;
			});
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: streamResponses(
				[
					{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
					{ content: ["Recovered on fallback"] },
				],
				requestedModels,
			),
		});
		session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry, extensionRunner });

		const prompt = session.prompt("Recover despite observer delay");
		try {
			await reached.promise;
			await prompt;
			expect(requestedModels).toEqual([primary, fallback]);
			expect(session.model?.id).toBe(primaryModel.id);
		} finally {
			release.resolve();
		}
	});

	it("delays restoration until the matching assistant response settlement completes", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled fallback test models");
		const primary = `${primaryModel.provider}/${primaryModel.id}`;
		const fallback = `${fallbackModel.provider}/${fallbackModel.id}`;
		const requestedModels: string[] = [];
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const restorationBoundary = Promise.withResolvers<void>();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { [primary]: [fallback] },
			"retry.refusalFallbackRevertPolicy": "after-success",
		});
		settings.setModelRole("default", primary);
		const parameters = type({});
		const tool: AgentTool<typeof parameters> = {
			name: "inspect",
			label: "Inspect",
			description: "Inspect the fixture",
			parameters,
			async execute() {
				return { content: [{ type: "text", text: "Inspection complete" }], details: {} };
			},
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: streamResponses(
				[
					{ stopReason: "error", stopDetails: { type: "refusal" }, errorMessage: "Classifier declined" },
					{ content: [{ type: "toolCall", id: "inspect-1", name: "inspect", arguments: {} }] },
					{ content: ["Continued on the original model"] },
				],
				requestedModels,
			),
		});
		const original = TurnRecovery.prototype.onAssistantSettledSuccessfully;
		vi.spyOn(TurnRecovery.prototype, "onAssistantSettledSuccessfully").mockImplementation(
			async function (this: TurnRecovery, message) {
				if (message.provider === fallbackModel.provider && message.model === fallbackModel.id) {
					reached.resolve();
					await release.promise;
				}
				await original.call(this, message);
			},
		);
		const hasRequestScopedFallback = TurnRecovery.prototype.hasRequestScopedRetryFallback;
		vi.spyOn(TurnRecovery.prototype, "hasRequestScopedRetryFallback").mockImplementation(
			function (this: TurnRecovery) {
				const requestScoped = hasRequestScopedFallback.call(this);
				if (requestScoped) restorationBoundary.resolve();
				return requestScoped;
			},
		);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const prompt = session.prompt("Inspect the fixture");
		try {
			await reached.promise;
			// Release bookkeeping only after turn-end reaches its restoration
			// decision: skipping the matching-response wait must invoke the fallback again.
			await restorationBoundary.promise;
			// Let turn-end progress while bookkeeping is held. It must not
			// sample a tool-result continuation on the fallback before settlement.
			const checkpoint = Promise.withResolvers<void>();
			const channel = new MessageChannel();
			channel.port1.onmessage = () => checkpoint.resolve();
			try {
				channel.port2.postMessage(null);
				await checkpoint.promise;
			} finally {
				channel.port1.close();
				channel.port2.close();
			}
			expect(requestedModels).toEqual([primary, fallback]);
			expect(session.model?.id).toBe(fallbackModel.id);
			release.resolve();
			await prompt;
			expect(requestedModels).toEqual([primary, fallback, primary]);
		} finally {
			release.resolve();
		}
	});
});
