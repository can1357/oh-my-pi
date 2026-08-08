import { afterEach, describe, expect, it, mock } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { DROID_SYSTEM_PREFIX, streamFactoryDroid } from "../src/providers/factory-droid";
import type { Model } from "../src/types";

function kimiK3(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "kimi-k3",
			name: "Kimi K3 (Droid Core)",
			wire: "openai-completions",
			contextWindow: 196_608,
			maxTokens: 65_536,
			apiProviders: ["fireworks", "baseten"],
			supportedReasoningEfforts: ["off", Effort.Low, Effort.High, Effort.Max],
			defaultReasoningEffort: Effort.High,
		}),
	);
}

function nemotron(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "nemotron-3-ultra",
			name: "Nemotron 3 Ultra (Droid Core)",
			wire: "openai-completions",
			contextWindow: 136_464,
			maxTokens: 65_536,
			apiProviders: ["baseten", "fireworks"],
			supportedReasoningEfforts: ["off", Effort.High],
			defaultReasoningEffort: Effort.High,
			noImageSupport: true,
		}),
	);
}

function gptTerra(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			wire: "openai-responses",
			contextWindow: 922_000,
			maxTokens: 128_000,
			apiProviders: ["openai"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultReasoningEffort: Effort.Medium,
			responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		}),
	);
}

function sonnet5(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "claude-sonnet-5",
			name: "Sonnet 5",
			wire: "anthropic-messages",
			contextWindow: 872_000,
			maxTokens: 128_000,
			apiProviders: ["anthropic", "vertex_anthropic", "bedrock_anthropic"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			defaultReasoningEffort: Effort.High,
			thinkingStyle: "adaptive-summarized",
			pdfSupport: true,
		}),
	);
}

function gemini(): Model<"factory-droid-agent"> {
	return buildModel(
		buildFactoryDroidModel({
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro",
			wire: "google-generate",
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			apiProviders: ["google"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High],
			defaultReasoningEffort: Effort.High,
			geminiMedium: true,
			pdfSupport: true,
		}),
	);
}

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function sseResponse(chunks: string[]): Response {
	const body = `${chunks.map(chunk => `data: ${chunk}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function completionsChunks(text: string, model: string): string[] {
	return [
		JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [{ index: 0, delta: { role: "assistant", content: text } }],
		}),
		JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
		}),
	];
}

function responsesChunks(text: string): string[] {
	return [
		JSON.stringify({ type: "response.output_text.delta", delta: text }),
		JSON.stringify({
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } },
		}),
	];
}

const ANTHROPIC_EVENTS = [
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
];

function anthropicChunks(text: string): string[] {
	return [
		JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_t",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-5",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 7 },
			},
		}),
		JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		JSON.stringify({ type: "content_block_stop", index: 0 }),
		JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
		JSON.stringify({ type: "message_stop" }),
	];
}

function geminiChunks(text: string): string[] {
	return [
		JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }),
		JSON.stringify({
			candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 6 },
		}),
	];
}

/** Fake WorkOS-shaped JWT carrying the given external org id claim. */
function workosJwt(orgId?: string): string {
	const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${b64({ alg: "none" })}.${b64(orgId ? { external_org_id: orgId } : {})}.sig`;
}

/** Credential for the `/login factory-droid` store path, with an org claim. */
const WORKOS_TOKEN = workosJwt("org-1");

function captureFetch(captured: CapturedRequest[], chunks: string[], eventNames?: string[]) {
	return mock(async (url: string | URL | Request, init?: RequestInit) => {
		const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
		const rawBody = init?.body;
		const bodyText =
			typeof rawBody === "string"
				? rawBody
				: rawBody instanceof Uint8Array
					? new TextDecoder().decode(rawBody)
					: "{}";
		captured.push({
			url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
			headers,
			body: JSON.parse(bodyText || "{}") as Record<string, unknown>,
		});
		if (!eventNames) return sseResponse(chunks);
		const body = `${chunks.map((chunk, i) => `event: ${eventNames[i] ?? "message"}\ndata: ${chunk}`).join("\n\n")}\n\n`;
		return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	});
}

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
		// droid sends random v4 UUIDs; the OMP session id must not leak its v7 shape.
		expect(request.headers["x-session-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(request.headers["x-session-id"]).not.toContain("019fd");

		expect(request.body.model).toBe("kimi-k3");
		expect(request.body.stream).toBe(true);
		expect(request.body.stream_options).toEqual({ include_usage: true });
		// buildModel's output clamp lands at 64000 for kimi-k3 (65536 exceeds the compat ceiling).
		expect(request.body.max_tokens).toBe(64_000);
		expect(request.body.temperature).toBe(1);
		expect(request.body.store).toBeUndefined();
		const messages = request.body.messages as Array<{ role: string; content: unknown }>;
		expect(messages[0].role).toBe("system");
		// The proxy gates on the Droid identity prefix; OMP's own prompt must survive behind it.
		expect(JSON.stringify(messages[0].content)).toContain(DROID_SYSTEM_PREFIX);
		expect(JSON.stringify(messages[0].content)).toContain("OMP system prompt");
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
		expect(request.body.parallel_tool_calls).toBe(true);
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
		expect(generation.temperature).toBe(1);
		expect(generation.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" });
		expect(JSON.stringify(request.body.systemInstruction)).toContain(DROID_SYSTEM_PREFIX);
	});
});
