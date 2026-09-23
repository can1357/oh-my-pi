import { describe, expect, test } from "bun:test";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("Vercel AI Gateway provider", () => {
	test("caps meta/muse-spark-1.2-contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel currently reports both context_window and max_tokens as 1M for the
		// contributor model, which makes Anthropic messages requests fail with 400
		// when prompt + max_tokens exceeds the shared context window. The mapper
		// must cap the output allowance while leaving the context window intact.
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: contributorId,
						object: "model",
						owned_by: "meta",
						tags: ["tool-use", "reasoning", "vision"],
						context_window: 1_048_576,
						max_tokens: 1_048_576,
						pricing: { input: 0.0000001, output: 0.0000002 },
					},
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
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const contributor = byId.get(contributorId);
		expect(contributor).toBeDefined();
		expect(contributor?.contextWindow).toBe(1_048_576);
		expect(contributor?.maxTokens).toBe(131_072);

		const control = byId.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});
});
