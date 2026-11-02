import { type } from "@oh-my-pi/omptype";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Api, FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { RerankRequest, RerankResult } from "./types";

export interface RerankOptions {
	apiKey: ApiKey;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

/** Non-2xx response from an OpenRouter-compatible rerank endpoint. */
export class RerankApiError extends AIError.ProviderHttpError {
	override readonly name = "RerankApiError";
}

const upstreamResponseSchema = type({
	model: "string",
	results: type({
		index: "number",
		relevance_score: "number",
		"document?": "unknown",
	}).array(),
	"usage?": "object",
});

interface UpstreamUsage {
	total_tokens?: unknown;
	cost?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function decodeUsage(model: Model<Api>, raw: unknown): Usage {
	const upstream = raw && typeof raw === "object" ? (raw as UpstreamUsage) : {};
	const totalTokens = finiteNumber(upstream.total_tokens) ?? 0;
	const reportedCost = finiteNumber(upstream.cost);
	const usage: Usage = {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: reportedCost ?? 0 },
	};
	if (reportedCost === undefined) calculateCost(model, usage);
	return usage;
}

function documentText(document: unknown): string | undefined {
	if (typeof document === "string") return document;
	if (document === null || typeof document !== "object" || !("text" in document)) return undefined;
	return typeof document.text === "string" ? document.text : undefined;
}

async function responseError(response: Response, model: Model<Api>): Promise<RerankApiError> {
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
				if (typeof envelope.code === "string" || typeof envelope.code === "number") code = String(envelope.code);
				else if (typeof envelope.type === "string") code = envelope.type;
			}
		}
	} catch {}
	return new RerankApiError(
		`${model.provider}/${model.id} rerank API error (${response.status}): ${detail || response.statusText}`,
		response.status,
		{ headers: response.headers, code },
	);
}

/** Call an OpenRouter-compatible rerank endpoint. */
export async function rerankOpenRouter(
	model: Model<Api>,
	request: RerankRequest,
	options: RerankOptions,
): Promise<RerankResult> {
	const body = JSON.stringify({
		model: model.id,
		query: request.query,
		documents: request.documents,
		...(request.topN !== undefined && { top_n: request.topN }),
		...(request.returnDocuments !== undefined && { return_documents: request.returnDocuments }),
	});
	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const attempt = await fetchImpl(`${model.baseUrl.replace(/\/+$/, "")}/rerank`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body,
				signal: options.signal,
			});
			if (!attempt.ok) throw await responseError(attempt, model);
			return attempt;
		},
		{ signal: options.signal },
	);

	const payload: unknown = await response.json();
	const parsed = upstreamResponseSchema(payload);
	if (parsed instanceof type.errors) {
		throw new AIError.ProviderResponseError(
			`${model.provider}/${model.id} rerank response is malformed: ${parsed.summary}`,
			{ provider: model.provider, kind: "envelope" },
		);
	}
	return {
		model: parsed.model,
		results: parsed.results.map(result => {
			const document = documentText(result.document);
			return {
				index: result.index,
				relevanceScore: result.relevance_score,
				...(document !== undefined && { document }),
			};
		}),
		usage: decodeUsage(model, parsed.usage),
	};
}
