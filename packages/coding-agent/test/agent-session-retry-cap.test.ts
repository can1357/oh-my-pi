import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type {
	ApiKeyResolveContext,
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { opencodeGoUsageProvider } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

const RETRY_CAP_MOCK_API_SOURCE = "agent-session-retry-cap-test";
const CYBER_POLICY_ERROR =
	"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)";
const CYBER_POLICY_FAILURE: MockResponse = {
	content: [{ type: "thinking", thinking: "Checking whether this security request is allowed." }],
	stopReason: "error",
	errorMessage: CYBER_POLICY_ERROR,
};

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

function resolveInitialApiKey(
	apiKey: string | ((ctx: ApiKeyResolveContext) => string | Promise<string | undefined> | undefined) | undefined,
): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	if (typeof resolved !== "string") {
		throw new Error("Expected API key to be resolved before streaming");
	}
	return resolved;
}

/**
 * Contract: when the provider asks us to wait longer than `retry.maxDelayMs`
 * and we have no credential/model fallback to switch to, the auto-retry
 * loop MUST fail fast — preserving the terminal error message in agent
 * state and skipping the long sleep entirely.
 *
 * Without this defense, an Anthropic `429 rate_limit_error` with
 * `retry-after-ms=11180000` (≈3 hours) pinned a subagent in the retry
 * sleep, leaving the parent task tool stuck on the review phase for hours
 * (see GitHub issue #607).
 */
