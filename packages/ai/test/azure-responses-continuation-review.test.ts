import { expect, it } from "bun:test";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

it("preserves the Azure continuation ID in serialized JSON", async () => {
	const model = buildModel({
		id: "fixture",
		name: "fixture",
		provider: "azure",
		api: "azure-openai-responses",
		baseUrl: "https://fixture.openai.azure.com/openai/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 10000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	let body: Record<string, unknown> | undefined;
	await streamAzureOpenAIResponses(
		model,
		{ messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
		{
			apiKey: "fixture",
			azureBaseUrl: model.baseUrl,
			azureApiVersion: "v1",
			previousResponseId: "resp_fixture",
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return new Response(
					'data: {"type":"response.completed","response":{"id":"resp_done","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
	).result();
	expect(body?.previous_response_id).toBe("resp_fixture");
});
