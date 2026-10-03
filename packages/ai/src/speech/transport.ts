import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { SPEECH_FORMAT_MIME_TYPES, type SpeechFormat, type SpeechOptions, type SpeechResult } from "./types";

const SPEECH_TIMEOUT_MS = 60_000;

export class SpeechApiError extends AIError.ProviderHttpError {
	override readonly name = "SpeechApiError";
}

export async function postSpeechRequest(
	model: Model<Api>,
	path: string,
	payload: Record<string, unknown>,
	format: SpeechFormat,
	options: SpeechOptions,
): Promise<SpeechResult> {
	const timeoutSignal = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const fetchImpl = options.fetch ?? fetch;
	const label = `${model.provider}/${model.id}`;
	const audio = await withAuth(
		options.apiKey,
		async key => {
			const configuredHeaders = model.resolveHeaders ? await model.resolveHeaders(signal) : model.headers;
			const response = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}${path}`, {
				method: "POST",
				headers: {
					...configuredHeaders,
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(payload),
				signal,
			});
			if (!response.ok) {
				const detail = await response.text();
				throw new SpeechApiError(
					`${label} speech API failed (${response.status}): ${detail.slice(0, 300)}`,
					response.status,
					{
						headers: response.headers,
					},
				);
			}
			return new Uint8Array(await response.arrayBuffer());
		},
		{ signal },
	);
	// Speech endpoints return only audio bytes. OpenRouter exposes a generation id,
	// but neither it nor the OpenAI/xAI wires report token or billable-unit usage.
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return { audio, mimeType: SPEECH_FORMAT_MIME_TYPES[format], usage };
}
