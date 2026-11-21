import { mock } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type FactoryDroidRegistryModel, factoryDroidRegistry } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";

/** One captured request: URL, lowercased headers, and the parsed JSON body. */
export interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * Mock fetch that records every request into `captured` (normalizing headers
 * to lowercase and decoding string/Uint8Array bodies) and replies with the
 * given SSE chunks. Chunks carrying a `type` ride named `event:` frames, as the
 * anthropic wire streams them; the rest use bare `data:` framing ended by
 * `[DONE]`.
 */
export function captureFetch(captured: CapturedRequest[], chunks: string[], responseHeaders?: Record<string, string>) {
	const frames = chunks.map(chunk => {
		const { type } = JSON.parse(chunk) as { type?: unknown };
		return typeof type === "string" ? `event: ${type}\ndata: ${chunk}` : `data: ${chunk}`;
	});
	if (!frames.some(frame => frame.startsWith("event:"))) frames.push("data: [DONE]");
	const body = `${frames.join("\n\n")}\n\n`;
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
		return new Response(body, {
			status: 200,
			headers: { "Content-Type": "text/event-stream", ...responseHeaders },
		});
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

/** A registry model from `rules/providers/factory-droid.kdl`. */
export function factoryRegistryModel(id: string): FactoryDroidRegistryModel {
	const entry = factoryDroidRegistry().find(model => model.spec.id === id);
	if (!entry) throw new Error(`Unknown Factory Droid model: ${id}`);
	return entry;
}

/** A Factory model built from its native registry row, optionally pinned to a live rotation. */
export function factoryModel(id: string, rotation?: readonly string[]): Model<"factory-droid-agent"> {
	return buildModel(buildFactoryDroidModel(factoryRegistryModel(id), { apiProviders: rotation }));
}

/** A stored Factory completions assistant turn; tool calls make it a `toolUse` stop. */
export function assistantTurn(content: AssistantMessage["content"], model: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "factory-droid",
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 2,
	};
}

export const kimiK3 = (): Model<"factory-droid-agent"> => factoryModel("kimi-k3");
export const gptTerra = (): Model<"factory-droid-agent"> => factoryModel("gpt-5.6-terra");
export const sonnet5 = (): Model<"factory-droid-agent"> => factoryModel("claude-sonnet-5");
export const gemini = (): Model<"factory-droid-agent"> => factoryModel("gemini-3.1-pro-preview");
