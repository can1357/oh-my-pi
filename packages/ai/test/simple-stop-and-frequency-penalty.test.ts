import { afterEach, describe, expect, it } from "bun:test";
import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { clearGitLabDuoDirectAccessCache } from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import { getGitLabDuoModels } from "@oh-my-pi/pi-catalog/provider-models";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { withOfficialAnthropicEndpoint } from "./helpers";
import {
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	completionsChunks,
	responsesChunks,
} from "./helpers/factory-droid";

withOfficialAnthropicEndpoint();

const CONTEXT: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

const STUB = "x";

afterEach(() => {
	clearGitLabDuoDirectAccessCache();
});

async function routeGatewayRequest(
	model: Model<Api>,
	pathname: "/v1/chat/completions" | "/v1/messages",
	body: Record<string, unknown>,
	chunks: string[],
): Promise<{ status: number; upstream: CapturedRequest[] }> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storage.keys.setRuntime(model.provider, STUB);
	const upstream: CapturedRequest[] = [];
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: () => model,
		fetch: captureFetch(upstream, chunks),
	});
	try {
		const response = await router.route(
			new Request(`http://localhost${pathname}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			"127.0.0.1",
		);
		await response.text();
		return { status: response.status, upstream };
	} finally {
		router.close();
		storage.close();
	}
}

describe("simple request stopSequences and frequencyPenalty projection", () => {
	it("forwards OpenAI stop and frequency_penalty through auth-gateway completeSimple", async () => {
		const model = buildModel({
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});

		const { status, upstream } = await routeGatewayRequest(
			model,
			"/v1/chat/completions",
			{
				model: "openai/gpt-4o-mini",
				messages: [{ role: "user", content: "hi" }],
				stop: ["</end>", "HALT"],
				frequency_penalty: 0.6,
				stream: false,
			},
			completionsChunks("ok", "gpt-4o-mini"),
		);

		expect(status).toBe(200);
		expect(upstream).toHaveLength(1);
		expect(upstream[0].body.stop).toEqual(["</end>", "HALT"]);
		expect(upstream[0].body.frequency_penalty).toBe(0.6);
	});

	it("forwards Anthropic stop_sequences through auth-gateway streamSimple", async () => {
		const model = buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});

		const { status, upstream } = await routeGatewayRequest(
			model,
			"/v1/messages",
			{
				model: "anthropic/claude-sonnet-4-5",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
				stop_sequences: ["\n\nHuman:"],
				stream: true,
			},
			anthropicChunks("ok"),
		);

		expect(status).toBe(200);
		expect(upstream).toHaveLength(1);
		expect(upstream[0].body.stop_sequences).toEqual(["\n\nHuman:"]);
	});

	it("retains provider capability filtering for models or APIs that reject stop or penalties", async () => {
		const reasoningCompletions = buildModel({
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "http://127.0.0.1:9/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		});
		const reasoningUpstream: CapturedRequest[] = [];
		await streamSimple(reasoningCompletions, CONTEXT, {
			apiKey: STUB,
			stopSequences: ["END"],
			frequencyPenalty: 0.8,
			fetch: captureFetch(reasoningUpstream, completionsChunks("ok", "gpt-5")),
		}).result();
		expect(reasoningUpstream[0].body.stop).toBe("END");
		expect(reasoningUpstream[0].body).not.toHaveProperty("frequency_penalty");

		const xaiCompletions = buildModel({
			id: "grok-3-mini",
			name: "Grok 3 Mini",
			api: "openai-completions",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131_072,
			maxTokens: 8_192,
		});
		const xaiUpstream: CapturedRequest[] = [];
		await streamSimple(xaiCompletions, CONTEXT, {
			apiKey: STUB,
			stopSequences: ["END"],
			frequencyPenalty: 0.8,
			fetch: captureFetch(xaiUpstream, completionsChunks("ok", "grok-3-mini")),
		}).result();
		expect(xaiUpstream[0].body).not.toHaveProperty("stop");
		expect(xaiUpstream[0].body).not.toHaveProperty("frequency_penalty");

		const responsesModel = buildModel({
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		const responsesUpstream: CapturedRequest[] = [];
		await streamSimple(responsesModel, CONTEXT, {
			apiKey: STUB,
			stopSequences: ["END"],
			frequencyPenalty: 0.8,
			fetch: captureFetch(responsesUpstream, responsesChunks("ok")),
		}).result();
		expect(responsesUpstream[0].body).not.toHaveProperty("stop");
		expect(responsesUpstream[0].body).not.toHaveProperty("frequency_penalty");
	});

	it("forwards stopSequences and frequencyPenalty through the OpenAI/Anthropic shim", async () => {
		const syntheticModel = buildModel({
			id: "Qwen/Qwen3-32B",
			name: "Qwen3 32B",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://api.synthetic.new/openai/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
		});

		const openaiUpstream: CapturedRequest[] = [];
		await streamSimple(syntheticModel, CONTEXT, {
			apiKey: STUB,
			syntheticApiFormat: "openai",
			stopSequences: ["END"],
			frequencyPenalty: 0.4,
			fetch: captureFetch(openaiUpstream, completionsChunks("ok", "Qwen/Qwen3-32B")),
		}).result();
		expect(openaiUpstream[0].body.stop).toBe("END");
		expect(openaiUpstream[0].body.frequency_penalty).toBe(0.4);

		const anthropicUpstream: CapturedRequest[] = [];
		await streamSimple(syntheticModel, CONTEXT, {
			apiKey: STUB,
			syntheticApiFormat: "anthropic",
			stopSequences: ["END"],
			frequencyPenalty: 0.4,
			fetch: captureFetch(anthropicUpstream, anthropicChunks("ok")),
		}).result();
		expect(anthropicUpstream[0].body.stop_sequences).toEqual(["END"]);
		expect(anthropicUpstream[0].body).not.toHaveProperty("frequency_penalty");
	});

	it("forwards stopSequences and frequencyPenalty through GitLab Duo simple dispatch", async () => {
		const duoModels = getGitLabDuoModels();
		const anthropicDuo = duoModels.find(candidate => candidate.id === "duo-chat-sonnet-4-5");
		const completionsBase = duoModels.find(candidate => candidate.id === "duo-chat-gpt-5-1");
		if (!anthropicDuo || !completionsBase) throw new Error("missing GitLab Duo fixture models");
		const completionsDuo = buildModel({
			...completionsBase,
			compat: { supportsSamplingParams: true },
		} as ModelSpec<"openai-completions">);

		const anthropicUpstream: CapturedRequest[] = [];
		const anthropicInnerFetch = captureFetch(anthropicUpstream, anthropicChunks("ok"));
		await streamSimple(anthropicDuo, CONTEXT, {
			apiKey: STUB,
			stopSequences: ["HALT"],
			fetch: async (input, init) => {
				if (String(input).includes("/direct_access")) {
					return Response.json({ token: STUB, headers: {} });
				}
				return anthropicInnerFetch(input, init);
			},
		}).result();
		expect(anthropicUpstream[0].body.stop_sequences).toEqual(["HALT"]);

		const completionsUpstream: CapturedRequest[] = [];
		const completionsInnerFetch = captureFetch(completionsUpstream, completionsChunks("ok", "gpt-5.1-2025-11-13"));
		await streamSimple(completionsDuo, CONTEXT, {
			apiKey: STUB,
			stopSequences: ["HALT"],
			frequencyPenalty: 0.5,
			fetch: async (input, init) => {
				if (String(input).includes("/direct_access")) {
					return Response.json({ token: STUB, headers: {} });
				}
				return completionsInnerFetch(input, init);
			},
		}).result();
		expect(completionsUpstream[0].body.stop).toBe("HALT");
		expect(completionsUpstream[0].body.frequency_penalty).toBe(0.5);
	});
});
