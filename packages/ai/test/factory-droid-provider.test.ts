import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as discovery from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DROID_SYSTEM_PREFIX, streamFactoryDroid } from "../src/providers/factory-droid";
import {
	ANTHROPIC_EVENTS,
	anthropicChunks,
	type CapturedRequest,
	captureFetch,
	completionsChunks,
	gemini,
	geminiChunks,
	geminiToolChunks,
	gptTerra,
	kimiK3,
	nemotron,
	responsesChunks,
	sonnet5,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

afterEach(() => {
	mock.restore();
});

describe("Factory Droid completions wire (Droid Core)", () => {
	it("fails with sign-in guidance when no Droid session exists", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("/login factory-droid");
	});

	it("posts to the Factory LLM proxy with bearer auth, identity headers, and upstream routing", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			kimiK3(),
			{ systemPrompt: ["OMP system prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, completionsChunks("OMP_DIRECT_OK", "kimi-k3")),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "OMP_DIRECT_OK" }]);
		expect(result.usage.input).toBe(11);
		expect(result.usage.output).toBe(3);

		expect(captured).toHaveLength(1);
		const request = captured[0];
		expect(request.url).toBe("https://api.factory.ai/api/llm/o/v1/chat/completions");
		expect(request.headers.authorization).toBe(`Bearer ${WORKOS_TOKEN}`);
		expect(request.headers["x-api-provider"]).toBe("fireworks");
		expect(request.headers["x-client-version"]).toBeDefined();
		expect(request.headers["user-agent"]).toMatch(/^factory-cli\//);
		expect(request.headers["x-factory-org-id"]).toBe("org-1");
		expect(request.headers["x-stainless-lang"]).toBe("js");
		// droid always walks its configured rotation, so every inference call
		// declares the routing source to the proxy.
		expect(request.headers["x-provider-routing-source"]).toBe("configured_order");
		// The Stainless runtime version is pinned to droid's packaged Node build
		// rather than read off the host runtime.
		expect(request.headers["x-stainless-runtime-version"]).toBe("v24.3.0");
		// droid sends random v4 UUIDs; the OMP session id must not leak its v7 shape.
		expect(request.headers["x-session-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.headers["x-session-id"]).not.toContain("019fd");

		expect(request.body.model).toBe("kimi-k3");
		expect(request.body.stream).toBe(true);
		expect(request.body.stream_options).toEqual({ include_usage: true });
		// The proxy accepts each model's advertised output cap — no 64k clamp here.
		expect(request.body.max_tokens).toBe(65_536);

		// droid pins temperature on every completions body.
		expect(request.body.temperature).toBe(1);
		expect(request.body.store).toBeUndefined();
		const messages = request.body.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0].role).toBe("system");
		// The proxy gates on the Droid identity prefix; OMP's own prompt must survive behind it.
		expect(JSON.stringify(messages[0].content)).toContain(DROID_SYSTEM_PREFIX);
		expect(JSON.stringify(messages[0].content)).toContain("OMP system prompt");
	});
	it("reports cacheRead from the fireworks-cached-prompt-tokens header when the body omits cached_tokens", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3"), undefined, {
					"fireworks-cached-prompt-tokens": "7",
				}),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.usage.input).toBe(4);
		expect(result.usage.cacheRead).toBe(7);
		expect(result.usage.output).toBe(3);
		expect(result.usage.totalTokens).toBe(14);
	});

	it("prefers body cached_tokens over the fireworks-cached-prompt-tokens header", async () => {
		const captured: CapturedRequest[] = [];
		const chunks = completionsChunks("OK", "kimi-k3");
		// Rebuild the terminal chunk with body-reported cached tokens.
		const terminal = JSON.parse(chunks[1]) as Record<string, unknown> & {
			usage?: Record<string, unknown>;
		};
		terminal.usage = {
			prompt_tokens: 11,
			completion_tokens: 3,
			total_tokens: 14,
			prompt_tokens_details: { cached_tokens: 8 },
		};
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, [chunks[0], JSON.stringify(terminal)], undefined, {
					"fireworks-cached-prompt-tokens": "7",
				}),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.usage.cacheRead).toBe(8);
		expect(result.usage.input).toBe(3);
		expect(result.usage.output).toBe(3);
	});

	it("sends reasoning_effort none when thinking is disabled", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				disableReasoning: true,
			},
		).result();

		expect(captured[0].body.reasoning_effort).toBe("none");
	});

	it("emits reasoning_effort plus reasoning_history preserved on Fireworks when effort is set", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "kimi-k3")),
				reasoning: Effort.Max,
			},
		).result();

		expect(captured[0].body.reasoning_effort).toBe("max");
		expect(captured[0].body.reasoning_history).toBe("preserved");
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
		// Baseten thinking rides the template switch, never reasoning_effort.
		expect(captured[0].body.chat_template_args).toEqual({ enable_thinking: true });
		expect(captured[0].body.reasoning_effort).toBeUndefined();
	});

	it("includes the tool name on tool-result messages for kimi-k3", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			kimiK3(),
			{
				messages: [
					{ role: "user", content: "read it", timestamp: 1 },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_0", name: "Read", arguments: { path: "/tmp/x" } }],
						api: "factory-droid-agent",
						provider: "factory-droid",
						model: "kimi-k3",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 2,
					},
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

	it("emits chat_template_args enable_thinking without reasoning_effort on Baseten", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			nemotron(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "workos-token",
				fetch: captureFetch(captured, completionsChunks("OK", "nemotron-3-ultra")),
				reasoning: Effort.High,
			},
		).result();

		expect(captured[0].body.chat_template_args).toEqual({ enable_thinking: true });
		expect(captured[0].body.reasoning_effort).toBeUndefined();
		expect(captured[0].headers["x-api-provider"]).toBe("baseten");
	});

	it("surfaces a non-200 JSON error body as a provider error on the completions wire", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: mock(
					async () =>
						new Response(JSON.stringify({ error: { message: "insufficient credits" } }), {
							status: 400,
							headers: { "Content-Type": "application/json" },
						}),
				),
			},
		).result();

		// The transport decodes the OpenAI envelope and surfaces the status plus
		// the body detail; a billing rejection must not look like a clean stop.
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("400");
		expect(result.errorMessage).toContain("insufficient credits");
	});
});

