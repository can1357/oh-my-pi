import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { SPEECH_FORMAT_MIME_TYPES, type SpeechFormat, type SpeechOptions, type SpeechResult } from "./types";

const SPEECH_TIMEOUT_MS = 60_000;

/** Status of a 2xx JSON body that reports no 4xx/5xx status of its own: a bad gateway. */
const UNREPORTED_ERROR_BODY_STATUS = 502;

export class SpeechApiError extends AIError.ProviderHttpError {
	override readonly name = "SpeechApiError";
}

/**
 * Error for a 2xx response that carries JSON instead of audio: some gateways
 * report failures that way. The status is the 4xx/5xx `status`/`code` the body
 * reports (in `error` or at the top level), else {@link UNREPORTED_ERROR_BODY_STATUS}.
 */
function jsonBodyError(label: string, text: string, headers: Headers): SpeechApiError {
	let body: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
	} catch {}
	const error = typeof body.error === "object" && body.error !== null ? (body.error as Record<string, unknown>) : {};
	const status = [error.status, error.code, body.status, body.code]
		.map(Number)
		.find(value => Number.isInteger(value) && value >= 400 && value < 600);
	const detail =
		typeof body.error === "string" ? body.error : typeof error.message === "string" ? error.message : text;
	return new SpeechApiError(
		`${label} speech API returned an error body: ${detail.slice(0, 300)}`,
		status ?? UNREPORTED_ERROR_BODY_STATUS,
		{ headers },
	);
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
			if (response.headers.get("content-type")?.includes("json")) {
				throw jsonBodyError(label, await response.text(), response.headers);
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
