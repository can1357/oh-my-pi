import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { type } from "@oh-my-pi/omptype";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { EmbeddingRequest, EmbeddingResult } from "./types";

export interface EmbeddingOptions {
	apiKey: ApiKey;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

/** Non-2xx response from an OpenAI-compatible embeddings endpoint. */
export class EmbeddingApiError extends AIError.ProviderHttpError {
	override readonly name = "EmbeddingApiError";
}

const upstreamResponseSchema = type({
	data: "object[]",
	model: "string",
	"usage?": "object",
});

interface UpstreamUsage {
	prompt_tokens?: unknown;
	total_tokens?: unknown;
	cost?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function decodeUsage(model: Model<Api>, raw: unknown): Usage {
	const upstream = raw && typeof raw === "object" ? (raw as UpstreamUsage) : {};
	const input = finiteNumber(upstream.prompt_tokens) ?? 0;
	const totalTokens = finiteNumber(upstream.total_tokens) ?? input;
	const reportedCost = finiteNumber(upstream.cost);
	const usage: Usage = {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		...(reportedCost !== undefined && { credits: { cost: reportedCost } }),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reportedCost ?? 0 },
	};
	if (reportedCost === undefined) calculateCost(model, usage);
	return usage;
}

function decodeEmbeddings(data: object[], model: Model<Api>): EmbeddingResult["embeddings"] {
	return data.map((raw, position) => {
		const index = Reflect.get(raw, "index");
		const embedding = Reflect.get(raw, "embedding");
		if (!Number.isInteger(index) || index < 0) {
			throw new AIError.ProviderResponseError(
				`${model.provider}/${model.id} embeddings response has an invalid index at data[${position}]`,
				{ provider: model.provider, kind: "envelope" },
			);
		}
		if (
			typeof embedding !== "string" &&
			(!Array.isArray(embedding) || !embedding.every(value => typeof value === "number" && Number.isFinite(value)))
		) {
			throw new AIError.ProviderResponseError(
				`${model.provider}/${model.id} embeddings response has an invalid vector at data[${position}]`,
				{ provider: model.provider, kind: "envelope" },
			);
		}
		return { index, embedding };
	});
}

async function responseError(response: Response, model: Model<Api>): Promise<EmbeddingApiError> {
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
	return new EmbeddingApiError(
		`${model.provider}/${model.id} embeddings API error (${response.status}): ${detail || response.statusText}`,
		response.status,
		{ headers: response.headers, code },
	);
}

/** Call an OpenAI/OpenRouter-compatible embeddings endpoint. */
export async function embedOpenAI(
	model: Model<Api>,
	request: EmbeddingRequest,
	options: EmbeddingOptions,
): Promise<EmbeddingResult> {
	const fetchImpl = options.fetch ?? fetch;
	const body = {
		model: model.id,
		input: request.input,
		encoding_format: request.encodingFormat,
		...(request.dimensions !== undefined && { dimensions: request.dimensions }),
		...(request.user !== undefined && { user: request.user }),
	};
	const response = await withAuth(
		options.apiKey,
		async key => {
			const attempt = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/embeddings`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: options.signal,
			});
			if (!attempt.ok) throw await responseError(attempt, model);
			return attempt;
		},
		{ signal: options.signal },
	);

	const raw: unknown = await response.json();
	const parsed = upstreamResponseSchema(raw);
	if (parsed instanceof type.errors) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} embeddings response is malformed: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	return {
		embeddings: decodeEmbeddings(parsed.data, model),
		model: parsed.model,
		usage: decodeUsage(model, parsed.usage),
	};
}
