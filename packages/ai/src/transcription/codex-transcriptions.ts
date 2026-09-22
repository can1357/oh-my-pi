import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	URL_PATHS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { type } from "@oh-my-pi/omptype";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getCodexAttestationHeader } from "../providers/openai-codex-attestation";
import { responseError as transcriptionResponseError, type TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

/**
 * The ChatGPT backend dictation route. Unlike `/v1/audio/transcriptions` it
 * accepts only the audio file — no `model`, `language`, `prompt`, or
 * `response_format` — and answers with the transcript plus an asset pointer.
 */
const codexResponseSchema = type({
	text: "string",
	"asset_pointer?": "string",
});

function transcribeUrl(model: Model<Api>): string {
	const baseUrl = (model.baseUrl || CODEX_BASE_URL).replace(/\/+$/, "");
	return `${baseUrl}${URL_PATHS.TRANSCRIBE}`;
}

/**
 * Transcribe through the ChatGPT subscription rather than the platform API.
 *
 * Identity comes from the Codex bearer itself (the account id is a JWT claim),
 * matching the hosted-image transport, so no separate OAuth source is needed:
 * `withAuth` still force-refreshes and rotates a server-rejected credential.
 */
export async function transcribeCodex(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const accountId = getCodexAccountId(key);
			if (!accountId) {
				throw new AIError.ConfigurationError("OpenAI Codex authentication is missing an account id.");
			}
			const headers = new Headers({
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
				[OPENAI_HEADERS.ACCOUNT_ID]: accountId,
				[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
				[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
				"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
			});
			applyCodexResidencyHeader(headers, key);
			const attestation = await getCodexAttestationHeader(accountId);
			if (attestation) headers.set(OPENAI_HEADERS.ATTESTATION, attestation);
			// Rebuilt per attempt: a FormData body cannot be replayed after the
			// first upload consumes it.
			const form = new FormData();
			form.append(
				"file",
				new File([request.audio], request.fileName?.trim() || "audio", { type: request.mimeType }),
			);
			const attempt = await fetchImpl(transcribeUrl(model), {
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

	const body: unknown = await response.json();
	const parsed = codexResponseSchema(body);
	if (parsed instanceof type.errors) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response is malformed: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	// The subscription funds the request and the route reports no usage: bill
	// zero rather than inventing token counts.
	return {
		text: parsed.text,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
