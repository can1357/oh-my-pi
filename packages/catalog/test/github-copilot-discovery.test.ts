import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	createModelManager,
	type ModelRefreshStrategy,
	resolveProviderModels,
} from "@oh-my-pi/pi-catalog/model-manager";
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

/** Priced 1M Claude entry whose billed tiers are bounded by `context_max`. */
function pricedClaudeEntry(id: string, name: string) {
	return {
		id,
		name,
		capabilities: {
			type: "chat",
			limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 64_000 },
			supports: { vision: true },
		},
		billing: {
			token_prices: {
				default: { context_max: 200_000, input_price: 500, output_price: 2500, cache_price: 50 },
				long_context: { context_max: 936_000, input_price: 500, output_price: 2500, cache_price: 50 },
			},
		},
	};
}

/** Priced 1M Claude entry whose billed tiers are bounded by `max_prompt_tokens`. */
function promptTieredClaudeEntry(id: string) {
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

async function discoverWindows(entries: unknown[]): Promise<Map<string, number | null>> {
	const fetch = vi.fn(async () => Response.json({ data: entries }));
	const specs =
		(await githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch }).fetchDynamicModels?.()) ?? [];
	return new Map(specs.map(spec => [spec.id, spec.contextWindow]));
}

function copilotFetch() {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ data: [pricedClaudeEntry("claude-opus-5", "Claude Opus 5")] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	);
}

// Ids are deliberately absent from the KDL rules so no `limits-patch` masks the mapper.
describe("tiered default-lane window", () => {
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

	it("keeps a current tier-level prompt budget separate from the model-wide long-context budget", async () => {
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

describe("cached base context windows", () => {
	it("keeps discovered default-tier windows for bundled ids on cached reads", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-copilot-cached-windows-"));
		try {
			const options = {
				...githubCopilotModelManagerOptions({
					apiKey: "copilot-test-key",
					fetch: async () => Response.json({ data: [promptTieredClaudeEntry("claude-opus-5")] }),
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

describe("reference-less Claude model", () => {
	it("derives reasoning + adaptive efforts and synthesizes the 1M sibling", async () => {
		const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: copilotFetch() });
		const specs = (await options.fetchDynamicModels?.()) ?? [];

		const base = specs.find(m => m.id === "claude-opus-5");
		expect(base).toBeDefined();
		expect(base?.api).toBe("anthropic-messages");
		expect(base?.reasoning).toBe(true);

		// buildModel derives the adaptive effort ladder from the id, matching how
		// bundled Copilot Opus 4.7/4.8 resolve.
		if (!base) throw new Error("missing base spec");
		const built = buildModel(base);
		expect(built.thinking?.mode).toBe("anthropic-adaptive");
		expect(built.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);

		const variant = specs.find(m => m.id === "claude-opus-5-1m");
		expect(variant).toBeDefined();
		expect(variant?.requestModelId).toBe("claude-opus-5");
		expect(variant?.contextWindow).toBe(1_000_000);
	});

	it("keeps the model and its 1M sibling alive across an offline read", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-copilot-offline-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		try {
			const manager = createModelManager({
				...githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: copilotFetch() }),
				cacheDbPath,
			});

			const online = await manager.refresh("online");
			expect(online.models.find(m => m.id === "claude-opus-5")).toBeDefined();
			expect(online.models.find(m => m.id === "claude-opus-5-1m")).toBeDefined();

			// The header-restore path drops unrestorable dynamic-only models on
			// offline reads; the trusted COPILOT_API_HEADERS constant must survive.
			const offline = await manager.refresh("offline");
			const opus5 = offline.models.find(m => m.id === "claude-opus-5");
			const opus5_1m = offline.models.find(m => m.id === "claude-opus-5-1m");
			expect(opus5).toBeDefined();
			expect(opus5?.reasoning).toBe(true);
			expect(opus5?.headers?.["X-GitHub-Api-Version"]).toBe("2026-08-01");
			expect(opus5_1m).toBeDefined();
			expect(opus5_1m?.headers?.["X-GitHub-Api-Version"]).toBe("2026-08-01");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not fabricate a thinking dial for a pre-thinking reference-less Claude", async () => {
		// A lagging enterprise catalog could surface an old kind-first Claude on
		// the Messages proxy. It must stay non-reasoning so no effort dial is
		// offered for thinking parameters the model would reject.
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [pricedClaudeEntry("claude-sonnet-3.5", "Claude Sonnet 3.5")] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const options = githubCopilotModelManagerOptions({ apiKey: "copilot-test-key", fetch: fetchMock });
		const specs = (await options.fetchDynamicModels?.()) ?? [];

		const base = specs.find(m => m.id === "claude-sonnet-3.5");
		expect(base).toBeDefined();
		expect(base?.api).toBe("anthropic-messages");
		expect(base?.reasoning).toBe(false);
		if (!base) throw new Error("missing base spec");
		expect(buildModel(base).thinking).toBeUndefined();
	});
});
