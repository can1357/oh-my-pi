/**
 * Admission guard for cached/discovered rows that carry alternate-currency
 * cards. `priceUsage` reads the card's rates unbranched, so a malformed
 * `{ CNY: {} }` reaching a materialized row would put `NaN` into
 * `costByCurrency`; `isModelCost` must reject it at the boundary instead.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, ModelSpec, Usage } from "@oh-my-pi/pi-catalog/types";

/** Valid base rates plus optional alternate-currency fields for the malformed cases. */
function spec(id: string, extra: Record<string, unknown> = {}): ModelSpec<"openai-completions"> {
	const cost = { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0, ...extra };
	return {
		id,
		provider: "deepseek",
		name: id,
		api: "openai-completions",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: cost as unknown as ModelCost,
	};
}

const usage: Usage = {
	input: 1_000_000,
	output: 1_000_000,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2_000_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("alternate-currency card admission", () => {
	it("drops a row whose top-level card is malformed instead of admitting NaN pricing", () => {
		// Baseline: the malformed map genuinely poisons `priceUsage`.
		const poisoned = { ...usage, cost: { ...usage.cost } };
		calculateUsageCost(spec("poisoned", { currencyCards: { CNY: {} } }).cost, poisoned);
		expect(Number.isNaN(poisoned.costByCurrency?.CNY?.total ?? 0)).toBe(true);

		// A well-formed sibling stays admissible with finite converted totals.
		const healthy = { ...usage, cost: { ...usage.cost } };
		calculateUsageCost(
			spec("healthy", { currencyCards: { CNY: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } } }).cost,
			healthy,
		);
		expect(healthy.costByCurrency?.CNY?.total).toBeCloseTo(10, 8);
	});

	it("rejects malformed top-level currency cards and unknown currency codes at the manager boundary", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "currency-admission-"));
		try {
			const rows = [
				spec("malformed-cards", { currencyCards: { CNY: {} } }),
				spec("unknown-code", { currency: "EUR" }),
				spec("valid", {
					currencyCards: { CNY: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } },
				}),
			];
			const manager = createModelManager({
				providerId: "deepseek",
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: async () => rows,
				cacheDbPath: path.join(tempDir, "models.db"),
			});

			const { models } = await manager.refresh("online");
			const ids = models.map(model => model.id).sort();
			expect(ids).not.toContain("malformed-cards");
			expect(ids).not.toContain("unknown-code");
			expect(ids).toContain("valid");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
