import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { openaiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const DAYBREAK_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
// The openai seed also carries transcription and embedding runners; only the
// Responses rows are Daybreak/GPT-5.6 chat models.
const DAYBREAK_MODELS = seedModels("openai").filter(model => model.api === "openai-responses");

describe("OpenAI Daybreak and GPT-5.6 models", () => {
	test("bakes off support and long-context pricing onto every first-party GPT-5.6 alias", () => {
		const longContextCosts = {
			"daybreak-blue-latest": { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
			"gpt-5.6": { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
			"gpt-5.6-luna": { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			"gpt-5.6-luna-pro": { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
			"gpt-5.6-sol": { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
			"gpt-5.6-sol-pro": { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
			"gpt-5.6-terra": { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
			"gpt-5.6-terra-pro": { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
		} as const;
		for (const [id, longContext] of Object.entries(longContextCosts)) {
			const model = getBundledModel<"openai-responses">("openai", id);
			expect(model.compat.reasoningDisableMode).toBe("none-effort");
			expect(model.cost.longContext).toEqual({ inputThreshold: 272_000, ...longContext });
		}
		for (const id of ["daybreak-red-latest", "gpt-5.6-cyber"]) {
			const model = getBundledModel<"openai-responses">("openai", id);
			expect(model.compat.reasoningDisableMode).toBe("none-effort");
			expect(model.cost.longContext).toBeUndefined();
		}
	});

	test("exposes off and every GPT-5.6 wire effort on all Daybreak IDs", () => {
		const generated: ModelSpec<Api>[] = DAYBREAK_MODELS.map(model => ({
			...model,
			cost: { ...model.cost },
		}));
		applyGeneratedModelPolicies(generated);

		for (const spec of generated) {
			const model = buildModel(spec);
			expect(getSupportedEfforts(model)).toEqual(DAYBREAK_EFFORTS);
			expect(model.thinking?.requiresEffort).not.toBe(true);
			expect(model.compat).toMatchObject({
				supportsPromptCacheBreakpoints: true,
				supportsSamplingParams: false,
				reasoningDisableMode: "none-effort",
			});
			expect(model.applyPatchToolType).toBe("freeform");
			expect(model.supportsComputerUse).toBe(spec.id === "gpt-5.6-cyber");
		}
	});
});

describe("OpenAI Decisions judge row", () => {
	const DECISIONS_ROW = {
		api: "openai-decisions",
		kind: "judge",
		requestModelId: "gpt-6-luna",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		reasoning: false,
		cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_050_000,
	};

	test("builds the seed as a GPT-6 Luna Decisions judge", () => {
		const seed = seedModels("openai").find(model => model.id === "gpt-6-luna-decisions");
		expect(seed).toBeDefined();
		expect(buildModel(seed!)).toMatchObject({ name: "GPT-6 Luna Decisions", ...DECISIONS_ROW });
	});

	test("joins successful discovery while bundled seeds and discovered chat rows resolve unchanged", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-openai-decisions-"));
		try {
			const fetchMock: FetchImpl = async () =>
				Response.json({ data: [{ id: "gpt-5.5", object: "model", owned_by: "openai" }] });
			const options = openaiModelManagerOptions({ apiKey: "sk-test", fetch: fetchMock });
			const discovered = (await options.fetchDynamicModels?.()) ?? [];
			const bundledIds = new Set(getBundledModels("openai").map(model => model.id));
			const appended = discovered.filter(model => model.id !== "gpt-5.5");
			// Only seeds the bundle lacks ride discovery; bundled seeds (Daybreak,
			// transcription, embedding rows) keep their bundled materialization.
			expect(appended.every(model => !bundledIds.has(model.id))).toBe(true);
			if (!bundledIds.has("gpt-6-luna-decisions")) {
				expect(appended.map(model => model.id)).toEqual(["gpt-6-luna-decisions"]);
			}

			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online",
			);
			expect(result.source).toBe("provider");
			const rows = result.models.filter(model => model.id === "gpt-6-luna-decisions");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject(DECISIONS_ROW);
			expect(result.models.find(model => model.id === "gpt-6-luna")?.kind).toBeUndefined();
			expect(result.models.find(model => model.id === "whisper-1")).toEqual(getBundledModel("openai", "whisper-1"));

			const failed = openaiModelManagerOptions({
				apiKey: "sk-test",
				fetch: async () => new Response("unavailable", { status: 503 }),
			});
			expect(await failed.fetchDynamicModels?.()).toBeNull();
			expect(openaiModelManagerOptions().fetchDynamicModels).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
