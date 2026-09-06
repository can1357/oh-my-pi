import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage, type CompactionSummaryMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { calculateContextTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const CONTEXT_WINDOW = 372_000;
const CACHE_READ_TOKENS = 371_200;
const INPUT_TOKENS = 200;
const OUTPUT_TOKENS = 150;

interface MaintenanceHarness {
	advisor: Agent;
	advisorMock: MockModel;
	modelRegistry: ModelRegistry;
	settings: Settings;
}

interface AdvisorCompactionSummaryFixture extends CompactionSummaryMessage {
	advisorUsageAnchorStartIndex?: number;
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

	function createHarness(contextPromotionTarget?: string, contextPromotionEnabled = false): MaintenanceHarness {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			responses: [{ content: ["advisor reviewed current update"] }],
		});
		Object.assign(advisorMock, { contextPromotionTarget });
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
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
		return { advisor, advisorMock, modelRegistry, settings };
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

	function compactionSummary(timestamp: number): AdvisorCompactionSummaryFixture {
		return {
			role: "compactionSummary",
			summary: "bounded advisor summary",
			tokensBefore: CACHE_READ_TOKENS + INPUT_TOKENS + OUTPUT_TOKENS,
			timestamp,
			// `[summary, retained]` is the compacted array; index 2 is the first
			// position eligible for a newly appended provider-usage anchor.
			advisorUsageAnchorStartIndex: 2,
		};
	}

	function createAdvisorFallbackHarness(options?: { sameProviderNativeEnabled?: boolean }) {
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
		const crossProviderModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!nativeModel || !sameProviderModel || !crossProviderModel) {
			throw new Error("Expected bundled compaction models");
		}

		authStorage.setRuntimeApiKey(nativeModel.provider, "openai-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"contextPromotion.enabled": false,
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
			usageAnchor(advisorMock, Date.now() - 2_000),
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		return { advisor, apiKeySpy, crossProviderModel, nativeModel, sameProviderModel, settings };
	}

	it("maintains a 371,200-token cached advisor context before the 372,000-token window", async () => {
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

		// Provider usage triggers maintenance, but recovery sends only the bounded
		// current update into the reset advisor context.
		expect(JSON.stringify(advisorCall.context.messages)).toContain("small current update");
		expect(JSON.stringify(advisor.state.messages)).not.toContain("prior advisor output");
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
	});

	it("ignores late context-promotion credentials after a session transition", async () => {
		const promotion = createMockModel({
			id: "advisor-promotion-target",
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW + 1,
		});
		const { advisor, advisorMock, modelRegistry } = createHarness(`${promotion.provider}/${promotion.id}`, true);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisor.state.model, promotion]);
		const credentialStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const credentialReturned = Promise.withResolvers<void>();
		let credentialSignal: AbortSignal | undefined;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, _sessionId, options) => {
			if (model === promotion) {
				credentialSignal = options?.signal;
				credentialStarted.resolve();
				await releaseCredential.promise;
				credentialReturned.resolve();
			}
			return "test-key";
		});
		advisor.emitExternalEvent({
			type: "message_end",
			message: usageAnchor(advisorMock, Date.now() - 1_000),
		});

		const prompt = session.prompt("trigger advisor context promotion");
		await credentialStarted.promise;
		await session.newSession();
		releaseCredential.resolve();
		await credentialReturned.promise;
		await prompt;
		expect(credentialSignal?.aborted).toBe(true);
		expect(session.getAdvisorAgent()?.state.model).toBe(advisorMock);
	});

	it("includes advisor system prompt and tool schemas in the local maintenance floor", async () => {
		const { advisor, advisorMock, settings } = createHarness();
		const seed: AgentMessage = { role: "user", content: "small stored advisor message", timestamp: 1 };
		advisor.state.messages.push(seed);
		const storedTokens = advisor.tokenizer.countMessage(seed, { excludeEncryptedReasoning: true });
		const fixedPrefixTokens =
			advisor.tokenizer.countTokens(advisor.state.systemPrompt) +
			estimateToolSchemaTokens(advisor.state.tools, advisor.tokenizer);
		const threshold = storedTokens + Math.floor(fixedPrefixTokens / 2);
		settings.set("compaction.thresholdTokens", threshold);

		await session.prompt("tiny local-floor update");

		const advisorCall = advisorMock.calls[0];
		const update = advisorCall.context.messages.find(message => message.role === "user");
		if (!update) throw new Error("Expected the advisor's incremental update");
		const messagesOnlyTokens = storedTokens + advisor.tokenizer.countMessage(update as AgentMessage);
		expect(messagesOnlyTokens).toBeLessThan(threshold);
		expect(messagesOnlyTokens + fixedPrefixTokens).toBeGreaterThan(threshold);
		expect(JSON.stringify(advisor.state.messages)).not.toContain("small stored advisor message");
	});

	it("ignores retained provider usage that predates the latest advisor compaction", async () => {
		const { advisor, advisorMock } = createHarness();
		const compactedAt = Date.now();
		const summary = compactionSummary(compactedAt);
		const retained = usageAnchor(advisorMock, compactedAt);
		retained.content = [{ type: "text", text: "retained pre-compaction output" }];
		advisor.state.messages.push(summary, retained);

		await session.prompt("post-compaction update");

		expect(advisorMock.calls).toHaveLength(1);
		const sentContext = JSON.stringify(advisorMock.calls[0].context.messages);
		expect(sentContext).toContain("retained pre-compaction output");
		expect(sentContext).toContain("post-compaction update");
	});

	it("accepts equal-timestamp usage appended after the explicit compaction boundary", async () => {
		const { advisor, advisorMock } = createHarness();
		const compactedAt = Date.now();
		const summary = compactionSummary(compactedAt);
		const retained = usageAnchor(advisorMock, compactedAt);
		retained.content = [{ type: "text", text: "retained pre-compaction output" }];
		const fresh = usageAnchor(advisorMock, compactedAt);
		fresh.content = [{ type: "text", text: "fresh post-compaction output" }];
		advisor.state.messages.push(summary, retained, fresh);

		await session.prompt("equal-timestamp post-compaction update");

		expect(advisorMock.calls).toHaveLength(1);
		const sentContext = JSON.stringify(advisorMock.calls[0].context.messages);
		expect(sentContext).toContain("equal-timestamp post-compaction update");
		expect(sentContext).not.toContain("retained pre-compaction output");
		expect(sentContext).not.toContain("fresh post-compaction output");
	});

	it("forwards compaction metadata and aborts transitions without fallback or re-prime", async () => {
		// Regression for #6625 review: advisor overflow compaction issues a direct
		// `compact(...)` request that bypasses the advisor `Agent`, so the metadata
		// resolver installed on the agent never runs for it. The direct call must
		// still emit the advisor's `metadata.user_id` session identity.
		// The advisor model is the first compaction candidate; registering the mock
		// API lets the compaction one-shot's `completeSimple` route to it so the
		// summarization request actually reaches the mock (and its recorded calls).
		registerMockApi();
		const compactionStarted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
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
				const signal = options?.signal;
				if (!signal) throw new Error("Expected compaction abort signal");
				const compactionAborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => compactionAborted.resolve(), { once: true });
				await Promise.race([releaseCompaction.promise, compactionAborted.promise]);
				signal.throwIfAborted();
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
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
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
		advisor.setModel(advisorMock);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisorMock, fallbackMock]);
		// Unlike the recovery-branch harness, the advisor holds usable credentials
		// so maintenance runs the LLM summarization compaction path.
		const getApiKey = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		// Two accumulated turns so compaction has older history to summarize while
		// retaining the most recent one (a single message would be fully retained,
		// making compaction a no-op).
		advisor.state.messages.push(
			usageAnchor(advisorMock, Date.now() - 2_000),
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		const previousAdvisorMessages = [...advisor.state.messages];

		const prompt = session.prompt("small current update");
		await compactionStarted.promise;
		const failure = new Error("new session failed");
		vi.spyOn(session.sessionManager, "newSession").mockRejectedValue(failure);
		const transition = session.newSession();
		try {
			await expect(transition).rejects.toThrow(failure);
			expect(fallbackCalls).toBe(0);
			expect(advisor.state.messages).toEqual(previousAdvisorMessages);
			expect(getApiKey).toHaveBeenCalledWith(advisorMock, advisor.sessionId, {
				signal: expect.any(AbortSignal),
			});
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

		// Every advisor request — the compaction one-shot and the advisor turn —
		// carries the advisor's own provider session id via metadata.user_id.
		for (const call of advisorMock.calls) {
			const userId = call.options?.metadata?.user_id;
			if (typeof userId !== "string") throw new Error("Expected advisor metadata.user_id");
			expect((JSON.parse(userId) as { session_id?: string }).session_id).toBe(advisor.sessionId);
		}
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
				tokensBefore: 42,
			};
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
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
					tokensBefore: 42,
				};
			}
			throw new Error(
				`Unexpected cross-provider compaction ${crossProviderModel.provider}/${crossProviderModel.id}`,
			);
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("same-provider native summary");
	});

	it("skips unauthenticated advisor candidates before enforcing the native boundary", async () => {
		const { advisor, apiKeySpy, crossProviderModel, nativeModel, sameProviderModel, settings } =
			createAdvisorFallbackHarness();
		settings.setModelRole("smol", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		settings.setModelRole("slow", `${sameProviderModel.provider}/${sameProviderModel.id}`);
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
					tokensBefore: 42,
				};
			}
			throw new Error(`Unexpected advisor compaction model ${model.provider}/${model.id}`);
		});

		await session.prompt("small current update");

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
				tokensBefore: 42,
			};
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).not.toContain("generic same-provider summary");
		expect(sameProviderModel.remoteCompaction?.enabled).toBe(false);
	});

	it("allows advisor compaction to cross providers after auth-classified native failures", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
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
				tokensBefore: 42,
			};
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
			`${crossProviderModel.provider}/${crossProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("authenticated fallback summary");
	});
});
