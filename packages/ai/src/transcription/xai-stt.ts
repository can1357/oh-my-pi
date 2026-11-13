import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { type } from "@oh-my-pi/omptype";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import {
	decodeTranscriptionUsage,
	type TranscriptionOptions,
	transcriptionResponseError,
} from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult, TranscriptionWord } from "./types";

const xaiWordSchema = type({
	text: "string",
	start: "number",
	end: "number",
	"speaker?": "number | string",
});

const xaiResponseSchema = type({
	text: "string",
	"language?": "string",
	"duration?": "number",
	"words?": "object[]",
});

/**
 * Transcribe through xAI's `POST /v1/stt` (multipart, not OpenAI-shaped). The
 * response always carries word timestamps; `{ text, start, end, speaker? }`
 * words are normalized to {@link TranscriptionWord}.
 */
export async function transcribeXai(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	if (request.prompt !== undefined) throw new AIError.ValidationError("xai-stt does not support prompt");
	if (request.temperature !== undefined) throw new AIError.ValidationError("xai-stt does not support temperature");
	if (request.timestampGranularities?.includes("segment")) {
		throw new AIError.ValidationError("xai-stt does not support segment timestamps");
	}

	// xAI ignores option fields that follow `file`, so `file` goes last.
	const form = new FormData();
	form.append("model", model.id);
	if (request.language !== undefined) form.append("language", request.language);
	const fileName = request.fileName?.trim() || "audio";
	form.append("file", new File([request.audio], fileName, { type: request.mimeType }));

	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const attempt = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/stt`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				body: form,
				signal: options.signal,
			});
			if (!attempt.ok) throw await transcriptionResponseError(attempt, model);
			return attempt;
		},
		{ signal: options.signal },
	);

	const body: unknown = await response.json();
	const parsed = xaiResponseSchema(body);
	if (parsed instanceof type.errors) throw malformed(model, parsed.summary);
	const words: TranscriptionWord[] = [];
	for (const raw of parsed.words ?? []) {
		const word = xaiWordSchema(raw);
		if (word instanceof type.errors) throw malformed(model, `word ${words.length}: ${word.summary}`);
		const { text, ...rest } = raw as Record<string, unknown> & { text: string };
		words.push({ ...rest, word: text, start: word.start, end: word.end });
	}
	return {
		text: parsed.text,
		...(parsed.language !== undefined && { language: parsed.language }),
		...(parsed.duration !== undefined && { duration: parsed.duration }),
		...(parsed.words !== undefined && { words }),
		usage: decodeTranscriptionUsage(model, undefined).usage,
	};
}

function malformed(model: Model<Api>, detail: string): AIError.ProviderResponseError {
	return new AIError.ProviderResponseError(
		`${model.provider}/${model.id} transcription response is malformed: ${detail}`,
		{ provider: model.provider, kind: "envelope" },
	);
}
