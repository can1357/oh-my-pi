import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveProviderMaxRetries } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { CustomTool, CustomToolSessionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createCustomToolsExtension } from "@oh-my-pi/pi-coding-agent/sdk";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";
const LONG_RETRY_AFTER_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after=11180.0005';

function lastErrorMessage(session: AgentSession): string {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant" || typeof message.errorMessage !== "string") {
		throw new Error("Expected trailing assistant error message");
	}
	return message.errorMessage;
}

describe("retry.maxRetriesOverrides", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-overrides-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(async () => {
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
		unregisterCustomApis("agent-session-retry-overrides-test");
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	describe("resolveProviderMaxRetries", () => {
		it("resolves exact provider keys, the wildcard fallback, and rejects malformed entries", () => {
			expect(resolveProviderMaxRetries({ zen: "unlimited" }, "zen")).toBe("unlimited");
			expect(resolveProviderMaxRetries({ zen: "unlimited" }, "other")).toBeUndefined();
			expect(resolveProviderMaxRetries({ "*": 2 }, "other")).toBe(2);
			expect(resolveProviderMaxRetries({ zen: 2, "*": 5 }, "zen")).toBe(2);
			expect(resolveProviderMaxRetries({ zen: 2, "*": 5 }, "other")).toBe(5);
			expect(
				resolveProviderMaxRetries({ zen: "UNLIMITED" } as unknown as Record<string, number | "unlimited">, "zen"),
			).toBeUndefined();
			expect(resolveProviderMaxRetries({ zen: -1 }, "zen")).toBeUndefined();
			expect(resolveProviderMaxRetries({ zen: Number.NaN }, "zen")).toBeUndefined();
			expect(resolveProviderMaxRetries({ zen: 2.7 }, "zen")).toBe(2);
			expect(resolveProviderMaxRetries({}, "zen")).toBeUndefined();
			expect(resolveProviderMaxRetries(undefined, "zen")).toBeUndefined();
			expect(resolveProviderMaxRetries({ zen: 3 }, undefined)).toBeUndefined();
		});
	});

	it("per-provider override replaces the global budget", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		const mock = createMockModel({ handler: () => ({ throw: RETRIABLE_SERVER_ERROR }) });
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
			"retry.maxRetries": 1,
			"retry.maxRetriesOverrides": { anthropic: 3 },
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

		await session.prompt("Trigger retriable server errors");
		await session.waitForIdle();

		// Global budget of 1 would have stopped after a single retry; the
		// anthropic override of 3 owns the saga instead.
		expect(retryStartEvents).toHaveLength(3);
		expect(retryStartEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 3 });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			success: false,
			attempt: 3,
			reason: "budget-exhausted",
			provider: "anthropic",
			model: model.id,
		});
		expect(lastErrorMessage(session)).toBe(`Retry budget exhausted after 3 retries: ${RETRIABLE_SERVER_ERROR}`);
		expect(session.isRetrying).toBe(false);
	});

	it('"unlimited" keeps retrying past the global cap until the provider recovers', async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		const mock = createMockModel({
			responses: [
				{ throw: RETRIABLE_SERVER_ERROR },
				{ throw: RETRIABLE_SERVER_ERROR },
				{ throw: RETRIABLE_SERVER_ERROR },
				{ throw: RETRIABLE_SERVER_ERROR },
				{ content: ["recovered after repeated stream deaths"], stopReason: "stop" },
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
			"retry.maxRetries": 1,
			"retry.maxRetriesOverrides": { anthropic: "unlimited" },
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

		await session.prompt("Trigger retriable server errors, then recover");
		await session.waitForIdle();

		// Four failures each retried; the fifth turn succeeds and ends the saga.
		expect(retryStartEvents).toHaveLength(4);
		expect(retryStartEvents[0].maxAttempts).toBe("unlimited");
		// RPC (`rpc-frame.ts`) and collab (`crypto.ts`) serialize events with raw
		// `JSON.stringify`, which maps `Infinity` to `null`. The sentinel must
		// survive that exact encoding.
		expect(JSON.parse(JSON.stringify(retryStartEvents[0])).maxAttempts).toBe("unlimited");
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(retryEndEvents[0].reason).toBeUndefined();
		expect(session.isRetrying).toBe(false);
	});

	it("delay-cap terminal failures carry delay-cap-exceeded enrichment", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		const mock = createMockModel({ handler: () => ({ throw: LONG_RETRY_AFTER_ERROR }) });
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
			"retry.maxDelayMs": 100,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger rate limit with long retry-after");
		await session.waitForIdle();

		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			success: false,
			reason: "delay-cap-exceeded",
			provider: "anthropic",
			model: model.id,
		});
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		expect(session.isRetrying).toBe(false);
	});

	it("a fallback switch grants the new route its own override budget", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const requestedModels: string[] = [];
		let fallbackCalls = 0;
		const mock = createMockModel();
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
				if (requestedModel.provider === primaryModel.provider) {
					mock.push({ throw: RETRIABLE_SERVER_ERROR });
				} else if (requestedModel.provider === fallbackModel.provider) {
					fallbackCalls++;
					mock.push(
						fallbackCalls === 1
							? { throw: RETRIABLE_SERVER_ERROR }
							: { content: ["recovered on fallback route"] },
					);
				} else {
					throw new Error(`Unexpected model requested: ${requestedModel.provider}/${requestedModel.id}`);
				}
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 10,
			"retry.maxRetriesOverrides": { openai: 1 },
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);
		// The fallback consult resolves the candidate's key through the
		// registry (not the Agent's getApiKey): without this the switch is
		// skipped and the saga stays on the primary.
		authStorage.setRuntimeApiKey("openai", "openai-test-key");

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

		await session.prompt("Fail once on primary, then recover on fallback");
		await session.waitForIdle();

		// Primary fails once (saga attempt 1 of its global-10 budget) and the
		// chain switches. The fallback's own override (1) then owns its route:
		// its first failure retries under its own budget and the second serve
		// succeeds. Event numbering stays saga-cumulative while the budget
		// check is per-route. A saga-wide budget counter would check the
		// fallback's first failure as global attempt 2 > 1 and kill the saga
		// before the fallback ever retried.
		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 10 });
		expect(retryStartEvents[1]).toMatchObject({ attempt: 2, maxAttempts: 1 });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(retryEndEvents[0].reason).toBeUndefined();
		expect(session.isRetrying).toBe(false);
	});

	it("the SDK custom-tools bridge forwards terminal enrichment to onSession", async () => {
		// AgentSession only stores `preparedExtensions` for fork forwarding —
		// binding happens in the SDK/CLI loader — so the observable `onSession`
		// translation is driven here through the real factory with a stub API.
		// The translation under test is the exact handler the extension runner
		// invokes on `auto_retry_end`; runner emission itself is pre-existing
		// machinery covered by session.subscribe assertions above.
		const seen: CustomToolSessionEvent[] = [];
		const probe: CustomTool = {
			name: "retry_enrichment_probe",
			label: "retry-enrichment-probe",
			description: "Captures session events for the retry enrichment test.",
			parameters: { type: "object" },
			async execute() {
				return { content: [{ type: "text", text: "" }] };
			},
			onSession: event => {
				seen.push(event);
			},
		};
		const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
		createCustomToolsExtension([probe])({
			registerTool: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				handlers[event] = handler;
			},
		} as never);
		const ctx = {
			sessionManager: undefined,
			modelRegistry: undefined,
			model: undefined,
			isIdle: true,
			hasPendingMessages: false,
			abort: () => {},
			localProtocolOptions: undefined,
		};
		await handlers["auto_retry_end"]?.(
			{
				type: "auto_retry_end",
				success: false,
				attempt: 2,
				finalError: RETRIABLE_SERVER_ERROR,
				reason: "budget-exhausted",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
			ctx,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			reason: "auto_retry_end",
			success: false,
			// `reason` is the envelope discriminator, so the failure cause
			// travels as `failureReason`.
			failureReason: "budget-exhausted",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
		// Terminal success carries no enrichment: the optional fields stay absent.
		seen.length = 0;
		await handlers["auto_retry_end"]?.({ type: "auto_retry_end", success: true, attempt: 3 }, ctx);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ reason: "auto_retry_end", success: true });
		// The bridge forwards enrichment keys unconditionally (same as the
		// pre-existing finalError/retryErrors forwarding): on success they
		// are present-but-undefined, which JSON.stringify drops on the wire.
		if (seen[0].reason !== "auto_retry_end") throw new Error("Expected auto_retry_end event");
		expect(seen[0].failureReason).toBeUndefined();
		expect(seen[0].provider).toBeUndefined();
		expect(seen[0].model).toBeUndefined();
	});
});
