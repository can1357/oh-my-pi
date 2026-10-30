import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { compileCompatRules } from "../scripts/compat-compiler";

const RULES_DIR = path.join(import.meta.dir, "../src/compat/rules");

describe("rerank catalog policy", () => {
	test("OpenRouter's documented rerank seed resolves onto the rerank runner", async () => {
		const rules = await compileCompatRules(RULES_DIR);
		const provider = rules.providers.openrouter;
		if (!provider?.seed) throw new Error("openrouter has no catalog seed");
		expect(provider.kindApis?.rerank).toBe("openrouter-rerank");
		const models = provider.seed.models
			.filter(row => row.api === "openrouter-rerank")
			.map(row => buildModel(row as ModelSpec));
		expect(models.map(model => model.id)).toEqual(["cohere/rerank-v3.5"]);
		expect(models[0]).toMatchObject({
			kind: "rerank",
			api: "openrouter-rerank",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
});