describe("AgentSession retry delay cap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-cap-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		// A live env var now overrides a stored static api_key; these tests rotate stored Anthropic
		// credentials, so neutralize env resolution (ignores every provider's ambient env key).
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		for (const provider of ["anthropic", "openai-codex"]) {
			await authStorage.remove(provider);
		}
		for (const provider of [
			"anthropic",
			"openai",
			"openai-codex",
			"opencode-go",
			"openrouter",
			"github-copilot",
			"cursor",
		]) {
			authStorage.removeRuntimeApiKey(provider);
		}
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		unregisterCustomApis(RETRY_CAP_MOCK_API_SOURCE);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("bails immediately when retry-after exceeds retry.maxDelayMs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// 11.18M ms == ~3.1 hours, matching the report on the original incident.
		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after=11180.0005';

		const mock = createMockModel({ handler: () => ({ throw: rateLimitError }) });
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Spy after construction so the constructor's no-op work isn't intercepted.
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger rate limit with long retry-after");
		await session.waitForIdle();

		// Only one model call: the auto-retry MUST NOT loop into a fresh attempt
		// because the cap fired before scheduler.wait was even reached.
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		expect(retryEndEvents[0].finalError).toContain("Provider requested 11180001ms wait");
		// No multi-hour (or any) sleep — the cap path skips scheduler.wait entirely.
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}

		// The terminal error stays as the last assistant message so the caller
		// (interactive UI, parent task tool, SDK consumer) can act on it.
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("rate_limit_error");
		expect(session.isRetrying).toBe(false);
	});

	it("waits past retry.maxDelayMs for a usage-limit reset when retry.waitForUsageReset is set", async () => {
		// Contract: with the opt-in set, a provider-stated usage-limit reset
		// sleeps until the reset instead of failing fast. Uses the reported
		// ZAI shape (Zhipu 5h 使用上限 with an absolute reset timestamp,
		// single credential so no rotation can save it); the bypass keys off
		// Flag.UsageLimit, so every provider whose exhaustion classifies as
		// a usage limit is covered.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// Reset two hours out, formatted like the provider timestamp (parsed
		// as UTC, so toISOString stays exact); bounds below absorb test time.
		const resetStamp = new Date(Date.now() + 7_200_000).toISOString().slice(0, 19).replace("T", " ");
		const usageLimitError = `429 已达到 5 小时的使用上限。您的限额将在 ${resetStamp} 重置。`;

		const mock = createMockModel({
			responses: [{ throw: usageLimitError }, { content: ["recovered after usage reset"], stopReason: "stop" }],
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger long usage-limit reset with waitForUsageReset");
		await session.waitForIdle();
		// The multi-hour provider-stated wait runs instead of failing fast,
		// then the retry succeeds on the same credential.
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeGreaterThan(7_000_000);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(7_200_000);
		expect(waitSpy.mock.calls.some(call => (call[0] as number) > 7_000_000)).toBe(true);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
		expect(session.isRetrying).toBe(false);
	});

	it("still fails fast on a long usage-limit reset when retry.waitForUsageReset is off", async () => {
		// Contract: the default is unchanged — a multi-hour usage-limit wait
		// without the opt-in (or a sibling/fallback) MUST fail fast.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const resetStamp = new Date(Date.now() + 7_200_000).toISOString().slice(0, 19).replace("T", " ");
		const usageLimitError = `429 已达到 5 小时的使用上限。您的限额将在 ${resetStamp} 重置。`;

		const mock = createMockModel({ handler: () => ({ throw: usageLimitError }) });
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger long usage-limit reset without the opt-in");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("使用上限");
		expect(session.isRetrying).toBe(false);
	});

	it("still fails fast on a long transient retry-after when retry.waitForUsageReset is set", async () => {
		// Contract: the opt-in covers provider-stated *usage-limit* resets
		// only — a long transient retry-after (server overload, no quota
		// exhaustion) MUST still fail fast so the hung-subagent guard keeps
		// working for non-quota errors.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const overloadedError = "503 service unavailable: overloaded_error retry-after-ms=3600000";

		const mock = createMockModel({ handler: () => ({ throw: overloadedError }) });
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger long transient retry-after with the opt-in set");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		expect(session.isRetrying).toBe(false);
	});

	it("fails fast on a usage-limit error with no provider reset hint when retry.waitForUsageReset is set", async () => {
		// Contract: the opt-in only honors *parsed provider* reset timing. A
		// usage-limit error with no hint (e.g. 402 balance) falls back to the
		// 30-minute QUOTA_EXHAUSTED heuristic, which must NOT bypass the cap —
		// otherwise a permanent error holds the session through repeated
		// heuristic sleeps instead of surfacing.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const balanceError = "402 Insufficient balance, please top up your account";

		const mock = createMockModel({ handler: () => ({ throw: balanceError }) });
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger hintless usage-limit error with the opt-in set");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		expect(retryEndEvents[0].finalError).toContain("Provider requested 1800000ms wait");
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("Insufficient balance");
		expect(session.isRetrying).toBe(false);
	});

	it("retries promptly on a zero-valued usage-limit retry hint when retry.waitForUsageReset is set", async () => {
		// Contract: an explicit `retry-after-ms=0` is a provider "retry now"
		// signal. It must not collapse into "no hint" — that would substitute
		// the 30-minute QUOTA_EXHAUSTED heuristic, which (lacking parsed
		// provider timing) cannot authorize the opt-in and would trip
		// retry.maxDelayMs, surfacing the error instead of retrying as asked.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const zeroHintError = "429 quota exceeded. retry-after-ms=0";

		const mock = createMockModel({
			responses: [{ throw: zeroHintError }, { content: ["recovered after immediate retry"], stopReason: "stop" }],
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger zero retry-after usage-limit with the opt-in set");
		await session.waitForIdle();

		// The retry ran within the cap instead of sleeping the heuristic or
		// failing fast, and the second attempt recovered.
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeGreaterThan(0);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(100);
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
		expect(session.isRetrying).toBe(false);
	});

	it("honors the account reset over a shorter appended retry hint when retry.waitForUsageReset is set", async () => {
		// Contract: a usage-limit message carrying both an account reset and
		// a shorter appended `retry-after-ms` (header timing folded into the
		// message) must sleep until the account reset — waking on the short
		// hint would retry a still-blocked credential and burn the budget.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const dualSignalError = "429 quota exceeded. Your limit will reset in 13 minutes. retry-after-ms=5000";

		const mock = createMockModel({
			responses: [{ throw: dualSignalError }, { content: ["recovered after account reset"], stopReason: "stop" }],
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 2,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger dual-signal usage-limit error with the opt-in set");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBe(13 * 60_000);
		expect(waitSpy.mock.calls.some(call => call[0] === 13 * 60_000)).toBe(true);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
		expect(session.isRetrying).toBe(false);
	});

	/**
	 * Isolated AuthStorage whose opencode-go usage endpoint reports the given
	 * rolling/weekly windows. Lets recovery tests drive report-derived
	 * unblock deadlines without network access. A past `resetsAtIso` models
	 * an exhausted window with no future reset (e.g. a permanent cap). The
	 * caller owns closing the storage.
	 */
	interface OpencodeWindowSpec {
		status: "ok" | "rate-limited";
		percent: number;
		resetsAtIso: string;
	}
	async function createOpencodeStorageWithUsage(
		rolling: OpencodeWindowSpec,
		weekly: OpencodeWindowSpec,
	): Promise<AuthStorage> {
		const windowPayload = (spec: OpencodeWindowSpec): Record<string, unknown> => ({
			status: spec.status,
			percent: spec.percent,
			resetsAt: spec.resetsAtIso,
		});
		const localStore = new SqliteAuthCredentialStore(new Database(":memory:"));
		const localStorage = new AuthStorage(localStore, {
			usageProviderResolver: provider => (provider === "opencode-go" ? opencodeGoUsageProvider : undefined),
			usageFetch: (async () =>
				new Response(
					JSON.stringify({
						usage: {
							rolling: windowPayload(rolling),
							weekly: windowPayload(weekly),
							monthly: {
								status: "ok",
								percent: 8,
								resetsAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
							},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)) as unknown as typeof fetch,
		});
		await localStorage.reload();
		await localStorage.set("opencode-go", { type: "api_key", key: "opencode-go-usage-key" });
		return localStorage;
	}

	it("sleeps until the report-derived unblock deadline when it outlasts the error hint", async () => {
		// Contract: when the usage report reveals a later exhausted window
		// than the error text names (here a 60s hint while the weekly window
		// is spent for ~2h), the wait honors the credential's actual unblock
		// deadline — waking on the shorter hint would retry a still-blocked
		// credential and burn the budget.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "ok", percent: 12, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 7_200_000).toISOString() },
		);
		try {
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));

			const mock = createMockModel({
				responses: [
					{ throw: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=60000" },
					{ content: ["recovered after weekly reset"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger usage limit with a later report-derived reset");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(1);
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(7_100_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(7_200_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 7_100_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("sleeps on a report-derived reset with no error-text hint when retry.waitForUsageReset is set", async () => {
		// Contract: a hintless usage-limit error still bypasses the cap when
		// the usage report carries an authoritative exhausted window — the
		// parsed-hint requirement must not reject report-derived deadlines.
		// (A hintless error with no report extension still fails fast, as
		// the heuristic-only test above proves.)
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "ok", percent: 12, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 7_200_000).toISOString() },
		);
		try {
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));

			const mock = createMockModel({
				responses: [
					{ throw: "429 quota exceeded for this account" },
					{ content: ["recovered after reported reset"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit with a reported reset");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(1);
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(7_100_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(7_200_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 7_100_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("sleeps on a shorter authoritative report reset with no error-text hint", async () => {
		// Contract: report authoritativeness does not depend on outlasting
		// the heuristic — a complete report window resetting sooner than the
		// 30-minute QUOTA_EXHAUSTED fallback still authorizes the opt-in wait.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "ok", percent: 12, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
		);
		try {
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));

			const mock = createMockModel({
				responses: [
					{ throw: "429 quota exceeded for this account" },
					{ content: ["recovered after short reported reset"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit with a short reported reset");
			await session.waitForIdle();

			expect(retryStartEvents).toHaveLength(1);
			// The authoritative 5-minute report reset replaces the 30-minute
			// heuristic — not just authorizes it.
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(290_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(300_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 290_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("keeps a sibling session's longer stored block over a short report reset", async () => {
		// Contract: the stored credential block merges every mark call for
		// the shared credential (longest-wins). When an earlier
		// sibling-session response blocked it for ~2h, a later hintless
		// error with a complete ~5-minute report must not undercut that
		// merged deadline: the report window replaces only this call's
		// 30-minute heuristic, and waking at the report reset would retry a
		// credential whose actual unblock time is still hours away.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "ok", percent: 12, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
		);
		try {
			// An earlier usage-limit response on a sibling session (same
			// shared credential, single entry so it stays usable) established
			// the longer block before this session's failing turn. The key
			// resolution binds the credential to the sibling session, as a
			// real prior turn would have.
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));
			await localRegistry.getApiKeyForProvider("opencode-go", "sibling-session");
			await localStorage.markUsageLimitReached("opencode-go", "sibling-session", {
				retryAfterMs: 7_200_000,
				providerTimed: true,
			});

			const mock = createMockModel({
				responses: [
					{ throw: "429 quota exceeded for this account" },
					{ content: ["recovered after merged block"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit under a longer sibling block");
			await session.waitForIdle();

			// The ~2h merged credential deadline wins over the ~5-minute
			// report window — the report only replaced the 30-minute guess.
			expect(retryStartEvents).toHaveLength(1);
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(7_100_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(7_200_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 7_100_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("keeps a pre-existing block shorter than the heuristic over a short report reset", async () => {
		// Contract: the merged credential deadline masks a pre-existing block
		// that is shorter than this call's 30-minute heuristic fallback
		// (longest-wins in the mark). The prior deadline is an earlier
		// response's provider-stated window and must survive — a hintless
		// error with a ~5-minute report must not undercut a sibling session's
		// 20-minute block to retry before that provider window clears.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "ok", percent: 12, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
		);
		try {
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));
			await localRegistry.getApiKeyForProvider("opencode-go", "sibling-session");
			// The sibling's 20-minute provider-stated block is shorter than
			// the 30-minute heuristic this session's hintless error will
			// contribute, so the merged deadline alone cannot distinguish it.
			await localStorage.markUsageLimitReached("opencode-go", "sibling-session", {
				retryAfterMs: 1_200_000,
				providerTimed: true,
			});

			const mock = createMockModel({
				responses: [
					{ throw: "429 quota exceeded for this account" },
					{ content: ["recovered after prior block"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit under a 20-minute sibling block");
			await session.waitForIdle();

			// The ~20-minute prior block wins over both the ~5-minute report
			// and the masked 30-minute heuristic.
			expect(retryStartEvents).toHaveLength(1);
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(1_150_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(1_200_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 1_150_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("ignores a heuristic-only prior block over a short report reset", async () => {
		// Contract: a prior block that was itself only a 30-minute heuristic
		// guess (a hintless sibling error whose report was unavailable) has no
		// provider authority. A complete ~5-minute report on the current call
		// must replace it — sleeping the guess would hold the session ~25
		// minutes past the known reset.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "ok", percent: 12, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 300_000).toISOString() },
		);
		try {
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));
			await localRegistry.getApiKeyForProvider("opencode-go", "sibling-session");
			// Hintless sibling error whose report was unavailable: the stored
			// block is the 30-minute heuristic fallback, not provider timing.
			await localStorage.markUsageLimitReached("opencode-go", "sibling-session", {
				retryAfterMs: 1_800_000,
			});

			const mock = createMockModel({
				responses: [
					{ throw: "429 quota exceeded for this account" },
					{ content: ["recovered after short reported reset"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit under a heuristic sibling block");
			await session.waitForIdle();

			// The authoritative ~5-minute report wins over the sibling's
			// 30-minute heuristic guess.
			expect(retryStartEvents).toHaveLength(1);
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(290_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(300_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 290_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("ignores a persisted heuristic prior block after a restart", async () => {
		// Contract: persisted credential blocks carry no provenance. A
		// 30-minute heuristic guess persisted before a restart must not read
		// as provider timing afterwards — a fresh complete ~5-minute report
		// wins, instead of sleeping ~25 minutes past the known reset.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const windowPayload = (status: "ok" | "rate-limited", resetsAtIso: string): Record<string, unknown> => ({
			status,
			percent: 100,
			resetsAt: resetsAtIso,
		});
		const usageOptions = {
			usageProviderResolver: (provider: string) =>
				provider === "opencode-go" ? opencodeGoUsageProvider : undefined,
			usageFetch: (async () =>
				new Response(
					JSON.stringify({
						usage: {
							rolling: windowPayload("ok", new Date(Date.now() + 300_000).toISOString()),
							weekly: windowPayload("rate-limited", new Date(Date.now() + 300_000).toISOString()),
							monthly: {
								status: "ok",
								percent: 8,
								resetsAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
							},
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)) as unknown as typeof fetch,
		};

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const priorStorage = new AuthStorage(store, usageOptions);
		const restartedStorage = new AuthStorage(store, usageOptions);
		try {
			await priorStorage.reload();
			await restartedStorage.reload();
			await priorStorage.set("opencode-go", { type: "api_key", key: "opencode-go-usage-key" });
			await restartedStorage.reload();
			// Pre-restart hintless sibling response with no report reset: the
			// stored block is the 30-minute heuristic guess (no providerTimed).
			await priorStorage.getApiKey("opencode-go", "sibling-session");
			await priorStorage.markUsageLimitReached("opencode-go", "sibling-session", {
				retryAfterMs: 1_800_000,
			});

			const localRegistry = new ModelRegistry(restartedStorage, path.join(tempDir.path(), "models.yml"));

			const mock = createMockModel({
				responses: [
					{ throw: "429 quota exceeded for this account" },
					{ content: ["recovered after short reported reset"], stopReason: "stop" },
				],
			});
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.maxRetries": 2,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit after a restart over a heuristic block");
			await session.waitForIdle();

			// The fresh ~5-minute report wins over the stale persisted
			// 30-minute heuristic guess.
			expect(retryStartEvents).toHaveLength(1);
			expect(retryStartEvents[0].delayMs).toBeGreaterThan(290_000);
			expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(300_000);
			expect(waitSpy.mock.calls.some(call => (call[0] as number) > 290_000)).toBe(true);
			expect(requestedModels).toEqual([
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
				`${exhaustedModel.provider}/${exhaustedModel.id}`,
			]);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: true });
			expect(lastAssistant(session).stopReason).toBe("stop");
			expect(session.isRetrying).toBe(false);
		} finally {
			priorStorage.close();
			restartedStorage.close();
		}
	});

	it("fails fast when a co-exhausted window has no future reset despite a timed one", async () => {
		// Contract: a report is authoritative only when EVERY exhausted
		// window carries a future reset. Here the rolling window resets in
		// ~2h but the weekly window is spent with a stale timestamp
		// (permanent-cap shape), so the opt-in must fail fast instead of
		// parking until a reset that cannot clear the account.
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		if (!exhaustedModel) {
			throw new Error("Expected bundled OpenCode Go test model to exist");
		}

		const localStorage = await createOpencodeStorageWithUsage(
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() + 7_200_000).toISOString() },
			{ status: "rate-limited", percent: 100, resetsAtIso: new Date(Date.now() - 3_600_000).toISOString() },
		);
		try {
			const localRegistry = new ModelRegistry(localStorage, path.join(tempDir.path(), "models.yml"));

			const mock = createMockModel({ handler: () => ({ throw: "429 quota exceeded for this account" }) });
			const requestedModels: string[] = [];
			const agent = new Agent({
				getApiKey: model => localRegistry.resolver(model, agent.sessionId),
				initialState: {
					model: exhaustedModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (requestedModel, context, options) => {
					requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
					return mock.stream(requestedModel, context, options);
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
				"retry.modelFallback": false,
				"retry.waitForUsageReset": true,
			});
			settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry: localRegistry,
			});

			const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Trigger hintless usage limit with a permanently capped window");
			await session.waitForIdle();

			expect(requestedModels).toEqual([`${exhaustedModel.provider}/${exhaustedModel.id}`]);
			expect(retryStartEvents).toHaveLength(0);
			expect(retryEndEvents).toHaveLength(1);
			expect(retryEndEvents[0]).toMatchObject({ success: false });
			expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
			for (const call of waitSpy.mock.calls) {
				expect(call[0]).toBeLessThanOrEqual(100);
			}
			const last = lastAssistant(session);
			expect(last.stopReason).toBe("error");
			expect(last.errorMessage).toContain("quota exceeded");
			expect(session.isRetrying).toBe(false);
		} finally {
			localStorage.close();
		}
	});

	it("switches a long OpenCode Go usage limit to an earlier cross-provider fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const alternateOpenCodeModel = getBundledModel("opencode-go", "deepseek-v4-pro");
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		if (!primaryModel || !alternateOpenCodeModel || !exhaustedModel || !fallbackModel) {
			throw new Error("Expected bundled primary, OpenCode Go, and cross-provider fallback test models to exist");
		}

		authStorage.setRuntimeApiKey("opencode-go", "opencode-go-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=60000" },
				{
					content: [{ type: "thinking", thinking: "Classifier refusal." }],
					errorMessage: "Refusal (cyber): Declined.",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					stopReason: "error",
				},
				{
					content: [{ type: "thinking", thinking: "Classifier refusal." }],
					errorMessage: "Refusal (cyber): Declined.",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					stopReason: "error",
				},
				{
					throw: "429 Weekly usage limit reached. Resets in 55min. type=GoUsageLimitError retry-after-ms=3242000",
				},
				{ content: ["recovered on cross-provider fallback"], stopReason: "stop" },
			],
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxDelayMs": 300_000,
			"retry.maxRetries": 3,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [
					`${alternateOpenCodeModel.provider}/${alternateOpenCodeModel.id}`,
					`${fallbackModel.provider}/${fallbackModel.id}`,
					`${exhaustedModel.provider}/${exhaustedModel.id}`,
				],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Trigger the long OpenCode Go weekly usage limit");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${alternateOpenCodeModel.provider}/${alternateOpenCodeModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${exhaustedModel.provider}/${exhaustedModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(fallbackEvents).toContainEqual({
			type: "retry_fallback_applied",
			from: `${exhaustedModel.provider}/${exhaustedModel.id}`,
			to: `${fallbackModel.provider}/${fallbackModel.id}`,
			role: "default",
		});
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThan(300_000);
		}
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "recovered on cross-provider fallback",
		});
	});
	it("waits for a short OpenCode Go sibling credential before model fallback", async () => {
		const exhaustedModel = getBundledModel("opencode-go", "deepseek-v4-flash");
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		if (!exhaustedModel || !fallbackModel) {
			throw new Error("Expected bundled OpenCode Go and fallback test models to exist");
		}

		await authStorage.set("opencode-go", [
			{ type: "api_key", key: "opencode-go-key-1" },
			{ type: "api_key", key: "opencode-go-key-2" },
		]);
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		await modelRegistry.getApiKeyForProvider("opencode-go", "other-session");
		const blocked = await authStorage.markUsageLimitReached("opencode-go", "other-session", {
			retryAfterMs: 2_000,
		});
		expect(blocked.switched).toBe(true);
		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached");

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, agent.sessionId),
			initialState: {
				model: exhaustedModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				mock.push(
					requestedModels.length === 1
						? {
								throw: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
							}
						: { content: ["recovered after sibling unblock"], stopReason: "stop" },
				);
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxDelayMs": 300_000,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
		});
		settings.setModelRole("default", `${exhaustedModel.provider}/${exhaustedModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Trigger the long OpenCode Go limit while a sibling is briefly blocked");
		await session.waitForIdle();
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		const usageLimitResult = usageLimitSpy.mock.results[0]?.value;
		expect(usageLimitResult).toBeDefined();
		expect(await usageLimitResult).toMatchObject({ retryAtMs: expect.any(Number), switched: false });

		expect(requestedModels).toEqual([
			`${exhaustedModel.provider}/${exhaustedModel.id}`,
			`${exhaustedModel.provider}/${exhaustedModel.id}`,
		]);
		expect(fallbackEvents).toEqual([]);
		expect(waitSpy.mock.calls.some(call => call[0] >= 1_000 && call[0] <= 3_000)).toBe(true);
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "recovered after sibling unblock",
		});
	});

	it("honors the reason backoff for a transient rate-limit 429 without a provider hint", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "429 Rate limit exceeded, too many requests" },
				{ content: ["recovered after rate-limit window"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 60_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger transient rate limit without retry-after");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBe(30_000);
		expect(waitSpy.mock.calls.some(call => call[0] === 30_000)).toBe(true);
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "recovered after rate-limit window",
		});
	});

	it("auto-retries OpenAI Responses stream_read_error instead of stopping the conversation", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.setRuntimeApiKey("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "Error Code stream_read_error: stream_read_error" },
				{ content: ["recovered after stream read retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger stream read retry");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after stream read retry" });
	});

	it("auto-retries an empty Anthropic stream truncated before message_stop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "Anthropic stream envelope error: stream ended before message_stop" },
				{ content: ["recovered after envelope retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger empty envelope retry");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after envelope retry" });
	});

	it("auto-retries Unable to connect transport failures instead of stopping the conversation", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.setRuntimeApiKey("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "Unable to connect. Is the computer able to access the url?" },
				{ content: ["recovered after connection retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger unable to connect retry");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after connection retry" });
	});

	it("marks extension agent_end willContinue when auto-retry schedules a continue", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.setRuntimeApiKey("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "Error Code stream_read_error: stream_read_error" },
				{ content: ["recovered after stream read retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const extensionEmits: Array<{ type: string; willContinue?: boolean }> = [];
		// Partial ExtensionRunner double — same pattern as sibling agent-session tests;
		// only emit surfaces used on the auto-retry path are implemented.
		const extensionRunner = {
			emit: async (event: { type: string; willContinue?: boolean }) => {
				extensionEmits.push({ type: event.type, willContinue: event.willContinue });
			},
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: () => false,
			emitSessionStop: async () => undefined,
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		await session.prompt("Trigger stream read retry");
		await session.waitForIdle();

		const agentEnds = extensionEmits.filter(event => event.type === "agent_end");
		expect(agentEnds.length).toBeGreaterThanOrEqual(2);
		// First settle is the failed attempt that scheduled continue; final settle is terminal.
		expect(agentEnds[0]?.willContinue).toBe(true);
		expect(agentEnds.at(-1)?.willContinue).toBeFalsy();
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("rolls through four sibling credentials inside one AgentSession prompt before delay-cap retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled primary and fallback test models to exist");
		}
		const providerSessionId = "retry-four-credential-session-3";

		registerMockApi(RETRY_CAP_MOCK_API_SOURCE);
		authStorage.removeRuntimeApiKey("anthropic");
		authStorage.setRuntimeApiKey("openai", "openai-fallback-key");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-A" },
			{ type: "api_key", key: "anthropic-key-B" },
			{ type: "api_key", key: "anthropic-key-C" },
			{ type: "api_key", key: "anthropic-key-D" },
		]);

		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
		const requestedKeys: string[] = [];
		const mock = createMockModel({
			id: model.id,
			provider: model.provider,
			handler: (_context, options) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
				if (!apiKey) {
					throw new Error("Expected streamSimple to pass a resolved string API key");
				}
				requestedKeys.push(apiKey);
				// Succeed only once the fourth distinct sibling is attempted; the
				// session-hash start index is arbitrary, so the repro must not pin
				// which credential comes first — only that all four are rolled through.
				return new Set(requestedKeys).size >= 4
					? { content: ["recovered on fourth credential"], stopReason: "stop" }
					: { throw: rateLimitError };
			},
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, providerSessionId),
			sessionId: providerSessionId,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return aiStream.streamSimple(mock.model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
			"retry.maxRetries": 0,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId,
		});

		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit with long retry-after");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(requestedKeys).toHaveLength(4);
		expect(new Set(requestedKeys).size).toBe(4);
		expect(mock.calls).toHaveLength(4);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(0);
		expect(session.model?.provider).toBe(model.provider);
		expect(session.model?.id).toBe(model.id);
		for (const call of mock.calls) {
			expect(call.context.messages.filter(message => message.role === "user")).toHaveLength(1);
		}
		expect(session.agent.state.messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(
			session.agent.state.messages.some(
				message => message.role === "custom" && "customType" in message && message.customType === "irc:incoming",
			),
		).toBe(false);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered on fourth credential" });
	});

	it("switches same-provider credentials before model fallback on ChatGPT usage limits", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled primary and fallback test models to exist");
		}

		authStorage.removeRuntimeApiKey("anthropic");
		authStorage.setRuntimeApiKey("openai", "openai-fallback-key");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		const usageLimitError = "Error: You have hit your ChatGPT usage limit (k12 plan). Try again in ~231 min.";
		const mock = createMockModel();
		const requestedModels: string[] = [];
		const requestedKeys: string[] = [];
		const agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, agent.sessionId),
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				const apiKey = resolveInitialApiKey(options?.apiKey);
				requestedKeys.push(apiKey);
				if (requestedKeys.length === 1) {
					mock.push({ throw: usageLimitError });
				} else {
					mock.push({ content: ["recovered after sibling account"] });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		await session.prompt("Trigger k12 usage limit");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect([...requestedKeys].sort()).toEqual(["anthropic-key-1", "anthropic-key-2"]);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after sibling account" });
	});

	it("tries every Codex account before the configured model fallback on cyber-policy denials", async () => {
		const primaryModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled primary and fallback test models to exist");
		}
		const providerSessionId = "cyber-policy-account-rotation";

		registerMockApi(RETRY_CAP_MOCK_API_SOURCE);
		authStorage.setRuntimeApiKey("openai", "openai-fallback-key");
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "codex-key-A" },
			{ type: "api_key", key: "codex-key-B" },
			{ type: "api_key", key: "codex-key-C" },
			{ type: "api_key", key: "codex-key-D" },
		]);

		const requestedKeys: string[] = [];
		const mock = createMockModel({
			id: primaryModel.id,
			provider: primaryModel.provider,
			handler: (_context, options) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
				if (!apiKey) throw new Error("Expected streamSimple to pass a resolved string API key");
				requestedKeys.push(apiKey);
				return new Set(requestedKeys).size >= 4
					? { content: ["recovered on cyber-approved account"], stopReason: "stop" }
					: CYBER_POLICY_FAILURE;
			},
		});
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, providerSessionId),
			sessionId: providerSessionId,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return aiStream.streamSimple(mock.model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxRetries": 0,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId,
		});

		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Continue authorized security work");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(requestedKeys).toHaveLength(4);
		expect([...requestedKeys].sort()).toEqual(["codex-key-A", "codex-key-B", "codex-key-C", "codex-key-D"]);
		expect(fallbackEvents).toEqual([]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "recovered on cyber-approved account",
		});
	});

	it("tries sibling Codex accounts before advisor model fallback on cyber-policy denials", async () => {
		const mainModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const advisorModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		const fallbackModel = getBundledModel("openai", "gpt-5.5");
		if (!mainModel || !advisorModel || !fallbackModel) {
			throw new Error("Expected bundled main, advisor, and fallback test models to exist");
		}

		registerMockApi(RETRY_CAP_MOCK_API_SOURCE);
		authStorage.setRuntimeApiKey("openai", "openai-fallback-key");
		await authStorage.set("openai-codex", [
			{ type: "api_key", key: "advisor-codex-key-A" },
			{ type: "api_key", key: "advisor-codex-key-B" },
			{ type: "api_key", key: "advisor-codex-key-C" },
		]);

		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const requestedAdvisorKeys: string[] = [];
		const advisorRecovered = Promise.withResolvers<void>();
		const advisorMock = createMockModel({
			id: advisorModel.id,
			provider: advisorModel.provider,
			handler: (_context, options) => {
				const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
				if (!apiKey) throw new Error("Expected advisor streamSimple to pass a resolved string API key");
				requestedAdvisorKeys.push(apiKey);
				if (new Set(requestedAdvisorKeys).size < 3) return CYBER_POLICY_FAILURE;
				advisorRecovered.resolve();
				return { content: ["Advisor recovered on cyber-approved account"], stopReason: "stop" };
			},
		});
		const requestedAdvisorModels: string[] = [];
		const advisorSelector = `${advisorModel.provider}/${advisorModel.id}`;
		const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: mainModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mainMock.stream,
		});

		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.maxRetries": 0,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				[advisorSelector]: [fallbackSelector],
			},
		});
		settings.setModelRole("default", `${mainModel.provider}/${mainModel.id}`);
		settings.setModelRole("advisor", advisorSelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "cyber-policy", model: advisorSelector }],
			advisorStreamFn: (requestedModel, context, options) => {
				requestedAdvisorModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return aiStream.streamSimple(advisorMock.model, context, options);
			},
		});

		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("Complete one primary turn");
		await advisorRecovered.promise;
		await session.waitForIdle();

		expect(requestedAdvisorModels).toEqual([advisorSelector, advisorSelector, advisorSelector]);
		expect([...requestedAdvisorKeys].sort()).toEqual([
			"advisor-codex-key-A",
			"advisor-codex-key-B",
			"advisor-codex-key-C",
		]);
		expect(fallbackEvents).toEqual([]);
		expect(session.getAdvisorAgent()?.state.model).toMatchObject({
			provider: advisorModel.provider,
			id: advisorModel.id,
		});
	});

	it("waits for the earliest sibling unblock instead of failing the delay cap", async () => {
		// Regression: with every sibling credential momentarily blocked (e.g. a
		// short post-401 or usage-probe block), a usage-limit 429 with a
		// multi-hour retry-after used to adopt the full provider wait and trip
		// the fail-fast cap ("gave up after 1 attempt") — even though a sibling
		// would have been usable seconds later. The retry delay must track the
		// earliest sibling unblock, not the provider window.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		// Another session holds one credential and parks it for 2s — the test
		// session lands on the sibling.
		await modelRegistry.getApiKeyForProvider("anthropic", "other-session");
		const blocked = await authStorage.markUsageLimitReached("anthropic", "other-session", { retryAfterMs: 2_000 });
		expect(blocked.switched).toBe(true);

		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
		const mock = createMockModel();
		let attempts = 0;
		const agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				attempts += 1;
				mock.push(attempts === 1 ? { throw: rateLimitError } : { content: ["recovered after sibling unblock"] });
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit while the sibling is briefly blocked");
		await session.waitForIdle();

		expect(attempts).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		// ~2s sibling block + 1s buffer — NOT the provider's 11180s window and
		// NOT the fail-fast bail (which would emit zero start events).
		expect(retryStartEvents[0].delayMs).toBeGreaterThanOrEqual(1_000);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(3_000);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(5_000);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after sibling unblock" });
	});

	it("still retries normally when the delay is under retry.maxDelayMs", async () => {
		// Sanity check: a small retry-after MUST still go through the retry
		// loop so we don't regress the existing transient-error recovery.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=50" },
				{ content: ["recovered after short backoff"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger transient with short retry-after");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(5_000);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(waitSpy).toHaveBeenCalled();
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});

	it("auto-retries a timeout after streaming a complete unexecuted write tool call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tc-write",
			name: "write",
			arguments: { path: "doc/report.md", content: "large report chunk" },
		};
		let streamCalls = 0;
		let resumedWithSyntheticResult = false;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					const matchingResult = context.messages.find(
						message => message.role === "toolResult" && message.toolCallId === toolCall.id,
					);
					resumedWithSyntheticResult =
						matchingResult?.role === "toolResult" &&
						typeof matchingResult.details === "object" &&
						matchingResult.details !== null &&
						"executed" in matchingResult.details &&
						matchingResult.details.executed === false;
					const recoveryModel = createMockModel({
						id: requestedModel.id,
						provider: requestedModel.provider,
					});
					recoveryModel.push({ content: ["Recovered after timeout"] });
					return recoveryModel.stream(recoveryModel, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					partial.content.push(toolCall);
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							errorMessage: "The operation timed out.",
							duration: 1000,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Write a large report");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(resumedWithSyntheticResult).toBe(true);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "Recovered after timeout",
		});
	});

	it.each([
		["OpenAI-completions stall", "error", "OpenAI completions stream stalled while waiting for the next event"],
		[
			"pi-native premature close",
			"error",
			"pi-native stream read error: stream closed before a terminal response event",
		],
		["reasonless abort", "aborted", "Request was aborted"],
	] as const)("resumes a %s after a synthetic unexecuted tool result", async (_case, stopReason, errorMessage) => {
		const model = createMockModel({
			id: "grok-4",
			provider: "openrouter",
		});
		authStorage.setRuntimeApiKey("openrouter", "openrouter-test-key");
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "grok-write-1",
			name: "write",
			arguments: { path: "review.md", content: "partial review" },
		};
		let streamCalls = 0;
		let resumedWithSyntheticResult = false;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (_requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					const matchingResult = context.messages.find(
						message => message.role === "toolResult" && message.toolCallId === toolCall.id,
					);
					resumedWithSyntheticResult =
						matchingResult?.role === "toolResult" &&
						typeof matchingResult.details === "object" &&
						matchingResult.details !== null &&
						"executed" in matchingResult.details &&
						matchingResult.details.executed === false;
					model.push({ content: ["Recovered after interrupted tool call"] });
					return model.stream(model, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [toolCall],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: stopReason,
						error: {
							...partial,
							stopReason,
							errorMessage,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Write a review");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(resumedWithSyntheticResult).toBe(true);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "toolResult" && message.toolCallId === toolCall.id,
			),
		).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "Recovered after interrupted tool call",
		});
	});

	it("resumes a stalled Cursor stream after its exec tool result", async () => {
		const stallMessage = "Provider stream stalled while waiting for the next event";
		const model = createMockModel({
			id: "composer-2.5",
			provider: "cursor",
		});
		authStorage.setRuntimeApiKey("cursor", "cursor-test-key");
		const toolCall = {
			type: "toolCall" as const,
			id: "cursor-shell-1",
			name: "shell",
			arguments: { command: "pwd" },
			[kCursorExecResolved]: true as const,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "/workspace" }],
			isError: false,
			timestamp: Date.now(),
		};
		let streamCalls = 0;
		let resumedWithToolResult = false;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			cursorOnToolResult: message => message,
			streamFn: (_requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					resumedWithToolResult = context.messages.some(
						message => message.role === "toolResult" && message.toolCallId === toolCall.id,
					);
					model.push({ content: ["Recovered after Cursor stall"] });
					return model.stream(model, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					await options?.cursorOnToolResult?.(toolResult);
					const partial: AssistantMessage = {
						role: "assistant",
						content: [toolCall],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							errorMessage: stallMessage,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Run pwd");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(resumedWithToolResult).toBe(true);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "toolResult" && message.toolCallId === toolCall.id,
			),
		).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({ type: "text", text: "Recovered after Cursor stall" });
	});

	it("resumes a Cursor HTTP/2 stream reset after an unmarked MCP tool result", async () => {
		const resetMessage = "Stream closed with error code NGHTTP2_INTERNAL_ERROR";
		const model = createMockModel({
			id: "composer-2.5",
			provider: "cursor",
		});
		authStorage.setRuntimeApiKey("cursor", "cursor-test-key");
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "cursor-mcp-1",
			name: "mcp__databricks_production_execute_sql",
			arguments: { query: "SELECT 1" },
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "1" }],
			isError: false,
			timestamp: Date.now(),
		};
		let streamCalls = 0;
		let resumedWithToolResult = false;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			cursorOnToolResult: message => message,
			streamFn: (_requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					resumedWithToolResult = context.messages.some(
						message => message.role === "toolResult" && message.toolCallId === toolCall.id,
					);
					model.push({ content: ["Recovered after Cursor HTTP/2 reset"] });
					return model.stream(model, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					await options?.cursorOnToolResult?.(toolResult);
					const partial: AssistantMessage = {
						role: "assistant",
						content: [toolCall],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							errorMessage: resetMessage,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Run the query");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(resumedWithToolResult).toBe(true);
		expect(
			session.agent.state.messages.some(
				message => message.role === "toolResult" && message.toolCallId === toolCall.id,
			),
		).toBe(true);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "Recovered after Cursor HTTP/2 reset",
		});
	});

	it("resumes a Cursor idle stall after an unmarked MCP tool result", async () => {
		const stallMessage = "Provider stream stalled while waiting for the next event";
		const model = createMockModel({
			id: "composer-2.5",
			provider: "cursor",
		});
		authStorage.setRuntimeApiKey("cursor", "cursor-test-key");
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "cursor-mcp-idle-1",
			name: "mcp__databricks_production_execute_sql",
			arguments: { query: "SELECT 1" },
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "1" }],
			isError: false,
			timestamp: Date.now(),
		};
		let streamCalls = 0;
		let resumedWithToolResult = false;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			cursorOnToolResult: message => message,
			streamFn: (_requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					resumedWithToolResult = context.messages.some(
						message => message.role === "toolResult" && message.toolCallId === toolCall.id,
					);
					model.push({ content: ["Recovered after Cursor idle stall"] });
					return model.stream(model, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					await options?.cursorOnToolResult?.(toolResult);
					const partial: AssistantMessage = {
						role: "assistant",
						content: [toolCall],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							errorMessage: stallMessage,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Run the query");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(resumedWithToolResult).toBe(true);
		expect(
			session.agent.state.messages.some(
				message => message.role === "toolResult" && message.toolCallId === toolCall.id,
			),
		).toBe(true);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "Recovered after Cursor idle stall",
		});
	});

	it("resumes a Cursor reasonless abort after an unmarked client-side tool call", async () => {
		const model = createMockModel({
			id: "composer-2.5",
			provider: "cursor",
		});
		authStorage.setRuntimeApiKey("cursor", "cursor-test-key");
		// Cursor emits `todo` client-side without the server-execution marker; a
		// reasonless abort after it must still recover (issue #6668 review).
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "cursor-todo-1",
			name: "todo",
			arguments: { ops: [] },
		};
		let streamCalls = 0;
		let resumedWithSyntheticResult = false;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (_requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					const matchingResult = context.messages.find(
						message => message.role === "toolResult" && message.toolCallId === toolCall.id,
					);
					resumedWithSyntheticResult =
						matchingResult?.role === "toolResult" &&
						typeof matchingResult.details === "object" &&
						matchingResult.details !== null &&
						"executed" in matchingResult.details &&
						matchingResult.details.executed === false;
					model.push({ content: ["Recovered after Cursor reasonless abort"] });
					return model.stream(model, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [toolCall],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(toolCall.arguments),
						partial,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					stream.push({
						type: "error",
						reason: "aborted",
						error: {
							...partial,
							stopReason: "aborted",
							errorMessage: "Request was aborted",
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Update the todo list");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(resumedWithSyntheticResult).toBe(true);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "toolResult" && message.toolCallId === toolCall.id,
			),
		).toHaveLength(1);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "Recovered after Cursor reasonless abort",
		});
	});

	it.each([
		["verbose socket close", "The socket connection was closed unexpectedly"],
		["bare socket close", "Socket is closed"],
		["pi-native premature close", "pi-native stream read error: stream closed before a terminal response event"],
		["gateway 500", "auth-gateway 500: <none>"],
		["gateway 524", "auth-gateway 524: <none>"],
	])("retries a transient %s after partial text and thinking", async (_label, errorMessage) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				streamCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};

					if (streamCalls === 1) {
						const thinking = { type: "thinking" as const, thinking: "partial thought" };
						const text = { type: "text" as const, text: "partial buffered answer" };
						partial.content.push(thinking, text);
						stream.push({ type: "start", partial });
						stream.push({ type: "thinking_start", contentIndex: 0, partial });
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
						stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
						stream.push({ type: "text_start", contentIndex: 1, partial });
						stream.push({ type: "text_delta", contentIndex: 1, delta: text.text, partial });
						stream.push({
							type: "error",
							reason: "error",
							error: {
								...partial,
								stopReason: "error",
								errorMessage,
								duration: 1000,
							},
						});
						return;
					}

					const recovered = { type: "text" as const, text: "recovered after partial socket close" };
					partial.content.push(recovered);
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.push({ type: "text_delta", contentIndex: 0, delta: recovered.text, partial });
					stream.push({ type: "text_end", contentIndex: 0, content: recovered.text, partial });
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...partial,
							stopReason: "stop",
							duration: 1000,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		session.setTextOutputCommitted(false);
		await session.prompt("Trigger partial socket close");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after partial socket close" });
	});

	it("retries on Bun HTTP/2 stream reset errors", async () => {
		// Regression: Bun's fetch surfaces HTTP/2 RST_STREAM as `Error: HTTP2StreamReset
		// fetching "<url>". For more information, pass \`verbose: true\` ...`. The verbatim
		// message contains no "503", "overloaded", or "network error" hooks, so without the
		// dedicated HTTP2(StreamReset|RefusedStream|EnhanceYourCalm) carveout the assistant
		// turn fails terminally even though the underlying condition is transient.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					throw: 'HTTP2StreamReset fetching "https://chatgpt.com/backend-api/codex/responses". For more information, pass `verbose: true` in the second argument to fetch()',
				},
				{ content: ["recovered after stream reset"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger HTTP/2 stream reset");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});
	it("retries generic upstream_error gateway failures", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "upstream_error: Upstream request failed" },
				{ content: ["recovered after generic gateway upstream error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger generic upstream_error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after generic gateway upstream error" });
	});

	it("retries empty reasonless aborted turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["recovered after empty reasonless abort"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Trigger empty aborted turn");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after empty reasonless abort" });
	});

	it("does not retry reasonless aborted turns that have partial content", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [{ content: ["partial"], stopReason: "aborted", errorMessage: "Request was aborted" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger partial aborted turn");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("aborted");
		expect(last.content).toContainEqual({ type: "text", text: "partial" });
	});

	it("records visible-text usage limits without replaying the failed turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const usageLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';
		const mock = createMockModel({
			responses: [{ content: ["Already visible"], stopReason: "error", errorMessage: usageLimitError }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const usageLimitSpy = vi.spyOn(authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger visible usage limit");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		expect(usageLimitSpy).toHaveBeenCalledTimes(1);
		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.content).toContainEqual({ type: "text", text: "Already visible" });
	});

	it("does not auto-retry empty reasonless aborts once the session is disposing", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// A dispose-driven abort produces the same empty/reason-less shape as a
		// transient provider abort. It MUST settle the turn instead of entering
		// auto-retry: a retry here schedules a continuation that the disposed guard
		// skips without resolving #retryPromise, hanging prompt() during shutdown.
		const mock = createMockModel({
			responses: [
				{ stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["should not be reached after dispose"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		// Enter the disposing window before the empty abort lands. Without the
		// #isDisposed guard this prompt would hang on an orphaned retry promise.
		session.beginDispose();
		await session.prompt("Trigger empty aborted turn while disposing");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		// No retry continuation fired, so the second scripted response is untouched.
		expect(mock.calls).toHaveLength(1);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("aborted");
	});

	async function expectThinkingStreamCloseRetryCap(options: {
		model: Model;
		errorMessage: string;
		prompt: string;
	}): Promise<void> {
		authStorage.setRuntimeApiKey(options.model.provider, `${options.model.provider}-test-key`);
		let calls = 0;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model: options.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				calls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const usage: AssistantMessage["usage"] = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					if (calls > 2) {
						const text: TextContent = { type: "text", text: "must remain unused" };
						const message: AssistantMessage = {
							role: "assistant",
							content: [text],
							api: requestedModel.api,
							provider: requestedModel.provider,
							model: requestedModel.id,
							usage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					const thinking: ThinkingContent = { type: "thinking", thinking: "" };
					const message: AssistantMessage = {
						role: "assistant",
						content: [thinking],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage,
						stopReason: "error",
						errorMessage: options.errorMessage,
						errorId: AIError.create(AIError.Flag.Transient),
						timestamp: Date.now(),
					};
					const delta = `reasoning attempt ${calls}`;
					stream.push({ type: "start", partial: message });
					stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
					thinking.thinking = delta;
					stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: message });
					stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 10,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${options.model.provider}/${options.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt(options.prompt);
		await session.waitForIdle();

		expect(calls).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 1 });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(lastAssistant(session).errorMessage).toBe(`Retry budget exhausted after 1 retry: ${options.errorMessage}`);
		expect(session.isRetrying).toBe(false);
	}

	it("caps repeated OpenRouter stream closes after streamed thinking at one retry", async () => {
		const model = getBundledModel("openrouter", "~google/gemini-flash-latest");
		if (!model) {
			throw new Error("Expected bundled OpenRouter Gemini test model to exist");
		}
		await expectThinkingStreamCloseRetryCap({
			model,
			errorMessage: "server_error: stream closed with reason: error",
			prompt: "Trigger OpenRouter reasoning transition failure",
		});
	});

	it("caps repeated Copilot Grok Responses closes after streamed thinking at one retry", async () => {
		const model = getBundledModel("github-copilot", "grok-4.6");
		if (!model) {
			throw new Error("Expected bundled Copilot Grok 4.6 test model to exist");
		}
		await expectThinkingStreamCloseRetryCap({
			model,
			errorMessage: "OpenAI responses stream closed before a terminal response event was received",
			prompt: "Trigger Copilot Grok Responses incomplete stream",
		});
	});

	it("defaults 502 auto-retry to ten capped backoff attempts", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel();
		let attempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				attempts += 1;
				mock.push(
					attempts <= 10
						? { throw: "502 Bad Gateway upstream_error" }
						: { content: ["recovered after default 502 retry budget"] },
				);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(Math, "random").mockReturnValue(0);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger repeated 502s");
		await session.waitForIdle();

		expect(attempts).toBe(11);
		expect(retryStartEvents).toHaveLength(10);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		expect(retryStartEvents.map(event => event.maxAttempts)).toEqual(new Array(10).fill(10));
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([
			500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000,
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 10 });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after default 502 retry budget" });
	});
});
