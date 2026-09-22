import type { Api, FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import {
	applyCodexResidencyHeader,
	getCodexAccountId,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	URL_PATHS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getCodexAttestationHeader } from "../providers/openai-codex-attestation";
import { responseError, type TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

/**
 * Batch transcription through the Codex subscription backend. The
 * `/transcribe` endpoint is undocumented: it accepts a bare multipart audio
 * upload (no `model`/`language` form fields) authenticated with ChatGPT-OAuth
 * plus the Codex Desktop originator headers, and answers `{ "text": … }`.
 * Subscription-billed, so the result reports zero usage.
 */

/** Hard ceiling for one buffered dictation upload. */
const REQUEST_TIMEOUT_MS = 90_000;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Call the Codex `/transcribe` endpoint on an OpenAI/OpenRouter-compatible multipart shape. */
export async function transcribeOpenAICodex(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const fileName = request.fileName?.trim() || "codex.wav";
	const boundary = `----codex-transcribe-${crypto.randomUUID()}`;
	const encoder = new TextEncoder();
	const header = encoder.encode(
		[
			`--${boundary}`,
			`Content-Disposition: form-data; name="file"; filename="${fileName}"`,
			`Content-Type: ${request.mimeType}`,
			"",
			"",
		].join("\r\n"),
	);
	const trailer = encoder.encode(`\r\n--${boundary}--\r\n`);
	const audio = new Uint8Array(request.audio);
	const body = new Uint8Array(header.byteLength + audio.byteLength + trailer.byteLength);
	body.set(header);
	body.set(audio, header.byteLength);
	body.set(trailer, header.byteLength + audio.byteLength);

	const url = `${model.baseUrl.replace(/\/+$/, "")}${URL_PATHS.TRANSCRIBE}`;
	const fetchImpl: FetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
				[OPENAI_HEADERS.BETA]: OPENAI_HEADER_VALUES.BETA_RESPONSES,
				[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.CODEX_DESKTOP.NAME,
				"User-Agent": OPENAI_HEADER_VALUES.CODEX_DESKTOP.USER_AGENT,
				"Content-Type": `multipart/form-data; boundary=${boundary}`,
				"Content-Length": String(body.byteLength),
			};
			const accountId = getCodexAccountId(key);
			if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
			applyCodexResidencyHeader(headers, key);
			const attestation = accountId ? await getCodexAttestationHeader(accountId) : undefined;
			if (attestation) headers[OPENAI_HEADERS.ATTESTATION] = attestation;
			const signal = options.signal
				? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
				: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const attempt = await fetchImpl(url, { method: "POST", headers, body, signal });
			if (!attempt.ok) throw await responseError(attempt, model);
			return attempt;
		},
		{ signal: options.signal },
	);

	const payload: unknown = await response.json();
	const text =
		payload && typeof payload === "object" && "text" in payload ? (payload as { text?: unknown }).text : undefined;
	if (typeof text !== "string") {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response does not contain text`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	return { text, usage: ZERO_USAGE };
}
