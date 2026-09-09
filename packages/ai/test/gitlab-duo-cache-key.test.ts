import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import {
	clearGitLabDuoDirectAccessCache,
	getGitLabDuoModels,
	streamGitLabDuo,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import * as registerBuiltins from "@oh-my-pi/pi-ai/providers/register-builtins";
import { apiRouteFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveGitLabDuoModelIdentity } from "@oh-my-pi/pi-catalog/provider-models";

const context: Context = {
	systemPrompt: ["You are helpful."],
	messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
	tools: [],
};

afterEach(() => {
	clearGitLabDuoDirectAccessCache();
	mock.restore();
});

describe("GitLab Duo catalog mapping", () => {
	it("builds the complete alias roster from canonical metadata and KDL routes", () => {
		const expectedUpstreamIds: Readonly<Record<string, string>> = {
			"duo-chat-opus-4-6": "claude-opus-4-6",
			"duo-chat-sonnet-4-6": "claude-sonnet-4-6",
			"duo-chat-opus-4-5": "claude-opus-4-5-20251101",
			"duo-chat-sonnet-4-5": "claude-sonnet-4-5-20250929",
			"duo-chat-haiku-4-5": "claude-haiku-4-5-20251001",
			"duo-chat-gpt-5-1": "gpt-5.1-2025-11-13",
			"duo-chat-gpt-5-2": "gpt-5.2-2025-12-11",
			"duo-chat-gpt-5-mini": "gpt-5-mini-2025-08-07",
			"duo-chat-gpt-5-codex": "gpt-5-codex",
			"duo-chat-gpt-5-2-codex": "gpt-5.2-codex",
		};
		const models = getGitLabDuoModels();
		expect(models).toHaveLength(10);

		for (const alias in expectedUpstreamIds) {
			const model = models.find(candidate => candidate.id === alias);
			const identity = resolveGitLabDuoModelIdentity(alias);
			expect(model).toBeDefined();
			expect(identity?.upstreamModelId).toBe(expectedUpstreamIds[alias]);
			if (!model || !identity) continue;

			const reference = getBundledModel(identity.referenceProvider, identity.referenceModelId);
			expect(reference).toBeDefined();
			expect(apiRouteFor("gitlab-duo", alias)?.api).toBe(model.api);
			expect(model).toMatchObject({
				reasoning: reference.reasoning,
				input: reference.input,
				cost: reference.cost,
				contextWindow: reference.contextWindow,
				maxTokens: reference.maxTokens,
			});
		}
	});
});

describe("GitLab Duo prompt cache affinity", () => {
	it("dispatches Anthropic and chat aliases to their catalog-selected transports and upstream ids", async () => {
		const models = getGitLabDuoModels();
		const anthropicModel = models.find(candidate => candidate.id === "duo-chat-sonnet-4-5");
		const completionsModel = models.find(candidate => candidate.id === "duo-chat-gpt-5-1");
		if (!anthropicModel || !completionsModel) throw new Error("GitLab Duo dispatch fixtures are missing");

		const anthropicSpy = spyOn(registerBuiltins, "streamAnthropic");
		const completionsSpy = spyOn(registerBuiltins, "streamOpenAICompletions");
		const options = {
			apiKey: "gitlab-dispatch-token",
			fetch: async (input: string | Request | URL) => {
				if (String(input).includes("/direct_access")) {
					return new Response(JSON.stringify({ token: "direct-access-token", headers: {} }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				throw new Error("the payload hook should stop the proxy request before fetch");
			},
			onPayload: () => {
				throw new Error("stop after dispatch capture");
			},
		};

		await streamGitLabDuo(anthropicModel, context, options).result();
		await streamGitLabDuo(completionsModel, context, options).result();

		expect(anthropicSpy).toHaveBeenCalledTimes(1);
		expect(anthropicSpy.mock.calls[0]?.[0]).toMatchObject({
			id: "claude-sonnet-4-5-20250929",
			api: "anthropic-messages",
		});
		expect(completionsSpy).toHaveBeenCalledTimes(1);
		expect(completionsSpy.mock.calls[0]?.[0]).toMatchObject({
			id: "gpt-5.1-2025-11-13",
			api: "openai-completions",
		});
	});

	it("forwards explicit cache affinity and disabled Responses chaining to the proxy", async () => {
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-gpt-5-codex");
		if (!model) throw new Error("GitLab Duo Responses model is missing");
		const cacheKey = "gitlab-duo-cache-key";
		let payload: Record<string, unknown> | undefined;
		const responsesSpy = spyOn(registerBuiltins, "streamOpenAIResponses");
		const stream = streamGitLabDuo(model, context, {
			apiKey: "gitlab-access-token",
			promptCacheKey: cacheKey,
			statefulResponses: false,
			fetch: async input => {
				if (String(input).includes("/direct_access")) {
					return new Response(JSON.stringify({ token: "direct-access-token", headers: {} }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				throw new Error("the payload hook should stop the proxy request before fetch");
			},
			onPayload: body => {
				payload = body as Record<string, unknown>;
				throw new Error("stop after payload capture");
			},
		});

		await stream.result();

		expect(responsesSpy).toHaveBeenCalledTimes(1);
		expect(responsesSpy.mock.calls[0]?.[0].id).toBe("gpt-5-codex");
		expect(responsesSpy.mock.calls[0]?.[2]).toMatchObject({
			promptCacheKey: cacheKey,
			statefulResponses: false,
		});
		expect(payload?.prompt_cache_key).toBe(cacheKey);
	});
});