describe("Factory Droid responses wire (GPT series)", () => {
	it("posts to /responses with droid cache and routing fields", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			gptTerra(),
			{ systemPrompt: ["OMP prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, responsesChunks("GPT_OK")),
				sessionId: "sess-1",
				reasoning: Effort.Max,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		const request = captured[0];
		expect(request.url).toBe("https://api.factory.ai/api/llm/o/v1/responses");
		expect(request.headers.authorization).toBe(`Bearer ${WORKOS_TOKEN}`);
		expect(request.headers["x-api-provider"]).toBe("openai");
		expect(request.body.model).toBe("gpt-5.6-terra");
		expect(request.body.prompt_cache_key).toBeDefined();
		// The HTTPS Responses route rejects droid's legacy "900" — these models
		// require 24h extended caching (verified live).
		expect(request.body.prompt_cache_retention).toBe("24h");
		// parallel_tool_calls defaults to the API's on; only false is written.
		expect(request.body.parallel_tool_calls).toBeUndefined();
		// Top-level verbosity moved to text.verbosity on the HTTPS Responses surface; omitted.
		// dXT: the Responses surface wants xhigh, never max.
		expect(JSON.stringify(request.body.reasoning)).toContain("xhigh");
		expect(JSON.stringify(request.body.reasoning)).not.toContain("max");
		expect(JSON.stringify(request.body.reasoning)).toContain("auto");
		expect(JSON.stringify(request.body.instructions)).toContain(DROID_SYSTEM_PREFIX);
	});
});

describe("Factory Droid anthropic wire (Claude series)", () => {
	it("posts to /a/v1/messages with adaptive thinking and effort config", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			sonnet5(),
			{ systemPrompt: ["OMP prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, anthropicChunks("CLAUDE_OK"), ANTHROPIC_EVENTS),
				sessionId: "sess-2",
				reasoning: Effort.High,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		const request = captured[0];
		expect(request.url).toStartWith("https://api.factory.ai/api/llm/a/v1/messages");
		expect(request.headers.authorization).toBe(`Bearer ${WORKOS_TOKEN}`);
		expect(request.headers["x-api-key"]).toBe("placeholder");
		expect(request.headers["x-api-provider"]).toBe("anthropic");
		expect(request.headers["anthropic-version"]).toBe("2023-06-01");
		expect(request.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(request.body.output_config).toEqual({ effort: "high" });
		expect(JSON.stringify(request.body.system)).toContain(DROID_SYSTEM_PREFIX);
	});

	it("surfaces a non-200 JSON error body as a provider error on the anthropic wire", async () => {
		const result = await streamFactoryDroid(
			sonnet5(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: mock(
					async () =>
						new Response(
							JSON.stringify({
								type: "error",
								error: { type: "invalid_request_error", message: "bad request" },
							}),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						),
				),
			},
		).result();

		// The SDK reads the error envelope and the catch surfaces the status;
		// a 400 must land as an error turn, never a clean stop.
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("400");
	});
});

describe("Factory Droid gemini wire (Google series)", () => {
	it("posts native generateContent to /g/v1/generate with thinking config", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroid(
			gemini(),
			{ systemPrompt: ["OMP prompt"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: captureFetch(captured, geminiChunks("GEM_OK")),
				sessionId: "sess-3",
				reasoning: Effort.Medium,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "GEM_OK" }]);
		expect(result.usage.input).toBe(21);
		const request = captured[0];
		expect(request.url).toBe("https://api.factory.ai/api/llm/g/v1/generate");
		expect(request.headers.authorization).toBe(`Bearer ${WORKOS_TOKEN}`);
		expect(request.headers["x-api-provider"]).toBe("google");
		expect(request.body.model).toBe("gemini-3.1-pro-preview");
		const generation = request.body.generationConfig as Record<string, unknown>;
		// Sampling is caller-driven; no defaults are injected.
		expect(generation.temperature).toBeUndefined();
		expect(generation.topP).toBeUndefined();
		expect(generation.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
		expect(JSON.stringify(request.body.systemInstruction)).toContain(DROID_SYSTEM_PREFIX);
	});

	it("captures thoughtSignature on tool calls and replays the droid continuation shape", async () => {
		// First turn: the stream stores the signature on the toolCall block.
		const firstCaptured: CapturedRequest[] = [];
		const first = await streamFactoryDroid(
			gemini(),
			{ messages: [{ role: "user", content: "read the file", timestamp: 1 }] },
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(firstCaptured, geminiToolChunks()), sessionId: "sess-4" },
		).result();
		expect(first.stopReason).toBe("toolUse");
		const toolCalls = first.content.filter(block => block.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({ name: "Read", thoughtSignature: "sig-abc" });
		expect(toolCalls[1]).toMatchObject({ name: "Read", thoughtSignature: "sig-def" });

		// Second turn: the two parallel tool results continue past the captured
		// first turn. Replayed model-turn part shapes (functionCall + signature,
		// thinking as plain text) are covered by the transport-level gemini tests.
		const secondCaptured: CapturedRequest[] = [];
		await streamFactoryDroid(
			gemini(),
			{
				messages: [
					{ role: "user", content: "read the file", timestamp: 1 },
					{
						...first,
						content: [
							{ type: "thinking", thinking: "unsigned reasoning" },
							{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig-think" },
							...first.content,
						],
					},
					{
						role: "toolResult",
						toolCallId: "call_0",
						toolName: "Read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "Read",
						content: [{ type: "text", text: "other body" }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(secondCaptured, geminiChunks("DONE")), sessionId: "sess-4" },
		).result();
		const contents = secondCaptured[0].body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		// Replayed functionCall part shapes are covered by the transport-level
		// gemini tests; this driver test only pins the driver-owned contract:
		// parallel responses ride ONE user content — the proxy 400s on a
		// call/response part-count mismatch.
		const responseTurns = contents.filter(
			entry => entry.role === "user" && entry.parts.some(part => part.functionResponse),
		);
		expect(responseTurns).toHaveLength(1);
		expect(responseTurns[0].parts.map(part => (part.functionResponse as { name: string }).name)).toEqual([
			"Read",
			"Read",
		]);
	});
});

describe("Factory Droid region availability", () => {
	it("rewrites a region-400 into actionable guidance and records the model as region-blocked", async () => {
		const recordSpy = spyOn(discovery, "recordFactoryDroidRegionBlock").mockResolvedValue(undefined);
		const regionError = {
			status: 400,
			title: "Bad Request",
			detail: "Provider not available in this region",
			requestId: "cdg1::p123",
		};
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: mock(async () => new Response(JSON.stringify(regionError), { status: 400 })),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("kimi-k3 is not served from your network's region");
		expect(result.errorMessage).toContain("serving edge: cdg1");
		expect(result.errorMessage).toContain("hidden from the model picker");
		expect(result.errorMessage).not.toContain("Bad Request");
		expect(recordSpy).toHaveBeenCalledWith("kimi-k3");
	});

	it("passes unrelated errors through untouched", async () => {
		const recordSpy = spyOn(discovery, "recordFactoryDroidRegionBlock").mockResolvedValue(undefined);
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: mock(
					async () =>
						new Response(JSON.stringify({ status: 400, detail: "context length exceeded" }), { status: 400 }),
				),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("context length exceeded");
		expect(recordSpy).not.toHaveBeenCalled();
	});
});

describe("Factory Droid quota exhaustion", () => {
	const forbidden = { status: 403, title: "Forbidden", detail: "Forbidden", requestId: "yul1::q1" };

	function limitsPayload(coreWeeklyPercent: number, extraBalanceCents = 0) {
		const window = (usedPercent: number) => ({
			usedPercent,
			windowEnd: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
		});
		return {
			limits: {
				standard: { fiveHour: window(10), weekly: window(20), monthly: window(30) },
				core: { fiveHour: window(40), weekly: window(coreWeeklyPercent), monthly: window(50) },
			},
			extraUsageBalanceCents: extraBalanceCents,
		};
	}

	function quotaFetch(limitsResponse: () => Response) {
		return mock(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/api/billing/limits")) return limitsResponse();
			return new Response(JSON.stringify(forbidden), { status: 403 });
		});
	}

	it("rewrites a bare 403 into pool guidance when the model's pool is exhausted", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: quotaFetch(() => new Response(JSON.stringify(limitsPayload(100)), { status: 200 })),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("kimi-k3 is unavailable");
		expect(result.errorMessage).toContain("Droid Core weekly pool is exhausted");
		expect(result.errorMessage).toContain("resets in");
		expect(result.errorMessage).toContain("Standard Credits models remain available");
		expect(result.errorMessage).not.toContain("Forbidden");
	});

	it("names the Standard Credits pool for non-core wires", async () => {
		const payload = limitsPayload(10);
		payload.limits.standard.weekly = { usedPercent: 100, windowEnd: new Date(Date.now() + 60_000).toISOString() };
		const result = await streamFactoryDroid(
			sonnet5(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: quotaFetch(() => new Response(JSON.stringify(payload), { status: 200 })),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.errorMessage).toContain("Standard Credits weekly pool is exhausted");
		expect(result.errorMessage).toContain("Droid Core models remain available");
	});

	it("leaves a bare 403 untouched when no pool is exhausted", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: quotaFetch(() => new Response(JSON.stringify(limitsPayload(40)), { status: 200 })),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.errorMessage).toContain("Forbidden");
	});

	it("leaves the 403 untouched when the limits re-check fails", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: quotaFetch(() => new Response("unavailable", { status: 500 })),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.errorMessage).toContain("Forbidden");
	});

	it("does not rewrite the 403 when extra-usage balance remains", async () => {
		const result = await streamFactoryDroid(
			kimiK3(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				apiKey: WORKOS_TOKEN,
				fetch: quotaFetch(() => new Response(JSON.stringify(limitsPayload(100, 500)), { status: 200 })),
				sessionId: "019fd-test-session",
			},
		).result();

		expect(result.errorMessage).toContain("Forbidden");
		expect(result.errorMessage).not.toContain("pool is exhausted");
	});
});
