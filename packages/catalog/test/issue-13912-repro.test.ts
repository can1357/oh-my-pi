/**
 * Regression for #13912: a tiered Copilot `/models` row whose billed default
 * ceiling (`billing.token_prices.default.context_max`) overlaps the long lane
 * resolved its base entry to ~1M, ignoring the default lane's reported
 * `max_prompt_tokens`, so the base row and its `-1m` sibling were both ~1M.
 */
import { describe, expect, it, vi } from "bun:test";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

/** `/models` entry shaped like Copilot under `X-GitHub-Api-Version: 2026-08-01`. */
function copilotEntry(
	id: string,
	limits: { window: number; prompt: number; output: number },
	billing?: { defaultMax: number; longMax: number },
) {
	return {
		id,
		name: id,
		capabilities: {
			type: "chat",
			limits: {
				max_context_window_tokens: limits.window,
				max_prompt_tokens: limits.prompt,
				max_output_tokens: limits.output,
			},
		},
		...(billing && {
			billing: {
				token_prices: {
					default: { context_max: billing.defaultMax },
					long_context: { context_max: billing.longMax },
				},
			},
		}),
	};
}

async function discoverWindows(entries: unknown[]): Promise<Map<string, number | null>> {
	const fetch = vi.fn(async () => Response.json({ data: entries }));
	const specs =
		(await githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch }).fetchDynamicModels?.()) ?? [];
	return new Map(specs.map(spec => [spec.id, spec.contextWindow]));
}

// Ids are deliberately absent from the KDL rules so no `limits-patch` masks the mapper.
describe("github-copilot tiered default-lane window", () => {
	it("bounds the base row by max_prompt_tokens when the billed default overlaps the long lane", async () => {
		const windows = await discoverWindows([
			copilotEntry(
				"gpt-9-overlap",
				{ window: 1_050_000, prompt: 272_000, output: 56_000 },
				{ defaultMax: 950_000, longMax: 994_000 },
			),
		]);
		expect(windows.get("gpt-9-overlap")).toBe(328_000);
		expect(windows.get("gpt-9-overlap-1m")).toBe(1_050_000);
	});

	it("keeps a current tier-level prompt budget separate from the model-wide long-context budget (#14770)", async () => {
		const windows = await discoverWindows([
			{
				id: "gpt-9-current-tiers",
				name: "GPT 9 Current Tiers",
				capabilities: {
					type: "chat",
					limits: {
						max_context_window_tokens: 1_050_000,
						max_prompt_tokens: 922_000,
						max_output_tokens: 128_000,
					},
				},
				billing: {
					token_prices: {
						default: { max_prompt_tokens: 272_000 },
						long_context: { max_prompt_tokens: 922_000 },
					},
				},
			},
		]);
		expect(windows.get("gpt-9-current-tiers")).toBe(400_000);
		expect(windows.get("gpt-9-current-tiers-1m")).toBe(1_050_000);
	});

	it("keeps the billed default ceiling when it is tighter than max_prompt_tokens", async () => {
		const windows = await discoverWindows([
			copilotEntry(
				"claude-fable-9",
				{ window: 1_000_000, prompt: 900_000, output: 64_000 },
				{ defaultMax: 200_000, longMax: 936_000 },
			),
		]);
		expect(windows.get("claude-fable-9")).toBe(264_000);
		expect(windows.get("claude-fable-9-1m")).toBe(1_000_000);
	});

	it("keeps the total window for untiered rows that report a smaller prompt budget", async () => {
		const windows = await discoverWindows([
			copilotEntry("gpt-9-untiered", { window: 400_000, prompt: 272_000, output: 128_000 }),
		]);
		expect(windows.get("gpt-9-untiered")).toBe(400_000);
		expect(windows.has("gpt-9-untiered-1m")).toBe(false);
	});
});
