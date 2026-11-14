import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { completeSimple } from "../stream";
import type { Context } from "../types";
import systemTemplate from "./gemini-cli-transcribe-system.md" with { type: "text" };
import userTemplate from "./gemini-cli-transcribe-user.md" with { type: "text" };
import { type TranscriptionOptions, TranscriptionApiError } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

/**
 * Transcribe through a Gemini chat model on Cloud Code Assist
 * (`google-antigravity`/`google-gemini-cli` OAuth), which serves no transcribe
 * SKU: the audio rides as an inline-data part next to a verbatim-transcription
 * instruction on the existing `google-gemini-cli` transport, so auth, headers,
 * project and endpoint handling are that provider's. The stt row's
 * `requestModelId` names the chat SKU.
 */
export async function transcribeGeminiCli(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const label = `${model.provider}/${model.id}`;
	if (request.timestampGranularities?.length) {
		throw new AIError.ValidationError(`${label} does not support timestamp granularities`);
	}
	if (!request.mimeType.startsWith("audio/")) {
		throw new AIError.ValidationError(`${label} needs an audio/* MIME type, got ${request.mimeType}`);
	}
	const bytes =
		request.audio instanceof Uint8Array ? request.audio : new Uint8Array(await request.audio.arrayBuffer());
	const audioPart = { inlineData: { mimeType: request.mimeType, data: bytes.toBase64() } };

	// `reasoning: false` sends no thinkingConfig, so each SKU thinks at its
	// server default: tier SKUs (`gemini-3.8-flash-low`) answer 400 to a
	// MINIMAL suppression and `gemini-3-flash` to any explicit one (live, 2026-11-13).
	const chatModel = buildModel({
		id: model.requestModelId ?? model.id,
		name: model.name,
		api: "google-gemini-cli",
		provider: model.provider,
		baseUrl: model.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: model.cost,
		contextWindow: null,
		maxTokens: null,
		...(model.headers && { headers: model.headers }),
	});
	const context: Context = {
		systemPrompt: [prompt.render(systemTemplate)],
		messages: [
			{
				role: "user",
				content: prompt.render(userTemplate, { language: request.language, prompt: request.prompt }),
				timestamp: Date.now(),
			},
		],
	};

	const response = await completeSimple(chatModel, context, {
		apiKey: options.apiKey,
		signal: options.signal,
		temperature: request.temperature ?? 0,
		...(options.fetch && { fetch: options.fetch }),
		// The chat wire has no audio content block; place the audio ahead of the
		// instruction in the only user turn.
		onPayload: payload => {
			const contents = cloudCodeAssistContents(payload);
			if (!contents?.[0]) {
				throw new AIError.ProviderResponseError(`${label}: unexpected Cloud Code Assist request shape`, {
					provider: model.provider,
					kind: "envelope",
				});
			}
			contents[0].parts.unshift(audioPart);
			return undefined;
		},
	});
	if (response.stopReason === "aborted") {
		throw options.signal?.reason instanceof Error
			? options.signal.reason
			: new AIError.AbortError(`${label} transcription aborted`);
	}
	if (response.stopReason === "error") {
		const message = `${label} transcription failed: ${response.errorMessage ?? "unknown error"}`;
		if (response.errorStatus !== undefined) throw new TranscriptionApiError(message, response.errorStatus);
		throw new AIError.ProviderResponseError(message, { provider: model.provider });
	}
	let text = "";
	for (const block of response.content) if (block.type === "text") text += block.text;
	return { text: unwrapTranscript(text), usage: response.usage };
}

function cloudCodeAssistContents(payload: unknown): { parts: unknown[] }[] | undefined {
	if (!payload || typeof payload !== "object" || !("request" in payload)) return undefined;
	const inner = payload.request;
	if (!inner || typeof inner !== "object" || !("contents" in inner) || !Array.isArray(inner.contents)) {
		return undefined;
	}
	return inner.contents.every(
		(content: unknown) =>
			!!content && typeof content === "object" && "parts" in content && Array.isArray(content.parts),
	)
		? inner.contents
		: undefined;
}

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["\u201c", "\u201d"],
	["\u2018", "\u2019"],
	["\u00ab", "\u00bb"],
];

/** Strip a code fence and matching wrapper quotes a chat model may add around the transcript. */
export function unwrapTranscript(raw: string): string {
	let text = raw.trim();
	const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fenced) text = fenced[1].trim();
	for (;;) {
		const pair = WRAPPERS.find(([open, close]) => text.length >= 2 && text.startsWith(open) && text.endsWith(close));
		if (!pair) return text;
		const inner = text.slice(pair[0].length, -pair[1].length);
		// `"a" and "b"` is quoted speech, not a wrapper.
		if (inner.includes(pair[0]) || inner.includes(pair[1])) return text;
		text = inner.trim();
	}
}
