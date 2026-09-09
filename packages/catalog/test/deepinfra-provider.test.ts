import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { DEEPINFRA_BASE_URL, deepinfraModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const DISCOVERY_URL = "https://api.deepinfra.com/v1/openai/models?filter=with_meta&sort_by=omp";

function catalogFixture(): Response {
	return Response.json({
		object: "list",
		data: [
			{
				id: "vendor/vision-thinker",
				object: "model",
				metadata: {
					context_length: 262144,
					max_tokens: 131072,
					pricing: { input_tokens: 0.68, output_tokens: 3.4, cache_read_tokens: 0.136 },
					tags: ["chat", "vlm", "vision", "prompt_cache", "reasoning_effort"],
				},
			},
			{
				id: "vendor/a-plain-chat",
				object: "model",
				metadata: {
					// Mirrors production: `max_tokens` restates the context ceiling,
					// so it must not be treated as an output cap.
					context_length: 131072,
					max_tokens: 131072,
					pricing: { input_tokens: 0.09, output_tokens: 0.18 },
					tags: ["chat", "reasoning"],
				},
			},
			{
				id: "vendor/embedder",
				object: "model",
				metadata: { context_length: 512, pricing: { input_tokens: 0.005 }, tags: ["embed"] },
			},
			{
				id: "vendor/speaker",
				object: "model",
				metadata: { pricing: { input_characters: 5 }, tags: ["tts"] },
			},
			{
				id: "vendor/painter",
				object: "model",
				metadata: { pricing: { per_image_unit: 0.04 }, tags: ["image-gen"] },
			},
		],
	});
}

describe("DeepInfra built-in provider", () => {
	test("registers catalog descriptor with DEEPINFRA_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepinfra");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("DEEPINFRA_API_KEY");
		expect(descriptor?.catalogDiscovery?.allowUnauthenticated).toBe(true);
		expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.deepinfra).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
	});

	test("maps chat models from tagged catalog metadata and drops non-chat surfaces", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers);
			requests.push({ url: input.toString(), authorization: headers.get("Authorization") });
			return catalogFixture();
		};

		const options = deepinfraModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requests).toEqual([{ url: DISCOVERY_URL, authorization: null }]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		// Response order is preserved (the endpoint sorts by priority), even
		// though "vendor/a-plain-chat" sorts before "vendor/vision-thinker" by id.
		expect(models?.map(item => item.id)).toEqual(["vendor/vision-thinker", "vendor/a-plain-chat"]);

		const vision = models?.find(item => item.id === "vendor/vision-thinker");
		expect(vision?.provider).toBe("deepinfra");
		expect(vision?.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.reasoning).toBe(true);
		expect(vision?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] });
		expect(vision?.cost).toEqual({ input: 0.68, output: 3.4, cacheRead: 0.136, cacheWrite: 0 });
		expect(vision?.contextWindow).toBe(262144);
		// Genuine output cap: strictly below the context window, so it is kept.
		expect(vision?.maxTokens).toBe(131072);

		const plain = models?.find(item => item.id === "vendor/a-plain-chat");
		expect(plain?.input).toEqual(["text"]);
		expect(plain?.reasoning).toBe(true);
		expect(plain?.thinking).toBeUndefined();
		expect(plain?.cost).toEqual({ input: 0.09, output: 0.18, cacheRead: 0, cacheWrite: 0 });
		expect(plain?.contextWindow).toBe(131072);
		// `max_tokens === context_length` is the total ceiling, not an output
		// cap — with no bundled reference the output limit stays unknown.
		expect(plain?.maxTokens).toBeNull();
	});

	test("clamps a bundled output cap to the context window DeepInfra serves", async () => {
		// A same-id reference carries the canonical deployment's cap, which can
		// exceed the smaller window DeepInfra serves — `Qwen/Qwen3.7-Max` is the
		// live example, a 500K reference cap against a 256K DeepInfra context.
		// An output cap above the context ceiling is meaningless, so the
		// reference fallback is clamped into the window.
		const referenceId = "Qwen/Qwen3.7-Max";
		const reference = getBundledModels("deepinfra").find(model => model.id === referenceId);
		expect(reference).toBeDefined();

		const fetchMock = async (): Promise<Response> =>
			Response.json({
				object: "list",
				data: [
					{
						id: referenceId,
						object: "model",
						metadata: {
							context_length: 256000,
							max_tokens: 256000,
							pricing: { input_tokens: 1.2, output_tokens: 6 },
							tags: ["chat"],
						},
					},
				],
			});

		const options = deepinfraModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		const mapped = models?.find(item => item.id === referenceId);
		expect(mapped?.contextWindow).toBe(256000);
		expect(mapped?.maxTokens).toBe(256000);
	});

	test("ships no bundled row whose output cap exceeds its context window", () => {
		// Guards the generated slice itself: the reference fallback runs again
		// during `gen:models`, so an unclamped cap would be baked into the
		// bundle rather than just appearing at discovery time.
		const offenders = getBundledModels("deepinfra")
			.filter(model => model.maxTokens !== null && model.contextWindow !== null)
			.filter(model => (model.maxTokens as number) > (model.contextWindow as number))
			.map(model => `${model.id}: ${model.maxTokens} > ${model.contextWindow}`);

		expect(offenders).toEqual([]);
	});

	test("keeps a live modality removal authoritative through the production manager merge", async () => {
		// The CLI resolves models through the manager, which merges the discovered
		// row over the bundled reference. `mergeDynamicModel` ORs image support
		// when both sides share a base URL — and every DeepInfra row does — so
		// without the provider override a model that lost its `vision`/`vlm` tags
		// would keep advertising image input and the agent would send images to a
		// now text-only route.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-deepinfra-refresh-"));
		const dbPath = path.join(tempDir, "models.db");
		const bundledVisionModel: ModelSpec<"openai-completions"> = {
			id: "vendor/was-vision",
			name: "Was Vision",
			api: "openai-completions",
			provider: "deepinfra",
			baseUrl: DEEPINFRA_BASE_URL,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 16384,
		};
		const fetchMock = async (): Promise<Response> =>
			Response.json({
				object: "list",
				data: [
					{
						id: "vendor/was-vision",
						object: "model",
						metadata: {
							// Live catalog no longer tags this model as vision-capable.
							context_length: 131072,
							max_tokens: 131072,
							pricing: { input_tokens: 0.1, output_tokens: 0.2 },
							tags: ["chat"],
						},
					},
				],
			});

		try {
			const { models } = await resolveProviderModels<"openai-completions">(
				{
					...deepinfraModelManagerOptions({ fetch: fetchMock }),
					staticModels: [bundledVisionModel],
					cacheDbPath: dbPath,
				},
				"online",
			);

			const model = models.find(item => item.id === "vendor/was-vision");
			expect(model?.input).toEqual(["text"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("sends a bearer token on keyed discovery", async () => {
		const authorizations: Array<string | null> = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			authorizations.push(new Headers(init?.headers).get("Authorization"));
			return catalogFixture();
		};

		const options = deepinfraModelManagerOptions({ apiKey: "di-test-key", fetch: fetchMock });
		await options.fetchDynamicModels?.();

		expect(authorizations).toEqual(["Bearer di-test-key"]);
	});
});
