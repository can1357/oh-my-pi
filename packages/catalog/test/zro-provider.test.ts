import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { carriesReasoning } from "@oh-my-pi/pi-catalog/compat/reasoning-carry";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { zroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** A row as Zro's LiteLLM-backed `/v1/models` reports it (captured 2026-11-02). */
function row(id: string, limits?: { input: number; output: number }) {
	return {
		id,
		object: "model",
		created: 1677610602,
		owned_by: "openai",
		...(limits && { mode: "chat", max_input_tokens: limits.input, max_output_tokens: limits.output }),
	};
}

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("Zro provider support", () => {
	test("live discovery keeps bare chat ids, drops aliases, the router and retired ids, and reads wire limits", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zro-"));
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return Response.json({
				object: "list",
				data: [
					row("deepseek-v4.1-flash", { input: 1_048_576, output: 64_000 }),
					row("zro/deepseek-v4.1-flash", { input: 1_048_576, output: 64_000 }),
					row("glm-5.3", { input: 1_048_576, output: 131_000 }),
					row("zro/glm-5.3", { input: 1_048_576, output: 131_000 }),
					row("deepseek-v4-flash-0731", { input: 1_048_576, output: 64_000 }),
					row("auto"),
					row("zro/auto"),
					// A model released after this bundle: only the wire describes it.
					row("deepseek-v4.2-flash", { input: 2_097_152, output: 200_000 }),
				],
			});
		}) as FetchImpl;

		const { models } = await resolveProviderModels(
			{
				...zroModelManagerOptions({ apiKey: "sk-zro-test", fetch: fetchMock }),
				cacheDbPath: path.join(tempDir, "models.db"),
			},
			"online",
		);

		expect(requests).toEqual([{ url: "https://zro.moonmath.ai/v1/models", authorization: "Bearer sk-zro-test" }]);
		// Bundled rows absent from the live roster (glm-5.3-flash, the Dolly
		// models) are pruned: the roster is authoritative.
		expect(models.map(model => model.id).sort()).toEqual(["deepseek-v4.1-flash", "deepseek-v4.2-flash", "glm-5.3"]);

		// A bundled id keeps the seed's prices and modalities instead of
		// degrading to an unpriced, text-only default.
		const deepseek = models.find(model => model.id === "deepseek-v4.1-flash");
		expect(getModelPricingStatus(deepseek!)).toBe("fixed");
		expect(deepseek?.input).toEqual(["text", "image"]);

		// An unbundled id takes its limits from the wire and its reasoning
		// ladder from the DeepSeek lineage.
		const unbundled = models.find(model => model.id === "deepseek-v4.2-flash");
		expect(unbundled?.contextWindow).toBe(2_097_152);
		expect(unbundled?.maxTokens).toBe(200_000);
		expect(unbundled?.reasoning).toBe(true);
		expect(unbundled?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("Dolly reasoning stays on Dolly; Zro's stock GLM reasoning carries to other GLM hosts", () => {
		const zroGlm = { provider: "zro", api: "openai-completions", model: "glm-5.3" };
		const zaiGlm = { provider: "zai", api: "openai-completions", id: "glm-5.3" };
		expect(carriesReasoning(zroGlm, zaiGlm)).toBe(true);

		// Dolly 2 classifies as GLM 5.3, but its fine-tuned weights must never
		// replay their reasoning as stock GLM's, in either direction.
		const dolly = { provider: "zro", api: "openai-completions", model: "dolly2-security" };
		expect(carriesReasoning(dolly, zaiGlm)).toBe(false);
		expect(
			carriesReasoning(
				{ provider: "zai", api: "openai-completions", model: "glm-5.3" },
				{ provider: "zro", api: "openai-completions", id: "dolly2-security" },
			),
		).toBe(false);
	});

	test("Zro GLM and Dolly models start at Zro's documented `high` while other GLM hosts keep the lineage `max`", () => {
		const zro = seedModels<"openai-completions">("zro");
		for (const id of ["glm-5.3", "glm-5.3-flash", "dolly1-security", "dolly2-security"]) {
			expect(buildModel(zro.find(model => model.id === id)!).thinking?.defaultLevel).toBe(Effort.High);
		}
		const zaiGlm = seedModels<"openai-completions">("zai").find(model => model.id === "glm-5.3")!;
		expect(buildModel(zaiGlm).thinking?.defaultLevel).toBe(Effort.Max);
	});
});
