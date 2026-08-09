import { mock } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

/** One captured request: URL, lowercased headers, and the parsed JSON body. */
export interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** Build a 200 `text/event-stream` response from bare SSE data lines. */
export function sseResponse(chunks: string[]): Response {
	const body = `${chunks.map(chunk => `data: ${chunk}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * Mock fetch that records every request into `captured` (normalizing headers
 * to lowercase and decoding string/Uint8Array bodies) and replies with the
 * given SSE chunks. When `eventNames` is provided, chunks are wrapped in
 * named SSE `event:` frames (the anthropic wire); otherwise they use the
 * bare `data:` framing.
 */
export function captureFetch(captured: CapturedRequest[], chunks: string[], eventNames?: string[]) {
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

/** Fake WorkOS-shaped JWT carrying the given claims (org id by default use case). */
export function workosJwt(claims: Record<string, string> = {}): string {
	const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

/** Credential for the `/login factory-droid` store path, with an org claim. */
export const WORKOS_TOKEN = workosJwt({ external_org_id: "org-1" });

/** Chat-completions SSE chunks: a content delta plus a terminal usage chunk. */
export function completionsChunks(text: string, model: string): string[] {
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

/** Responses-wire SSE chunks: a text delta plus a completed response. */
export function responsesChunks(text: string): string[] {
	return [
		JSON.stringify({ type: "response.output_text.delta", delta: text }),
		JSON.stringify({
			type: "response.completed",
			response: { status: "completed", usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } },
		}),
	];
}

/** Named SSE event sequence for the anthropic messages stream. */
export const ANTHROPIC_EVENTS = [
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
];

/** Anthropic messages SSE chunks for a single text turn. */
export function anthropicChunks(text: string): string[] {
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

/** Gemini generateContent chunks carrying two signed function calls, then STOP. */
export function geminiToolChunks(): string[] {
	return [
		JSON.stringify({
			candidates: [
				{
					content: {
						role: "model",
						parts: [
							{ functionCall: { name: "Read", args: { path: "/tmp/x" } }, thoughtSignature: "sig-abc" },
							{ functionCall: { name: "Read", args: { path: "/tmp/y" } }, thoughtSignature: "sig-def" },
						],
					},
				},
			],
		}),
		JSON.stringify({
			candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
		}),
	];
}

/** Gemini generateContent chunks for a plain text turn. */
export function geminiChunks(text: string): string[] {
	return [
		JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }),
		JSON.stringify({
			candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 6 },
		}),
	];
}

/** A single terminal Gemini generateContent chunk with the given finish reason. */
export function finishChunk(reason: string): string {
	return JSON.stringify({
		candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: reason }],
		usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
	});
}

export function kimiK3(): Model<"factory-droid-agent"> {
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

export function nemotron(): Model<"factory-droid-agent"> {
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

export function gptTerra(): Model<"factory-droid-agent"> {
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

export function sonnet5(): Model<"factory-droid-agent"> {
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
		}),
	);
}

export function gemini(): Model<"factory-droid-agent"> {
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
		}),
	);
}
