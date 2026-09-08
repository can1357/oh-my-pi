import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import {
	googleModelManagerOptions,
	googleVertexModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/google";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const googleVertexModelsDevPayload = {
	"google-vertex": {
		models: {
			"gemini-3.5-flash": {
				name: "Gemini 3.5 Flash",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image", "pdf"] },
				limit: { context: 1_048_576, output: 65_536 },
				cost: { input: 0.3, output: 2.5, cache_read: 0.03, cache_write: 0.75 },
				provider: { npm: "@ai-sdk/google-vertex" },
			},
			"deepseek-ai/deepseek-v3.2-maas": {
				name: "DeepSeek V3.2",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "pdf"] },
				limit: { context: 163_840, output: 65_536 },
				provider: { npm: "@ai-sdk/openai-compatible" },
			},
			"claude-sonnet-4@20250514": {
				name: "Claude Sonnet 4",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image", "pdf"] },
				limit: { context: 200_000, output: 64_000 },
				provider: { npm: "@ai-sdk/google-vertex/anthropic" },
			},
			"gemini-embedding-001": {
				name: "Gemini Embedding 001",
				tool_call: false,
				provider: { npm: "@ai-sdk/google-vertex" },
			},
		},
	},
} satisfies Record<string, unknown>;

describe("google-vertex model catalog", () => {
	it("maps the stencil.so Vertex catalog instead of the project discovery endpoint", () => {
		const models = mapModelsDevToModels(googleVertexModelsDevPayload, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "google-vertex",
		);

		expect(models.map(model => model.id)).toEqual([
			"gemini-3.5-flash",
			"deepseek-ai/deepseek-v3.2-maas",
			"claude-sonnet-4@20250514",
		]);

		const gemini = models.find(model => model.id === "gemini-3.5-flash");
		expect(gemini?.api).toBe("google-vertex");
		expect(gemini?.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
		expect(gemini?.input).toEqual(["text", "image"]);
		expect(gemini?.contextWindow).toBe(1_048_576);

		const deepseek = models.find(model => model.id === "deepseek-ai/deepseek-v3.2-maas");
		expect(deepseek?.api).toBe("openai-completions");
		expect(deepseek?.baseUrl).toBe(
			"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi",
		);

		const claude = models.find(model => model.id === "claude-sonnet-4@20250514");
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.baseUrl).toBe(
			"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
		);
		expect(claude?.reasoning).toBe(true);
	});

	it("uses the bundled Vertex catalog without ADC project discovery", async () => {
		const options = googleVertexModelManagerOptions({
			project: "vertex-project",
			location: "global",
			fetch: async () => new Response("unexpected", { status: 500 }),
		});

		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toBeUndefined();

		const result = await resolveProviderModels({ ...options, cacheDbPath: ":memory:" }, "offline");
		expect(result.stale).toBe(false);
		expect(result.models.some(model => model.id.endsWith("-maas") && model.api === "openai-completions")).toBe(true);
		expect(result.models.some(model => model.id === "gemini-3.5-flash")).toBe(true);
		expect(result.models.some(model => model.id === "gemini-1.5-pro")).toBe(false);
	});

	it("invalidates cached Gemini 3.7 Flash effort metadata on upgrade (#10543)", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-google-flash37-cache-"));
		try {
			for (const [providerId, options] of [
				["google", googleModelManagerOptions()],
				["google-vertex", googleVertexModelManagerOptions()],
			] as const) {
				const bundledModels = getBundledModels(providerId);
				const current = bundledModels.find(model => model.id === "gemini-3.7-flash");
				if (!current?.thinking) throw new Error(`${providerId} Gemini 3.7 Flash is missing thinking metadata`);
				const stale = {
					...current,
					thinking: {
						...current.thinking,
						efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
					},
				};
				const cacheDbPath = path.join(tempDir, `${providerId}.db`);
				writeModelCache(providerId, Date.now(), [stale], true, "merge-v3:pre-10543", cacheDbPath);

				const result = await resolveProviderModels(
					{ ...options, staticModels: bundledModels, cacheDbPath },
					"offline",
				);
				expect(result.models.find(model => model.id === current.id)?.thinking?.efforts).toEqual([
					Effort.Low,
					Effort.Medium,
					Effort.High,
				]);
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
