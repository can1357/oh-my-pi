import { type } from "@oh-my-pi/omptype";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import {
	applyCodexResidencyHeader,
	CODEX_DESKTOP_ORIGINATOR,
	CODEX_DESKTOP_USER_AGENT,
	getCodexAccountId,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { emptyUsage } from "../images/shared";
import { normalizeCodexBaseUrl } from "../usage/openai-codex-base-url";
import { type TranscriptionOptions, transcriptionResponseError } from "./openai-transcriptions";
import { TRANSCRIPTION_AUDIO_MIME_TYPES, type TranscriptionRequest, type TranscriptionResult } from "./types";

const responseSchema = type({ text: "string" });

/** Extensions the endpoint decodes. */
const DECODABLE_EXTENSIONS: Readonly<Record<string, true>> = {
	wav: true,
	mp3: true,
	mpeg: true,
	mp4: true,
	m4a: true,
	ogg: true,
	webm: true,
	flac: true,
};

/**
 * The endpoint picks its decoder from the upload's file extension and answers `500 Error in ASR API` when the
 * extension is missing or unknown (`voice.oga`, `audio`), even for audio it can decode. Keep a decodable name
 * whose container agrees with the MIME type (`mp3`/`mpeg`, `m4a`/`mp4` share one MIME type); otherwise name the
 * file after the container the MIME type declares, and fall back to the caller's name when the MIME type is
 * unknown too.
 */
function uploadFileName(request: TranscriptionRequest): string {
	const name = request.fileName?.trim() || "audio";
	const dot = name.lastIndexOf(".");
	const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
	const mimeType = request.mimeType.split(";", 1)[0]?.trim().toLowerCase().replace("audio/x-", "audio/");
	const declared = Object.entries(TRANSCRIPTION_AUDIO_MIME_TYPES).find(([, mime]) => mime === mimeType)?.[0];
	if (
		DECODABLE_EXTENSIONS[extension] === true &&
		(!declared || TRANSCRIPTION_AUDIO_MIME_TYPES[extension] === mimeType)
	) {
		return name;
	}
	return declared ? `audio.${declared}` : name;
}

/**
 * Transcribe through the ChatGPT backend dictation endpoint (`POST /transcribe`) with a Codex OAuth bearer.
 *
 * The endpoint takes only `file` and `language` and reports no usage or segments, so prompt, temperature,
 * response format and timestamp options are not forwarded and the result carries text with zero usage. A
 * `baseUrl` override that is not a chatgpt.com origin is ignored ({@link normalizeCodexBaseUrl}), so the
 * Codex bearer is never sent to another host.
 */
export async function transcribeOpenAICodex(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const form = new FormData();
	form.append("file", new File([request.audio], uploadFileName(request), { type: request.mimeType }));
	if (request.language !== undefined) form.append("language", request.language);

	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
				"User-Agent": CODEX_DESKTOP_USER_AGENT,
				[OPENAI_HEADERS.ORIGINATOR]: CODEX_DESKTOP_ORIGINATOR,
			};
			const accountId = getCodexAccountId(key);
			if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
			// The backend 401s a region-pinned workspace unless the request declares its residency.
			applyCodexResidencyHeader(headers, key);
			const attempt = await fetchImpl(`${normalizeCodexBaseUrl(model.baseUrl)}/transcribe`, {
				method: "POST",
				headers,
				body: form,
				signal: options.signal,
			});
			if (!attempt.ok) throw await transcriptionResponseError(attempt, model);
			return attempt;
		},
		{ signal: options.signal },
	);

	const parsed = responseSchema(await response.json());
	if (parsed instanceof type.errors) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response is malformed: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	return { text: parsed.text, usage: emptyUsage() };
}
