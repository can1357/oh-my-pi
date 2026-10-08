import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { paretoModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const GLM_FLASH = "z-ai/glm-5.3-flash";

function rosterFetch(rows: readonly Record<string, unknown>[]): FetchImpl {
	return vi.fn(
		async () =>
			new Response(JSON.stringify({ object: "list", data: rows }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as FetchImpl;
}

async function resolveRoster(fetch: FetchImpl): Promise<Map<string, Model<"openai-completions">>> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-pareto-"));
	try {
		const result = await resolveProviderModels(
			{
				...paretoModelManagerOptions({ apiKey: "sk-pareto", fetch }),
				staticModels: getBundledModels("pareto"),
				cacheDbPath: path.join(tempDir, "models.db"),
			},
			"online",
		);
		return new Map(result.models.map(model => [model.id, model as Model<"openai-completions">]));
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Pareto Inference provider support", () => {
	test("live /v1/models pricing replaces the bundled list price; the seed keeps limits and the GLM ladder", async () => {
		// An account with its own price agreement: `/v1/models` called with that
		// key reports the account rate as OpenRouter-format USD-per-token strings.
		const fetchMock = rosterFetch([
			{
				id: GLM_FLASH,
				object: "model",
				owned_by: "z-ai",
				pricing: { prompt: "0.00000003", completion: "0.0000001", input_cache_read: "0.000000006" },
			},
		]);
		const model = (await resolveRoster(fetchMock)).get(GLM_FLASH);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.paretoinference.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer sk-pareto" }),
			}),
		);
		expect(model?.cost).toEqual({ input: 0.03, output: 0.1, cacheRead: 0.006, cacheWrite: 0 });
		expect(model).toMatchObject({ input: ["text"], contextWindow: null, maxTokens: 131072 });
		expect(model?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model?.compat.thinkingFormat).toBe("openai");
	});

	test("a row without usable pricing keeps the bundled rate instead of reading as free", async () => {
		const bundled = getBundledModels("pareto").find(model => model.id === GLM_FLASH);
		const model = (
			await resolveRoster(rosterFetch([{ id: GLM_FLASH, pricing: { prompt: "n/a", completion: null } }]))
		).get(GLM_FLASH);

		expect(bundled?.cost.input).toBeGreaterThan(0);
		expect(model?.cost).toEqual(bundled?.cost);
	});
});
