import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/** #9235: byte/media HTTP 413s must not route into token-context compaction. */

const PAYLOAD_ERROR_MESSAGE =
	"413 request body exceeds the configured payload limit (type=invalid_request_error param=request_too_large)";
const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
const TRANSIENT_ERROR_MESSAGE = "503 Service Unavailable: upstream connect error";

describe("AgentSession payload-rejection 413 handling", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const NOTICE_SOURCE = "compaction";

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
	});

	afterEach(async () => {
		await session?.dispose();
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage?.close();
	});
	async function createSession(
		contextWindow: number | null,
		seed?: { toolText: string },
		options?: {
			streamFn?: NonNullable<ConstructorParameters<typeof Agent>[0]>["streamFn"];
			extraSettings?: Parameters<typeof Settings.isolated>[0];
		},
	): Promise<void> {
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				return {
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		const model = {
			...bundled,
			contextWindow,
			maxTokens: contextWindow ? Math.min(64_000, Math.floor(contextWindow / 2)) : bundled.maxTokens,
		};

		const initialMessages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: Date.now() } as AgentMessage,
			...(seed
				? [
						{
							role: "toolResult",
							toolCallId: "call-big",
							toolName: "bash",
							content: [{ type: "text", text: seed.toolText }],
							isError: false,
							timestamp: Date.now(),
						} as AgentMessage,
					]
				: []),
		];
		for (const message of initialMessages) {
			sessionManager.appendMessage(message as never);
		}
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: initialMessages,
			},
			...(options?.streamFn ? { streamFn: options.streamFn } : {}),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
				...options?.extraSettings,
			}),
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
	}

	function collectNotices() {
		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		return notices;
	}

	function countCompactionEvents(type: "auto_compaction_start" | "auto_compaction_end") {
		let count = 0;
		session.subscribe(event => {
			if (event.type === type) count++;
		});
		return () => count;
	}

	function payloadRejectionAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: PAYLOAD_ERROR_MESSAGE,
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function statusOnlyPayloadAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorStatus: 413,
			errorMessage: "Content Too Large",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function mediaBudgetPayloadAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "request_too_large: image count exceeds the limit of 20",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function usageBackedMediaBudgetAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "request_too_large: image count exceeds the limit of 20",
			usage: {
				input: 250_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 250_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	it("honestly skips token compaction for a low-token payload-shaped 413", async () => {
		await createSession(200_000);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		const assistantMsg = payloadRejectionAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(endCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();

		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(payloadNotices[0].message).not.toContain(NO_PROGRESS_FRAGMENT);

		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	it("falls through to overflow recovery when the local gauge shows no headroom", async () => {
		await createSession(8_000, { toolText: "y".repeat(60_000) });

		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = payloadRejectionAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(startCount()).toBeGreaterThanOrEqual(1);
		expect(prepareSpy).toHaveBeenCalled();
		expect(notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413")).length).toBe(0);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("keeps genuine token-worded overflows on the normal overflow path", async () => {
		await createSession(200_000);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(startCount()).toBeGreaterThanOrEqual(1);

		expect(prepareSpy).toHaveBeenCalled();
		expect(notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413")).length).toBe(0);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("treats a payload-only 413 as terminal without a local context window", async () => {
		await createSession(null);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		const assistantMsg = payloadRejectionAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(endCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();

		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(payloadNotices[0].message).not.toContain("headroom");
		expect(payloadNotices[0].message).not.toContain(NO_PROGRESS_FRAGMENT);

		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	it("reports a usage-backed payload-shaped dead end as a token-context problem", async () => {
		await createSession(200_000, undefined, { extraSettings: { "compaction.enabled": false } });
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();

		const assistantMsg = usageBackedMediaBudgetAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();

		const deadEndNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.level === "warning");
		expect(deadEndNotices.length).toBe(1);
		expect(deadEndNotices[0].message).toContain("IS a token-context problem");
		expect(deadEndNotices[0].message).not.toContain("NOT a token-context problem");

		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	function activateOngoingGoal(id: string): void {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id,
				objective: "finish the ongoing work",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
	}

	it("consults a configured fallback chain in goal mode before any maintenance outcome stands", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "anthropic") {
					primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				}
				fallbackMock.push({ content: ["recovered on configured fallback"] });
				return fallbackMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-fallback");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(endCount()).toBe(0);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(0);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0].to).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.model?.provider).toBe(fallbackModel.provider);
	});

	it("consults a configured fallback chain for dual-flag bare-413 rejections", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "anthropic") {
					primaryMock.push({ throw: "413 status code (no body)" });
					return primaryMock.stream(model, context, options);
				}
				fallbackMock.push({ content: ["recovered on configured fallback"] });
				return fallbackMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-dual-flag-fallback");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(endCount()).toBe(0);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(0);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0].to).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.model?.provider).toBe(fallbackModel.provider);
	});

	it("routes goal-mode transient failures exactly like the non-goal ladder", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const chainMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "anthropic") {
					primaryMock.push({ throw: TRANSIENT_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				}
				chainMock.push({ content: ["recovered on configured fallback"] });
				return chainMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-transient-ladder");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels.slice(0, 2)).toEqual([
			"anthropic/claude-sonnet-4-5",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
	});

	it("keeps usage-backed payload overflows off the configured chain", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let failedOnce = false;
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				primaryMock.push(
					failedOnce
						? { content: ["made progress after compaction"] }
						: {
								content: [],
								stopReason: "error",
								errorMessage: "request_too_large: image count exceeds the limit of 20",
								usage: { input: 250_000 },
							},
				);
				failedOnce = true;
				return primaryMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-usage-backed");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});
		const startCount = countCompactionEvents("auto_compaction_start");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(fallbackEvents).toHaveLength(0);
		expect(requestedModels.every(m => m.startsWith("anthropic/"))).toBe(true);
		expect(startCount()).toBeGreaterThanOrEqual(1);
	});

	it("keeps the goal-mode BLOCK terminal when no fallback chain is configured", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
				return primaryMock.stream(model, context, options);
			},
		});
		activateOngoingGoal("goal-terminal");

		const notices = collectNotices();

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
	});
	it("does not blind-resend a transient-wrapped payload rejection before maintenance sees it", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			200_000,
			{ toolText: "seed" },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: "Provider returned error: 413 Payload Too Large" });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: { "retry.baseDelayMs": 5 },
			},
		);

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		await session.prompt("hello");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(startCount()).toBe(0);
	});
	it("consults the chain before overflow maintenance absorbs a high-occupancy payload rejection", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider === "anthropic") {
						primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
						return primaryMock.stream(model, context, options);
					}
					fallbackMock.push({ content: ["recovered on configured fallback"] });
					return fallbackMock.stream(model, context, options);
				},
				extraSettings: {
					"retry.baseDelayMs": 5,
					"retry.modelFallback": true,
					"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
					"contextPromotion.enabled": true,
					"compaction.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-high-occupancy");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});
		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		const endCount = countCompactionEvents("auto_compaction_end");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(startCount()).toBe(0);
		expect(endCount()).toBe(0);
		expect(notices.filter(n => n.source === NOTICE_SOURCE)).toHaveLength(0);
	});
	it("believes provider-reported usage when it contradicts a payload-only body", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			200_000,
			{ toolText: "seed" },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({
						stopReason: "error",
						errorMessage: PAYLOAD_ERROR_MESSAGE,
						usage: { input: 250_000 },
					});
					return primaryMock.stream(model, context, options);
				},
			},
		);
		const overflowStarts: Array<Extract<AgentSessionEvent, { type: "auto_compaction_start" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && event.reason === "overflow") overflowStarts.push(event);
		});
		const notices = collectNotices();
		await session.prompt("trigger usage-backed overflow");
		await session.waitForIdle();

		expect(requestedModels[0]).toBe("anthropic/claude-sonnet-4-5");
		expect(overflowStarts.length).toBeGreaterThanOrEqual(1);
		expect(notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"))).toHaveLength(0);
	});

	it("blocks automatic continuation when a high-occupancy payload rejection has no runnable recovery", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-no-runnable-recovery");
		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(startCount()).toBe(0);
	});
	it("persists the terminal payload 413 when an active goal dead ends", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-persist-terminal-413");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const terminalErrors = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => (entry as { message?: AssistantMessage }).message)
			.filter(message => message?.role === "assistant" && message.stopReason === "error");
		expect(terminalErrors).toHaveLength(1);
		expect(terminalErrors[0]?.errorMessage).toContain("413");
		const providerCtx = sessionManager.buildSessionContext().messages;
		expect(providerCtx.some(m => m.role === "assistant" && (m as AssistantMessage).stopReason === "error")).toBe(
			false,
		);
	});
	it("blocks dual-flag bare-413 dead ends even though overflow evidence is present", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: "413 status code (no body)" });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-dual-flag-dead-end");
		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(startCount()).toBe(0);
		const terminalErrors = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => (entry as { message?: AssistantMessage }).message)
			.filter(message => message?.role === "assistant" && message.stopReason === "error");
		expect(terminalErrors).toHaveLength(1);
		expect(terminalErrors[0]?.errorMessage).toContain("413");
		const providerCtx = sessionManager.buildSessionContext().messages;
		expect(providerCtx.some(m => m.role === "assistant" && (m as AssistantMessage).stopReason === "error")).toBe(
			false,
		);
	});

	it("persists a blocked dual-flag 413 outside goal mode", async () => {
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					primaryMock.push({ throw: "413 status code (no body)" });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);

		await session.prompt("continue normally");
		await session.waitForIdle();

		const terminalErrors = sessionManager
			.getBranch()
			.flatMap(entry => (entry.type === "message" ? [entry.message] : []))
			.filter(
				(message): message is AgentMessage & { role: "assistant" } =>
					message.role === "assistant" && message.stopReason === "error",
			);
		expect(terminalErrors).toHaveLength(1);
		expect(terminalErrors[0]?.errorMessage).toContain("413");
		const providerCtx = sessionManager.buildSessionContext().messages;
		expect(providerCtx.some(m => m.role === "assistant" && m.stopReason === "error")).toBe(false);
	});
	it("blocks status-only Content Too Large rejections with no context window", async () => {
		await createSession(null);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");

		const assistantMsg = statusOnlyPayloadAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(startCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	it("honestly skips compaction for media-budget numeric-limit rejections", async () => {
		await createSession(200_000);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");

		const assistantMsg = mediaBudgetPayloadAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(startCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});
});
