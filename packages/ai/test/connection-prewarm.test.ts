import { afterEach, describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { resolveAnthropicPrewarmTarget } from "@oh-my-pi/pi-ai/providers/anthropic-http-options";
import { prewarmModelConnection, resetConnectionPrewarmForTesting } from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { resetDispatchOriginsForTesting, transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api } from "@oh-my-pi/pi-catalog/types";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

function model<TApi extends Api>(provider: string, api: TApi, baseUrl: string): Model<TApi> {
	return buildModel({
		id: "test-model",
		name: "Test Model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const ANTHROPIC = model("anthropic", "anthropic-messages", "https://api.anthropic.com");
// Bundled host; the Copilot credential routes requests to the account's plan host.
const COPILOT = model("github-copilot", "openai-completions", "https://api.githubcopilot.com");
const COPILOT_PLAN_URL = "https://api.business.githubcopilot.com/chat/completions";

function captureFetch(): { calls: Array<{ url: string; init: RequestInit & { tls?: unknown } }>; fetch: FetchImpl } {
	const calls: Array<{ url: string; init: RequestInit & { tls?: unknown } }> = [];
	const fetch: FetchImpl = async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(null, { status: 404 });
	};
	return { calls, fetch };
}

/** Sends one inference request for {@link target} through the shared transport, as a turn would. */
async function dispatch(target: Model<Api>, url: string): Promise<void> {
	await transportFetch(target, async () => new Response("{}"))(url, { method: "POST", body: "{}" });
}

withOfficialAnthropicEndpoint();
afterEach(() => {
	resetConnectionPrewarmForTesting();
	resetDispatchOriginsForTesting();
});

describe("prewarmModelConnection", () => {
	it("warms official Anthropic with the real request's TLS options and no credentials", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmModelConnection(ANTHROPIC, { fetch });

		const real = buildAnthropicClientOptions({
			model: ANTHROPIC,
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			extraBetas: [],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.anthropic.com");
		expect(calls[0].init.method).toBe("HEAD");
		expect(calls[0].init.tls).toEqual(real.fetchOptions?.tls);
		const headers = new Headers(calls[0].init.headers);
		expect([headers.get("authorization"), headers.get("x-api-key")]).toEqual([null, null]);
	});

	it("warms the origin the model's last request reached, never a guess from baseUrl", async () => {
		const { calls, fetch } = captureFetch();
		await prewarmModelConnection(COPILOT, { fetch });
		await dispatch(COPILOT, COPILOT_PLAN_URL);
		await prewarmModelConnection(COPILOT, { fetch });

		expect(calls.map(call => [call.url, call.init.method])).toEqual([
			["https://api.business.githubcopilot.com", "HEAD"],
		]);
	});

	it("throttles repeat warm-ups per origin, not globally", async () => {
		const { calls, fetch } = captureFetch();
		await dispatch(COPILOT, COPILOT_PLAN_URL);
		await prewarmModelConnection(ANTHROPIC, { fetch });
		await prewarmModelConnection(ANTHROPIC, { fetch });
		await prewarmModelConnection(COPILOT, { fetch });
		await prewarmModelConnection(COPILOT, { fetch });

		expect(calls.map(call => call.url)).toEqual([
			"https://api.anthropic.com",
			"https://api.business.githubcopilot.com",
		]);
	});

	it("never probes custom providers, built-in ids routed to a gateway, or Anthropic gateways", async () => {
		const { calls, fetch } = captureFetch();
		const custom = model("corp-gateway", "openai-completions", "https://llm.corp.example/v1");
		await dispatch(custom, "https://llm.corp.example/v1/chat/completions");
		await prewarmModelConnection(custom, { fetch });
		// models.yml `provider: openai` with a gateway baseUrl.
		const overridden = model("openai", "openai-responses", "https://gateway.internal.example/v1");
		await dispatch(overridden, "https://gateway.internal.example/v1/responses");
		await prewarmModelConnection(overridden, { fetch });
		// Bundled xAI row rerouted at dispatch (XAI_BASE_URL).
		const rerouted = model("xai", "openai-completions", "https://api.x.ai/v1");
		await dispatch(rerouted, "https://xai-proxy.example/v1/chat/completions");
		await prewarmModelConnection(rerouted, { fetch });
		await prewarmModelConnection(model("anthropic", "anthropic-messages", "https://opencode.ai/zen"), { fetch });
		await withEnv({ ANTHROPIC_BASE_URL: "https://llm-gateway.corp.example" }, () =>
			prewarmModelConnection(ANTHROPIC, { fetch }),
		);

		expect(calls).toHaveLength(0);
	});

	it("settles quietly when resolving Anthropic's TLS options throws", async () => {
		const { calls, fetch } = captureFetch();
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: "1",
				FOUNDRY_BASE_URL: undefined,
				CLAUDE_CODE_CLIENT_CERT: "/nonexistent/client.pem",
			},
			async () => {
				expect(() => resolveAnthropicPrewarmTarget(ANTHROPIC)).toThrow();
				await expect(prewarmModelConnection(ANTHROPIC, { fetch })).resolves.toBeUndefined();
			},
		);

		expect(calls).toHaveLength(0);
	});
});
