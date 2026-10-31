import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { resolveAnthropicPrewarmTarget } from "@oh-my-pi/pi-ai/providers/anthropic-http-options";
import {
	prewarmModelConnection,
	probeModelConnection,
	resetConnectionPrewarmForTesting,
} from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry/registry";
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

describe("probeModelConnection", () => {
	it("probes a local server's base URL before its first request", async () => {
		// A fallback has never sent a request, and a local server is exactly the
		// host a warm-up skips; the probe must still reach it to report it alive.
		const { calls, fetch } = captureFetch();
		const local = model("local-llm", "openai-completions", "http://127.0.0.1:11434/v1");

		await expect(probeModelConnection(local, { apiKey: "local-key", fetch })).resolves.toBe(true);

		expect(calls.map(call => [call.url, call.init.method])).toEqual([["http://127.0.0.1:11434", "HEAD"]]);
	});

	it("reports a host whose connection is rejected as unreachable, once per origin and transport", async () => {
		let requests = 0;
		const fetch: FetchImpl = async () => {
			requests++;
			throw Object.assign(new TypeError("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" });
		};
		const openai = model("openai", "openai-responses", "https://api.openai.com/v1");

		await expect(probeModelConnection(openai, { apiKey: "sk-test", fetch })).resolves.toBe(false);
		// A second chain entry on the same host reuses the answer instead of sending another probe.
		await expect(probeModelConnection(openai, { apiKey: "sk-test", fetch })).resolves.toBe(false);
		expect(requests).toBe(1);
	});

	it("shares one probe per host on the default transport, as fallback recovery uses it", async () => {
		// Turn recovery passes no fetch: back-to-back chain entries and parallel
		// sessions on one host must send one probe between them.
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(
				Object.assign(async () => new Response(null, { status: 404 }), { preconnect: fetch.preconnect }),
			);
		const openai = model("openai", "openai-responses", "https://api.openai.com/v1");

		try {
			await expect(probeModelConnection(openai, { apiKey: "sk-test" })).resolves.toBe(true);
			await expect(probeModelConnection(openai, { apiKey: "sk-test" })).resolves.toBe(true);
			expect(fetchSpy.mock.calls.map(call => String(call[0]))).toEqual(["https://api.openai.com"]);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("does not reuse one transport's failed probe for another transport to the same host", async () => {
		const openai = model("openai", "openai-responses", "https://api.openai.com/v1");
		const rejecting: FetchImpl = async () => {
			throw Object.assign(new TypeError("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" });
		};
		const { calls, fetch: responding } = captureFetch();

		await expect(probeModelConnection(openai, { apiKey: "sk-test", fetch: rejecting })).resolves.toBe(false);
		await expect(probeModelConnection(openai, { apiKey: "sk-test", fetch: responding })).resolves.toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("does not reuse one provider's failed probe for another provider on the same host", async () => {
		// Each provider has its own proxy (`PI_PROXY_<PROVIDER>`) and TLS options.
		const rejectUnlessProxied: FetchImpl = async (_input, init) => {
			if ("proxy" in (init ?? {})) return new Response(null, { status: 404 });
			throw Object.assign(new TypeError("getaddrinfo ENOTFOUND gateway.example"), { code: "ENOTFOUND" });
		};
		await withEnv({ PI_PROXY_PROXIED_GW: "http://proxy.corp.example:3128" }, async () => {
			const direct = model("direct-gw", "openai-completions", "https://gateway.example/v1");
			const proxied = model("proxied-gw", "openai-completions", "https://gateway.example/v1");
			await expect(probeModelConnection(direct, { apiKey: "k", fetch: rejectUnlessProxied })).resolves.toBe(false);
			await expect(probeModelConnection(proxied, { apiKey: "k", fetch: rejectUnlessProxied })).resolves.toBe(true);
		});
	});

	it.each([
		[
			"MOONSHOT_BASE_URL",
			"moonshot",
			"https://api.moonshot.ai/v1",
			"https://api.moonshot.cn/v1",
			"https://api.moonshot.cn",
		],
		["XAI_BASE_URL", "xai", "https://api.x.ai/v1", "https://xai-proxy.example/v1", "https://xai-proxy.example"],
	])(
		"probes the host %s sends requests to before the first request",
		async (env, provider, baseUrl, override, origin) => {
			const { calls, fetch } = captureFetch();
			await withEnv({ [env]: override }, async () => {
				await probeModelConnection(model(provider, "openai-completions", baseUrl), { apiKey: "sk-test", fetch });
			});

			expect(calls.map(call => call.url)).toEqual([origin]);
		},
	);

	it("probes an Anthropic gateway with the real request's URL and TLS options", async () => {
		const { calls, fetch } = captureFetch();
		await withEnv({ ANTHROPIC_BASE_URL: "https://llm-gateway.corp.example" }, async () => {
			await probeModelConnection(ANTHROPIC, { apiKey: "sk-ant-api-test", fetch });
			const real = buildAnthropicClientOptions({ model: ANTHROPIC, apiKey: "sk-ant-api-test", extraBetas: [] });
			expect(calls.map(call => [call.url, call.init.tls])).toEqual([
				["https://llm-gateway.corp.example", real.fetchOptions?.tls],
			]);
		});
	});

	it("treats a model whose request route it cannot work out as reachable, without probing", async () => {
		// Never skip a fallback on a guessed URL: an API with its own endpoint rules
		// that has not sent a request yet keeps today's behaviour.
		const { calls, fetch } = captureFetch();
		const google = model("google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta");

		await expect(probeModelConnection(google, { apiKey: "g-test", fetch })).resolves.toBe(true);
		expect(calls).toHaveLength(0);
	});

	it("probes the route the selected credential resolves to, not another account's last request", async () => {
		// Dispatch history is process-wide: a business-plan session sent this model
		// to its plan host, while the fallback's own credential is an individual one.
		await dispatch(COPILOT, COPILOT_PLAN_URL);
		const { calls, fetch } = captureFetch();

		await probeModelConnection(COPILOT, { apiKey: "ghu_individual-token", fetch });

		expect(calls.map(call => call.url)).toEqual(["https://api.githubcopilot.com"]);
	});

	it.each([
		["google-generative-ai", "google"],
		["anthropic-messages", "anthropic"],
	] as const)("probes a pi-native %s model at its gateway, with no provider routing", async (api, provider) => {
		// pi-native POSTs every API to `baseUrl/v1/pi/stream` through the plain
		// transport fetch: no provider endpoint rules, no Anthropic TLS options.
		const { calls, fetch } = captureFetch();
		const gateway = buildModel({
			...model(provider, api, "https://auth-gateway.example:8443"),
			transport: "pi-native",
		});

		await expect(probeModelConnection(gateway, { apiKey: "gw-token", fetch })).resolves.toBe(true);

		expect(calls.map(call => [call.url, call.init.tls])).toEqual([["https://auth-gateway.example:8443", undefined]]);
	});

	it("does not probe Snowflake's catalog placeholder before the account route is known", async () => {
		// Dispatch swaps `snowflake-account.invalid` for the credential's account
		// origin in the provider's `prepareRequest`, which a probe does not run.
		const { calls, fetch } = captureFetch();
		const snowflake = model("snowflake", "anthropic-messages", "https://snowflake-account.invalid/api/v2/cortex");

		await expect(probeModelConnection(snowflake, { apiKey: "pat", fetch })).resolves.toBe(true);
		expect(calls).toHaveLength(0);

		// Once a request has gone out, the account origin it reached is the route.
		await dispatch(snowflake, "https://myorg-myacct.snowflakecomputing.com/api/v2/cortex/v1/messages");
		await probeModelConnection(snowflake, { apiKey: "pat", fetch });
		expect(calls.map(call => call.url)).toEqual(["https://myorg-myacct.snowflakecomputing.com"]);
	});

	it("treats every provider whose requests are reshaped before dispatch as reachable until it has sent one", async () => {
		// Provider preparers (`prepareModel` / `prepareRequest`) and the providers
		// `stream.ts` routes to hosts of their own can move a request anywhere.
		const reshaped = [
			...PROVIDER_REGISTRY.filter(definition => definition.prepareModel || definition.prepareRequest).map(
				definition => definition.id,
			),
			"gitlab-duo",
			"kimi-code",
			"synthetic",
		];
		expect(reshaped).toContain("snowflake");
		const { calls, fetch } = captureFetch();

		for (const provider of reshaped) {
			for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
				await expect(
					probeModelConnection(model(provider, api, "https://catalog-host.example/v1"), { apiKey: "k", fetch }),
				).resolves.toBe(true);
			}
		}
		expect(calls).toHaveLength(0);
	});

	it("never probes a `.invalid` host", async () => {
		const { calls, fetch } = captureFetch();
		const placeholder = model("custom-gw", "openai-completions", "https://gateway.invalid/v1");

		await expect(probeModelConnection(placeholder, { apiKey: "k", fetch })).resolves.toBe(true);
		expect(calls).toHaveLength(0);
	});

	it("counts a redirect as an answer instead of following it", async () => {
		// A gateway root that redirects to a docs or login host that is down.
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/" } }),
		});
		try {
			const local = model("redirecting-gw", "openai-completions", `http://127.0.0.1:${server.port}/v1`);
			await expect(probeModelConnection(local, { apiKey: "k" })).resolves.toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("reports a host that never answers as unreachable once the probe's timeout fires", async () => {
		// A route that drops packets never rejects; only the timeout ends the probe.
		// The fake signal is already timed out, standing in for the 5 s wait.
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
			AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError")),
		);
		// Without a deadline the probe would wait forever; fail the test instead of hanging it.
		const noDeadline = Promise.withResolvers<never>();
		const fetch: FetchImpl = (_input, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = init?.signal;
			if (!signal) noDeadline.reject(new Error("the probe sent no deadline"));
			else if (signal.aborted) reject(signal.reason);
			else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		};

		try {
			const probe = probeModelConnection(model("openai", "openai-responses", "https://api.openai.com/v1"), {
				apiKey: "sk-test",
				fetch,
			});
			await expect(Promise.race([probe, noDeadline.promise])).resolves.toBe(false);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("sends the probe through the provider's proxy, like its requests", async () => {
		const { calls, fetch } = captureFetch();
		await withEnv({ PI_PROXY_PROBE_PROXY_TEST: "http://proxy.corp.example:3128" }, async () => {
			await probeModelConnection(model("probe-proxy-test", "openai-completions", "https://llm.example/v1"), {
				apiKey: "sk-test",
				fetch,
			});
		});

		expect(calls.map(call => [call.url, "proxy" in call.init ? call.init.proxy : undefined])).toEqual([
			["https://llm.example", "http://proxy.corp.example:3128"],
		]);
	});
});
