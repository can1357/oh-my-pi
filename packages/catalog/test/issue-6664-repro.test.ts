/**
 * Regression for #6664: GitHub Copilot serves a Claude model with no bundled
 * catalog reference (e.g. `claude-opus-5`). Before the fix such a model was
 * discovered with `reasoning: false` / `thinking: undefined` (no effort dial),
 * and it — plus its synthesized `-1m` sibling — vanished on the next offline
 * read because their `COPILOT_API_HEADERS` could not be restored from any
 * bundled static entry.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { githubCopilotModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

/** `/models` entry shaped like Copilot under `X-GitHub-Api-Version: 2026-08-01`. */
function tieredEntry(id: string, name: string) {
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

function copilotFetch() {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ data: [tieredEntry("claude-opus-5", "Claude Opus 5")] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	);
}

describe("#6664 github-copilot reference-less Claude model", () => {
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
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-6664-"));
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
				new Response(JSON.stringify({ data: [tieredEntry("claude-sonnet-3.5", "Claude Sonnet 3.5")] }), {
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
