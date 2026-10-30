import { describe, expect, it, mock } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import { streamSimple } from "../src/stream";
import {
	anthropicChunks,
	assistantTurn,
	type CapturedRequest,
	captureFetch,
	completionsChunks,
	factoryModel,
	factoryRegistryModel,
	gemini,
	geminiChunks,
	gptTerra,
	kimiK3,
	responsesChunks,
	sonnet5,
	WORKOS_TOKEN,
	workosJwt,
} from "./helpers/factory-droid";

const DROID_IDENTITY = "You are Droid, an AI software engineering agent built by Factory.";

/** GLM-5.2 is the one model whose EU inference limits are narrower than global. */
const glm52 = factoryRegistryModel("glm-5.2");

describe("Factory Droid completions wire (Droid Core)", () => {
	it.each(["global", "us"] as const)(
		"rotates OAuth host and organization while intersecting known routes in %s inference",
		async inferenceRegion => {
			const model = factoryModel("kimi-k3");
			model.baseUrl = "https://api.eu.factory.ai/api/llm/o/v1";
			model.factoryDroidOrgId = "org-eu";
			model.factoryDroidApiProviders = ["fireworks", "baseten"];
			const captured: CapturedRequest[] = [];
			const capture = captureFetch(captured, completionsChunks("ROTATED", model.id));
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					apiKey: async context =>
						context.error
							? {
									apiKey: "global-token",
									credentialId: 2,
									oauthIdentity: { orgId: "org-global", region: "global", inferenceRegion },
								}
							: {
									apiKey: "eu-token",
									credentialId: 1,
									oauthIdentity: { orgId: "org-eu", region: "eu", inferenceRegion: "global" },
								},
					fetch: async (url, init) => {
						const response = await capture(url, init);
						return captured.length === 1
							? new Response(JSON.stringify({ error: { message: "Forbidden", type: "authentication_error" } }), {
									status: 403,
								})
							: response;
					},
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(
				captured.map(request => [
					request.url,
					request.headers["x-factory-org-id"],
					request.headers["x-api-provider"],
					request.headers.authorization,
				]),
			).toEqual([
				["https://api.eu.factory.ai/api/llm/o/v1/chat/completions", "org-eu", "fireworks", "Bearer eu-token"],
				[
					"https://api.factory.ai/api/llm/o/v1/chat/completions",
					"org-global",
					inferenceRegion === "us" ? "baseten" : "fireworks",
					"Bearer global-token",
				],
			]);
		},
	);

	it("keeps the discovered rotation's order for an OAuth identity", async () => {
		// Live routing preferred baseten; the static table leads with fireworks.
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			factoryModel("kimi-k3", ["baseten", "fireworks"]),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: workosJwt({ external_org_id: "org-global" }),
				oauthIdentity: { orgId: "org-global", region: "global", inferenceRegion: "global" },
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
	});

	it("refuses global GLM-5.2 replay into a narrower EU window", async () => {
		const model = buildModel(
			buildFactoryDroidModel(glm52, {
				apiProviders: ["baseten"],
				region: "global",
				inferenceRegion: "global",
				orgId: "org-global",
			}),
		);
		// No cached route: each attempt takes its identity's registry rotation
		// (global Baseten, then EU Mistral), so only the window can refuse it.
		model.factoryDroidApiProviders = undefined;
		const captured: CapturedRequest[] = [];
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: async context =>
					context.error
						? { apiKey: "eu-token", oauthIdentity: { orgId: "org-eu", region: "eu", inferenceRegion: "eu" } }
						: {
								apiKey: "global-token",
								oauthIdentity: { orgId: "org-global", region: "global", inferenceRegion: "global" },
							},
				fetch: async (url, init) => {
					await captureFetch(captured, completionsChunks("UNEXPECTED", model.id))(url, init);
					return new Response(JSON.stringify({ error: { message: "Forbidden", type: "authentication_error" } }), {
						status: 403,
					});
				},
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`${glm52.policy.euLimits.contextWindow}-token context window`);
		expect(result.errorMessage).toContain("Rediscover and select the regional model");
		expect(captured.map(request => request.url)).toEqual(["https://api.factory.ai/api/llm/o/v1/chat/completions"]);
		expect(captured[0].body.max_tokens).toBe(glm52.policy.limits.maxTokens);
		expect(model.contextWindow).toBe(glm52.policy.limits.contextWindow);
	});

	it.each([undefined, 1024])(
		"narrows a stale global output ceiling to the EU cap but keeps caller cap %s",
		async maxTokens => {
			const model = buildModel(
				buildFactoryDroidModel(glm52, {
					apiProviders: ["mistral"],
					region: "global",
					inferenceRegion: "global",
					orgId: "org-global",
				}),
			);
			// The caller already selected a context budget safe for either region;
			// the global output ceiling must still be resolved per attempt.
			model.contextWindow = glm52.policy.euLimits.contextWindow!;
			model.baseUrl = "https://gateway.example/factory/v1";
			const captured: CapturedRequest[] = [];
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: "eu-token",
					oauthIdentity: { orgId: "org-eu", region: "eu", inferenceRegion: "eu" },
					maxTokens,
					fetch: captureFetch(captured, completionsChunks("EU_OK", model.id)),
				},
			).result();
			expect(result.stopReason).toBe("stop");
			expect(captured[0].body.max_tokens).toBe(maxTokens ?? glm52.policy.euLimits.maxTokens);
			expect(captured[0].url).toBe("https://gateway.example/factory/v1/chat/completions");
			expect(model.maxTokens).toBe(glm52.policy.limits.maxTokens);
		},
	);

	it.each([{ providers: [] }, { providers: ["mistral"] }])(
		"does not broaden cached explicit routes %j for a new global account",
		async ({ providers }) => {
			const model = factoryModel("glm-5.2");
			model.factoryDroidOrgId = "previous-org";
			model.factoryDroidApiProviders = [...providers];
			const captured: CapturedRequest[] = [];
			const result = await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: "new-token",
					oauthIdentity: {},
					fetch: captureFetch(captured, completionsChunks("UNEXPECTED", model.id)),
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("unavailable");
			expect(captured).toEqual([]);
		},
	);

	it("preserves a custom gateway and never borrows a cached organization for an unscoped OAuth identity", async () => {
		const model = kimiK3();
		model.baseUrl = "https://gateway.example/factory/v1";
		model.factoryDroidOrgId = "previous-org";
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: "token",
				oauthIdentity: {},
				fetch: captureFetch(captured, completionsChunks("OK", model.id)),
			},
		).result();
		expect(captured[0].url).toBe("https://gateway.example/factory/v1/chat/completions");
		expect(captured[0].headers["x-factory-org-id"]).toBeUndefined();
	});

	it("fails with sign-in guidance before any request when no Droid session exists", async () => {
		const fetch = mock(async () => new Response(null, { status: 500 }));
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ fetch },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("/login");
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		["/o/v1/chat/completions", kimiK3, completionsChunks("OK", "kimi-k3")],
		["/o/v1/responses", gptTerra, responsesChunks("OK")],
		["/a/v1/messages", sonnet5, anthropicChunks("OK")],
		["/g/v1/generate", gemini, geminiChunks("OK")],
	] as const)("posts %s to Factory with account identity and the Droid prompt", async (path, model, chunks) => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			model(),
			{ systemPrompt: ["OMP system prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(captured, [...chunks]), sessionId: "019fd-test-session" },
		).result();

		expect(result.stopReason).toBe("stop");
		const request = captured[0];
		expect(request.url.split("?")[0]).toBe(`https://api.factory.ai/api/llm${path}`);
		expect(request.headers.authorization).toBe(`Bearer ${WORKOS_TOKEN}`);
		expect(request.headers["x-factory-org-id"]).toBe("org-1");
		// droid sends random v4 UUIDs; the OMP session id must not leak its v7 shape.
		expect(request.headers["x-session-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.headers["x-session-id"]).not.toContain("019fd");
		// The identity leads the wire's system channel and the caller's prompt follows it.
		const { messages, instructions, system, systemInstruction } = request.body as Record<string, unknown>;
		const systemChannel = JSON.stringify(
			instructions ?? system ?? systemInstruction ?? (messages as Array<{ role: string }>)[0],
		);
		expect(systemChannel).toContain(DROID_IDENTITY);
		expect(systemChannel).toContain("OMP system prompt");
		// Toolless requests leave parallel tool calls at the API default.
		expect(request.body.parallel_tool_calls).toBeUndefined();
	});

	it("forwards payload replacement, response metadata and raw SSE observation through the wrapper", async () => {
		const captured: CapturedRequest[] = [];
		const observed = { status: 0, chunks: [] as string[] };
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, completionsChunks("hooked", "kimi-k3")),
				onPayload: payload => ({ ...(payload as object), temperature: 0.4 }),
				onResponse: response => {
					observed.status = response.status;
				},
				onSseEvent: event => observed.chunks.push(event.data),
			},
		).result();
		expect(result.content).toEqual([{ type: "text", text: "hooked" }]);
		expect(captured[0].body.temperature).toBe(0.4);
		expect(observed.status).toBe(200);
		expect(observed.chunks.some(chunk => chunk.includes("hooked"))).toBe(true);
	});

	it.each([
		["header only", undefined, 7, 4],
		["body 0 over the header", 0, 0, 11],
		["body 8 over the header", 8, 8, 3],
	] as const)("reads fireworks cached prompt tokens with %s", async (_case, cached, cacheRead, input) => {
		const chunks = completionsChunks("OK", "kimi-k3");
		if (cached !== undefined) {
			// Rebuild the terminal chunk with body-reported cached tokens.
			const terminal = JSON.parse(chunks[1]) as Record<string, unknown>;
			terminal.usage = {
				prompt_tokens: 11,
				completion_tokens: 3,
				total_tokens: 14,
				prompt_tokens_details: { cached_tokens: cached },
			};
			chunks[1] = JSON.stringify(terminal);
		}
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch([], chunks, { "fireworks-cached-prompt-tokens": "7" }),
			},
		).result();

		expect(result.usage.cacheRead).toBe(cacheRead);
		expect(result.usage.input).toBe(input);
		expect(result.usage.output).toBe(3);
		expect(result.usage.totalTokens).toBe(14);
	});

	it("honors the account-resolved upstream rotation from the model spec", async () => {
		// The live provider_routing config routes kimi-k3 baseten-first for this
		// account; the spec field must override the registry's static order.
		const routed = kimiK3();
		routed.factoryDroidApiProviders = ["baseten", "fireworks"];
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			routed,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				reasoning: Effort.High,
			},
		).result();

		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
		// Kimi K3 uses Baseten's effort dialect, unlike its opt-in models.
		expect(captured[0].body.reasoning_effort).toBe("high");
		expect(captured[0].body.chat_template_args).toBeUndefined();
	});

	it("includes the tool name on tool-result messages for kimi-k3", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{
				messages: [
					{ role: "user", content: "read it", timestamp: 1 },
					assistantTurn(
						[{ type: "toolCall", id: "call_0", name: "Read", arguments: { path: "/tmp/x" } }],
						"kimi-k3",
					),
					{
						role: "toolResult",
						toolCallId: "call_0",
						toolName: "Read",
						content: [{ type: "text", text: "body" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{ apiKey: "workos-token", fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")) },
		).result();

		const messages = captured[0].body.messages as Array<{ role: string; name?: string }>;
		const toolMessage = messages.find(message => message.role === "tool");
		expect(toolMessage?.name).toBe("Read");
	});
});

describe("Factory Droid error handling", () => {
	it("names the model when the proxy rejects the route regionally", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: async () =>
					new Response(JSON.stringify({ detail: "Provider not available in this region" }), { status: 400 }),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toMatch(/kimi-k3.*region/);
	});
});
