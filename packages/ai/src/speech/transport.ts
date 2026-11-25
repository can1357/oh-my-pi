import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { SPEECH_FORMAT_MIME_TYPES, type SpeechFormat, type SpeechOptions, type SpeechResult } from "./types";

const SPEECH_TIMEOUT_MS = 60_000;

/** Status of a 2xx JSON error body that reports no 4xx/5xx status of its own: a bad gateway. */
const UNREPORTED_ERROR_BODY_STATUS = 502;

export class SpeechApiError extends AIError.ProviderHttpError {
	override readonly name = "SpeechApiError";
}

/**
 * The error a gateway reported in a 2xx body instead of audio (`{"error": ...}`),
 * or `undefined` when the body is not such an envelope. The status comes from a
 * numeric (or 3-digit string) `status`/`code` field in the 4xx/5xx range, else
 * {@link UNREPORTED_ERROR_BODY_STATUS}.
 */
function readSpeechErrorBody(label: string, body: Uint8Array, headers: Headers): SpeechApiError | undefined {
	let start = 0;
	while (
		start < body.length &&
		(body[start] === 0x20 || body[start] === 0x09 || body[start] === 0x0a || body[start] === 0x0d)
	) {
		start += 1;
	}
	if (body[start] !== 0x7b) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body.subarray(start)));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined;
	const envelope: { error: unknown; status?: unknown; code?: unknown } = parsed;
	const error = envelope.error;
	const fields: { message?: unknown; status?: unknown; code?: unknown } =
		typeof error === "object" && error !== null ? error : {};
	const detail =
		typeof error === "string" ? error : typeof fields.message === "string" ? fields.message : JSON.stringify(error);
	let status: number | undefined;
	let code: string | undefined;
	for (const value of [fields.status, fields.code, envelope.status, envelope.code]) {
		const numeric =
			typeof value === "number"
				? value
				: typeof value === "string" && /^\d{3}$/.test(value)
					? Number(value)
					: undefined;
		if (numeric !== undefined && numeric >= 400 && numeric < 600) {
			status ??= numeric;
		} else if (typeof value === "string" && value.length > 0) {
			code ??= value;
		}
	}
	return new SpeechApiError(
		`${label} speech API returned an error body: ${detail.slice(0, 300)}`,
		status ?? UNREPORTED_ERROR_BODY_STATUS,
		{ code, headers },
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
			const body = new Uint8Array(await response.arrayBuffer());
			const bodyError = readSpeechErrorBody(label, body, response.headers);
			if (bodyError) throw bodyError;
			return body;
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
