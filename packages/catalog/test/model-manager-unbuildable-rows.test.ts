/**
 * A remote row `buildModel` rejects (e.g. an equal-rank KDL overlap on an id
 * newer than the running build's rule tree) costs only that row. Before, the
 * throw discarded the whole source: a new `claude-haiku-5-5` on the shared
 * catalog took every catalog-only Anthropic id (`claude-sonnet-5-5`) offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import * as buildModule from "@oh-my-pi/pi-catalog/build";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { removeWithRetries } from "../../utils/src/temp";

const UNBUILDABLE = "unbuildable-model";

function spec(id: string): ModelSpec<"openai-completions"> {
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

describe("discovery rows that fail to build", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-unbuildable-"));
		dbPath = path.join(tempDir, "models.db");
		const build = buildModule.buildModel;
		vi.spyOn(buildModule, "buildModel").mockImplementation(<TApi extends Api>(row: ModelSpec<TApi>): Model<TApi> => {
			if (row.id === UNBUILDABLE) throw new Error("ambiguous overlap");
			return build(row);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tempDir);
	});

	it("keeps the source's other rows", async () => {
		const result = await resolveProviderModels(
			{
				providerId: "synthetic",
				staticModels: [],
				modelsDev: { fetch: async () => null, map: () => [spec("catalog-only-model"), spec(UNBUILDABLE)] },
				cacheDbPath: dbPath,
			},
			"online",
		);

		expect(result.models.map(model => model.id)).toEqual(["catalog-only-model"]);
	});

	it("fails the fetch when no row builds, so authoritative discovery keeps static models", async () => {
		const result = await resolveProviderModels(
			{
				providerId: "synthetic",
				staticModels: [spec("static-model")],
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: async () => [spec(UNBUILDABLE)],
				cacheDbPath: dbPath,
			},
			"online",
		);

		expect(result.models.map(model => model.id)).toEqual(["static-model"]);
	});
});
