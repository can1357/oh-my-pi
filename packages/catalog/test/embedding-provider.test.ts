import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { compileCompatRules } from "../scripts/compat-compiler";

const RULES_DIR = path.join(import.meta.dir, "../src/compat/rules");

async function resolvedSeedModels(providerId: "openai" | "openrouter") {
	const rules = await compileCompatRules(RULES_DIR);
	const seed = rules.providers[providerId]?.seed;
	if (!seed) throw new Error(`${providerId} has no catalog seed`);
	return seed.models.filter(row => row.api === "openai-embeddings").map(row => buildModel(row as ModelSpec));
}

describe("cloud embedding catalog policy", () => {
	test("OpenAI embedding seeds resolve onto the embeddings runner", async () => {
		const models = await resolvedSeedModels("openai");
		expect(models.map(model => model.id)).toEqual([
			"text-embedding-3-small",
			"text-embedding-3-large",
			"text-embedding-ada-002",
		]);
		expect(models.map(model => model.cost.input)).toEqual([0.02, 0.13, 0.1]);
		for (const model of models) {
			expect(model.kind).toBe("embedding");
			expect(model.api).toBe("openai-embeddings");
			expect(model.cost.output).toBe(0);
		}
	});

	test("OpenRouter's bundled embedding fallbacks resolve onto the embeddings runner", async () => {
		const models = await resolvedSeedModels("openrouter");
		expect(models.map(model => model.id)).toEqual(["openai/text-embedding-3-small", "qwen/qwen3-embedding-8b"]);
		expect(models.map(model => model.cost.input)).toEqual([0.02, 0.01]);
		for (const model of models) {
			expect(model.kind).toBe("embedding");
			expect(model.api).toBe("openai-embeddings");
			expect(model.cost.output).toBe(0);
		}
	});
});
