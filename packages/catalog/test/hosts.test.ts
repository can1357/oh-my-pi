import { describe, expect, test } from "bun:test";
import {
	hostMatchesUrl,
	isDashscopeCompatibleModeUrl,
	isVertexExpressOpenAIUrl,
	isVertexPublisherResponsesUrl,
	isVertexRawPredictUrl,
	modelMatchesHost,
	resolveVertexEndpointHost,
} from "@oh-my-pi/pi-catalog/hosts";

describe("hostMatchesUrl", () => {
	test("matches OpenRouter URLs and rejects other or missing URLs", () => {
		expect(hostMatchesUrl("https://openrouter.ai/api/v1", "openrouter")).toBe(true);
		expect(hostMatchesUrl("https://api.openai.com/v1", "openrouter")).toBe(false);
		expect(hostMatchesUrl(undefined, "openrouter")).toBe(false);
	});

	test("matches Z.AI URLs case-insensitively", () => {
		expect(hostMatchesUrl("https://API.Z.AI/api/paas/v4", "zai")).toBe(true);
	});

	test("keeps DeepSeek direct host narrower than DeepSeek family", () => {
		expect(hostMatchesUrl("https://api.deepseek.com/v1", "deepseekDirect")).toBe(true);
		expect(hostMatchesUrl("https://api.deepseek.com/v1", "deepseekFamily")).toBe(true);
		expect(hostMatchesUrl("https://chat.deepseek.com/api", "deepseekFamily")).toBe(true);
		expect(hostMatchesUrl("https://chat.deepseek.com/api", "deepseekDirect")).toBe(false);
	});
});

describe("modelMatchesHost", () => {
	test("matches by provider id, provider prefix, and URL-only Fireworks markers", () => {
		expect(modelMatchesHost({ provider: "openrouter", baseUrl: "https://example.com/v1" }, "openrouter")).toBe(true);
		expect(modelMatchesHost({ provider: "xiaomi-token-plan-eu", baseUrl: "https://example.com/v1" }, "xiaomi")).toBe(
			true,
		);
		expect(modelMatchesHost({ provider: "fireworks", baseUrl: "https://example.com/v1" }, "fireworks")).toBe(false);
		expect(
			modelMatchesHost({ provider: "custom", baseUrl: "https://api.fireworks.ai/inference/v1" }, "fireworks"),
		).toBe(true);
	});
});

describe("endpoint shape predicates", () => {
	test("recognizes Vertex express OpenAI-compatible URLs", () => {
		expect(
			isVertexExpressOpenAIUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us/endpoints/openapi",
			),
		).toBe(true);
		expect(
			isVertexExpressOpenAIUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/google/models/gemini",
			),
		).toBe(false);
	});
	test("recognizes Vertex publisher Responses API URLs", () => {
		expect(
			isVertexPublisherResponsesUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/meta/v1",
			),
		).toBe(true);
		expect(
			isVertexPublisherResponsesUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/meta/v1/",
			),
		).toBe(true);
		expect(
			isVertexPublisherResponsesUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/meta/v1/responses",
			),
		).toBe(false);
		expect(
			isVertexPublisherResponsesUrl(
				"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/openai/v1",
			),
		).toBe(true);
		expect(
			isVertexPublisherResponsesUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/openai/v1/responses",
			),
		).toBe(false);
		expect(
			isVertexPublisherResponsesUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/claude:rawPredict",
			),
		).toBe(false);
		expect(
			isVertexPublisherResponsesUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/mistralai/models/mistral:streamRawPredict",
			),
		).toBe(false);
		expect(
			isVertexPublisherResponsesUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/google/models/gemini",
			),
		).toBe(false);
		expect(
			isVertexPublisherResponsesUrl(
				"https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us/endpoints/openapi",
			),
		).toBe(false);
		expect(
			isVertexPublisherResponsesUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/meta/v1/chat/completions",
			),
		).toBe(false);
	});

	test("recognizes Vertex rawPredict and streamRawPredict URLs", () => {
		expect(
			isVertexRawPredictUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/claude:rawPredict",
			),
		).toBe(true);
		expect(
			isVertexRawPredictUrl(
				"https://aiplatform.googleapis.com/v1/projects/p/locations/us/publishers/anthropic/models/claude:streamRawPredict",
			),
		).toBe(true);
	});

	test("resolves Vertex endpoint hosts for global, multi-region, and regional locations", () => {
		expect(resolveVertexEndpointHost("global")).toBe("aiplatform.googleapis.com");
		expect(resolveVertexEndpointHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
		expect(resolveVertexEndpointHost("us")).toBe("aiplatform.us.rep.googleapis.com");
		expect(resolveVertexEndpointHost("europe-west4")).toBe("europe-west4-aiplatform.googleapis.com");
		expect(resolveVertexEndpointHost("us-central1")).toBe("us-central1-aiplatform.googleapis.com");
	});

	test("requires all DashScope compatible-mode URL markers", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(true);
		expect(isDashscopeCompatibleModeUrl("https://example.aliyuncs.com/compatible-mode/v1")).toBe(false);
		expect(isDashscopeCompatibleModeUrl("https://dashscope.example.com/compatible-mode/v1")).toBe(false);
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/api/v1")).toBe(false);
	});
});
