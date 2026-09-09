import { describe, expect, test } from "bun:test";
import { cerebrasModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

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
});
