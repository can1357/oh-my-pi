import { afterEach, describe, expect, it, vi } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { calculateCost, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { moonshotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { $pickenv } from "@oh-my-pi/pi-utils";

function moonshotKimiModel(id: string, reasoning: boolean): Model<"openai-completions"> {
	const reference = getBundledModel("openai", "gpt-4o-mini");
	// Derive a variant from the built bundled model: sparse compat comes from
	// `compatConfig`; `buildModel` re-resolves it for the Moonshot host.
	return buildModel({
		...reference,
		api: "openai-completions",
		provider: "moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		id,
		reasoning,
		compat: reference.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function basicContext(): Context {
	return {
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	};
}

function encodeSseChunks(chunks: ReadonlyArray<Record<string, unknown>>): string {
	return `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

function buildMockMoonshotResponse(): Response {
	const body = encodeSseChunks([
		{
			id: "chatcmpl-k26-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: { role: "assistant", content: "Hello!" }, finish_reason: null }],
		},
		{
			id: "chatcmpl-k26-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	]);
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

async function runHiTurn(
	model: Model<"openai-completions">,
	options?: Pick<OpenAICompletionsOptions, "reasoning">,
): Promise<{ captured: CapturedRequest; assistant: AssistantMessage }> {
	const captured: CapturedRequest = { url: "", body: {} };
	const fetchMock = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		captured.url = url;
		const raw = typeof init?.body === "string" ? init.body : "";
		captured.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		return buildMockMoonshotResponse();
	}) as typeof fetch;

	const stream = streamOpenAICompletions(model, basicContext(), { apiKey: "test-key", fetch: fetchMock, ...options });
	for await (const _ of stream) {
		// drain until terminal event
	}
	const assistant = await stream.result();
	return { captured, assistant };
}

function moonshotModelsResponse(): Response {
	const body = {
		object: "list",
		data: [
			{ id: "kimi-k3", object: "model", owned_by: "moonshot" },
			{ id: "kimi-k2.6", object: "model", owned_by: "moonshot" },
		],
	};
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function discoverKimiK3(): Promise<ModelSpec<"openai-completions">> {
	const fetchMock = (async (_input: string | URL | Request): Promise<Response> =>
		moonshotModelsResponse()) as typeof fetch;
	const models = await moonshotModelManagerOptions({ apiKey: "test-key", fetch: fetchMock }).fetchDynamicModels?.();
	const k3 = models?.find(m => m.id === "kimi-k3");
	if (!k3) throw new Error("kimi-k3 not discovered");
	return k3;
}

describe("moonshot Kimi K2.x discovery and wire format", () => {
	it("moonshot discovery mapper marks kimi-k2.6 as reasoning + vision with thinking metadata", async () => {
		const fetchMock = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			expect(url).toContain("api.moonshot.ai/v1/models");
			const body = {
				object: "list",
				data: [
					{ id: "kimi-k2.5", object: "model", owned_by: "moonshot" },
					{ id: "kimi-k2.6", object: "model", owned_by: "moonshot" },
					{ id: "kimi-k2-thinking", object: "model", owned_by: "moonshot" },
				],
			};
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const models = await moonshotModelManagerOptions({ apiKey: "test-key", fetch: fetchMock }).fetchDynamicModels?.();
		expect(models).toBeDefined();
		const byId = new Map(models?.map(m => [m.id, m]));

		const k25 = byId.get("kimi-k2.5");
		expect(k25?.reasoning).toBe(true);
		expect(k25?.input).toEqual(["text", "image"]);
		expect(k25?.thinking).toBeDefined();

		const k26 = byId.get("kimi-k2.6");
		expect(k26?.reasoning).toBe(true);
		expect(k26?.input).toEqual(["text", "image"]);
		expect(k26?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});

		const thinkingOnly = byId.get("kimi-k2-thinking");
		expect(thinkingOnly?.reasoning).toBe(true);
		expect(thinkingOnly?.thinking).toBeDefined();
	});

	it("wire body for moonshot kimi-k2.6 carries an explicit thinking parameter", async () => {
		// Moonshot K2.6 stalls on the first turn when the request carries no
		// `thinking` parameter, so reasoning=true must route through the z.ai
		// branch that emits `thinking: {type}`.
		const model = moonshotKimiModel("kimi-k2.6", true);
		const { captured, assistant } = await runHiTurn(model);

		expect(captured.url).toContain("api.moonshot.ai/v1/chat/completions");
		expect(captured.body.thinking).toEqual({ type: "disabled" });
		expect(assistant.errorMessage).toBeUndefined();
		const textBlock = assistant.content.find(b => b.type === "text");
		expect(textBlock).toBeDefined();
	});

	it("uses Moonshot-native max_tokens and omits OpenAI store control", async () => {
		const model = moonshotKimiModel("kimi-k2.5", true);
		const { captured } = await runHiTurn(model, { reasoning: "high" });

		expect(captured.body.max_tokens).toBeDefined();
		expect(captured.body.max_completion_tokens).toBeUndefined();
		expect(captured.body.store).toBeUndefined();
	});

	it("wire body includes thinking.keep='all' when reasoning is explicitly requested", async () => {
		const model = moonshotKimiModel("kimi-k2.6", true);
		const { captured } = await runHiTurn(model, { reasoning: "high" });

		expect(captured.body.thinking).toEqual({ type: "enabled", keep: "all" });
	});
});

describe("moonshot Kimi K3 pricing and wire format", () => {
	it("discovery mapper stamps K3 pricing, limits, vision, and reasoning", async () => {
		const k3 = await discoverKimiK3();
		expect(k3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
		expect(k3.contextWindow).toBe(1_048_576);
		expect(k3.maxTokens).toBe(131_072);
		expect(k3.input).toEqual(["text", "image"]);
		expect(k3.reasoning).toBe(true);
		// The effort ladder itself tracks the generated catalog policies; the
		// binding K3 contract — reasoning_effort=max on the wire, no K2-style
		// thinking block — is asserted by the wire-body test below.
		expect(k3.thinking?.mode).toBe("effort");
		expect(k3.thinking?.efforts?.length).toBeGreaterThan(0);
	});

	it("K3 native compat uses the OpenAI reasoning_effort dialect, not the K2 thinking block", async () => {
		const model = buildModel(await discoverKimiK3());
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(model.compat.reasoningDisableMode).toBe("lowest-effort");
		expect(model.compat.supportsReasoningEffort).toBe(true);
	});

	it("prices K3 cache-write tokens at the 5min TTL rate", async () => {
		// A source row reporting no cache-write fee must not zero the cost: the
		// moonshot.kdl cost-patch owns Moonshot's separately billed cache writes.
		const spec = { ...(await discoverKimiK3()), cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } };
		const cost = calculateCost(buildModel(spec), {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 1_000_000,
			totalTokens: 1_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(cost.cacheWrite).toBe(3);
		expect(cost.total).toBe(3);
	});

	it("wire body carries reasoning_effort=max and omits the thinking block", async () => {
		const model = buildModel(await discoverKimiK3());
		let body: Record<string, unknown> = {};
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof init?.body === "string" ? init.body : "";
			body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			return new Response(
				encodeSseChunks([
					{ choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
					{
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const stream = streamOpenAICompletions(model, basicContext(), {
			apiKey: "test-key",
			reasoning: "max",
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(body.reasoning_effort).toBe("max");
		expect("thinking" in body).toBe(false);
		// Moonshot-native Kimi rate-limits on max_tokens, not
		// max_completion_tokens; K3's default reaches its advertised 131K cap.
		expect(body.max_tokens).toBe(131_072);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("keeps reasoning_effort=max on forced-tool-choice turns (mandatory K3 reasoning)", async () => {
		// K3 always reasons via `reasoning_effort: "max"`. The K2.x Kimi
		// `disableReasoningOnForcedToolChoice` rule (Moonshot 400s on forced
		// tool_choice + the binary `thinking` block, #827) must NOT strip K3's
		// effort, or plan-mode `toolChoice` turns run without the required
		// reasoning.
		const model = buildModel(await discoverKimiK3());
		let body: Record<string, unknown> = {};
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const raw = typeof init?.body === "string" ? init.body : "";
			body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			return new Response(
				encodeSseChunks([
					{
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{ index: 0, id: "c1", type: "function", function: { name: "plan", arguments: "{}" } },
									],
								},
								finish_reason: null,
							},
						],
					},
					{
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 1, completion_tokens: 1 },
					},
				]),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		const context: Context = {
			...basicContext(),
			tools: [{ name: "plan", description: "plan", parameters: { type: "object", properties: {} } }],
		};
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoning: "max",
			maxTokens: 131_072,
			toolChoice: { type: "tool", name: "plan" },
			fetch: fetchMock,
		});
		for await (const _ of stream) {
			// drain
		}

		expect(body.reasoning_effort).toBe("max");
		expect("thinking" in body).toBe(false);
		expect(body.max_tokens).toBe(131_072);
	});
});

describe("unbundled Moonshot variants (no reference row)", () => {
	// `kimi-k3` / `kimi-k2.6` above ride bundled references, which bypass the
	// mapper's no-reference branch entirely. These ids have no bundled row, so
	// the mapper seeds only live facts (structured reasoning, official K3
	// pricing, model-limits fallbacks) and the built model derives rule-owned
	// input/thinking.
	async function discoverUnbundled(): Promise<Map<string, ModelSpec<"openai-completions">>> {
		const body = {
			object: "list",
			data: [
				{ id: "kimi-k3-turbo", object: "model", owned_by: "moonshot" },
				{ id: "kimi-k2.6-turbo", object: "model", owned_by: "moonshot" },
			],
		};
		const fetchMock = (async (_input: string | URL | Request): Promise<Response> =>
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const models = await moonshotModelManagerOptions({ apiKey: "test-key", fetch: fetchMock }).fetchDynamicModels?.();
		return new Map((models ?? []).map(model => [model.id, model]));
	}

	it("seeds an unbundled K3-family id with official pricing, limits, and mandatory reasoning", async () => {
		const k3 = (await discoverUnbundled()).get("kimi-k3-turbo");
		if (!k3) throw new Error("kimi-k3-turbo not discovered");
		// Raw spec: live/seed facts only — modalities and the ladder stay unset.
		expect(k3.reasoning).toBe(true);
		expect(k3.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 });
		expect(k3.contextWindow).toBe(1_048_576);
		expect(k3.maxTokens).toBe(131_072);
		expect(k3.input).toEqual(["text"]);
		expect(k3.thinking).toBeUndefined();
		// Built model: rule-owned modalities and the census K3 effort surface.
		const built = buildModel(k3);
		expect(built.input).toEqual(["text", "image"]);
		expect(built.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(built.thinking?.requiresEffort).toBe(true);
		expect(built.thinking?.defaultLevel).toBe(Effort.Max);
	});

	it("derives the K2.x thinking block and modalities for an unbundled K2.6 variant", async () => {
		const k26 = (await discoverUnbundled()).get("kimi-k2.6-turbo");
		if (!k26) throw new Error("kimi-k2.6-turbo not discovered");
		expect(k26.reasoning).toBe(true);
		expect(k26.thinking).toBeUndefined();
		const built = buildModel(k26);
		expect(built.input).toEqual(["text", "image"]);
		expect(built.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});
});

describe("Moonshot China platform", () => {
	const MODELS_DEV_URL = "https://catalog.stencil.so/models.json.zstd";

	const ORIGINAL_ENV: Record<string, string | undefined> = {
		MOONSHOT_BASE_URL: Bun.env.MOONSHOT_BASE_URL,
		MOONSHOT_API_KEY: Bun.env.MOONSHOT_API_KEY,
		KIMI_API_KEY: Bun.env.KIMI_API_KEY,
	};

	function inputUrl(input: string | URL | Request): string {
		if (typeof input === "string") return input;
		if (input instanceof URL) return input.toString();
		return input.url;
	}

	function makeFetchMock(calls: string[]): FetchImpl {
		return vi.fn(async (input: string | URL | Request) => {
			const url = inputUrl(input);
			if (url === MODELS_DEV_URL) {
				return new Response("{}", { status: 500 });
			}
			calls.push(url);
			return new Response(JSON.stringify({ data: [{ id: "kimi-k2.7-code" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as FetchImpl;
	}

	afterEach(() => {
		for (const key in ORIGINAL_ENV) {
			const value = ORIGINAL_ENV[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
		vi.restoreAllMocks();
	});

	it("moonshot accepts KIMI_API_KEY as an env-key fallback for MOONSHOT_API_KEY", () => {
		// `getEnvApiKey("moonshot")` resolves a catalog provider via `$pickenv(...envVars)`
		// (see ai/src/stream.ts), so the descriptor's env-var order IS the resolution order.
		const envVars = providerEntry("moonshot")?.envVars;
		expect(envVars).toEqual(["MOONSHOT_API_KEY", "KIMI_API_KEY"]);

		delete Bun.env.MOONSHOT_API_KEY;
		Bun.env.KIMI_API_KEY = "kimi-china-key";
		expect($pickenv(...(envVars ?? []))).toBe("kimi-china-key");
	});

	it("MOONSHOT_API_KEY keeps precedence over the KIMI_API_KEY alias", () => {
		const envVars = providerEntry("moonshot")?.envVars ?? [];
		Bun.env.MOONSHOT_API_KEY = "moonshot-primary-key";
		Bun.env.KIMI_API_KEY = "kimi-fallback-key";
		expect($pickenv(...envVars)).toBe("moonshot-primary-key");
	});

	it("discovers models against api.moonshot.cn when MOONSHOT_BASE_URL is set", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const calls: string[] = [];
		const options = moonshotModelManagerOptions({ apiKey: "kimi-china-key", fetch: makeFetchMock(calls) });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("https://api.moonshot.cn/v1/models");
		expect(models?.[0]).toMatchObject({
			provider: "moonshot",
			baseUrl: "https://api.moonshot.cn/v1",
		});
	});

	it("explicit config baseUrl keeps precedence over MOONSHOT_BASE_URL", async () => {
		Bun.env.MOONSHOT_BASE_URL = "https://api.moonshot.cn/v1";
		const calls: string[] = [];
		const options = moonshotModelManagerOptions({
			apiKey: "kimi-china-key",
			baseUrl: "https://proxy.example/v1",
			fetch: makeFetchMock(calls),
		});
		const models = await options.fetchDynamicModels?.();

		expect(calls).toContain("https://proxy.example/v1/models");
		expect(models?.[0]?.baseUrl).toBe("https://proxy.example/v1");
	});
});
