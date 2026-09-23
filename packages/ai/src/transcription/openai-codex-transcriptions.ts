import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import {
	applyCodexResidencyHeader,
	getCodexAccountId,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	URL_PATHS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { type } from "@oh-my-pi/omptype";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getCodexAttestationHeader } from "../providers/openai-codex-attestation";
import { responseError, type TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

/**
 * Batch transcription through the Codex subscription backend. The
 * `/transcribe` endpoint is undocumented: it accepts a multipart audio
 * upload authenticated with ChatGPT-OAuth plus the OMP originator headers,
 * and answers `{ "text": … }`.
 * Subscription-billed, so the result reports zero usage.
 */

const upstreamResponseSchema = type({
	text: "string",
});

function decodeUsage(): { usage: Usage } {
	return {
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

async function buildCodexHeaders(key: string): Promise<Record<string, string>> {
	const accountId = getCodexAccountId(key);
	const attestation = accountId ? await getCodexAttestationHeader(accountId) : undefined;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${key}`,
		Accept: "application/json",
		[OPENAI_HEADERS.BETA]: OPENAI_HEADER_VALUES.BETA_RESPONSES,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		"User-Agent": USER_AGENT,
		...(accountId && { [OPENAI_HEADERS.ACCOUNT_ID]: accountId }),
		...(attestation && { [OPENAI_HEADERS.ATTESTATION]: attestation }),
	};
	applyCodexResidencyHeader(headers, key);
	return headers;
}

/** Call the Codex `/transcribe` endpoint on an OpenAI/OpenRouter-compatible multipart shape. */
export async function transcribeOpenAICodex(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const form = new FormData();
	const fileName = request.fileName?.trim() || "codex.wav";
	form.append("file", new File([request.audio], fileName, { type: request.mimeType }));

	const language = request.language?.trim();
	if (language) form.append("language", language);

	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const attempt = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}${URL_PATHS.TRANSCRIBE}`, {
				method: "POST",
				headers: await buildCodexHeaders(key),
				body: form,
				signal: options.signal,
			});
			if (!attempt.ok) throw await responseError(attempt, model);
			return attempt;
		},
		{ signal: options.signal },
	);

	const body: unknown = await response.json();
	const parsed = upstreamResponseSchema(body);
	if (parsed instanceof type.errors) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} transcription response does not contain text: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	const decoded = decodeUsage();
	return {
		text: parsed.text,
		usage: decoded.usage,
	};
}
