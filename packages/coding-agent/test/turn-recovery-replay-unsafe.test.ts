import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage, SyntheticToolResultDetails } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createProviderErrorMessage } from "../../ai/src/providers/error-message";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeMessage(content: AssistantMessage["content"], model: Model): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage: "timeout",
		timestamp: Date.now(),
	};
}

function createHost(
	model: Model,
	modelRegistry: ModelRegistry,
	options: {
		fallbackChains?: Record<string, string[]>;
		textOutputCommitted?: boolean;
		messages?: readonly AgentMessage[];
		lastModelChangeRole?: string;
		modelRoles?: Record<string, string>;
	} = {},
): TurnRecoveryHost {
	const settings = Settings.isolated({
		...(options.fallbackChains ? { "retry.fallbackChains": options.fallbackChains } : {}),
		...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
	});
	if (options.modelRoles) {
		for (const [role, selector] of Object.entries(options.modelRoles)) {
			settings.setModelRole(role, selector);
		}
	}
	return {
		agent: { state: { messages: options.messages ?? [] } } as never,
		sessionManager: {
			getLastModelChangeRole: () => options.lastModelChangeRole,
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => model,
		contextFitsModel: () => true,
		textOutputCommitted: () => options.textOutputCommitted !== false,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		sessionId: () => "test-session",
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemCodexReset: async () => false,
		runAutoCompaction: async () =>
			({ deferredHandoff: false, continuationScheduled: false }) as RecoveryCompactionResult,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};
}

describe("TurnRecovery replay-unsafe output classification", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");

	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-recovery-replay-");
		authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		// Live-role resolution (#liveRetryRoleHint) filters by provider auth;
		// pin a runtime key so the test does not depend on host env credentials.
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("rolls back a usage fallback cancelled during model reconciliation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		let activeModel = model;
		const fallbackApplied = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const emittedEvents: string[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
			getSessionId: () => "replay-unsafe-session",
		} as never;
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
			if (nextModel.provider === fallback.provider && nextModel.id === fallback.id) {
				fallbackApplied.resolve();
				await releaseReconciliation.promise;
			}
		};
		host.emitSessionEvent = async event => {
			emittedEvents.push(event.type);
		};
		const recovery = new TurnRecovery(host);
		const controller = new AbortController();
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key", signal: controller.signal },
		);

		await fallbackApplied.promise;
		controller.abort();
		releaseReconciliation.resolve();
		const committed = await applying;

		expect(committed).toBe(false);
		expect(activeModel).toBe(model);
		expect(modelChanges).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});

	it("does not commit a fallback superseded during model reconciliation", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback race model");
		const selectedModel = { ...fallback, baseUrl: "https://user-selected-route.example" };
		let activeModel = model;
		const fallbackApplied = Promise.withResolvers<void>();
		const releaseReconciliation = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const emittedEvents: string[] = [];
		const thinkingChanges: unknown[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
			getSessionId: () => "replay-unsafe-session",
		} as never;
		host.setThinkingLevel = level => thinkingChanges.push(level);
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
			if (nextModel.provider === fallback.provider && nextModel.id === fallback.id) {
				fallbackApplied.resolve();
				await releaseReconciliation.promise;
			}
		};
		host.emitSessionEvent = async event => {
			emittedEvents.push(event.type);
		};
		const recovery = new TurnRecovery(host);
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key" },
		);

		await fallbackApplied.promise;
		activeModel = selectedModel;
		releaseReconciliation.resolve();
		const committed = await applying;

		expect(committed).toBe(false);
		expect(activeModel).toBe(selectedModel);
		expect(modelChanges).toEqual([]);
		expect(thinkingChanges).toEqual([]);
		expect(emittedEvents).toEqual([]);
	});
	it("keeps a committed fallback when cancellation arrives during applied-event delivery", async () => {
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!fallback) throw new Error("Expected bundled fallback model");
		let activeModel = model;
		const eventStarted = Promise.withResolvers<void>();
		const releaseEvent = Promise.withResolvers<void>();
		const modelChanges: string[] = [];
		const host = createHost(model, modelRegistry);
		host.model = () => activeModel;
		host.sessionManager = {
			appendModelChange: (selector: string) => modelChanges.push(selector),
			getSessionId: () => "replay-unsafe-session",
		} as never;
		host.setModelWithProviderSessionReset = async nextModel => {
			activeModel = nextModel;
		};
		host.emitSessionEvent = async event => {
			if (event.type !== "retry_fallback_applied") return;
			eventStarted.resolve();
			await releaseEvent.promise;
		};
		const recovery = new TurnRecovery(host);
		const controller = new AbortController();
		const applying = recovery.applyRetryFallbackCandidate(
			"default",
			{
				raw: `${fallback.provider}/${fallback.id}`,
				provider: fallback.provider,
				id: fallback.id,
				thinkingLevel: undefined,
			},
			`${model.provider}/${model.id}`,
			{ pinFallback: true, apiKey: "test-key", signal: controller.signal },
		);

		await eventStarted.promise;
		controller.abort();
		releaseEvent.resolve();
		const committed = await applying;

		expect(committed).toBe(true);
		expect(activeModel.provider).toBe(fallback.provider);
		expect(activeModel.id).toBe(fallback.id);
		expect(modelChanges).toEqual([`${fallback.provider}/${fallback.id}`]);
	});

	it("treats a failed turn with partial non-whitespace text as NOT retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Here is the first part of my answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("does not replay a long OpenCode Go usage limit after committed text", () => {
		const openCodeModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!openCodeModel) throw new Error("Expected bundled OpenCode Go model");
		const recovery = new TurnRecovery(
			createHost(openCodeModel, modelRegistry, {
				fallbackChains: {
					[`${openCodeModel.provider}/${openCodeModel.id}`]: ["openai/gpt-4o-mini"],
				},
			}),
		);
		const message = {
			...makeMessage([{ type: "text", text: "Already shown to the user" }], openCodeModel),
			errorMessage: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
		} as AssistantMessage;
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("allows replay-safe hard fallback and excludes committed text with a configured chain", () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		};
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		// Thinking-only output is replay-safe: nothing visible reached the user.
		const message = makeMessage([{ type: "thinking", thinking: "safe reasoning before failing" }], model);
		const visible = makeMessage([{ type: "text", text: "Already shown" }], model);
		expect(recovery.isHardErrorFallbackEligible(visible)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("retries partial text while its buffered output remains uncommitted", () => {
		const fallbackChains = {
			[`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"],
		};
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, { fallbackChains, textOutputCommitted: false }),
		);
		const message = makeMessage([{ type: "text", text: "Buffered partial answer" }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("excludes a Fireworks Fast failed turn with partial visible text from Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		const message = makeMessage([{ type: "text", text: "partial visible output" }], fastModel);
		expect(recovery.isFireworksFastFallbackEligible(message)).toBe(false);
	});

	it("keeps a Fireworks Fast empty/whitespace failed turn eligible for Fast→base fallback", () => {
		const fastModel = getBundledModel("fireworks", "kimi-k2.6-fast");
		if (!fastModel) throw new Error("Expected bundled model kimi-k2.6-fast");
		const recovery = new TurnRecovery(createHost(fastModel, modelRegistry));
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([], fastModel))).toBe(true);
		expect(recovery.isFireworksFastFallbackEligible(makeMessage([{ type: "text", text: "   \n" }], fastModel))).toBe(
			true,
		);
	});

	it("bars usage-backed payload-shaped overflows from the hard-error fallback chain", () => {
		const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		const message = {
			...makeMessage([], model),
			errorMessage: "request_too_large: image count exceeds the limit of 20",
			usage: { ...USAGE, input: (model.contextWindow ?? 0) + 1_000 },
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		expect(AIError.isPayloadRejection(message)).toBe(true);
		expect(AIError.isUsageBackedContextOverflow(message, model.contextWindow ?? 0)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps text-ambiguous media-budget 413s eligible for the configured chain", () => {
		const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		const message = {
			...makeMessage([], model),
			errorMessage: "request_too_large: image count exceeds the limit of 20",
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		expect(AIError.isContextOverflow(message, model.contextWindow ?? 0)).toBe(true);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(true);
	});

	it("keeps pure token-context overflows barred from the configured chain", () => {
		const fallbackChains = { [`${model.provider}/${model.id}`]: ["openai/gpt-4o-mini"] };
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { fallbackChains }));
		const message = {
			...makeMessage([], model),
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		expect(AIError.isContextOverflow(message, model.contextWindow ?? 0)).toBe(true);
		expect(AIError.isPayloadRejection(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("treats a thinking-only partial turn as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Let me reason about this step by step." }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a whitespace-only text partial as still retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("keeps the tool-call case replay-unsafe (no regression)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps side-effecting output replay-unsafe while text is uncommitted", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry, { textOutputCommitted: false }));
		const message = makeMessage(
			[
				{ type: "text", text: "Buffered partial answer" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
		expect(recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});

	it("keeps an empty-content error retriable (baseline)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([], model);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats a mix of thinking and text as replay-unsafe (text wins)", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Reasoning before the visible answer." },
				{ type: "text", text: "The answer is 42." },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats thinking plus whitespace-only text as replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{ type: "thinking", thinking: "Long reasoning." },
				{ type: "text", text: "  " },
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("does not retry malformed calls after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Already shown" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("retries malformed calls with replay-safe output", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "thinking", thinking: "Unshown reasoning" }], model);
		message.errorId = AIError.create(AIError.Flag.MalformedFunctionCall);
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	it("treats generated images as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], model);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("treats Anthropic server tools as replay-unsafe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage(
			[
				{
					type: "anthropicServerTool",
					block: { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "status" } },
				},
			],
			model,
		);
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps replay-safe classifier refusals retriable", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const thinking = makeMessage([{ type: "thinking", thinking: "reasoning before refusal" }], model);
		thinking.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(thinking)).toBe(true);

		const whitespace = makeMessage([{ type: "text", text: "   \n\n  " }], model);
		whitespace.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(whitespace)).toBe(true);

		const empty = makeMessage([], model);
		empty.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(empty)).toBe(true);
	});

	it("does not retry a classifier refusal after visible text", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = makeMessage([{ type: "text", text: "Visible refusal output" }], model);
		message.stopDetails = { type: "refusal" };
		expect(recovery.isRetryableError(message)).toBe(false);
	});

	it("keeps pre-stream provider diagnostics replay-safe", () => {
		const recovery = new TurnRecovery(createHost(model, modelRegistry));
		const message = createProviderErrorMessage(model, new Error("fetch failed"));
		expect(recovery.isRetryableError(message)).toBe(true);
	});

	// Anthropic's request classifier can refuse AFTER the model streamed a tool
	// call. Production shape (omp.2026-08-07 log): `stopDetails.type === "refusal"`,
	// `errorId: 0` (no AIError flag, so `AIError.retriable` cannot rescue it), and
	// the agent loop appends a synthetic `executed: false` result AFTER the refused
	// assistant message, so state ends with `lastRole: "toolResult"`.
	describe("classifier refusal with emitted tool calls", () => {
		function makeRefusal(content: AssistantMessage["content"]): AssistantMessage {
			const message = makeMessage(content, model);
			message.errorMessage =
				"Refusal (cyber): This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy.";
			message.stopDetails = { type: "refusal" };
			message.errorId = 0;
			return message;
		}

		function toolCall(id: string): AssistantMessage["content"][number] {
			return { type: "toolCall", id, name: "read", arguments: { path: "https://developer.android.com/reference" } };
		}

		function syntheticResult(toolCallId: string): ToolResultMessage<SyntheticToolResultDetails> {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "Tool call was not executed." }],
				isError: true,
				details: { __synthetic: true, source: "assistant_stop_error", executed: false },
				timestamp: Date.now(),
			};
		}

		function realResult(toolCallId: string): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [{ type: "text", text: "# Android reference" }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		function recoveryFor(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it("retries a refusal whose only tool call provably never executed", () => {
			const message = makeRefusal([toolCall("call-1")]);
			expect(message.errorId).toBe(0);
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});

		it("does not retry a refusal whose tool call produced a real result", () => {
			const message = makeRefusal([toolCall("call-1")]);
			expect(recoveryFor(message, [realResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal when only some tool calls went unexecuted", () => {
			const message = makeRefusal([toolCall("call-1"), toolCall("call-2")]);
			const recovery = recoveryFor(message, [realResult("call-1"), syntheticResult("call-2")]);
			expect(recovery.isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal that also committed visible text", () => {
			const message = makeRefusal([{ type: "text", text: "Let me fetch that page." }, toolCall("call-1")]);
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal whose tool call has no result at all", () => {
			const message = makeRefusal([toolCall("call-1")]);
			expect(recoveryFor(message, []).isRetryableError(message)).toBe(false);
		});

		it("does not retry a refusal when one call is synthetic-paired and another has no result", () => {
			// Reachable in practice: the agent loop skips Cursor server-resolved calls
			// when pairing synthetic results, so a turn can carry one accounted-for
			// call beside one it never paired. Accounting for only some of them is
			// not proof that none ran.
			const message = makeRefusal([toolCall("call-1"), toolCall("call-2")]);
			const recovery = recoveryFor(message, [syntheticResult("call-1")]);
			expect(recovery.isRetryableError(message)).toBe(false);
		});

		it("keeps a refusal with no tool calls retriable (baseline)", () => {
			const message = makeRefusal([{ type: "thinking", thinking: "reasoning before refusal" }]);
			expect(recoveryFor(message, []).isRetryableError(message)).toBe(true);
		});

		it("retries a malformed function call whose tool call provably never executed", () => {
			const message = makeMessage([toolCall("call-1")], model);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});

		it("does not retry a malformed function call whose tool call produced a real result", () => {
			const message = makeMessage([toolCall("call-1")], model);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			expect(recoveryFor(message, [realResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry a malformed function call that also committed visible text", () => {
			const message = makeMessage([{ type: "text", text: "Let me fetch that page." }, toolCall("call-1")], model);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("retries a transport error with a provably unexecuted tool call", () => {
			const message = makeMessage([toolCall("call-1")], model);
			expect(recoveryFor(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});
	});

	// A provider transport error (e.g. `The socket connection was closed
	// unexpectedly` after the model emitted a complete tool call) ends the turn
	// with `stopReason: "error"`; the agent loop pairs every emitted-but-unrun
	// call with a synthetic `executed: false` result. With positive proof that
	// none of them ran, the turn is replay-safe the same way a post-call
	// classifier refusal is, so the configured retry/fallback policy gets its
	// chance instead of surfacing the socket error as terminal.
	describe("transport error with emitted tool calls", () => {
		const socketClose =
			"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

		function transportError(content: AssistantMessage["content"]): AssistantMessage {
			const message = makeMessage(content, model);
			message.errorMessage = socketClose;
			return message;
		}

		function toolCall(id: string): AssistantMessage["content"][number] {
			return { type: "toolCall", id, name: "bash", arguments: { command: "ssh host" } };
		}

		function syntheticResult(toolCallId: string): ToolResultMessage<SyntheticToolResultDetails> {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "Tool call was not executed." }],
				isError: true,
				details: { __synthetic: true, source: "assistant_stop_error", executed: false },
				timestamp: Date.now(),
			};
		}

		function realResult(toolCallId: string): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		function recoveryForTransport(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it("retries when the only tool call provably never executed", () => {
			const message = transportError([toolCall("call-1")]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(true);
		});

		it("does not retry when the tool call produced a real result", () => {
			const message = transportError([toolCall("call-1")]);
			expect(recoveryForTransport(message, [realResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry when only some tool calls went unexecuted", () => {
			const message = transportError([toolCall("call-1"), toolCall("call-2")]);
			const recovery = recoveryForTransport(message, [realResult("call-1"), syntheticResult("call-2")]);
			expect(recovery.isRetryableError(message)).toBe(false);
		});

		it("does not retry when the turn also committed visible text", () => {
			const message = transportError([{ type: "text", text: "Connecting..." }, toolCall("call-1")]);
			expect(recoveryForTransport(message, [syntheticResult("call-1")]).isRetryableError(message)).toBe(false);
		});

		it("does not retry when the tool call has no result at all", () => {
			const message = transportError([toolCall("call-1")]);
			expect(recoveryForTransport(message, []).isRetryableError(message)).toBe(false);
		});
	});

	describe("HTTP/2 stream reset after resolved tool calls", () => {
		const nghttp2Internal = "Stream closed with error code NGHTTP2_INTERNAL_ERROR";
		const nghttp2Refused = "Stream closed with error code NGHTTP2_REFUSED_STREAM";
		const stallMessage = "Provider stream stalled while waiting for the next event";

		function cursorMessage(content: AssistantMessage["content"], errorMessage: string): AssistantMessage {
			const message = makeMessage(content, model);
			message.provider = "cursor";
			message.errorMessage = errorMessage;
			return message;
		}

		function execToolCall(id: string, marked = false): AssistantMessage["content"][number] {
			const block: AssistantMessage["content"][number] = {
				type: "toolCall",
				id,
				name: "bash",
				arguments: { command: "pwd" },
			};
			if (marked) (block as { [kCursorExecResolved]?: true })[kCursorExecResolved] = true;
			return block;
		}

		function mcpToolCall(id: string): AssistantMessage["content"][number] {
			return {
				type: "toolCall",
				id,
				name: "mcp__databricks_production_execute_sql",
				arguments: { query: "SELECT 1" },
			};
		}

		function realResult(toolCallId: string, toolName = "bash"): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "/workspace" }],
				isError: false,
				timestamp: Date.now(),
			};
		}

		function recoveryForReset(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it("continues a Cursor NGHTTP2_INTERNAL_ERROR after a marked exec result", () => {
			const message = cursorMessage([execToolCall("call-1", true)], nghttp2Internal);
			const recovery = recoveryForReset(message, [realResult("call-1")]);
			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("continues a Cursor NGHTTP2_REFUSED_STREAM after a marked exec result", () => {
			const message = cursorMessage([execToolCall("call-1", true)], nghttp2Refused);
			expect(recoveryForReset(message, [realResult("call-1")]).classifyResolvedInterruptedToolTurn(message)).toBe(
				"stream-stall",
			);
		});

		it("continues a Cursor HTTP/2 reset after an unmarked MCP result", () => {
			const message = cursorMessage([mcpToolCall("mcp-1")], nghttp2Internal);
			const recovery = recoveryForReset(message, [realResult("mcp-1", "mcp__databricks_production_execute_sql")]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("continues a Cursor idle stall after an unmarked MCP call", () => {
			const message = cursorMessage([mcpToolCall("mcp-1")], stallMessage);
			const recovery = recoveryForReset(message, [realResult("mcp-1", "mcp__databricks_production_execute_sql")]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("does not continue an HTTP/2 reset whose tool call has no result", () => {
			const message = cursorMessage([execToolCall("call-1", true)], nghttp2Internal);
			expect(recoveryForReset(message, []).classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});

		it("does not continue an HTTP/2 CANCEL reset", () => {
			const message = cursorMessage([execToolCall("call-1", true)], "Stream closed with error code NGHTTP2_CANCEL");
			expect(
				recoveryForReset(message, [realResult("call-1")]).classifyResolvedInterruptedToolTurn(message),
			).toBeUndefined();
		});

		it("matches a Connect-wrapped NGHTTP2 close", () => {
			const message = cursorMessage(
				[mcpToolCall("mcp-1")],
				"Connect error failed_precondition: Error: Stream closed with error code NGHTTP2_INTERNAL_ERROR",
			);
			expect(
				recoveryForReset(message, [
					realResult("mcp-1", "mcp__databricks_production_execute_sql"),
				]).classifyResolvedInterruptedToolTurn(message),
			).toBe("stream-stall");
		});
	});

	describe("premature stream close after resolved tool calls", () => {
		const completionsClose = "OpenAI completions stream closed before a finish_reason was received";
		const responsesClose = "OpenAI responses stream closed before a terminal response event was received";

		function gatewayMessage(content: AssistantMessage["content"], errorMessage: string): AssistantMessage {
			const message = makeMessage(content, model);
			message.provider = "opencode-go";
			message.errorMessage = errorMessage;
			// Production persists the Transient flag that ProviderResponseError(kind:
			// "incomplete-stream") attaches; the bare message text classifies as 0.
			message.errorId = AIError.create(AIError.Flag.Transient);
			return message;
		}

		function recoveryForClose(message: AssistantMessage, tail: readonly AgentMessage[]): TurnRecovery {
			return new TurnRecovery(createHost(model, modelRegistry, { messages: [message as AgentMessage, ...tail] }));
		}

		it("continues a premature completions close after a resolved tool call", () => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				completionsClose,
			);
			const recovery = recoveryForClose(message, [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "Tool call was not executed." }],
					isError: true,
					details: { __synthetic: true, source: "assistant_stop_error", executed: false },
					timestamp: Date.now(),
				},
			]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("continues a premature responses close after a resolved tool call", () => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				responsesClose,
			);
			const recovery = recoveryForClose(message, [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "Tool call was not executed." }],
					isError: true,
					details: { __synthetic: true, source: "assistant_stop_error", executed: false },
					timestamp: Date.now(),
				},
			]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBe("stream-stall");
		});

		it("does not continue a premature close whose tool call has no result", () => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				completionsClose,
			);
			expect(recoveryForClose(message, []).classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});

		it("does not continue an unrelated provider error", () => {
			const message = gatewayMessage(
				[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
				"Provider returned 500 boom",
			);
			const recovery = recoveryForClose(message, [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "/workspace" }],
					isError: false,
					timestamp: Date.now(),
				},
			]);
			expect(recovery.classifyResolvedInterruptedToolTurn(message)).toBeUndefined();
		});
	});

	it("maps an ephemeral fallback hop to the default chain instead of a shared later-listed role", () => {
		const vision = getBundledModel("openai", "gpt-4o-mini");
		if (!vision) throw new Error("Expected bundled model gpt-4o-mini");
		const selector = `${model.provider}/${model.id}`;
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				lastModelChangeRole: "fallback",
				modelRoles: {
					default: selector,
					vision: selector,
				},
				fallbackChains: {
					vision: [`${vision.provider}/${vision.id}`],
					default: [`${vision.provider}/${vision.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(selector, model)).toBe("default");
	});

	it("uses the live vision role when that role shares a model with default", () => {
		const visionFallback = getBundledModel("openai", "gpt-4o-mini");
		if (!visionFallback) throw new Error("Expected bundled model gpt-4o-mini");
		const selector = `${model.provider}/${model.id}`;
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				lastModelChangeRole: "vision",
				modelRoles: {
					default: selector,
					vision: selector,
				},
				fallbackChains: {
					vision: [`${visionFallback.provider}/${visionFallback.id}`],
					default: [`${visionFallback.provider}/${visionFallback.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(selector, model)).toBe("vision");
	});

	it("ignores a recorded role whose assignment no longer matches the active model", () => {
		const vision = getBundledModel("openai", "gpt-4o-mini");
		if (!vision) throw new Error("Expected bundled model gpt-4o-mini");
		const selector = `${model.provider}/${model.id}`;
		const recovery = new TurnRecovery(
			createHost(model, modelRegistry, {
				lastModelChangeRole: "vision",
				modelRoles: {
					default: selector,
					vision: `${vision.provider}/${vision.id}`,
				},
				fallbackChains: {
					vision: [`${vision.provider}/${vision.id}`],
					default: [`${vision.provider}/${vision.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(selector, model)).toBe("default");
	});

	it("does not attach the default chain to a model that is not default's primary", () => {
		const other = getBundledModel("openai", "gpt-4o-mini");
		if (!other) throw new Error("Expected bundled model gpt-4o-mini");
		const recovery = new TurnRecovery(
			createHost(other, modelRegistry, {
				lastModelChangeRole: "fallback",
				modelRoles: {
					default: `${model.provider}/${model.id}`,
				},
				fallbackChains: {
					default: [`${model.provider}/${model.id}`],
				},
			}),
		);
		expect(recovery.resolveRetryFallbackRole(`${other.provider}/${other.id}`, other)).toBeUndefined();
	});

	// Gemini reports MALFORMED_FUNCTION_CALL when the model transcribes the call
	// as text (`call:default_api:read{…}`). The text is committed, so the replay
	// retry refuses the turn; the session must still recover by keeping the turn
	// and continuing with a corrective reminder instead of pinning the error.
	describe("malformed function call without a structured tool call", () => {
		function malformedTextTurn(): AssistantMessage {
			const message = makeMessage(
				[
					{
						type: "text",
						text: "```call:default_api:read{i:Read call_frame.rs,path:src/call_frame.rs:215-320}```",
					},
				],
				model,
			);
			message.errorMessage = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
			return message;
		}

		function continuationHost(message: AssistantMessage) {
			const messages: AgentMessage[] = [message];
			const continues: string[] = [];
			const host = createHost(model, modelRegistry, { messages });
			host.agent = {
				state: { messages },
				appendMessage: (appended: AgentMessage) => messages.push(appended),
			} as never;
			host.scheduleAgentContinue = options => continues.push(options.source);
			return { host, messages, continues };
		}

		it("continues with a corrective developer message when replay is refused", () => {
			const message = malformedTextTurn();
			const { host, messages, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.isRetryableError(message)).toBe(false);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);

			expect(messages[0]).toBe(message);
			const reminder = messages[1];
			expect(reminder?.role).toBe("developer");
			if (reminder?.role !== "developer") throw new Error("expected developer reminder");
			const text =
				typeof reminder.content === "string"
					? reminder.content
					: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
			expect(text).toContain("malformed");
			expect(text).toContain("Attempt #1/3");
			expect(continues).toEqual(["malformed-function-call-retry"]);
		});

		it("stops continuing past the per-prompt cap and resets on a new prompt", () => {
			const message = malformedTextTurn();
			const { host, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(false);
			expect(continues).toHaveLength(3);

			recovery.resetForNewPrompt();
			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(true);
		});

		it("ignores errors that are not malformed function calls", () => {
			const message = makeMessage([{ type: "text", text: "partial answer" }], model);
			message.errorMessage = "500 Internal Server Error";
			const { host, messages, continues } = continuationHost(message);
			const recovery = new TurnRecovery(host);

			expect(recovery.handleMalformedFunctionCallStop(message)).toBe(false);
			expect(messages).toHaveLength(1);
			expect(continues).toEqual([]);
		});
	});
});
