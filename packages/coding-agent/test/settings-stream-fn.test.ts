/**
 * Contract: `createSettingsAwareStreamFn` layers session provider settings
 * (`providers.openrouterVariant`, `providers.antigravityEndpoint`,
 * `providers.stream*TimeoutSeconds`, `providers.maxInFlightRequests`,
 * `model.loopGuard.*`, `textVerbosity` for Responses-family requests)
 * options win — the same wiring the main agent and the advisor agent share so
 * OpenRouter sticky-routing / response caching behaves the same on advisor turns
 * (can1357/oh-my-pi#3639).
 */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { type Context, type Model, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import { configureProviderStoreResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgProvidersMuseCodeStoreResponses } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";

function captureBase(): { fn: StreamFn; calls: Array<{ options?: SimpleStreamOptions }> } {
	const calls: Array<{ options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (_model, _context, options) => {
		calls.push({ options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

const stubModel = {} as unknown as Model;
const stubCodexModel = { api: "openai-codex-responses" } as unknown as Model;
const stubResponsesModel = { api: "openai-responses" } as unknown as Model;
const stubContext = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;

describe("createSettingsAwareStreamFn", () => {
	it("applies provider settings to the forwarded options when caller omits them", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
			"model.loopGuard.checkAssistantContent": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, { apiKey: "k" });

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("floor");
		expect(options?.antigravityEndpointMode).toBe("sandbox");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 4 });
		expect(options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
		// caller's own option is preserved
		expect(options?.apiKey).toBe("k");
	});

	it("forwards configured hidden thinking summaries", () => {
		const settings = Settings.isolated({ omitThinking: true });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(true);
	});

	it("applies Codex text verbosity only when settings or caller options configure it", () => {
		const unconfiguredSettings = Settings.isolated({});
		const { fn: unconfiguredBase, calls: unconfiguredCalls } = captureBase();
		const unconfiguredWrapped = createSettingsAwareStreamFn(unconfiguredSettings, unconfiguredBase);

		unconfiguredWrapped(stubCodexModel, stubContext, undefined);
		unconfiguredWrapped(stubCodexModel, stubContext, { textVerbosity: "medium" });

		expect(unconfiguredCalls[0]?.options?.textVerbosity).toBeUndefined();
		expect(unconfiguredCalls[1]?.options?.textVerbosity).toBe("medium");

		const settings = Settings.isolated({ textVerbosity: "low" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubCodexModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, { textVerbosity: "medium" });

		expect(calls[0]?.options?.textVerbosity).toBe("low");
		expect(calls[1]?.options?.textVerbosity).toBe("low");
		expect(calls[2]?.options?.textVerbosity).toBe("medium");
	});

	it("forwards configured stream watchdog budgets while preserving caller overrides", () => {
		const settings = Settings.isolated({
			"providers.streamFirstEventTimeoutSeconds": 600,
			"providers.streamIdleTimeoutSeconds": 300,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, {
			streamFirstEventTimeoutMs: 15_000,
			streamIdleTimeoutMs: 10_000,
		});

		expect(calls[0]?.options?.streamFirstEventTimeoutMs).toBe(600_000);
		expect(calls[0]?.options?.streamIdleTimeoutMs).toBe(300_000);
		expect(calls[1]?.options?.streamFirstEventTimeoutMs).toBe(15_000);
		expect(calls[1]?.options?.streamIdleTimeoutMs).toBe(10_000);
	});

	it("forwards retry.maxDelayMs while preserving caller overrides", () => {
		const settings = Settings.isolated({ "retry.maxDelayMs": 300_000 });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, { maxRetryDelayMs: 5_000 });

		expect(calls[0]?.options?.maxRetryDelayMs).toBe(300_000);
		expect(calls[1]?.options?.maxRetryDelayMs).toBe(5_000);
	});

	it("forwards the provider retry policy as one shared attempt budget", () => {
		const settings = Settings.isolated({
			"retry.provider.maxRetries": 2,
			"retry.baseDelayMs": 750,
			"retry.provider.timeoutMs": 42_000,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		const options = calls[0]?.options;
		// `retries` are retries: the initial request is part of the allowance.
		expect(options?.providerMaxAttempts).toBe(3);
		expect(options?.providerBaseDelayMs).toBe(750);
		expect(options?.providerTimeoutMs).toBe(42_000);
	});

	it("lets caller options override the provider retry policy", () => {
		const settings = Settings.isolated({
			"retry.provider.maxRetries": 5,
			"retry.baseDelayMs": 750,
			"retry.provider.timeoutMs": 42_000,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			providerMaxAttempts: 1,
			providerBaseDelayMs: 5,
			providerTimeoutMs: 0,
		});

		const options = calls[0]?.options;
		expect(options?.providerMaxAttempts).toBe(1);
		expect(options?.providerBaseDelayMs).toBe(5);
		expect(options?.providerTimeoutMs).toBe(0);
	});

	it("never maps a zero-retry policy to zero attempts", () => {
		const settings = Settings.isolated({ "retry.provider.maxRetries": 0 });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		// One retry-free request is still a request.
		expect(calls[0]?.options?.providerMaxAttempts).toBe(1);
	});

	it("treats the default openrouterVariant as absent so the base call carries no variant", () => {
		const settings = Settings.isolated({ "providers.openrouterVariant": "default" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.openrouterVariant).toBeUndefined();
	});

	it("forwards configured cache retention, leaves auto unset, and lets callers override", () => {
		const auto = captureBase();
		createSettingsAwareStreamFn(Settings.isolated({}), auto.fn)(stubModel, stubContext, undefined);
		// auto must stay unset so provider defaults and PI_CACHE_RETENTION apply
		expect(auto.calls[0]?.options?.cacheRetention).toBeUndefined();

		const long = captureBase();
		const settings = Settings.isolated({ "providers.cacheRetention": "long" });
		const wrapped = createSettingsAwareStreamFn(settings, long.fn);
		wrapped(stubModel, stubContext, undefined);
		expect(long.calls[0]?.options?.cacheRetention).toBe("long");

		wrapped(stubModel, stubContext, { cacheRetention: "none" });
		expect(long.calls[1]?.options?.cacheRetention).toBe("none");
	});

	it("lets caller-supplied options override the session settings", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			openrouterVariant: "nitro",
			antigravityEndpointMode: "production",
			maxInFlightRequests: { openrouter: 1 },
			loopGuard: { enabled: false },
			hideThinkingSummary: false,
		});

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("nitro");
		expect(options?.antigravityEndpointMode).toBe("production");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 1 });
		// Loop guard merges per-field: caller wins on `enabled`, settings fill
		// the rest (the inline closure the main agent used has the same shape).
		expect(options?.loopGuard?.enabled).toBe(false);
		expect(options?.loopGuard?.checkAssistantContent).toBe(true);
		expect(options?.hideThinkingSummary).toBe(false);
	});

	it("lowers the output cap so prompt plus output fits the model's context window", () => {
		// The reported DeepSeek /btw 400: a 666k-token prompt plus the model's
		// 384k default output cap exceeded the window. Test-env counts are bytes/4.
		const deepseek: Model = {
			...getBundledModel("deepseek", "deepseek-v4-pro"),
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		};
		const promptTokens = 666_387;
		const context = {
			messages: [{ role: "user", content: "x".repeat(promptTokens * 4), timestamp: 0 }],
		} as unknown as Context;
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		wrapped(deepseek, context, { apiKey: "k" });
		wrapped(deepseek, stubContext, { apiKey: "k" });

		const fitted = calls[0]?.options?.maxTokens;
		expect(fitted).toBeGreaterThan(0);
		expect(promptTokens + (fitted ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1_000_000);
		// A prompt that leaves room keeps the transport's own default.
		expect(calls[1]?.options?.maxTokens).toBeUndefined();
	});

	describe("providers.anthropic.serverSideFallback (opt-in)", () => {
		const stubFableModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5",
		} as unknown as Model;
		const stubOpusModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		} as unknown as Model;
		const stubFable51Model = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5-1",
		} as unknown as Model;
		const stubMythosModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-mythos-5-1",
		} as unknown as Model;
		const stubBedrockFableModel = {
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			id: "anthropic.claude-fable-5-1",
		} as unknown as Model;

		it("stays off by default: no fallbacks injected on any model", () => {
			const settings = Settings.isolated({});
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		// Targets must be in the model's `allowed_fallback_models`; Fable 5 / 5.1
		// publish ["claude-opus-4-8", "claude-opus-5"] and reject claude-opus-5-5
		// with a 400 (#13059).
		it.each([
			["Fable 5", stubFableModel],
			["Fable 5.1", stubFable51Model],
			["Mythos 5.1", stubMythosModel],
		])("injects an allowed Opus 5 fallback for %s when the setting is on", (_label, model) => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(model, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-opus-5" }]);
		});

		it("does NOT inject fallbacks for Fable off first-party Anthropic even when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubBedrockFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("does NOT inject fallbacks on non-Fable/Mythos Anthropic models even when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubOpusModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("caller-supplied fallbacks always win over the settings default", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, {
				apiKey: "k",
				fallbacks: [{ model: "claude-sonnet-5" }],
			});

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-sonnet-5" }]);
		});
	});

	describe("providers.muse-code.storeResponses (opt-in)", () => {
		const museModel = getBundledModel("muse-code", "muse-spark-1.3");
		if (!museModel) throw new Error("Expected bundled muse-code model");
		const museCredential = JSON.stringify({ oauthAccessToken: "meta-access", apiKey: "LLM|key" });
		const message = {
			id: "msg_1",
			type: "message",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: "ok", annotations: [] }],
		};
		// A streamed text item, so the turn completes on the first POST (no empty-completion retry).
		const sseBody = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...message, status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "ok" },
			{ type: "response.output_item.done", output_index: 0, item: message },
			{
				type: "response.completed",
				response: {
					id: "resp_store",
					status: "completed",
					output: [message],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		]
			.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
			.join("");

		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

		/** Send one real request via `send` with a capturing fetch; return the wire `store` field. */
		async function wireStore(
			env: string | undefined,
			send: (options: SimpleStreamOptions) => Promise<unknown>,
		): Promise<unknown> {
			const previous = process.env.PI_MUSE_STORE_RESPONSES;
			if (env === undefined) delete process.env.PI_MUSE_STORE_RESPONSES;
			else process.env.PI_MUSE_STORE_RESPONSES = env;
			try {
				const bodies: Array<Record<string, unknown>> = [];
				const fetch = (async (_url: unknown, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
				}) as FetchImpl;
				await send({ apiKey: museCredential, fetch });
				return bodies[0]?.store;
			} finally {
				if (previous === undefined) delete process.env.PI_MUSE_STORE_RESPONSES;
				else process.env.PI_MUSE_STORE_RESPONSES = previous;
			}
		}

		/** A session turn: the settings-aware stream over the real `streamSimple`. */
		const viaSession = (settings: Settings, model: Model) => async (options: SimpleStreamOptions) => {
			const stream = await createSettingsAwareStreamFn(settings)(model, context, options);
			return stream.result();
		};

		it.each([
			["stays off by default", {}, undefined, false],
			["stores when the setting is on", { "providers.muse-code.storeResponses": true }, undefined, true],
			[
				"lets PI_MUSE_STORE_RESPONSES=1 override the setting",
				{ "providers.muse-code.storeResponses": false },
				"1",
				true,
			],
		] as const)("%s", async (_label, values, env, expected) => {
			expect(await wireStore(env, viaSession(Settings.isolated(values), museModel))).toBe(expected);
		});

		it("does not opt other storing hosts into retention", async () => {
			const otherHost = { ...museModel, provider: "custom-store-host" } as Model;
			const settings = Settings.isolated({ "providers.muse-code.storeResponses": true });
			expect(await wireStore(undefined, viaSession(settings, otherHost))).toBe(false);
		});

		it("applies to direct side requests through the bound settings", async () => {
			// Titles, commit messages, and memories call `completeSimple`/`streamSimple`
			// without the settings-aware stream; the process-wide effect covers them.
			const settings = Settings.isolated();
			const release = bindEffects(settings);
			const direct = (options: SimpleStreamOptions) => streamSimple(museModel, context, options).result();
			try {
				expect(await wireStore(undefined, direct)).toBe(false);
				// Turning the setting on mid-process reaches the next direct request.
				cfgProvidersMuseCodeStoreResponses.set(settings, true);
				expect(await wireStore(undefined, direct)).toBe(true);
			} finally {
				release();
				configureProviderStoreResponses(undefined);
			}
		});
	});
});
