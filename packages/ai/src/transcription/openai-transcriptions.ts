import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { type } from "@oh-my-pi/omptype";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { TranscriptionRequest, TranscriptionResult, TranscriptionSegment, TranscriptionWord } from "./types";

export interface TranscriptionOptions {
	apiKey: ApiKey;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

/** Non-2xx response from an OpenAI-compatible transcription endpoint. */
export class TranscriptionApiError extends AIError.ProviderHttpError {
	override readonly name = "TranscriptionApiError";
}

const upstreamResponseSchema = type({
	text: "string",
	"language?": "string",
	"duration?": "number",
	"segments?": "object[]",
	"words?": "object[]",
	"usage?": "object",
});

interface UpstreamUsage {
	input_tokens?: unknown;
	output_tokens?: unknown;
	total_tokens?: unknown;
	cost?: unknown;
	seconds?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function decodeUsage(model: Model<Api>, raw: unknown): { usage: Usage; seconds?: number } {
	const upstream = raw && typeof raw === "object" ? (raw as UpstreamUsage) : {};
	const input = finiteNumber(upstream.input_tokens) ?? 0;
	const output = finiteNumber(upstream.output_tokens) ?? 0;
	const reportedTotal = finiteNumber(upstream.total_tokens);
	const reportedCost = finiteNumber(upstream.cost);
	const usage: Usage = {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: reportedTotal ?? input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reportedCost ?? 0 },
	};
	if (reportedCost === undefined) calculateCost(model, usage);
	return { usage, seconds: finiteNumber(upstream.seconds) };
}

async function responseError(response: Response, model: Model<Api>): Promise<TranscriptionApiError> {
	const text = await response.text();
	let detail = text;
	let code: string | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			const error = parsed.error;
			if (error && typeof error === "object") {
				const envelope = error as { message?: unknown; code?: unknown; type?: unknown };
				if (typeof envelope.message === "string") detail = envelope.message;
				if (typeof envelope.code === "string") code = envelope.code;
				else if (typeof envelope.type === "string") code = envelope.type;
			}
		}
	} catch {}
	return new TranscriptionApiError(
		`${model.provider}/${model.id} transcription API error (${response.status}): ${detail || response.statusText}`,
		response.status,
		{ headers: response.headers, code },
	);
}

/** Call an OpenAI/OpenRouter-compatible multipart transcription endpoint. */
export async function transcribeOpenAI(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	const form = new FormData();
	const fileName = request.fileName?.trim() || "audio";
	form.append("file", new File([request.audio], fileName, { type: request.mimeType }));
	form.append("model", model.id);
	form.append("response_format", request.responseFormat);
	if (request.language !== undefined) form.append("language", request.language);
	if (request.prompt !== undefined) form.append("prompt", request.prompt);
	if (request.temperature !== undefined) form.append("temperature", String(request.temperature));
	for (const granularity of request.timestampGranularities ?? []) {
		form.append("timestamp_granularities[]", granularity);
	}

	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const attempt = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
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
			`${model.provider}/${model.id} transcription response is malformed: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	const decoded = decodeUsage(model, parsed.usage);
	return {
		text: parsed.text,
		...(parsed.language !== undefined && { language: parsed.language }),
		...(parsed.duration !== undefined && { duration: parsed.duration }),
		...(parsed.segments !== undefined && { segments: parsed.segments as TranscriptionSegment[] }),
		...(parsed.words !== undefined && { words: parsed.words as TranscriptionWord[] }),
		...(decoded.seconds !== undefined && { seconds: decoded.seconds }),
		usage: decoded.usage,
	};
}
