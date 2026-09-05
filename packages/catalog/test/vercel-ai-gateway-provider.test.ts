import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Vercel AI Gateway provider", () => {
	test("caps Meta Muse Spark contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel reports both context_window and max_tokens as 1M for the Muse Spark
		// contributor SKUs, which makes Anthropic messages requests 400 when prompt +
		// max_tokens exceeds the shared context window. The `limits-patch` rule in
		// providers/vercel-ai-gateway.kdl must cap the output allowance for both the
		// 1.2 and 1.3 contributor ids (#9115, #10705) while leaving the context
		// window — and the non-contributor SKUs — untouched.
		const contributor12 = "meta/muse-spark-1.2-contributor";
		const contributor13 = "meta/muse-spark-1.3-contributor";
		const plain13 = "meta/muse-spark-1.3";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const oneMegModel = (id: string, owner: string) => ({
			id,
			object: "model",
			owned_by: owner,
			tags: ["tool-use", "reasoning", "vision"],
			context_window: 1_048_576,
			max_tokens: 1_048_576,
			pricing: { input: 0.0000001, output: 0.0000002 },
		});
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					oneMegModel(contributor12, "meta"),
					oneMegModel(contributor13, "meta"),
					oneMegModel(plain13, "meta"),
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
		// The model manager rebuilds every discovered spec via `buildModel`, which is
		// where the KDL limits-patch is applied — assert the built contract, not the
		// raw discovery spec.
		const byId = new Map((specs ?? []).map(spec => [spec.id, buildModel(spec)]));

		for (const id of [contributor12, contributor13]) {
			const model = byId.get(id);
			expect(model).toBeDefined();
			expect(model?.contextWindow).toBe(1_048_576);
			expect(model?.maxTokens).toBe(131_072);
		}

		// The non-contributor SKU is out of scope and must keep its reported budget.
		const plain = byId.get(plain13);
		expect(plain).toBeDefined();
		expect(plain?.maxTokens).toBe(1_048_576);

		const control = byId.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});
});
