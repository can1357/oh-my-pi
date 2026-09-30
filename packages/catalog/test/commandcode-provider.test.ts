import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey, streamSimple } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { commandCodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const originalPrimaryKey = Bun.env.COMMAND_CODE_API_KEY;
const originalLegacyKey = Bun.env.COMMANDCODE_API_KEY;

afterEach(() => {
	if (originalPrimaryKey === undefined) delete Bun.env.COMMAND_CODE_API_KEY;
	else Bun.env.COMMAND_CODE_API_KEY = originalPrimaryKey;
	if (originalLegacyKey === undefined) delete Bun.env.COMMANDCODE_API_KEY;
	else Bun.env.COMMANDCODE_API_KEY = originalLegacyKey;
	vi.restoreAllMocks();
});

// Snapshot of GET /provider/v1/models ids on 2026-09-29. A newly served id
// without a cost-patch rule fails the pricing test instead of silently billing
// at zero.
const servedIds = [
	"MiniMaxAI/MiniMax-M2.5",
	"MiniMaxAI/MiniMax-M2.7",
	"MiniMaxAI/MiniMax-M3",
	"Qwen/Qwen3.6-Max-Preview",
	"Qwen/Qwen3.6-Plus",
	"Qwen/Qwen3.7-Flash",
	"Qwen/Qwen3.7-Max",
	"Qwen/Qwen3.7-Plus",
	"Qwen/Qwen3.8-27B",
	"Qwen/Qwen3.8-Flash",
	"Qwen/Qwen3.8-Max",
	"Qwen/Qwen3.8-Max-0902",
	"Qwen/Qwen3.8-Omni-Flash",
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-haiku-4-5-20251001",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-opus-5-5",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-flash-fast",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4.1-flash",
	"deepseek/deepseek-v4.1-flash-fast",
	"google/gemini-3.1-flash-lite",
	"google/gemini-3.5-flash",
	"google/gemini-3.5-flash-lite",
	"google/gemini-3.6-flash",
	"google/gemini-3.7-flash",
	"google/gemini-3.8-flash",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.5",
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
	"inclusionai/ling-3.0-flash-sante:free",
	"meituan/LongCat-2.0",
	"meta/muse-spark-1.1",
	"meta/muse-spark-1.2",
	"meta/muse-spark-1.2-contributor",
	"meta/muse-spark-1.3",
	"meta/muse-spark-1.3-contributor",
	"moonshotai/Kimi-K2.5",
	"moonshotai/Kimi-K2.6",
	"moonshotai/Kimi-K2.7-Code",
	"moonshotai/Kimi-K2.7-Code-Highspeed",
	"moonshotai/Kimi-K3",
	"nvidia/nemotron-3-ultra-550b-a55b",
	"poolside/laguna-s-2.1-free",
	"sakana/fugu-ultra",
	"stealth/pixel-canary",
	"stealth/space-bunny-alpha",
	"stepfun/Step-3.5-Flash",
	"stepfun/Step-3.7-Flash",
	"stepfun/Step-5-Preview",
	"tencent/hy3-paid",
	"tencent/hy4-preview",
	"thinkingmachines/inkling",
	"thinkingmachines/inkling-small",
	"xai/grok-4.5",
	"xai/grok-4.6",
	"xai/grok-4.7",
	"xiaomi/mimo-v2.5",
	"xiaomi/mimo-v2.5-pro",
	"xiaomi/mimo-v2.6-flash",
	"xiaomi/mimo-v2.6-pro",
	"xiaomi/mimo-v2.6-pro-ultraspeed",
	"z-ai/glm-5.3-flash",
	"z-ai/glm-5.3-flashx",
	"zai-org/GLM-5",
	"zai-org/GLM-5.1",
	"zai-org/GLM-5.2",
	"zai-org/GLM-5.2-Fast",
	"zai-org/GLM-5.3",
];

const textOnlyIds: Record<string, true> = {
	"MiniMaxAI/MiniMax-M2.5": true,
	"MiniMaxAI/MiniMax-M2.7": true,
	"Qwen/Qwen3.6-Max-Preview": true,
	"Qwen/Qwen3.7-Max": true,
	"deepseek/deepseek-v4-flash": true,
	"deepseek/deepseek-v4-flash-fast": true,
	"deepseek/deepseek-v4-pro": true,
	"inclusionai/ling-3.0-flash-sante:free": true,
	"meituan/LongCat-2.0": true,
	"nvidia/nemotron-3-ultra-550b-a55b": true,
	"poolside/laguna-s-2.1-free": true,
	"stepfun/Step-3.5-Flash": true,
	"tencent/hy3-paid": true,
	"tencent/hy4-preview": true,
	"xiaomi/mimo-v2.5-pro": true,
	"zai-org/GLM-5": true,
	"zai-org/GLM-5.1": true,
	"zai-org/GLM-5.2": true,
	"zai-org/GLM-5.2-Fast": true,
	"zai-org/GLM-5.3": true,
};

function chatModels(specs: readonly ModelSpec[] | null | undefined) {
	return (specs ?? []).map(spec => buildModel(spec)).filter(model => model.kind !== "judge");
}

type ServedRow = { id: string; name?: string; context_length?: number };

async function discoverModels(rows: ReadonlyArray<string | ServedRow>) {
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		expect(init?.method).toBe("GET");
		return Response.json({
			data: rows.map(row => (typeof row === "string" ? { id: row, name: row, context_length: 1_000_000 } : row)),
		});
	});
	const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
	return chatModels(await options.fetchDynamicModels?.());
}

