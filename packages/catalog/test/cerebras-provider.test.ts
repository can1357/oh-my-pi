import { describe, expect, test } from "bun:test";
import { cerebrasModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

async function discoverModels(data: readonly Record<string, unknown>[]) {
	const options = cerebrasModelManagerOptions({
		apiKey: "cerebras-test-key",
		fetch: async () => Response.json({ data }),
	});
	return options.fetchDynamicModels?.();
}

describe("Cerebras provider discovery", () => {
	test("discovers gemma-4-31b as image-capable", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(input),
				authorization: headers.get("authorization"),
			});
			return new Response(
				JSON.stringify({
					data: [
						{ id: "gemma-4-31b", object: "model" },
						{ id: "llama3.1-8b", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = cerebrasModelManagerOptions({ apiKey: "cerebras-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([
			{
				url: "https://api.cerebras.ai/v1/models",
				authorization: "Bearer cerebras-test-key",
			},
		]);
		expect(models?.find(model => model.id === "gemma-4-31b")).toMatchObject({
			provider: "cerebras",
			api: "openai-completions",
			input: ["text", "image"],
		});
		expect(models?.find(model => model.id === "llama3.1-8b")?.input).toEqual(["text"]);
	});

	test.each([["both limits", 200_000, 32_000, 200_000, 32_000]] as const)(
		"reads provider-reported %s for an unbundled model",
		async (_, context, output, contextWindow, maxTokens) => {
			const models = await discoverModels([
				{ id: "new-unbundled-model", context_length: context, max_completion_tokens: output },
			]);

			expect(models).toMatchObject([{ id: "new-unbundled-model", contextWindow, maxTokens }]);
		},
	);

	test.each([["zero", 0]] as const)(
		"keeps unknown limits for %s values without discarding the valid counterpart",
		async (_, invalid) => {
			const models = await discoverModels([
				{ id: "invalid-context", context_length: invalid, max_completion_tokens: 32_000 },
				{ id: "invalid-output", context_length: 200_000, max_completion_tokens: invalid },
			]);

			expect(models).toMatchObject([
				{ id: "invalid-context", contextWindow: null, maxTokens: 32_000 },
				{ id: "invalid-output", contextWindow: 200_000, maxTokens: null },
			]);
		},
	);
});
