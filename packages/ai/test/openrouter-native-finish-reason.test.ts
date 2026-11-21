import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"openai-responses"> = buildModel({
	id: "google/gemini-4-argon",
	name: "Argon via OpenRouter",
	provider: "openrouter",
	api: "openai-responses",
	baseUrl: "https://openrouter.example/api/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const context: Context = { messages: [{ role: "user", content: "Continue", timestamp: 0 }] };
const responseId = "gen-malformed-response";
const usage = {
	input_tokens: 100,
	output_tokens: 604,
	total_tokens: 704,
	output_tokens_details: { reasoning_tokens: 590 },
};

function responseStream(response: Record<string, unknown>, prefix: unknown[] = []): Response {
	return new Response(
		[...prefix, { type: "response.completed", response: { id: responseId, status: "completed", usage, ...response } }]
			.map(event => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function createFetch(response: Record<string, unknown>, metadata: Response, prefix: unknown[] = []) {
	const requests: string[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = String(input);
		requests.push(`${init?.method ?? "GET"} ${url}`);
		if (url.endsWith("/responses")) return responseStream(response, prefix);
		if (url === `${model.baseUrl}/generation?id=${responseId}`) return metadata.clone() as Response;
		throw new Error(`Unexpected request: ${url}`);
	};
	return { fetchImpl, requests };
}

function generation(nativeFinishReason: string, id = responseId): Response {
	return Response.json({ data: { id, native_finish_reason: nativeFinishReason, finish_reason: "stop" } });
}

describe("OpenRouter native generation failures", () => {
	it("surfaces a malformed upstream response instead of a billed empty success", async () => {
		const { fetchImpl, requests } = createFetch({ output: [] }, generation("MALFORMED_RESPONSE"));
		const result = await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MALFORMED_RESPONSE");
		expect(result.responseId).toBe(responseId);
		expect(result.usage.output).toBe(604);
		expect(result.usage.reasoningTokens).toBe(590);
		expect(requests).toEqual([`POST ${model.baseUrl}/responses`, `GET ${model.baseUrl}/generation?id=${responseId}`]);
	});

	it("rejects an explicit native failure before promoting an earlier tool call", async () => {
		const { fetchImpl, requests } = createFetch(
			{ native_finish_reason: "MALFORMED_FUNCTION_CALL" },
			generation("STOP"),
			[
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: "{}" },
				},
			],
		);
		const result = await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MALFORMED_FUNCTION_CALL");
		expect(result.responseId).toBe(responseId);
		expect(result.usage.output).toBe(604);
		expect(requests).toEqual([`POST ${model.baseUrl}/responses`]);
	});

	it("surfaces a malformed response when metadata lags (404) on an empty stop with billed non-reasoning output", async () => {
		const { fetchImpl, requests } = createFetch({ output: [] }, new Response("not ready", { status: 404 }));
		const result = await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MALFORMED_RESPONSE");
		expect(result.errorMessage).toContain("inferred");
		expect(result.responseId).toBe(responseId);
		expect(result.usage.output).toBe(604);
		expect(result.usage.reasoningTokens).toBe(590);
		expect(requests).toEqual([`POST ${model.baseUrl}/responses`, `GET ${model.baseUrl}/generation?id=${responseId}`]);
	});

	it.each([
		["metadata authentication failure", () => new Response("unauthorized", { status: 401 })],
		["metadata permission failure", () => new Response("forbidden", { status: 403 })],
		["metadata rate limit", () => new Response("rate limited", { status: 429 })],
		["invalid diagnostic JSON", () => new Response("{")],
		[
			"diagnostic network failure",
			() => {
				throw new Error("fetch failed");
			},
		],
	] as const)("preserves the empty stop without replay for %s", async (_name, metadata) => {
		const requests: string[] = [];
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			fetch: async (input, init) => {
				const url = String(input);
				requests.push(`${init?.method ?? "GET"} ${url}`);
				return url.endsWith("/responses") ? responseStream({ output: [] }) : metadata();
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.usage.output).toBe(604);
		expect(requests).toEqual([`POST ${model.baseUrl}/responses`, `GET ${model.baseUrl}/generation?id=${responseId}`]);
	});

	it.each(["MALFORMED_RESPONSE", "UNEXPECTED_TOOL_CALL", "network_error"])(
		"leaves terminal %s retries to the appropriate layer",
		async reason => {
			const { fetchImpl, requests } = createFetch({ output: [], native_finish_reason: reason }, generation("STOP"));
			const result = await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(reason);
			expect(requests).toEqual(
				Array.from({ length: reason === "network_error" ? 2 : 1 }, () => `POST ${model.baseUrl}/responses`),
			);
		},
	);

	it("runs generation lookup when compat.isOpenRouterHost is set even if provider differs", async () => {
		const { compat: _compat, ...baseSpec } = model;
		const customProviderModel = buildModel({
			...baseSpec,
			provider: "custom-openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		const { fetchImpl } = createFetch({ output: [] }, new Response("not ready", { status: 404 }));
		const result = await streamOpenAIResponses(customProviderModel, context, {
			apiKey: "test-key",
			fetch: async (input, init) => {
				const url = String(input);
				if (url.endsWith("/responses")) return responseStream({ output: [] });
				if (url === `${customProviderModel.baseUrl}/generation?id=${responseId}`) {
					return new Response("not ready", { status: 404 });
				}
				return fetchImpl(input, init);
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MALFORMED_RESPONSE");
	});

	it.each([
		["unavailable metadata with reasoning-only usage", 590, () => new Response("not ready", { status: 404 })],
		["mismatched generation", 604, () => generation("MALFORMED_RESPONSE", "gen-unrelated")],
		["unrecognized native reason", 604, () => generation("NEW_PROVIDER_REASON")],
	] as const)("keeps existing empty-stop recovery for %s", async (_name, outputTokens, metadata) => {
		const { fetchImpl } = createFetch({ output: [], usage: { ...usage, output_tokens: outputTokens } }, metadata());
		const result = await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.usage.output).toBe(outputTokens);
	});

	it("does not look up metadata for signed reasoning-only progress", async () => {
		const { fetchImpl, requests } = createFetch({}, generation("MALFORMED_RESPONSE"), [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-signature" },
			},
		]);
		const result = await streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchImpl }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "thinking", thinkingSignature: expect.any(String) }),
		);
		expect(requests).toEqual([`POST ${model.baseUrl}/responses`]);
	});

	it("does not send OpenRouter generation requests to other Responses providers", async () => {
		const { compat: _compat, ...baseSpec } = model;
		const otherModel = buildModel({ ...baseSpec, provider: "openai", baseUrl: "https://other.example/v1" });
		let calls = 0;
		const result = await streamOpenAIResponses(otherModel, context, {
			apiKey: "other-key",
			fetch: async () => {
				calls++;
				return responseStream({ output: [] });
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(calls).toBe(1);
	});

	it("honors caller cancellation during the diagnostic lookup", async () => {
		const controller = new AbortController();
		let lookups = 0;
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			signal: controller.signal,
			fetch: async (input, init) => {
				if (String(input).endsWith("/responses")) return responseStream({ output: [] });
				lookups++;
				controller.abort();
				init?.signal?.throwIfAborted();
				throw new Error("Expected an aborted diagnostic request");
			},
		}).result();
		expect(lookups).toBe(1);
		expect(result.stopReason).toBe("aborted");
	});
});
