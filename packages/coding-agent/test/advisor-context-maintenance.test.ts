import { scheduler } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { calculateContextTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import { buildOpenAiNativeHistory } from "@oh-my-pi/pi-agent-core/compaction/openai";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAIResponsesHistoryPayload,
	ProviderSessionState,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as snapcompactModule from "@oh-my-pi/snapcompact";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { AdvisorContextMaintenance } from "@oh-my-pi/pi-coding-agent/advisor/context-maintenance";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const CONTEXT_WINDOW = 372_000;
const CACHE_READ_TOKENS = 371_200;
const INPUT_TOKENS = 200;
const OUTPUT_TOKENS = 150;

interface MaintenanceHarness {
	advisor: Agent;
	advisorMock: MockModel;
	primaryMock: MockModel;
	modelRegistry: ModelRegistry;
	settings: Settings;
}

interface NativeReplayFixture {
	providerPayload: OpenAIResponsesHistoryPayload;
	preserveData: NonNullable<compactionModule.CompactionResult["preserveData"]>;
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (predicate()) return;
		// Retry recovery uses a real backoff timer; yielding only microtasks can
		// exhaust an iteration cap before that timer becomes due.
		await scheduler.wait(5);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function waitForSuccessfulAdvisorCompletion(session: AgentSession, label: string): Promise<void> {
	if (!(await session.waitForAdvisorCatchup(2_000))) {
		throw new Error(`Advisor did not complete ${label}`);
	}
}
describe("AgentSession advisor context maintenance", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-context-maintenance-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function createHarness(
		contextPromotionTarget?: string,
		contextPromotionEnabled = false,
		advisorResponse = "advisor reviewed current update",
	): MaintenanceHarness {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			responses: [{ content: [advisorResponse] }],
		});
		Object.assign(advisorMock, { contextPromotionTarget });
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.thresholdTokens": 95_000,
			"compaction.methodOrder": ["soft"],
			"contextPromotion.enabled": contextPromotionEnabled,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorMock);
		// Keep maintenance on the no-summary recovery branch without blocking the
		// primary prompt's own credential preflight.
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model =>
			model === primaryMock ? "test-key" : undefined,
		);
		return { advisor, advisorMock, primaryMock, modelRegistry, settings };
	}

	function usageAnchor(advisorMock: MockModel, timestamp: number, cost = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "prior advisor output" }],
			api: advisorMock.api,
			provider: advisorMock.provider,
			model: advisorMock.id,
			usage: {
				input: INPUT_TOKENS,
				output: OUTPUT_TOKENS,
				cacheRead: CACHE_READ_TOKENS,
				cacheWrite: 0,
				totalTokens: CACHE_READ_TOKENS + INPUT_TOKENS + OUTPUT_TOKENS,
				cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop",
			timestamp,
		};
	}

	function nativeReplay(provider: string): NativeReplayFixture {
		const compactionItem = { type: "compaction", encrypted_content: "advisor-native-state" };
		const replacementHistory = [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "native-retained-decision" }],
			},
			compactionItem,
		];
		return {
			providerPayload: { type: "openaiResponsesHistory", provider, items: replacementHistory },
			preserveData: { openaiRemoteCompaction: { provider, replacementHistory, compactionItem } },
		};
	}

	function seedCompactionJournalOnFirstAdmission(
		advisor: Agent,
		before: AgentMessage[],
		tail: AgentMessage[],
		options: {
			summary: string;
			preserveData?: Record<string, unknown>;
			method?: "remote" | "soft";
			providerReplay?: boolean;
			after?: AgentMessage[];
		},
	): void {
		advisor.replaceMessages([]);
		const original = AdvisorContextMaintenance.prototype.maintainBeforePrompt;
		const admissionSpy = vi
			.spyOn(AdvisorContextMaintenance.prototype, "maintainBeforePrompt")
			.mockImplementation(async function (
				this: AdvisorContextMaintenance,
				incoming: AgentMessage[],
				signal: AbortSignal,
			) {
				admissionSpy.mockRestore();
				for (const message of before) this.recordFinalized(message);
				const replayBoundary = this.journal.getBranch().findLast(entry => entry.type === "message");
				if (!replayBoundary) throw new Error("Expected a real advisor replay boundary");
				for (const message of tail) this.recordFinalized(message);
				const messageEntries = this.journal.getBranch().filter(entry => entry.type === "message");
				const firstKeptEntry = tail.length > 0 ? messageEntries[before.length] : replayBoundary;
				if (!firstKeptEntry) throw new Error("Expected a real advisor keep boundary");
				this.journal.appendCompaction(options.summary, undefined, firstKeptEntry.id, CACHE_READ_TOKENS, {
					method: options.method ?? "remote",
					preserveData: options.preserveData,
					providerReplayThroughEntryId: options.providerReplay ? replayBoundary.id : undefined,
				});
				for (const message of options.after ?? []) this.recordFinalized(message);
				advisor.replaceMessages(this.journal.buildSessionContext().messages);
				await original.call(this, incoming, signal);
			});
	}

	function seedNativeReplayOnFirstAdmission(
		advisor: Agent,
		advisorMock: MockModel,
		provider: string,
		postCompaction: AgentMessage[] = [
			{ role: "user", content: "older post-compaction advisor turn", timestamp: Date.now() - 4_000 },
			usageAnchor(advisorMock, Date.now() - 3_000),
			{ role: "user", content: "latest post-compaction advisor turn", timestamp: Date.now() - 2_000 },
			usageAnchor(advisorMock, Date.now() - 1_000),
		],
	): NativeReplayFixture {
		const replay = nativeReplay(provider);
		seedCompactionJournalOnFirstAdmission(
			advisor,
			[{ role: "user", content: "raw pre-compaction advisor decision", timestamp: Date.now() - 5_000 }],
			[{ role: "user", content: "retained native advisor boundary", timestamp: Date.now() - 4_500 }],
			{
				summary: "bounded advisor summary",
				preserveData: replay.preserveData,
				providerReplay: true,
				after: postCompaction,
			},
		);
		return replay;
	}

	function createAdvisorFallbackHarness(options?: {
		sameProviderNativeEnabled?: boolean;
		contextPromotionEnabled?: boolean;
		remoteEnabled?: boolean;
	}) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "openai",
			responses: [{ content: ["advisor reviewed current update"] }],
		});
		const nativeModel = getBundledModel("openai", "gpt-5");
		const sameProviderBase = getBundledModel("openai", "gpt-5-mini");
		const sameProviderModel =
			sameProviderBase && options?.sameProviderNativeEnabled === false
				? { ...sameProviderBase, remoteCompaction: { ...sameProviderBase.remoteCompaction, enabled: false } }
				: sameProviderBase;
		const crossProviderModel = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");
		if (!nativeModel || !sameProviderModel || !crossProviderModel) {
			throw new Error("Expected bundled compaction models");
		}

		authStorage.setRuntimeApiKey(nativeModel.provider, "openai-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": options?.remoteEnabled === false ? ["soft"] : ["remote", "soft"],
			"contextPromotion.enabled": options?.contextPromotionEnabled ?? false,
		});
		settings.setModelRole("advisor", `${nativeModel.provider}/${nativeModel.id}`);
		settings.setModelRole("smol", `${sameProviderModel.provider}/${sameProviderModel.id}`);
		settings.setModelRole("slow", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(nativeModel);
		const apiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([nativeModel, sameProviderModel, crossProviderModel]);
		advisor.state.messages.push(
			{ role: "user", content: "older advisor decision", timestamp: Date.now() - 4_000 },
			usageAnchor(advisorMock, Date.now() - 3_000),
			{ role: "user", content: "recent advisor decision", timestamp: Date.now() - 2_000 },
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		return {
			advisor,
			advisorMock,
			primaryMock,
			apiKeySpy,
			crossProviderModel,
			nativeModel,
			sameProviderModel,
			settings,
		};
	}

	it("keeps working history when threshold maintenance has no usable compaction credentials", async () => {
		const { advisor, advisorMock, settings } = createHarness();
		const anchor = usageAnchor(advisorMock, Date.now() - 1_000, 0.5);
		advisor.emitExternalEvent({ type: "message_end", message: anchor });
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);

		await session.prompt("small current update");

		expect(advisorMock.calls).toHaveLength(1);
		const advisorCall = advisorMock.calls[0];
		const update = advisorCall.context.messages.find(message => message.role === "user");
		if (!update) throw new Error("Expected the advisor's incremental update");
		const threshold = resolveThresholdTokens(CONTEXT_WINDOW, settings.getGroup("compaction"));
		const providerAndUpdateTokens =
			calculateContextTokens(anchor.usage) + advisor.tokenizer.countMessage(update as AgentMessage);
		expect(calculateContextTokens(anchor.usage)).toBe(CACHE_READ_TOKENS + INPUT_TOKENS + OUTPUT_TOKENS);
		expect(providerAndUpdateTokens).toBeGreaterThan(threshold);

		// An unsuccessful maintenance attempt is not a lifecycle reset. The active
		// review proceeds with the admitted update and its prior working history.
		expect(JSON.stringify(advisorCall.context.messages)).toContain("small current update");
		expect(JSON.stringify(advisorCall.context.messages)).toContain("prior advisor output");
		expect(JSON.stringify(advisor.state.messages)).toContain("prior advisor output");
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
	});

	it("restores an advisor-owned provider session after failure without clearing primary provider state", async () => {
		const { advisor, advisorMock, primaryMock } = createHarness();
		session.settings.set("retry.enabled", true);
		session.settings.set("retry.maxRetries", 1);
		session.settings.set("retry.baseDelayMs", 0);

		await session.prompt("establish advisor history before a failed attempt");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		const advisorProviderState = advisorMock.calls[0]?.options?.providerSessionState;
		if (!advisorProviderState) throw new Error("Expected advisor-owned provider session state");

		const advisorClose = vi.fn();
		const advisorState = { close: advisorClose } satisfies ProviderSessionState;
		advisorProviderState.set("advisor-live-provider-session", advisorState);
		const primaryClose = vi.fn();
		const primaryState = { close: primaryClose } satisfies ProviderSessionState;
		session.providerSessionState.set("primary-live-provider-session", primaryState);
		primaryMock.push({ content: ["second primary complete"] });
		advisorMock.push({
			content: [],
			stopReason: "error",
			errorMessage: "503 Service Unavailable",
		});
		advisorMock.push({ content: ["advisor recovered without replaying the failed assistant"] });

		await session.prompt("review through one transient failed advisor attempt");
		await waitForCondition(() => advisorMock.calls.length >= 3, "advisor retry completion");

		expect(advisorMock.calls.length).toBeGreaterThanOrEqual(3);
		expect(advisorClose).toHaveBeenCalledTimes(1);
		expect(advisorProviderState.has("advisor-live-provider-session")).toBe(false);
		expect(session.providerSessionState.get("primary-live-provider-session")).toBe(primaryState);
		expect(primaryClose).not.toHaveBeenCalled();
		const recoveryRequest = JSON.stringify(advisorMock.calls.at(-1)!.context.messages);
		expect(recoveryRequest).not.toContain("503 Service Unavailable");
		expect(
			advisor.state.messages.filter(message => message.role === "assistant" && message.stopReason === "error"),
		).toHaveLength(0);
	});
	it.each([
		{ branch: "headroom-413", usage: 5_000, partial: false, expectsFallback: true },
		{ branch: "definitive-overflow", usage: 2_000_000, partial: false, expectsFallback: false },
		{ branch: "replay-unsafe-413", usage: 5_000, partial: true, expectsFallback: false },
	] as const)(
		"arbitrates $branch before context recovery and leaves a terminal review eligible for later updates",
		async ({ branch, usage, partial, expectsFallback }) => {
			const advisorPrimary = getBundledModel("anthropic", "claude-sonnet-4-5");
			const advisorFallback = getBundledModel("google", "gemini-2.5-flash");
			if (!advisorPrimary || !advisorFallback) throw new Error("Expected bundled advisor fallback models");
			const primaryMock = createMockModel({
				provider: "anthropic",
				responses: [{ content: ["primary one"] }, { content: ["primary two"] }],
			});
			const advisorWire = createMockModel();
			const requested: string[] = [];
			let advisorPrimaryAttempts = 0;
			const primarySelector = `${advisorPrimary.provider}/${advisorPrimary.id}`;
			const fallbackSelector = `${advisorFallback.provider}/${advisorFallback.id}`;
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"advisor.syncBacklog": "1",
				"compaction.enabled": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"retry.fallbackChains": { advisor: [fallbackSelector] },
			});
			settings.setModelRole("advisor", primarySelector);
			vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisorPrimary, advisorFallback]);
			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model: primaryMock, systemPrompt: [], tools: [] },
					streamFn: primaryMock.stream,
				}),
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				advisorTools: [],
				advisorStreamFn: (model, context, options) => {
					const selector = `${model.provider}/${model.id}`;
					requested.push(selector);
					if (selector === fallbackSelector) {
						advisorWire.push({ content: ["advisor recovered on configured fallback"] });
					} else if (advisorPrimaryAttempts++ === 0) {
						advisorWire.push({
							content: partial
								? [{ type: "toolCall", id: "unsafe-call", name: "read", arguments: { path: "unsafe.ts" } }]
								: [],
							stopReason: "error",
							errorMessage: "413 Request Entity Too Large",
							usage: { input: usage },
						});
					} else {
						advisorWire.push({ content: ["later advisor update remained eligible"] });
					}
					return advisorWire.stream(model, context, options);
				},
			});
			expect(session.setAdvisorEnabled(true)).toBe(true);

			await session.prompt(`first ${branch} update`);
			await waitForCondition(() => requested.length >= (expectsFallback ? 2 : 1), `${branch} terminal disposition`);
			if (expectsFallback) {
				expect(requested).toEqual([primarySelector, fallbackSelector]);
				expect(session.getAdvisorAgent()?.state.model.id).toBe(advisorFallback.id);
				const fallbackRequest = JSON.stringify(advisorWire.calls.at(-1)!.context.messages);
				expect(fallbackRequest.match(/first headroom-413 update/g)).toHaveLength(1);
				expect(JSON.stringify(session.getAdvisorAgent()?.state.messages)).toContain(
					"advisor recovered on configured fallback",
				);
			} else {
				expect(requested).toEqual([primarySelector]);
				await session.prompt(`later update after ${branch}`);
				await waitForCondition(() => requested.length >= 2, `${branch} later advisor request`);
				expect(requested).toEqual([primarySelector, primarySelector]);
				const laterRequest = JSON.stringify(advisorWire.calls.at(-1)!.context.messages);
				expect(laterRequest).toContain(`later update after ${branch}`);
			}
		},
	);

	it("ignores late context-promotion credentials after a session transition", async () => {
		const promotion = createMockModel({
			id: "advisor-promotion-target",
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW + 1,
		});
		const { advisor, advisorMock, modelRegistry } = createHarness(`${promotion.provider}/${promotion.id}`, true);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisor.state.model, promotion]);
		const credentialStarted = Promise.withResolvers<void>();
		const credentialAborted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const credentialReturned = Promise.withResolvers<void>();
		let credentialSignal: AbortSignal | undefined;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, _sessionId, options) => {
			if (model === promotion) {
				const requestSignal = options?.signal;
				credentialSignal ??= requestSignal;
				credentialStarted.resolve();
				requestSignal?.addEventListener("abort", () => credentialAborted.resolve(), { once: true });
				await releaseCredential.promise;
				credentialReturned.resolve();
			}
			return "test-key";
		});
		advisor.state.messages.push(
			{ role: "user", content: "promotion-eligible older turn", timestamp: Date.now() - 4_000 },
			usageAnchor(advisorMock, Date.now() - 3_000),
			{ role: "user", content: "promotion-eligible recent turn", timestamp: Date.now() - 2_000 },
			usageAnchor(advisorMock, Date.now() - 1_000),
		);

		const prompt = session.prompt("trigger advisor context promotion");
		try {
			await credentialStarted.promise;
			const transition = session.newSession();
			await credentialAborted.promise;
			expect(credentialSignal?.aborted).toBe(true);
			releaseCredential.resolve();
			await Promise.all([transition, credentialReturned.promise, prompt]);
		} finally {
			releaseCredential.resolve();
		}
		expect(credentialSignal?.aborted).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(advisorMock.id);
	});

	it("includes advisor system prompt and tool schemas in the local maintenance floor", async () => {
		const { advisor, advisorMock, modelRegistry } = createHarness();
		session.settings.set("compaction.keepRecentTokens", 1);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		const oldAssistant = usageAnchor(advisorMock, 2);
		oldAssistant.usage = {
			...oldAssistant.usage,
			input: 0,
			output: 0,
			cacheRead: 0,
			totalTokens: 0,
		};
		const stored: AgentMessage[] = [
			{ role: "user", content: "small archived advisor message", timestamp: 1 },
			oldAssistant,
			{ role: "user", content: "small retained advisor message", timestamp: 3 },
		];
		advisor.state.messages.push(...stored);
		const storedTokens = advisor.tokenizer.countMessages(stored, { excludeEncryptedReasoning: true });
		const fixedPrefixTokens =
			advisor.tokenizer.countTokens(advisor.state.systemPrompt) +
			estimateToolSchemaTokens(advisor.state.tools, advisor.tokenizer);
		const threshold = storedTokens + Math.floor(fixedPrefixTokens / 2);
		session.settings.override("compaction.thresholdTokens", threshold);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "LOCAL-FLOOR-REWRITE",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await session.prompt("tiny local-floor update");
		await waitForSuccessfulAdvisorCompletion(session, "local-floor maintenance review");

		const advisorCall = advisorMock.calls.at(-1)!;
		const update = advisorCall.context.messages.find(
			message => message.role === "user" && JSON.stringify(message.content).includes("tiny local-floor update"),
		);
		if (!update) throw new Error("Expected the advisor's incremental update");
		const messagesOnlyTokens = storedTokens + advisor.tokenizer.countMessage(update as AgentMessage);
		expect(messagesOnlyTokens).toBeLessThan(threshold);
		expect(messagesOnlyTokens + fixedPrefixTokens).toBeGreaterThan(threshold);
		expect(JSON.stringify(advisorCall.context.messages)).toContain("LOCAL-FLOOR-REWRITE");
	});

	it("ignores retained provider usage that predates the latest advisor compaction", async () => {
		const { advisor, advisorMock } = createHarness();
		const retained = usageAnchor(advisorMock, Date.now() - 1_000);
		retained.content = [{ type: "text", text: "retained pre-compaction output" }];
		seedCompactionJournalOnFirstAdmission(
			advisor,
			[{ role: "user", content: "summarized advisor history", timestamp: Date.now() - 2_000 }],
			[{ role: "user", content: "retained advisor boundary", timestamp: Date.now() - 1_500 }, retained],
			{ summary: "bounded advisor summary", method: "soft" },
		);

		await session.prompt("post-compaction update");

		expect(advisorMock.calls).toHaveLength(1);
		const sentContext = JSON.stringify(advisorMock.calls[0].context.messages);
		expect(sentContext).toContain("retained pre-compaction output");
		expect(sentContext).toContain("post-compaction update");
	});

	it("recognizes equal-timestamp usage after the boundary without resetting on unavailable maintenance", async () => {
		const { advisor, advisorMock, modelRegistry } = createHarness();
		const compactedAt = Date.now();
		const retained = usageAnchor(advisorMock, compactedAt);
		retained.content = [{ type: "text", text: "retained pre-compaction output" }];
		const fresh = usageAnchor(advisorMock, compactedAt);
		fresh.content = [{ type: "text", text: "fresh post-compaction output" }];
		seedCompactionJournalOnFirstAdmission(
			advisor,
			[{ role: "user", content: "summarized advisor history", timestamp: compactedAt - 1 }],
			[{ role: "user", content: "retained advisor boundary", timestamp: compactedAt }, retained],
			{ summary: "bounded advisor summary", method: "soft", after: [fresh] },
		);

		await session.prompt("equal-timestamp post-compaction update");

		expect(advisorMock.calls).toHaveLength(1);
		const sentContext = JSON.stringify(advisorMock.calls[0].context.messages);
		expect(sentContext).toContain("equal-timestamp post-compaction update");
		expect(sentContext).toContain("retained pre-compaction output");
		expect(sentContext).toContain("fresh post-compaction output");
		expect(modelRegistry.getApiKey).toHaveBeenCalledWith(advisor.state.model, expect.any(String));
	});

	it("discards a valid compaction result returned after cancellation without fallback or re-prime", async () => {
		// Regression for #6625 review: advisor overflow compaction issues a direct
		// `compact(...)` request that bypasses the advisor `Agent`, so the metadata
		// resolver installed on the agent never runs for it. The direct call must
		// still emit the advisor's `metadata.user_id` session identity.
		// The advisor model is the first compaction candidate; registering the mock
		// API lets the compaction one-shot's `completeSimple` route to it so the
		// summarization request actually reaches the mock (and its recorded calls).
		registerMockApi();
		const compactionStarted = Promise.withResolvers<void>();
		const compactionAborted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		let compactionSignal: AbortSignal | undefined;
		let fallbackCalls = 0;
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			handler: async (context, options) => {
				if (!JSON.stringify(context.messages).includes("<conversation>")) {
					return { content: ["advisor reviewed current update"] };
				}
				compactionStarted.resolve();
				compactionSignal = options?.signal;
				if (!compactionSignal) throw new Error("Expected compaction abort signal");
				compactionSignal.addEventListener("abort", () => compactionAborted.resolve(), { once: true });
				await releaseCompaction.promise;
				return { content: ["bounded advisor summary"] };
			},
		});
		const fallbackMock = createMockModel({
			id: "advisor-compaction-fallback",
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			handler: () => {
				fallbackCalls++;
				return { content: ["unexpected fallback"] };
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 95_000,
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": ["soft"],
			"contextPromotion.enabled": false,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor?.sessionId) throw new Error("Expected advisor agent with a provider session id");
		const advisorSessionId = advisor.sessionId;
		advisor.setModel(advisorMock);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisorMock, fallbackMock]);
		// Unlike the recovery-branch harness, the advisor holds usable credentials
		// so maintenance runs the LLM summarization compaction path.
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		// Two accumulated turns so compaction has older history to summarize while
		// retaining the most recent one (a single message would be fully retained,
		// making compaction a no-op).
		advisor.state.messages.push(
			{ role: "user", content: "older compaction turn", timestamp: Date.now() - 4_000 },
			usageAnchor(advisorMock, Date.now() - 3_000),
			{ role: "user", content: "recent compaction turn", timestamp: Date.now() - 2_000 },
			usageAnchor(advisorMock, Date.now() - 1_000),
		);

		const prompt = session.prompt("small current update");
		try {
			await compactionStarted.promise;
			const transition = session.newSession();
			let promptSettled = false;
			let transitionSettled = false;
			const promptCompletion = prompt.finally(() => {
				promptSettled = true;
			});
			const transitionCompletion = transition.finally(() => {
				transitionSettled = true;
			});
			await compactionAborted.promise;
			expect(compactionSignal?.aborted).toBe(true);
			releaseCompaction.resolve();
			await waitForCondition(() => promptSettled, "cancelled advisor prompt completion");
			await waitForCondition(() => transitionSettled, "advisor session transition completion");
			await Promise.all([promptCompletion, transitionCompletion]);
		} finally {
			releaseCompaction.resolve();
			await prompt;
		}

		// A summarization compaction one-shot actually ran (its prompt wraps the
		// conversation in <conversation> tags).
		const compactionCalls = advisorMock.calls.filter(call =>
			JSON.stringify(call.context.messages).includes("<conversation>"),
		);
		expect(compactionCalls.length).toBeGreaterThan(0);
		expect(compactionCalls.every(call => call.options?.signal instanceof AbortSignal)).toBe(true);
		expect(JSON.stringify(session.getAdvisorAgent()?.state.messages)).not.toContain("bounded advisor summary");
		expect(advisor.state.messages.some(message => message.role === "compactionSummary")).toBe(false);
		expect(JSON.stringify(advisor.state.messages)).not.toContain("bounded advisor summary");
		expect(fallbackCalls).toBe(0);

		// Every advisor request — the compaction one-shot and the advisor turn —
		// carries the advisor's own provider session id via metadata.user_id.
		for (const call of advisorMock.calls) {
			const userId = call.options?.metadata?.user_id;
			if (typeof userId !== "string") throw new Error("Expected advisor metadata.user_id");
			expect((JSON.parse(userId) as { session_id?: string }).session_id).toBe(advisorSessionId);
		}
	});

	it.each([true, false])(
		"replays consecutive native compactions when the reader's native endpoint is enabled=%s",
		async readerNativeEnabled => {
			const { advisor, advisorMock, primaryMock, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
			const writer = {
				...sameProviderModel,
				remoteCompaction: { ...sameProviderModel.remoteCompaction, v2StreamingEnabled: false },
			};
			advisor.setModel({
				...nativeModel,
				remoteCompaction: {
					...nativeModel.remoteCompaction,
					enabled: readerNativeEnabled,
					v2StreamingEnabled: false,
				},
				compactionModel: `${writer.provider}/${writer.id}`,
			});
			vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([advisor.state.model, writer]);
			session.settings.set("compaction.keepRecentTokens", 1);
			const retained = advisor.state.messages.at(-1);
			if (retained?.role !== "assistant") throw new Error("Expected retained advisor output");
			retained.content = [{ type: "text", text: "retained-advisor-boundary" }];
			const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
			const fetchFixture = asGlobalFetch(async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
				const output =
					requests.length === 1
						? [
								{
									type: "message",
									role: "user",
									content: [{ type: "input_text", text: "archived-advisor-decision" }],
								},
								{
									type: "message",
									role: "assistant",
									content: [{ type: "output_text", text: "retained-advisor-boundary" }],
								},
								{ type: "compaction", encrypted_content: "advisor-replay-1" },
							]
						: [{ type: "compaction", encrypted_content: "advisor-replay-2" }];
				return new Response(JSON.stringify({ output }));
			});
			vi.spyOn(globalThis, "fetch").mockImplementation(fetchFixture);

			await session.prompt("first update after native maintenance");
			await waitForSuccessfulAdvisorCompletion(session, "first native maintenance review");
			const firstInput = JSON.stringify(
				buildParams(
					advisor.state.model as Model<"openai-responses">,
					advisorMock.calls.at(-1)!.context,
					undefined,
					undefined,
				).params.input,
			);
			expect(firstInput).toContain("archived-advisor-decision");
			expect(firstInput.match(/retained-advisor-boundary/g)).toHaveLength(1);
			expect(firstInput.match(/advisor-replay-1/g)).toHaveLength(1);

			primaryMock.push({ content: ["second primary update complete"] });
			advisorMock.push({ content: ["second advisor review complete"] });
			advisor.state.messages.push(usageAnchor(advisorMock, Date.now()));
			await session.prompt("second update after native maintenance");
			await waitForSuccessfulAdvisorCompletion(session, "second native maintenance review");
			expect(requests).toHaveLength(2);
			const secondCompactionInput = JSON.stringify(requests[1].input);
			expect(secondCompactionInput).toContain("archived-advisor-decision");
			expect(secondCompactionInput.match(/retained-advisor-boundary/g)).toHaveLength(1);
			expect(secondCompactionInput.match(/advisor-replay-1/g)).toHaveLength(1);
			const secondInput = JSON.stringify(
				buildParams(
					advisor.state.model as Model<"openai-responses">,
					advisorMock.calls.at(-1)!.context,
					undefined,
					undefined,
				).params.input,
			);
			expect(secondInput.match(/advisor-replay-2/g)).toHaveLength(1);
			expect(secondInput).not.toContain("advisor-replay-1");
			expect(secondInput).not.toContain("prior advisor output");
		},
	);

	it.each(["anthropic", "openai"])(
		"uses a portable summary when an %s Anthropic-API advisor targets native OpenAI compaction",
		async provider => {
			registerMockApi();
			const { advisor, advisorMock, modelRegistry } = createHarness();
			const summarizer = createMockModel({
				id: "foreign-native-summarizer",
				provider: "openai",
				handler: () => ({ content: ["portable archived decision"] }),
			});
			Object.assign(summarizer, { remoteCompaction: { enabled: true, v2StreamingEnabled: false } });
			const active: Model<"anthropic-messages"> = {
				...getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5"),
				provider,
				contextWindow: CONTEXT_WINDOW,
				compactionModel: `${summarizer.provider}/${summarizer.id}`,
			};
			advisor.setModel(active);
			session.settings.set("compaction.keepRecentTokens", 1);
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([active, summarizer]);
			vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
			advisor.state.messages.push(
				{ role: "user", content: "archived readable decision", timestamp: Date.now() - 3_000 },
				usageAnchor(advisorMock, Date.now() - 2_000),
				{ role: "user", content: "retained-readable-tail", timestamp: Date.now() - 1_000 },
			);
			vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async () =>
					Response.json({
						output: [
							{
								type: "message",
								role: "user",
								content: [{ type: "input_text", text: "retained-readable-tail" }],
							},
							{ type: "compaction", encrypted_content: "unreadable-native-state" },
						],
					}),
				),
			);

			await session.prompt("review after foreign-target maintenance");
			await waitForSuccessfulAdvisorCompletion(session, "foreign-target maintenance review");

			const wire = JSON.stringify(
				convertAnthropicMessages(advisorMock.calls.at(-1)!.context.messages, active, false),
			);
			expect(wire).toContain("portable archived decision");
			expect(wire.match(/retained-readable-tail/g)).toHaveLength(1);
			expect(JSON.stringify(summarizer.calls[0].context.messages)).toContain("archived readable decision");
			expect(advisor.state.model.id).toBe(active.id);
		},
	);

	it("chooses compaction for the effective model after a promotion still overflows", async () => {
		registerMockApi();
		const { advisor, advisorMock, nativeModel, crossProviderModel, apiKeySpy } = createAdvisorFallbackHarness({
			contextPromotionEnabled: true,
		});
		const summarizer = createMockModel({
			id: "promoted-model-summarizer",
			provider: "openai",
			handler: () => ({ content: ["portable promoted-model summary"] }),
		});
		Object.assign(summarizer, { remoteCompaction: { enabled: true, v2StreamingEnabled: false } });
		const promoted = {
			...crossProviderModel,
			contextWindow: 200_000,
			compactionModel: `${summarizer.provider}/${summarizer.id}`,
		};
		const active = {
			...nativeModel,
			contextWindow: 100_000,
			contextPromotionTarget: `${promoted.provider}/${promoted.id}`,
			remoteCompaction: { ...nativeModel.remoteCompaction, v2StreamingEnabled: false },
		};
		advisor.setModel(active);
		session.settings.set("compaction.keepRecentTokens", 1);
		apiKeySpy.mockResolvedValue("test-key");
		vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([active, promoted, summarizer]);
		advisor.state.messages.push({ role: "user", content: "post-promotion-retained-tail", timestamp: Date.now() });
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () =>
				Response.json({ output: [{ type: "compaction", encrypted_content: "stale-model" }] }),
			),
		);

		await session.prompt("promote and compact the advisor");
		await waitForSuccessfulAdvisorCompletion(session, "promoted maintenance review");

		expect(advisor.state.model.id).toBe(promoted.id);
		const wire = JSON.stringify(
			convertAnthropicMessages(advisorMock.calls.at(-1)!.context.messages, promoted, false),
		);
		expect(wire).toContain("portable promoted-model summary");
		expect(wire.match(/post-promotion-retained-tail/g)).toHaveLength(1);
	});

	it.each(["foreign", "enabled", "remote-disabled", "model-disabled"])(
		"preserves native replay across a context promotion with %s compaction",
		async policy => {
			const compatible = policy !== "foreign";
			const { advisor, advisorMock, nativeModel, crossProviderModel, sameProviderModel } =
				createAdvisorFallbackHarness({
					contextPromotionEnabled: true,
					remoteEnabled: policy !== "remote-disabled",
					sameProviderNativeEnabled: policy !== "model-disabled",
				});
			const target = { ...(compatible ? sameProviderModel : crossProviderModel), contextWindow: 1_000_000 };
			const active = {
				...nativeModel,
				contextPromotionTarget: `${target.provider}/${target.id}`,
				remoteCompaction: { ...nativeModel.remoteCompaction, v2StreamingEnabled: false },
				compactionModel: `${target.provider}/${target.id}`,
			};
			advisor.setModel(active);
			const replay = seedNativeReplayOnFirstAdmission(advisor, advisorMock, nativeModel.provider);
			vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([active, target]);
			const compactionRequests: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(
				asGlobalFetch(async (_url, init) => {
					compactionRequests.push(String(init?.body));
					return Response.json({ output: replay.providerPayload.items });
				}),
			);

			await session.prompt("review after native context promotion");
			await waitForSuccessfulAdvisorCompletion(session, "native promotion review");

			expect(advisor.state.model.id).toBe(compatible ? target.id : active.id);
			const wire = JSON.stringify(
				buildParams(
					advisor.state.model as Model<"openai-responses">,
					advisorMock.calls.at(-1)!.context,
					undefined,
					undefined,
				).params.input,
			);
			expect(wire.match(/native-retained-decision/g)).toHaveLength(1);
			expect(wire.match(/advisor-native-state/g)).toHaveLength(1);
			if (!compatible) {
				expect(compactionRequests).toHaveLength(1);
				expect(compactionRequests[0].match(/advisor-native-state/g)).toHaveLength(1);
			} else {
				expect(compactionRequests).toHaveLength(0);
			}
		},
	);

	it("recovers native history through the working journal for an authenticated portable summarizer", async () => {
		const { advisor, advisorMock, nativeModel, crossProviderModel, apiKeySpy } = createAdvisorFallbackHarness();
		seedNativeReplayOnFirstAdmission(advisor, advisorMock, nativeModel.provider);
		session.settings.setModelRole("smol", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		apiKeySpy.mockImplementation(async model => (model.provider === "openai" ? undefined : "test-key"));
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "portable recovered native history",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await session.prompt("attempt maintenance with no native credentials");
		await waitForSuccessfulAdvisorCompletion(session, "portable native-history recovery review");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(compactSpy.mock.calls[0]?.[0].messagesToSummarize)).toContain(
			"raw pre-compaction advisor decision",
		);
		expect(JSON.stringify(advisorMock.calls.at(-1)!.context.messages)).toContain("portable recovered native history");
	});

	it.each(["remote-disabled", "model-disabled", "incompatible-native-result"])(
		"retains opaque history when native maintenance is %s",
		async policy => {
			const { advisor, advisorMock, nativeModel, sameProviderModel } = createAdvisorFallbackHarness({
				remoteEnabled: policy !== "remote-disabled",
				sameProviderNativeEnabled: false,
			});
			const active = {
				...nativeModel,
				remoteCompaction: { ...nativeModel.remoteCompaction, enabled: policy !== "model-disabled" },
			};
			advisor.setModel(active);
			vi.spyOn(session.modelRegistry, "getAvailable").mockReturnValue([active, sameProviderModel]);
			seedNativeReplayOnFirstAdmission(advisor, advisorMock, active.provider);
			const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "placeholder-only summary discarded the native history",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				preserveData: policy === "incompatible-native-result" ? nativeReplay("anthropic").preserveData : undefined,
			}));

			await session.prompt("review despite unavailable native maintenance");
			await waitForSuccessfulAdvisorCompletion(session, "opaque native maintenance review");

			if (policy === "incompatible-native-result") {
				expect(compactSpy).toHaveBeenCalled();
				const liveHistory = JSON.stringify(advisor.state.messages);
				expect(liveHistory).toContain("advisor-native-state");
				expect(liveHistory).not.toContain("placeholder-only summary");
			} else {
				expect(compactSpy).toHaveBeenCalledTimes(1);
				expect(JSON.stringify(compactSpy.mock.calls[0]?.[0].messagesToSummarize)).toContain(
					"raw pre-compaction advisor decision",
				);
				expect(JSON.stringify(advisorMock.calls.at(-1)!.context.messages)).toContain(
					"placeholder-only summary discarded the native history",
				);
			}
		},
	);

	it("keeps native compaction state in the working journal rather than private summary metadata", async () => {
		const { advisor, advisorMock, nativeModel } = createAdvisorFallbackHarness({ remoteEnabled: false });
		const replay = nativeReplay(nativeModel.provider);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "journal-backed native replacement",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			preserveData: replay.preserveData,
		}));

		await session.prompt("install a native replacement");
		await waitForSuccessfulAdvisorCompletion(session, "native replacement installation");

		const summary = advisor.state.messages.find(message => message.role === "compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected installed advisor summary");
		expect(summary).not.toHaveProperty("preserveData");
		const firstWire = JSON.stringify(
			buildOpenAiNativeHistory(advisorMock.calls.at(-1)!.context.messages, nativeModel),
		);
		expect(firstWire.match(/advisor-native-state/g)).toHaveLength(1);

		advisorMock.push({ content: ["second advisor review"] });
		await session.prompt("replay the journal-backed native replacement");
		await waitForSuccessfulAdvisorCompletion(session, "native replacement replay");
		const secondWire = JSON.stringify(
			buildOpenAiNativeHistory(advisorMock.calls.at(-1)!.context.messages, nativeModel),
		);
		expect(secondWire.match(/advisor-native-state/g)).toHaveLength(1);
	});

	it("continues same-provider advisor candidates but stops before crossing providers on non-auth failure", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider || model.provider === sameProviderModel.provider) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "cross-provider summary",
				shortSummary: "cross-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});

		await session.prompt("small current update");
		await waitForSuccessfulAdvisorCompletion(session, "native failure boundary review");

		const attempted = compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`);
		expect(attempted.slice(0, 2)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(attempted).not.toContain(`${crossProviderModel.provider}/${crossProviderModel.id}`);
		expect(JSON.stringify(advisor.state.messages)).toContain("prior advisor output");
	});

	it("applies a successful same-provider native advisor fallback", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider && model.id === nativeModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				return {
					summary: "same-provider native summary",
					shortSummary: "same-provider native",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					preserveData: nativeReplay(model.provider).preserveData,
				};
			}
			throw new Error(
				`Unexpected cross-provider compaction ${crossProviderModel.provider}/${crossProviderModel.id}`,
			);
		});

		await session.prompt("small current update");
		await waitForSuccessfulAdvisorCompletion(session, "same-provider native fallback review");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		// Provider-native compaction re-issues the advisor's own request, so
		// every candidate receives the advisor's live system prompt.
		expect(advisor.state.systemPrompt.length).toBeGreaterThan(0);
		for (const call of compactSpy.mock.calls) {
			expect(call[5]?.remoteSystemPrompt).toEqual(advisor.state.systemPrompt);
		}
		expect(JSON.stringify(advisor.state.messages)).toContain("same-provider native summary");
	});

	it("skips unauthenticated advisor candidates before enforcing the native boundary", async () => {
		const { advisor, apiKeySpy, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
		session.settings.setModelRole("smol", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		session.settings.setModelRole("slow", `${sameProviderModel.provider}/${sameProviderModel.id}`);
		apiKeySpy.mockImplementation(async model =>
			model.provider === crossProviderModel.provider && model.id === crossProviderModel.id ? undefined : "test-key",
		);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider && model.id === nativeModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				return {
					summary: "authenticated same-provider advisor summary",
					shortSummary: "authenticated same-provider advisor",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					preserveData: nativeReplay(model.provider).preserveData,
				};
			}
			throw new Error(`Unexpected advisor compaction model ${model.provider}/${model.id}`);
		});

		await session.prompt("small current update");
		await waitForSuccessfulAdvisorCompletion(session, "authenticated native fallback review");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("authenticated same-provider advisor summary");
	});

	it("stops before a same-provider advisor candidate with native compaction disabled", async () => {
		const { advisor, nativeModel, sameProviderModel } = createAdvisorFallbackHarness({
			sameProviderNativeEnabled: false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider && model.id === nativeModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			return {
				summary: "generic same-provider summary",
				shortSummary: "generic same-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});

		await session.prompt("small current update");
		await waitForSuccessfulAdvisorCompletion(session, "disabled native candidate review");

		const attempted = compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`);
		expect(attempted.length).toBeGreaterThan(0);
		expect(attempted.every(candidate => candidate === `${nativeModel.provider}/${nativeModel.id}`)).toBe(true);
		expect(JSON.stringify(advisor.state.messages)).not.toContain("generic same-provider summary");
		expect(sameProviderModel.remoteCompaction?.enabled).toBe(false);
	});

	it("allows advisor compaction to cross providers after auth-classified native failures", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness({
			remoteEnabled: false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider || model.provider === sameProviderModel.provider) {
				throw new compactionModule.NativeCompactionError(
					Object.assign(new Error("native compaction authentication failed"), { status: 401 }),
				);
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "authenticated fallback summary",
				shortSummary: "authenticated fallback",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});

		await session.prompt("small current update");
		await waitForSuccessfulAdvisorCompletion(session, "cross-provider compaction fallback review");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
			`${crossProviderModel.provider}/${crossProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("authenticated fallback summary");
	});
	it("preserves native compaction state across advisor compactions", async () => {
		const opus46 = getBundledModel("anthropic", "claude-opus-4-6");
		if (!opus46) throw new Error("Expected bundled opus model");
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }, { content: ["primary complete again"] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			responses: [
				{ content: ["advisor reviewed current update"] },
				{ content: ["advisor reviewed second update"] },
				{ content: ["advisor reviewed third update"] },
			],
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.thresholdTokens": 95_000,
			"compaction.methodOrder": ["soft"],
			"contextPromotion.enabled": false,
		});
		settings.setModelRole("advisor", `${opus46.provider}/${opus46.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(opus46);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([opus46]);
		// Opus 4-6 has a 1M-token window against a reserve-based threshold, and
		// only the newest usage report anchors the estimate — so the anchors
		// themselves must each clear ~850k, where the shared helper's 371k
		// suffices for the fallback harness's 400k windows.
		const hugeAnchor = (timestamp: number): AssistantMessage => {
			const anchor = usageAnchor(advisorMock, timestamp);
			const usage = { ...anchor.usage, cacheRead: 950_000 };
			return { ...anchor, usage: { ...usage, totalTokens: usage.input + usage.output + usage.cacheRead } };
		};
		const seedOverflow = (base: number): void => {
			advisor.state.messages.push(
				{ role: "user", content: `overflow history ${base}`, timestamp: base },
				hugeAnchor(base + 1),
				{ role: "user", content: `overflow retained ${base}`, timestamp: base + 2 },
				hugeAnchor(base + 3),
			);
		};
		const appendCompactionSpy = vi.spyOn(SessionManager.prototype, "appendCompaction");
		seedOverflow(Date.now() - 4_000);
		const nativePreserveData = {
			anthropicCompaction: {
				provider: "anthropic",
				content: "native advisor summary",
				encryptedContent: "enc_advisor_0",
				filesText: "<files>\n# /repo/\nold.ts (Read)\n</files>",
				model: "claude-opus-4-6",
				usedTokens: 60_000,
			},
		};
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "native advisor summary",
			shortSummary: "native advisor",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			preserveData: nativePreserveData,
		}));

		await session.prompt("small current update");
		await waitForSuccessfulAdvisorCompletion(session, "first preserved native compaction review");

		// The in-memory summary replays the native block on later requests...
		expect(compactSpy.mock.calls).toHaveLength(1);
		const [summaryMessage] = advisor.state.messages;
		expect(summaryMessage?.role).toBe("compactionSummary");
		if (summaryMessage?.role !== "compactionSummary") throw new Error("Expected advisor compaction summary");
		expect(summaryMessage.providerPayload).toEqual({
			type: "anthropicCompaction",
			provider: "anthropic",
			content: "native advisor summary",
			encryptedContent: "enc_advisor_0",
			filesText: "<files>\n# /repo/\nold.ts (Read)\n</files>",
		});
		expect(summaryMessage).not.toHaveProperty("preserveData");
		const nativeWrite = appendCompactionSpy.mock.calls.find(([, , , , options]) =>
			Object.hasOwn(options?.preserveData ?? {}, "anthropicCompaction"),
		);
		expect(nativeWrite?.[4]?.preserveData).toEqual(nativePreserveData);
		// The native summary's rewrite marker predates the retained tail, so
		// the next request keeps the tail's bound thinking and cached prefix.
		const retainedTail = advisor.state.messages[1];
		if (!retainedTail) throw new Error("Expected retained advisor tail");
		expect(summaryMessage.timestamp).toBeLessThan(retainedTail.timestamp);
		const firstSummaryTimestamp = summaryMessage.timestamp;
		// ...and the next maintenance round feeds it back into preparation.
		seedOverflow(Date.now());
		await session.prompt("second update");
		await waitForSuccessfulAdvisorCompletion(session, "second preserved native compaction review");

		expect(compactSpy.mock.calls).toHaveLength(2);
		const secondPreparation = compactSpy.mock.calls[1]?.[0];
		expect(secondPreparation?.previousSummary).toBe("native advisor summary");
		expect(secondPreparation?.previousPreserveData).toEqual(nativePreserveData);
		const secondRequest = JSON.stringify(advisorMock.calls.at(-1)?.context.messages);
		expect(secondRequest).toContain("enc_advisor_0");
		// The second summary reuses the first round's marker instead of minting
		// a fresh one, keeping one stable rewrite point across compactions.
		const [secondSummary] = advisor.state.messages;
		expect(secondSummary?.role).toBe("compactionSummary");
		if (secondSummary?.role !== "compactionSummary") throw new Error("Expected second advisor summary");
		expect(secondSummary.timestamp).toBe(firstSummaryTimestamp);
	});
	it.each(["soft", "snapcompact"] as const)(
		"installs %s output through the advisor adapter before its core request",
		async method => {
			const { advisor, advisorMock, modelRegistry } = createHarness();
			session.settings.override("compaction.asyncEnabled", false);
			session.settings.set("compaction.keepRecentTokens", 1);
			session.settings.override("compaction.methodOrder", [method]);
			const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey");
			getApiKeySpy.mockResolvedValue("test-key");
			if (method === "snapcompact") {
				advisor.setModel({ ...advisor.state.model, input: ["text", "image"] });
			}
			advisor.state.messages.push(
				{ role: "user", content: `${method}-archived-advisor-decision`, timestamp: Date.now() - 4_000 },
				usageAnchor(advisorMock, Date.now() - 3_000),
				{ role: "user", content: `${method}-retained-advisor-decision`, timestamp: Date.now() - 2_000 },
				usageAnchor(advisorMock, Date.now() - 1_000),
			);
			const marker = `${method.toUpperCase()}-ADVISOR-REWRITE`;
			if (method === "soft") {
				vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
					summary: marker,
					shortSummary: marker,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				}));
			} else {
				vi.spyOn(snapcompactModule, "compact").mockImplementation(
					async <TMessage>(preparation: snapcompactModule.CompactionPreparation<TMessage>) => ({
						summary: marker,
						shortSummary: marker,
						firstKeptEntryId: preparation.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						details: { readFiles: [], modifiedFiles: [] },
						preserveData: {
							[snapcompactModule.PRESERVE_KEY]: {
								frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 10 }],
								totalChars: 10,
								truncatedChars: 0,
								text: marker,
							},
						},
					}),
				);
			}

			await session.prompt(`review after ${method} maintenance`);
			await waitForSuccessfulAdvisorCompletion(session, `${method} maintenance review`);

			expect(advisorMock.calls).toHaveLength(1);
			const request = JSON.stringify(advisorMock.calls.at(-1)!.context.messages);
			expect(request).toContain(marker);
			expect(request.match(/prior advisor output/g)).toHaveLength(1);
			expect(request.match(new RegExp(`review after ${method} maintenance`, "g"))).toHaveLength(1);
			expect(JSON.stringify(advisor.state.messages)).toContain(marker);
		},
	);

	it.each([
		{ branch: "unavailable methods", failSnapcompact: false },
		{ branch: "failed first method", failSnapcompact: true },
	] as const)("falls through a nondefault advisor method chain after $branch", async ({ branch, failSnapcompact }) => {
		const { advisor, advisorMock, modelRegistry } = createHarness();
		session.settings.override("compaction.asyncEnabled", false);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.override(
			"compaction.methodOrder",
			failSnapcompact ? ["snapcompact", "soft"] : ["remote", "snapcompact", "soft"],
		);
		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey");
		getApiKeySpy.mockResolvedValue("test-key");
		if (failSnapcompact) {
			advisor.setModel({ ...advisor.state.model, input: ["text", "image"] });
			vi.spyOn(snapcompactModule, "compact").mockRejectedValue(new Error("snapcompact render failed"));
		}
		advisor.state.messages.push(
			{ role: "user", content: `archived ${branch} decision`, timestamp: Date.now() - 4_000 },
			usageAnchor(advisorMock, Date.now() - 3_000),
			{ role: "user", content: `retained ${branch} decision`, timestamp: Date.now() - 2_000 },
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: `SOFT-FALLBACK-${branch}`,
			shortSummary: "soft fallback",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
		}));

		await session.prompt(`review after ${branch}`);
		await waitForSuccessfulAdvisorCompletion(session, `${branch} fallback review`);

		const request = JSON.stringify(advisorMock.calls.at(-1)!.context.messages);
		expect(request).toContain(`SOFT-FALLBACK-${branch}`);
		expect(request.match(/prior advisor output/g)).toHaveLength(1);
		expect(request.match(new RegExp(`review after ${branch}`, "g"))).toHaveLength(1);
	});

	it("installs a generated handoff through the advisor adapter before its core request", async () => {
		const { advisor, advisorMock, modelRegistry } = createHarness(undefined, false, "HANDOFF-ADVISOR-CONTINUATION");
		session.settings.override("compaction.asyncEnabled", false);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.override("compaction.methodOrder", ["handoff"]);
		const getApiKeySpy = vi.spyOn(modelRegistry, "getApiKey");
		getApiKeySpy.mockResolvedValue("test-key");
		advisor.state.messages.push(
			{ role: "user", content: "handoff-archived-advisor-decision", timestamp: Date.now() - 4_000 },
			usageAnchor(advisorMock, Date.now() - 3_000),
			{ role: "user", content: "handoff-retained-advisor-decision", timestamp: Date.now() - 2_000 },
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		advisorMock.push({ content: ["advisor reviewed installed handoff"] });

		await session.prompt("review after handoff maintenance");
		await waitForSuccessfulAdvisorCompletion(session, "handoff maintenance review");

		const handoffCall = advisorMock.calls.find(call =>
			JSON.stringify(call.context.messages).includes("Write a handoff document"),
		);
		if (!handoffCall) throw new Error("Expected a distinct handoff side request");
		const coreCall = advisorMock.calls.findLast(call =>
			JSON.stringify(call.context.messages).includes("review after handoff maintenance"),
		);
		if (!coreCall || coreCall === handoffCall) throw new Error("Expected a distinct advisor core request");
		const coreRequest = JSON.stringify(coreCall.context.messages);
		expect(coreRequest).toContain("HANDOFF-ADVISOR-CONTINUATION");
		expect(coreRequest.match(/prior advisor output/g)).toHaveLength(1);
		expect(coreRequest.match(/review after handoff maintenance/g)).toHaveLength(1);
		expect(JSON.stringify(advisor.state.messages)).toContain("HANDOFF-ADVISOR-CONTINUATION");
	});

	it("keeps a shaken advisor tool result recoverable from its shared artifact store", async () => {
		const { advisor, advisorMock } = createHarness();
		session.settings.override("compaction.asyncEnabled", false);
		session.settings.override("compaction.methodOrder", ["shake"]);
		session.settings.set("compaction.keepRecentTokens", 1);
		const call: AssistantMessage = {
			...usageAnchor(advisorMock, Date.now() - 3_000),
			content: [{ type: "toolCall", id: "large-read", name: "read", arguments: { path: "large.ts" } }],
			stopReason: "toolUse",
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "large-read",
			toolName: "read",
			content: [{ type: "text", text: `SHAKE-RECOVERABLE-DETAIL ${"large output ".repeat(8_000)}` }],
			isError: false,
			timestamp: Date.now() - 2_000,
		};
		advisor.state.messages.push(
			{ role: "user", content: "inspect large tool output", timestamp: Date.now() - 5_000 },
			call,
			result,
			{
				role: "user",
				content: `protected recent advisor tail ${"recent context ".repeat(10_000)}`,
				timestamp: Date.now() - 2_000,
			},
			usageAnchor(advisorMock, Date.now() - 1_000),
		);

		await session.prompt("review after shake maintenance");
		await waitForSuccessfulAdvisorCompletion(session, "shake maintenance review");

		const request = JSON.stringify(advisorMock.calls.at(-1)!.context.messages);
		const artifactId = request.match(/artifact:\/\/([A-Za-z0-9_-]+)/)?.[1];
		if (!artifactId) throw new Error("Expected shake artifact reference in advisor request");
		expect(request).not.toContain("SHAKE-RECOVERABLE-DETAIL");
		expect(await session.sessionManager.getArtifactContent(artifactId)).toContain("SHAKE-RECOVERABLE-DETAIL");
	});

	it("rewrites the next request when a 95k advisor usage anchor plus tool output crosses its 100k threshold", async () => {
		const primaryMock = createMockModel({
			provider: "anthropic",
			contextWindow: 1_000_000,
			responses: [{ content: ["primary complete"] }],
		});
		const advisorModel = createMockModel({
			provider: "anthropic",
			contextWindow: 200_000,
		});
		const submitted: Context[] = [];
		let coreTurn = 0;
		const advisorStreamFn: typeof advisorModel.stream = (_model, context) => {
			submitted.push(context);
			coreTurn++;
			const toolUse = coreTurn === 1;
			const message: AssistantMessage = {
				role: "assistant",
				content: toolUse
					? [{ type: "toolCall", id: "cross-threshold", name: "read", arguments: {} }]
					: [{ type: "text", text: "review complete after maintenance" }],
				api: advisorModel.api,
				provider: advisorModel.provider,
				model: advisorModel.id,
				usage: {
					input: toolUse ? 95_000 : 1_000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: toolUse ? 95_100 : 1_100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: toolUse ? "toolUse" : "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message });
			});
			return stream;
		};
		const largeResultTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Returns enough new context to cross the maintenance threshold",
			parameters: type({}),
			execute: async () => ({
				content: [{ type: "text", text: `TOOL-CROSSING ${"material ".repeat(6_000)}` }],
			}),
		};
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.midTurnEnabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"contextPromotion.enabled": false,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [largeResultTool],
			advisorStreamFn,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorModel);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "MIDRUN-REWRITE retained the completed tool result",
			shortSummary: "midrun rewrite",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 105_000,
		}));

		await session.prompt("one primary update requiring a tool-assisted review");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(primaryMock.calls).toHaveLength(1);
		expect(submitted).toHaveLength(2);
		const firstRequest = JSON.stringify(submitted[0]!.messages);
		const nextRequest = JSON.stringify(submitted[1]!.messages);
		expect(firstRequest.match(/one primary update requiring a tool-assisted review/g)).toHaveLength(1);
		expect(nextRequest).toContain("MIDRUN-REWRITE");
		expect(nextRequest).toContain("TOOL-CROSSING");
		expect(
			(nextRequest.match(/one primary update requiring a tool-assisted review/g) ?? []).length,
		).toBeLessThanOrEqual(1);
		expect(JSON.stringify(advisor.state.messages)).toContain("MIDRUN-REWRITE");
	});
});
