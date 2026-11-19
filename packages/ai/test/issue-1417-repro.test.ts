import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { readModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { removeWithRetries } from "../../utils/src/temp";

const TTL_MS = 24 * 60 * 60 * 1000;

function syntheticModel(id: string): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "synthetic",
		baseUrl: "https://api.synthetic.new/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

describe("issue #1417 synthetic model deprecation", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-issue-1417-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("prunes static-only models when provider discovery is authoritative", async () => {
		const deprecatedModel = syntheticModel("hf:moonshotai/Kimi-K2.5");
		const supportedModel = syntheticModel("hf:zai-org/GLM-5.1");

		const result = await resolveProviderModels(
			{
				providerId: "synthetic",
				staticModels: [deprecatedModel],
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: async () => [supportedModel],
				cacheDbPath: dbPath,
			},
			"online",
		);

		expect(result.stale).toBe(false);
		expect(result.models.map(model => model.id)).toEqual(["hf:zai-org/GLM-5.1"]);
		expect(readModelCache("synthetic", TTL_MS, Date.now, dbPath)?.models.map(model => model.id)).toEqual([
			"hf:zai-org/GLM-5.1",
		]);
	});
});
