/**
 * Regression for #17481: GitHub Copilot's discovered Claude 5.x base rows
 * (capped to the default context tier) reverted to the bundled 1M window on
 * every cached read. `ModelRegistry` layers an `additiveOnly` shared catalog
 * over Copilot discovery, and the cached resolution stripped every cached row
 * whose id is bundled, so the live-corrected rows lost to the bundled ones.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { type ModelRefreshStrategy, resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

/** `/models` entry shaped like Copilot under `X-GitHub-Api-Version: 2026-08-01`. */
function tieredEntry(id: string) {
	return {
		id,
		name: id,
		capabilities: {
			type: "chat",
			limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 },
			supports: { vision: true },
		},
		billing: {
			token_prices: {
				default: { max_prompt_tokens: 136_000, input_price: 500, output_price: 2500, cache_price: 50 },
				long_context: { max_prompt_tokens: 936_000, input_price: 500, output_price: 2500, cache_price: 50 },
			},
		},
	};
}

describe("#17481 github-copilot cached base context windows", () => {
	it("keeps discovered default-tier windows for bundled ids on cached reads", async () => {
		// The premise: the bundled row is the 1M window discovery must override.
		expect(getBundledModels("github-copilot").find(model => model.id === "claude-opus-5")?.contextWindow).toBe(
			1_000_000,
		);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-issue-17481-"));
		try {
			const options = {
				...githubCopilotModelManagerOptions({
					apiKey: "copilot-test-key",
					fetch: async () => Response.json({ data: [tieredEntry("claude-opus-5")] }),
				}),
				cacheDbPath: path.join(tempDir, "models.db"),
				// ModelRegistry's shared-catalog layer for non-authoritative providers.
				modelsDev: { additiveOnly: true, fetch: async () => [], map: () => [] },
			};
			const windows = async (strategy: ModelRefreshStrategy) => {
				const { models } = await resolveProviderModels(options, strategy);
				const byId = new Map(models.map(model => [model.id, model.contextWindow]));
				return { base: byId.get("claude-opus-5"), long: byId.get("claude-opus-5-1m") };
			};

			const expected = { base: 136_000 + 64_000, long: 1_000_000 };
			expect(await windows("online")).toEqual(expected);
			expect(await windows("online-if-uncached")).toEqual(expected);
			expect(await windows("offline")).toEqual(expected);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
