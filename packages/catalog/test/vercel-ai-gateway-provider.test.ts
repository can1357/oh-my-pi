import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Vercel AI Gateway provider", () => {
	test("caps Muse Spark contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel reports both context_window and max_tokens as 1M for the Muse Spark
		// contributor SKUs, and the upstream answers HTTP 400 to that max_tokens (#10705).
		// The output cap is a limits-patch rule, applied by buildModel to every discovered
		// row, so the built model is the contract a request is sent with.
		const contributor12 = "meta/muse-spark-1.2-contributor";
		const contributor13 = "meta/muse-spark-1.3-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const oneMillionRow = (id: string) => ({
			id,
			object: "model",
			owned_by: "meta",
			tags: ["tool-use", "reasoning", "vision"],
			context_window: 1_048_576,
			max_tokens: 1_048_576,
			pricing: { input: 0.0000001, output: 0.0000002 },
		});
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					oneMillionRow(contributor12),
					oneMillionRow(contributor13),
					{
						id: controlId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use", "reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		expect(specs).not.toBeNull();
		const byId = new Map((specs ?? []).map(spec => [spec.id, buildModel(spec)]));

		for (const id of [contributor12, contributor13]) {
			const model = byId.get(id);
			expect(model?.contextWindow).toBe(1_048_576);
			expect(model?.maxTokens).toBe(131_072);
		}

		const control = byId.get(controlId);
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});
});
