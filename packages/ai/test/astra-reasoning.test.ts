import { describe, expect, it } from "bun:test";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { fetchCodexModels } from "@pk-nerdsaver-ai/pi-catalog/discovery/codex";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { OPENAI_CURATED_FALLBACK_MODELS } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import { parseRequest as parseChatRequest } from "../src/providers/openai-chat-server";
import { parseRequest as parseResponsesRequest } from "../src/providers/openai-responses-server";
import { streamSimple } from "../src/stream";
import type { FetchImpl, Model } from "../src/types";

const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;

async function capture(model: Model, reasoning: Effort): Promise<Record<string, unknown>> {
	const bodies: Record<string, unknown>[] = [];
	const fetchFixture: FetchImpl = async (input, init) => {
		if (!String(input).endsWith("/responses")) return new Response("not found", { status: 404 });
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return new Response(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "test-response",
					status: "completed",
					output: [],
					usage: {
						input_tokens: 10,
						output_tokens: 1,
						total_tokens: 11,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	const stream = streamSimple(
		model,
		{
			systemPrompt: ["Stable instructions"],
			messages: [{ role: "user", content: "Hello", timestamp: 0 }],
		},
		{ apiKey: token, fetch: fetchFixture, reasoning, preferWebsockets: false, sessionId: "astra-test" },
	);
	const result = await stream.result();
	expect(result.stopReason).not.toBe("error");
	expect(result.errorMessage).toBeUndefined();
	expect(bodies).toHaveLength(1);
	return bodies[0]!;
}

describe("Astra reasoning wire contract", () => {
	it("preserves max through both auth-gateway request parsers", () => {
		expect(
			parseChatRequest({
				model: "gpt-6-astra",
				messages: [{ role: "user", content: "Hello" }],
				reasoning_effort: "max",
			}).options.reasoning,
		).toBe(Effort.Max);
		expect(
			parseResponsesRequest({ model: "gpt-6-astra", input: "Hello", reasoning: { effort: "max" } }).options
				.reasoning,
		).toBe(Effort.Max);
	});

	for (const reasoning of [Effort.XHigh, Effort.Max, Effort.Ultra]) {
		it(`sends ${reasoning} through direct Responses without leaking Ultra`, async () => {
			const spec = OPENAI_CURATED_FALLBACK_MODELS.find(model => model.id === "gpt-6-astra");
			if (!spec) throw new Error("Missing Astra reference");
			const body = await capture(buildModel(spec), reasoning);
			expect(body.reasoning).toMatchObject({ effort: reasoning === Effort.Ultra ? "max" : reasoning });
			expect(body.service_tier).not.toBe("priority");
		});
	}

	for (const reasoning of [Effort.XHigh, Effort.Max, Effort.Ultra]) {
		it(`preserves ${reasoning} through Codex discovery and streaming`, async () => {
			const discovered = await fetchCodexModels({
				accessToken: "test",
				clientVersion: "1.0.0",
				fetchFn: Object.assign(
					async () =>
						Response.json({
							models: [
								{
									slug: "gpt-6-astra",
									default_reasoning_level: "low",
									supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(
										effort => ({ effort }),
									),
									multi_agent_reasoning_effort: "xhigh",
									prefer_websockets: true,
								},
							],
						}),
					{ preconnect: fetch.preconnect },
				),
			});
			const spec = discovered?.models[0];
			if (!spec) throw new Error("Missing discovered Astra");
			const body = await capture(buildModel(spec), reasoning);
			expect(body.reasoning).toMatchObject({ effort: reasoning === Effort.Ultra ? "xhigh" : reasoning });
			expect(body.store).toBe(false);
			expect(body.include).toContain("reasoning.encrypted_content");
			expect(body.service_tier).not.toBe("priority");
		});
	}

	it("respects metadata overrides rather than hardcoding Ultra as xhigh", async () => {
		const model = buildModel({
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
			thinking: { mode: "effort", efforts: [Effort.High, Effort.Ultra], effortMap: { [Effort.Ultra]: "high" } },
		});
		expect((await capture(model, Effort.Ultra)).reasoning).toMatchObject({ effort: "high" });
	});
});
