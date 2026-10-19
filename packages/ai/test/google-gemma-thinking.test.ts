import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** Streams one Gemini API request and returns the `thinkingConfig` it sent. */
async function sentThinkingConfig(id: string, reasoning: Effort | undefined): Promise<unknown> {
	// No explicit `thinking`: the dial must come from the KDL rules, as for discovered rows.
	const model = buildModel({
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 32_768,
	});
	let body: { generationConfig?: { thinkingConfig?: unknown } } | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		body = JSON.parse(requestBodyText(init) ?? "{}");
		const chunk = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	for await (const _ of streamSimple(model, context, { apiKey: "k", fetch, reasoning })) {
		// consume
	}
	return body?.generationConfig?.thinkingConfig;
}

describe("Gemma 4 on the Gemini API (#16350)", () => {
	// Gemma 4 toggles thinking only via thinkingLevel (HIGH on, MINIMAL off); any
	// thinkingBudget, including 0 for off, returns 400.
	// https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api#thinking
	for (const id of ["gemma-4-31b-it", "gemma-4-26b-a4b-it"]) {
		it(`${id} sends thinkingLevel for both on and off`, async () => {
			expect(await sentThinkingConfig(id, Effort.High)).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
			expect(await sentThinkingConfig(id, undefined)).toEqual({ includeThoughts: false, thinkingLevel: "MINIMAL" });
		});
	}
});
