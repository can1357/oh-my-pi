import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { otariModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://api.otari.ai/api/v1";

function rosterFetch(data: unknown[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

// Rows in the shape Otari's `/models` serves: OpenRouter-style
// `supported_parameters` and `architecture` where the gateway has models.dev
// metadata, bare id + pricing where it does not.
const HAIKU = {
	id: "anthropic/claude-haiku-4.5",
	object: "model",
	owned_by: "anthropic",
	name: "Claude Haiku 4.5",
	supported_parameters: ["tools", "tool_choice", "reasoning"],
	architecture: { input_modalities: ["text", "image", "pdf"], output_modalities: ["text"] },
	context_window: 200000,
	max_output_tokens: 64000,
	pricing: {
		input_price_per_million: 1,
		output_price_per_million: 5,
		cache_read_price_per_million: 0.1,
		cache_write_price_per_million: 1.25,
	},
};

describe("Otari discovery", () => {
	test("maps reasoning, modalities, limits, and per-million pricing from the live roster", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = otariModelManagerOptions({
			apiKey: "otari-test-key",
			fetch: rosterFetch(
				[
					HAIKU,
					{
						id: "mistralai/mistral-medium-3",
						object: "model",
						owned_by: "mistralai",
						pricing: { input_price_per_million: 1.5, output_price_per_million: 7.5 },
					},
				],
				calls,
			),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer otari-test-key" }]);
		const byId = new Map(models.map(model => [model.id, model]));
		expect(byId.get("anthropic/claude-haiku-4.5")).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
			maxTokens: 64000,
			cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		});
		// No models.dev metadata: text-only, non-reasoning, unknown limits.
		expect(byId.get("mistralai/mistral-medium-3")).toMatchObject({
			reasoning: false,
			input: ["text"],
			contextWindow: null,
			maxTokens: null,
			cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("drops rows that cannot answer a chat completion", async () => {
		const options = otariModelManagerOptions({
			apiKey: "otari-test-key",
			fetch: rosterFetch([
				HAIKU,
				// Metadata says it writes no text.
				{
					id: "google/gemini-2.5-flash-preview-tts",
					architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
				},
				// No metadata: caught by the KDL exclusion patterns, including
				// model-name patterns behind the `<upstream>/` prefix.
				{ id: "alibaba/qwen3-embedding-4b" },
				{ id: "baai/bge-m3" },
				// No metadata, but a chat model: kept.
				{ id: "openai/gpt-5.1-codex" },
			]),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];
		expect(models.map(model => model.id).sort()).toEqual(["anthropic/claude-haiku-4.5", "openai/gpt-5.1-codex"]);
	});

	test("a second workspace key never reads the first workspace's cached roster", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-otari-"));
		try {
			const cacheDbPath = path.join(tempDir, "shared.db");
			const workspaceA = await resolveProviderModels(
				{ ...otariModelManagerOptions({ apiKey: "key-a", fetch: rosterFetch([HAIKU]) }), cacheDbPath },
				"online",
			);
			expect(workspaceA.models.map(model => model.id)).toEqual(["anthropic/claude-haiku-4.5"]);

			// Within A's TTL, B's normal startup must still fetch its own roster.
			const calls: Array<{ url: string; authorization: string | null }> = [];
			const workspaceB = await resolveProviderModels(
				{
					...otariModelManagerOptions({
						apiKey: "key-b",
						fetch: rosterFetch([{ id: "mistralai/mistral-medium-3" }], calls),
					}),
					cacheDbPath,
				},
				"online-if-uncached",
			);
			expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer key-b" }]);
			expect(workspaceB.models.map(model => model.id)).toEqual(["mistralai/mistral-medium-3"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
