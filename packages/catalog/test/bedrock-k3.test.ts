import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const ids = ["global.moonshotai.kimi-k3", "us.moonshotai.kimi-k3"];

describe("Bedrock K3 catalog", () => {
	test("publishes only the routable profiles with K3 effort controls after generation", () => {
		const specs = seedModels("amazon-bedrock").filter(model => model.id.includes("kimi-k3"));
		expect(specs.map(model => model.id).sort()).toEqual(ids);
		applyGeneratedModelPolicies(specs);
		for (const spec of specs) {
			const generated = buildModel(spec);
			const bundled = getBundledModel("amazon-bedrock", spec.id);
			for (const model of [generated, bundled]) {
				expect(model.api).toBe("openai-completions");
				expect(model.identity.class).toBe("kimi");
				expect(model.identity.family).toBe("k3");
				expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High, Effort.Max]);
				expect(model.thinking?.defaultLevel).toBe(Effort.Max);
				expect(model.thinking?.requiresEffort).toBeTrue();
				expect(model.input).toEqual(["text", "image"]);
				expect(model.contextWindow).toBe(1_000_000);
				expect(model.maxTokens).toBe(128_000);
			}
		}
		expect(getBundledModel("amazon-bedrock", "moonshotai.kimi-k3")).toBeUndefined();
	});

	test("retains Chat routing and max across a colliding catalog refresh and offline reload", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-k3-catalog-"));
		try {
			const staleRows: ModelSpec[] = ids.map(id => ({
				id,
				name: "stale K3",
				provider: "amazon-bedrock",
				api: "bedrock-converse-stream",
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 16000,
				thinking: { mode: "budget", efforts: [Effort.Low, Effort.High] },
			}));
			const fallback = modelsDevCatalogFallback("amazon-bedrock");
			expect(fallback?.additiveOnly).toBeTrue();
			const options = {
				providerId: "amazon-bedrock",
				cacheDbPath: path.join(dir, "models.db"),
				modelsDev: {
					additiveOnly: fallback!.additiveOnly,
					fetch: async () => staleRows,
					map: (rows: ModelSpec[]) => rows,
				},
			};
			const refreshed = await resolveProviderModels(options, "online");
			const reloaded = await resolveProviderModels(options, "offline");
			for (const snapshot of [refreshed, reloaded]) {
				for (const id of ids) {
					const model = snapshot.models.find(model => model.id === id)!;
					expect(model.api).toBe("openai-completions");
					expect(model.thinking?.defaultLevel).toBe(Effort.Max);
					expect(model.contextWindow).toBe(1_000_000);
				}
				expect(snapshot.models.find(model => model.id === "global.openai.gpt-5.6-sol")?.api).toBe(
					"bedrock-converse-stream",
				);
				expect(snapshot.models.find(model => model.id === "global.anthropic.claude-fable-5-1")?.api).toBe(
					"bedrock-converse-stream",
				);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
