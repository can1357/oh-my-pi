import { describe, expect, test } from "bun:test";
import { exLlama3ModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * TabbyAPI serves an OpenAI `/v1/models` envelope, but its context metadata lives in
 * the llama-server-shaped `meta` block it attaches to each card plus the card's own
 * `parameters`. The generic OpenAI reader looks only at `max_model_len` /
 * `context_length`, which TabbyAPI never emits.
 */
function tabbyResponse(data: unknown[]): Response {
	return new Response(JSON.stringify({ object: "list", data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const TABBY_ROSTER = [
	{
		// Loaded at 131072 out of a 262144-token architecture window.
		id: "Qwen3.8-27B-exl3",
		object: "model",
		owned_by: "tabbyAPI",
		created: 1700000000,
		meta: { n_ctx_train: 262144, n_ctx: 131072, n_vocab: 151936, n_embd: 0, size: 0 },
		parameters: { max_seq_len: 131072, use_vision: false },
	},
	{
		// `n_ctx` is null until a model is loaded; only the trained window is known.
		id: "Qwama-0.5B-Instruct",
		object: "model",
		owned_by: "tabbyAPI",
		meta: { n_ctx_train: 8192, n_ctx: null },
	},
	{
		// A thin/odd entry: no meta, no parameters.
		id: "llama-3.1-8b-instruct-exl3",
		object: "model",
	},
];

describe("ExLlama3 (TabbyAPI) provider discovery", () => {
	test("reads the loaded context window from TabbyAPI's llama-server-shaped meta", async () => {
		const fetchMock: FetchImpl = async () => tabbyResponse(TABBY_ROSTER);
		const models = await exLlama3ModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		// `meta.n_ctx` (what the server will accept) must beat `meta.n_ctx_train`
		// (what the architecture could support): registering a 256K-trained model at
		// its trained window makes every request overflow after the template runs.
		expect(models?.find(model => model.id === "Qwen3.8-27B-exl3")).toMatchObject({
			provider: "exllama3",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:5000/v1",
			contextWindow: 131072,
		});
	});

	test("falls back through the card fields before giving up", async () => {
		const fetchMock: FetchImpl = async () => tabbyResponse(TABBY_ROSTER);
		const models = await exLlama3ModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		// null `n_ctx` -> `n_ctx_train`.
		expect(models?.find(model => model.id === "Qwama-0.5B-Instruct")?.contextWindow).toBe(8192);
		// No metadata at all -> stay unresolved rather than invent a window.
		expect(models?.find(model => model.id === "llama-3.1-8b-instruct-exl3")?.contextWindow).toBeNull();
	});

	test("honours EXLLAMA3_BASE_URL for a non-loopback server", async () => {
		const fetchMock: FetchImpl = async () => tabbyResponse(TABBY_ROSTER);
		const models = await exLlama3ModelManagerOptions({
			baseUrl: "http://10.0.0.7:5000/v1",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(models?.[0]?.baseUrl).toBe("http://10.0.0.7:5000/v1");
	});

	test("lights up the Qwen 3.8+ effort dial despite a roster that never advertises reasoning", async () => {
		const fetchMock: FetchImpl = async () => tabbyResponse(TABBY_ROSTER);
		const models = await exLlama3ModelManagerOptions({ fetch: fetchMock }).fetchDynamicModels?.();

		const qwen = models?.find(model => model.id === "Qwen3.8-27B-exl3");
		expect(qwen?.reasoning).toBe(true);
		// Non-reasoning generations keep the wire-reported default.
		expect(models?.find(model => model.id === "Qwama-0.5B-Instruct")?.reasoning).toBe(false);
	});
});

describe("ExLlama3 (TabbyAPI) provider compat", () => {
	// Asserted through `buildModel` so the reviewed KDL rules are the thing under
	// test, not a snapshot of bundled JSON.
	function buildResolved(id: string, baseUrl = "http://127.0.0.1:5000/v1") {
		const spec: ModelSpec<"openai-completions"> = {
			id,
			name: id,
			api: "openai-completions",
			provider: "exllama3",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 8192,
		};
		return buildModel(spec);
	}

	test("matches TabbyAPI's actual request schema", () => {
		const compat = buildResolved("qwen3.8-27b").compat;
		// `role` is forwarded verbatim to the Jinja template, which binds `system`.
		expect(compat.supportsDeveloperRole).toBe(false);
		// No OpenAI `store`/`prompt_cache_key` on the request schema.
		expect(compat.supportsStore).toBe(false);
		// `tool_choice` accepts a named choice but the generator only tests `!= "none"`.
		expect(compat.supportsNamedToolChoice).toBe(false);
	});

	test("steers Qwen thinking through chat_template_kwargs", () => {
		const model = buildResolved("qwen3.8-27b");
		expect(model.compat.thinkingFormat).toBe("qwen-chat-template");
		expect(model.compat.qwenPreserveThinking).toBe(true);
		// Discovered rows arrive `reasoning: false`; the KDL upgrade opt-in is what
		// materialises the ladder instead of a TypeScript id match.
		expect(model.thinking).toMatchObject({ mode: "effort", efforts: ["low", "medium", "xhigh"] });
	});

	test("treats a non-loopback TabbyAPI as the self-hosted backend it is", () => {
		// The loopback heuristic in `resolve.ts` covers 127.0.0.1 and RFC1918; these
		// provider rules are what keep a TabbyAPI reached by Tailscale address or
		// custom DNS name from inheriting hosted-provider timeouts and losing
		// reasoning replay.
		const compat = buildResolved("qwen3.8-27b", "http://tabby.example.net:5000/v1").compat;
		expect(compat.replayReasoningContent).toBe(true);
		expect(compat.clampOutputToModelMax).toBe(true);
		expect(compat.streamFirstEventTimeoutMs).toBe(0);
		expect(compat.streamIdleTimeoutMs).toBe(300_000);
	});
});