describe("Command Code provider support", () => {
	test("discovers mixed-protocol models with Command Code deployment policy", async () => {
		let requestHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = init?.headers;
			return Response.json({
				object: "list",
				data: [
					{
						id: "claude-sonnet-4-6",
						name: "Claude Sonnet 4.6",
						context_length: 1_000_000,
					},
					{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1_050_000 },
					{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 1_000_000 },
				],
			});
		});
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec));

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.commandcode.ai/provider/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		// The key is forwarded so entitled rows resolve like inference; the
		// public catalog ignores unknown credentials.
		expect(requestHeaders).toHaveProperty("Authorization", "Bearer user_test");
		expect(models.find(model => model.id === "claude-sonnet-4-6")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
			reasoning: true,
			// KDL grants image input from the command-code@1.67.0 registry; the
			// discovery row carries no modality metadata of its own.
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
		});
		expect(models.find(model => model.id === "gpt-5.6-sol")).toMatchObject({
			api: "openai-responses",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			reasoning: true,
			contextWindow: 1_050_000,
			maxTokens: 65_536,
			thinking: {
				mode: "effort",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
			},
		});
		expect(models.find(model => model.id === "deepseek/deepseek-v4-flash")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
		});
	});

	test("discovers the typesafe/jev judge model beside the served roster", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({
				data: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 1_000_000 }],
			}),
		);
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec));

		expect(models.find(model => model.id === "typesafe/jev")).toMatchObject({
			api: "typesafe",
			baseUrl: "https://api.commandcode.ai/provider",
			kind: "judge",
			cost: { input: 0.042, output: 0 },
		});
		expect(models.filter(model => model.kind !== "judge").map(model => model.id)).toEqual([
			"deepseek/deepseek-v4-flash",
		]);

		const proxied = commandCodeModelManagerOptions({
			apiKey: "user_test",
			baseUrl: "https://proxy.example/provider/v1",
			fetch: fetchMock,
		});
		const proxiedModels = ((await proxied.fetchDynamicModels?.()) ?? []).map(spec => buildModel(spec));
		expect(proxiedModels.find(model => model.id === "typesafe/jev")?.baseUrl).toBe("https://proxy.example/provider");
	});

	test("keeps one System One jev row when the models route also lists it", async () => {
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({
				data: [
					{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", context_length: 1_000_000 },
					{ id: "typesafe/jev", name: "TypeSafe Jev", context_length: 32_000 },
				],
			}),
		);
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		const models = ((await options.fetchDynamicModels?.()) ?? []).map(spec => buildModel(spec));

		const jevRows = models.filter(model => model.id === "typesafe/jev");
		expect(jevRows).toHaveLength(1);
		expect(jevRows[0]).toMatchObject({ api: "typesafe", kind: "judge" });
	});

	test("returns null from a failed discovery instead of the jev seed alone", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		expect(await options.fetchDynamicModels?.()).toBeNull();
	});

	test("resolves DeepSeek V4.1 Flash's rule-owned surface over neutral discovery metadata", async () => {
		// The Provider API ships no capability metadata for this id, so the
		// ladder, image input, and DeepSeek reasoning-content contract have to
		// arrive through `buildModel`. Without them a regenerated catalog
		// silently returns the model to an empty thinking control and stripped
		// attachments, and compat resolves against the discovery row's missing
		// reasoning instead of the capability the provider contract declares.
		const fetchMock: FetchImpl = vi.fn(async () =>
			Response.json({
				object: "list",
				data: [{ id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 1_000_000 }],
			}),
		);
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec));

		expect(models.find(model => model.id === "deepseek/deepseek-v4.1-flash")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			reasoning: true,
			input: ["text", "image"],
			thinking: { mode: "effort", efforts: ["low", "high", "max"] },
			compat: {
				supportsReasoningEffort: true,
				stripImageInput: false,
				disableReasoningOnToolChoice: true,
				requiresReasoningContentForToolCalls: true,
				requiresReasoningContentForAllAssistantTurns: true,
				allowsSyntheticReasoningContentForToolCalls: false,
			},
		});
	});

	test("discovers the public catalog without credentials", async () => {
		let requestHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = init?.headers;
			return Response.json({
				data: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1_050_000 }],
			});
		});
		const options = commandCodeModelManagerOptions({ fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		const models = chatModels(specs);
		expect(models).toHaveLength(1);
		expect(requestHeaders).not.toHaveProperty("Authorization");
	});

	test("preserves disjoint cache usage and timing through the chat-completions and Messages transports", async () => {
		const catalog = commandCodeModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "xiaomi/mimo-v2.5", name: "MiMo V2.5", context_length: 1_050_000 },
						{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
					],
				}),
		});
		const specs = await catalog.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec));
		const completions = models.find(model => model.id === "xiaomi/mimo-v2.5");
		const claude = models.find(model => model.id === "claude-sonnet-4-6");
		if (!completions || !claude) throw new Error("Expected Command Code transport fixtures");
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => ++clock);

		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url.endsWith("/chat/completions")) {
				return new Response(
					[
						'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"xiaomi/mimo-v2.5","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
						'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"xiaomi/mimo-v2.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3,"cache_write_tokens":2}}}',
						"data: [DONE]",
						"",
					].join("\n\n"),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (url.endsWith("/messages")) {
				return new Response(
					[
						'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}',
						'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
						'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
						'event: message_stop\ndata: {"type":"message_stop"}',
						"",
					].join("\n\n"),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response("unexpected route", { status: 404 });
		});
		const context = { messages: [{ role: "user" as const, content: "Reply ok", timestamp: Date.now() }] };
		const completionsResult = await streamSimple(completions, context, {
			apiKey: "user_test",
			fetch: fetchMock,
		}).result();
		const claudeResult = await streamSimple(claude, context, { apiKey: "user_test", fetch: fetchMock }).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(completionsResult.usage).toMatchObject({
			input: 5,
			output: 2,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 12,
		});
		expect(claudeResult.usage).toMatchObject({
			input: 5,
			output: 2,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 12,
		});
		for (const result of [completionsResult, claudeResult]) {
			expect(result.duration).toBeGreaterThan(0);
			expect(result.ttft).toBeGreaterThan(0);
			expect(result.ttft).toBeLessThanOrEqual(result.duration ?? 0);
		}
	});

	test("registers discovery, defaults, and both API key environment names", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "commandcode");
		expect(descriptor).toMatchObject({
			defaultModel: "claude-sonnet-5",
			allowUnauthenticated: true,
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { label: "Command Code", allowUnauthenticated: true },
			skipCrossProviderReferenceFills: true,
		});
		expect(DEFAULT_MODEL_PER_PROVIDER.commandcode).toBe("claude-sonnet-5");
		// Fresh installs resolve the default synchronously from the bundle:
		// dropping the default id from models.json must fail here, not at boot.
		expect(getBundledModels("commandcode").some(model => model.id === DEFAULT_MODEL_PER_PROVIDER.commandcode)).toBe(
			true,
		);

		delete Bun.env.COMMAND_CODE_API_KEY;
		Bun.env.COMMANDCODE_API_KEY = "legacy-key";
		expect(getEnvApiKey("commandcode")).toBe("legacy-key");
		Bun.env.COMMAND_CODE_API_KEY = "primary-key";
		expect(getEnvApiKey("commandcode")).toBe("primary-key");
	});

	test("validates a pasted Provider API key against the whoami endpoint", async () => {
		const provider = getOAuthProviders().find(item => item.id === "commandcode");
		expect(provider?.name).toBe("Command Code");
		const login = getProviderDefinition("commandcode")?.login;
		expect(login).toBeDefined();

		const probed: string[] = [];
		const probeFetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			probed.push(`${new Headers(init?.headers).get("authorization")} ${String(input)}`);
			return Response.json({ success: true, user: { id: "user_1" }, org: null });
		};
		const onAuth = vi.fn();
		await expect(
			login?.({
				onAuth,
				onPrompt: async () => "  user_test  ",
				fetch: probeFetch,
			}),
		).resolves.toBe("user_test");
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://commandcode.ai/studio",
			instructions: "Create or copy a Provider API key from Command Code Studio",
		});
		expect(probed).toEqual(["Bearer user_test https://api.commandcode.ai/alpha/whoami"]);
	});

	test("rejects a key the whoami endpoint refuses", async () => {
		const login = getProviderDefinition("commandcode")?.login;
		const unauthorizedFetch: FetchImpl = async () =>
			Response.json({ success: false, error: { code: "UNAUTHORIZED" } }, { status: 401 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "user_bogus", fetch: unauthorizedFetch }),
		).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
	});

	test("trusts a pasted key when the whoami route is unavailable", async () => {
		const login = getProviderDefinition("commandcode")?.login;
		for (const status of [404, 503]) {
			const unavailableFetch: FetchImpl = async () => new Response("unavailable", { status });
			await expect(
				login?.({ onAuth: vi.fn(), onPrompt: async () => "user_test", fetch: unavailableFetch }),
			).resolves.toBe("user_test");
		}
	});

	test("trusts a pasted key when the whoami route answers 403", async () => {
		const login = getProviderDefinition("commandcode")?.login;
		const forbiddenFetch: FetchImpl = async () =>
			Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "  user_test  ", fetch: forbiddenFetch }),
		).resolves.toBe("user_test");
	});

	test("still rejects a 403 from an optional probe that does not trust it", async () => {
		const login = getProviderDefinition("nvidia")?.login;
		const forbiddenFetch: FetchImpl = async () => Response.json({ error: { message: "forbidden" } }, { status: 403 });

		await expect(
			login?.({ onAuth: vi.fn(), onPrompt: async () => "nvapi-test", fetch: forbiddenFetch }),
		).rejects.toMatchObject({ status: 403 });
	});

	test("prices live-discovered models from the Command Code rate card", async () => {
		const models = await discoverModels([
			{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
			{ id: "Qwen/Qwen3.7-Flash", name: "Qwen 3.7 Flash", context_length: 1_000_000 },
			{ id: "xai/grok-4.6", name: "Grok 4.6", context_length: 500_000 },
			{ id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", context_length: 256_000 },
		]);

		expect(models.find(model => model.id === "claude-sonnet-4-6")).toMatchObject({
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		// Qwen 3.7 Flash has two upstream tiers (>32K at 0.10/0.40, >256K at
		// 0.20/0.80); the single long-context slot encodes the highest tier
		// from the first crossing so spend above 256K never under-reports.
		expect(models.find(model => model.id === "Qwen/Qwen3.7-Flash")).toMatchObject({
			cost: {
				input: 0.03,
				output: 0.13,
				cacheRead: 0.006,
				cacheWrite: 0.038,
				longContext: { inputThreshold: 32_000, input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25 },
			},
		});

		// Grok 4.6's whole-request 2x tier above 200K input, as absolute rates
		// (the xai class multiplier rule is scoped to xai/xai-oauth and never
		// matches this provider).
		expect(models.find(model => model.id === "xai/grok-4.6")).toMatchObject({
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.5,
				cacheWrite: 0,
				longContext: { inputThreshold: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
			},
		});
		// Documented-free model keeps the zero discovery default.
		expect(models.find(model => model.id === "poolside/laguna-s-2.1-free")).toMatchObject({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("prices every served catalog id; only documented-free models stay zero", async () => {
		const freeIds: Record<string, true> = {
			"inclusionai/ling-3.0-flash-sante:free": true,
			"poolside/laguna-s-2.1-free": true,
			"stealth/pixel-canary": true,
			"stealth/space-bunny-alpha": true,
		};
		const models = await discoverModels(servedIds);
		expect(models).toHaveLength(servedIds.length);
		for (const model of models) {
			if (freeIds[model.id]) {
				expect(model.cost).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			} else {
				expect(model.cost.input).toBeGreaterThan(0);
				expect(model.cost.output).toBeGreaterThan(0);
			}
		}
	});

	test("follows the command-code@1.67.0 effort registry", async () => {
		const models = await discoverModels([
			"claude-opus-5-5",
			"deepseek/deepseek-v4-pro",
			"z-ai/glm-5.3-flashx",
			"MiniMaxAI/MiniMax-M3",
			"xai/grok-4.7",
			"stealth/pixel-canary",
			"sakana/fugu-ultra",
			"meta/muse-spark-1.2",
			"meta/muse-spark-1.3",
		]);
		expect(Object.fromEntries(models.map(model => [model.id, model.thinking?.efforts]))).toEqual({
			"claude-opus-5-5": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			"deepseek/deepseek-v4-pro": [Effort.High, Effort.Max],
			"z-ai/glm-5.3-flashx": [Effort.Low, Effort.High, Effort.Max],
			"MiniMaxAI/MiniMax-M3": [Effort.Low, Effort.Medium, Effort.High],
			"xai/grok-4.7": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			"stealth/pixel-canary": [Effort.Low, Effort.Medium, Effort.XHigh],
			"sakana/fugu-ultra": [Effort.High, Effort.XHigh],
			"meta/muse-spark-1.2": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			"meta/muse-spark-1.3": [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});
	});

	test("keeps Responses-routed GPT rows off hosted image generation, the image model, and named tool choice", async () => {
		const models = await discoverModels(["gpt-6-luna", "gpt-5.4-mini", "gpt-5.3-codex"]);
		expect(models).toHaveLength(3);
		for (const model of models) {
			expect(model.api).toBe("openai-responses");
			expect(model.hostedImage).not.toBe(true);
			expect(model.imageModel).toBeUndefined();
			expect(model.compat).toMatchObject({ supportsNamedToolChoice: false });
			expect(model.webSearch).toBe("openai");
		}
	});

	test("leaves other gpt-prefixed ids on chat completions without the Responses opt-outs", async () => {
		const [model] = await discoverModels(["gpt-oss-120b"]);
		if (!model) throw new Error("Expected the gpt-oss-120b fixture");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
		expect(model.compat).not.toMatchObject({ supportsNamedToolChoice: false });
	});

	test("clears hosted image generation from a bundled GPT row that still carries it", async () => {
		const [discovered] = await discoverModels(["gpt-6-luna"]);
		if (!discovered) throw new Error("Expected the gpt-6-luna fixture");
		const rebuilt = buildModel({ ...discovered, hostedImage: true });
		expect(rebuilt.hostedImage).toBeUndefined();
	});

	test("clears the image model from a bundled GPT row that still carries it", async () => {
		const [discovered] = await discoverModels(["gpt-6-luna"]);
		if (!discovered) throw new Error("Expected the gpt-6-luna fixture");
		const rebuilt = buildModel({ ...discovered, imageModel: "gpt-image-2" });
		expect(rebuilt.imageModel).toBeUndefined();
	});

	test("advertises image input exactly outside the text-only set", async () => {
		const models = await discoverModels(servedIds);
		expect(models).toHaveLength(servedIds.length);
		expect(models.filter(model => textOnlyIds[model.id])).toHaveLength(Object.keys(textOnlyIds).length);
		for (const model of models) {
			expect(model.input).toEqual(textOnlyIds[model.id] ? ["text"] : ["text", "image"]);
		}
	});

	test("applies the command-code@1.67.0 per-model output caps", async () => {
		const models = await discoverModels([
			"inclusionai/ling-3.0-flash-sante:free",
			"z-ai/glm-5.3-flashx",
			"stealth/space-bunny-alpha",
		]);
		expect(Object.fromEntries(models.map(model => [model.id, model.maxTokens]))).toEqual({
			"inclusionai/ling-3.0-flash-sante:free": 32_768,
			"z-ai/glm-5.3-flashx": 131_072,
			"stealth/space-bunny-alpha": 524_288,
		});
	});
	test("omits effort controls for ids outside the verified effort registry", async () => {
		// Negative contract: ids absent from the exact `thinking-efforts`
		// groups expose no effort dial upstream. Discovery stays neutral
		// (`reasoning: false`, no cross-provider inheritance), the KDL
		// cascade grants no ladder without an exact rule, and the OpenAI
		// path omits `reasoning_effort` via the provider-default
		// `supports-reasoning-effort #false` — including on the Anthropic
		// route, where a fallback ladder would otherwise emit an
		// unsupported thinking payload.
		const models = await discoverModels([
			{ id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code", context_length: 262_144 },
			{ id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", context_length: 262_144 },
			{ id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", context_length: 1_000_000 },
			{ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", context_length: 200_000 },
		]);
		expect(models).toHaveLength(4);
		for (const model of models) {
			expect(model.reasoning).toBe(false);
			expect(model.thinking).toBeUndefined();
		}
		for (const model of models.filter(model => model.api === "openai-completions")) {
			expect(model.compat).toMatchObject({
				supportsReasoningEffort: false,
				omitReasoningEffort: true,
			});
		}
		expect(models.find(model => model.id === "claude-haiku-4-5-20251001")).toMatchObject({
			api: "anthropic-messages",
		});
	});
	test("keeps unknown context limits instead of copying another host", async () => {
		// A catalog row that omits or misreports `context_length` retains a
		// null window rather than inheriting another provider's deployment
		// limit; verified corrections arrive through KDL, never the mapper.
		const models = await discoverModels([
			{ id: "mystery-model", name: "Mystery Model" },
			{ id: "broken-model", name: "Broken Model", context_length: -5 },
		]);
		expect(models).toHaveLength(2);
		for (const model of models) {
			expect(model.contextWindow).toBeNull();
			expect(model.input).toEqual(["text"]);
		}
	});
});
