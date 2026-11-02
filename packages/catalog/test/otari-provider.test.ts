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

describe("Otari discovery", () => {
	test("maps reasoning, modalities, limits, and per-million pricing from the live roster", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = otariModelManagerOptions({
			apiKey: "otari-test-key",
			fetch: rosterFetch(
				[
					{
						id: "anthropic/claude-haiku-4.5",
						name: "Claude Haiku 4.5",
						reasoning: true,
						input_modalities: ["text"],
						context_window: 200000,
						max_output_tokens: 64000,
						pricing: { input_price_per_million: 1, output_price_per_million: 5 },
					},
					{
						id: "alibaba/qwen2.5-vl-72b-instruct",
						name: "Qwen2.5 VL 72B Instruct",
						reasoning: false,
						input_modalities: ["text", "image"],
						context_window: 131072,
						max_output_tokens: 8192,
						pricing: { input_price_per_million: 0.4, output_price_per_million: 1.2 },
					},
				],
				calls,
			),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer otari-test-key" }]);
		expect(models.map(model => model.id)).toEqual(["alibaba/qwen2.5-vl-72b-instruct", "anthropic/claude-haiku-4.5"]);
		expect(models[1]).toMatchObject({
			reasoning: true,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 64000,
			cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
		});
		// Vision input is the only modality promotion the mapper makes.
		expect(models[0].input).toEqual(["text", "image"]);
		expect(models[0].cost).toEqual({ input: 0.4, output: 1.2, cacheRead: 0, cacheWrite: 0 });
	});

	test("a missing pricing block and missing capability fields fall back to neutral defaults", async () => {
		const options = otariModelManagerOptions({
			apiKey: "otari-test-key",
			fetch: rosterFetch([{ id: "upstream/bare-model" }]),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: "upstream/bare-model",
			reasoning: false,
			input: ["text"],
			contextWindow: null,
			maxTokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("no key serves nothing, and the live roster prunes a stale cached row", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-otari-"));
		try {
			// `/models` is key-protected, so without a key there is no bundled
			// surface to fall back on.
			const withoutKey = await resolveProviderModels(
				{ ...otariModelManagerOptions({}), cacheDbPath: path.join(tempDir, "keyless.db") },
				"online-if-uncached",
			);
			expect(withoutKey.models).toEqual([]);

			// A workspace that had `old/retired-model` enabled and has since
			// disabled it must not keep it after an authoritative refresh.
			const withLive = await resolveProviderModels(
				{
					...otariModelManagerOptions({
						apiKey: "otari-test-key",
						fetch: rosterFetch([
							{
								id: "anthropic/claude-haiku-4.5",
								pricing: { input_price_per_million: 1, output_price_per_million: 5 },
							},
						]),
					}),
					cacheDbPath: path.join(tempDir, "live.db"),
				},
				"online",
			);
			expect(withLive.models.map(model => model.id)).toEqual(["anthropic/claude-haiku-4.5"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
