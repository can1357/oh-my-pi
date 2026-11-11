import { type ApiKey, getOpenRouterHeaders, postRerankRequest } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import { logger, withLoopPhase } from "@oh-my-pi/pi-utils";
import { combineSignals } from "@oh-my-pi/pi-utils/ptree";
import { rerankApiKey, rerankApiUrl, rerankCandidates, rerankModel, rerankScoreMode } from "../config";

export interface Reranker {
	readonly candidates: number;
	score(query: string, documents: readonly string[], signal?: AbortSignal): Promise<RerankCandidateScore[] | null>;
}

export interface RerankerConfig {
	apiUrl?: string;
	model?: string;
	apiKey?: ApiKey;
	scoreMode?: "auto" | "logit" | "probability";
	candidates?: number;
	fn?: RerankFunction;
}

/** Resolve endpoint credentials and validate a complete score set in one place. */
export function createReranker(config: RerankerConfig = {}): Reranker | undefined {
	const apiUrl = config.apiUrl ?? rerankApiUrl();
	const fn = config.fn;
	if (!apiUrl && !fn) return undefined;
	const apiKey = config.apiKey ?? rerankApiKey(apiUrl);
	const model = config.model ?? rerankModel();
	const scoreMode = config.scoreMode ?? rerankScoreMode();
	const candidates = Math.max(1, Math.floor(config.candidates ?? rerankCandidates()));
	return {
		candidates,
		async score(query, documents, signal) {
			try {
				const scores = fn
					? await fn(query, documents)
					: await executeRerank(query, documents, { apiUrl: apiUrl!, apiKey, model, scoreMode, signal });
				if (!scores || scores.length !== documents.length) return null;
				const seen = new Set<number>();
				for (const item of scores) {
					if (
						!Number.isInteger(item.index) ||
						item.index < 0 ||
						item.index >= documents.length ||
						!Number.isFinite(item.relevanceScore) ||
						seen.has(item.index)
					)
						return null;
					seen.add(item.index);
				}
				return scores;
			} catch (error) {
				logger.warn("mnemopi: cross-encoder rerank invocation failed; using first-stage order", {
					error: String(error),
				});
				return null;
			}
		},
	};
}

export interface RerankCandidateScore {
	readonly index: number;
	readonly relevanceScore: number;
}

export type RerankFunction = (query: string, documents: readonly string[]) => Promise<RerankCandidateScore[] | null>;

export interface RerankExecutionOptions {
	apiUrl: string;
	model?: string;
	scoreMode?: "auto" | "logit" | "probability";
	apiKey?: ApiKey;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxAttempts?: number;
}

/**
 * Execute a cross-encoder rerank call against an external HTTP endpoint.
 *
 * Supports both OpenAI/OpenRouter/Cohere shape:
 *   POST /rerank with { model, query, documents, top_n, return_documents: false }
 *   -> { results: [{ index, relevance_score }] }
 * and Text Embeddings Inference (TEI) shape:
 *   POST /rerank with { query, texts }
 *   -> [{ index, score }]
 *
 * Returns scored indices or null if the request failed or timed out.
 */
export async function executeRerank(
	query: string,
	documents: readonly string[],
	options: RerankExecutionOptions,
): Promise<RerankCandidateScore[] | null> {
	if (documents.length === 0) return [];
	const baseUrl = options.apiUrl.trim();
	if (!baseUrl) return null;

	const cleanBase = baseUrl.replace(/\/+$/, "");
	const targetUrl = cleanBase.endsWith("/rerank") ? cleanBase : `${cleanBase}/rerank`;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const signal = combineSignals(options.signal, timeoutMs);
	const body = JSON.stringify({
		model: options.model ?? "default",
		query,
		documents,
		texts: documents,
		top_n: documents.length,
		return_documents: false,
	});

	try {
		const apiKey = options.apiKey ?? "";
		const response = await postRerankRequest(targetUrl, body, {
			apiKey,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...(hostMatchesUrl(baseUrl, "openrouter") ? getOpenRouterHeaders() : {}),
			},
			signal,
			maxAttempts: options.maxAttempts ?? 3,
			defaultDelayMs: options.maxAttempts !== undefined ? () => 100 : attempt => 2 ** attempt * 1000,
			onHttpError: async response => {
				const detail = (await response.text().catch(() => "")).trim();
				return new ProviderHttpError(
					`mnemopi rerank request failed (${response.status}): ${detail || response.statusText}`,
					response.status,
					{ headers: response.headers },
				);
			},
		});

		const data = (await response.json()) as
			| { results?: Array<{ index: number; relevance_score?: number; score?: number }> }
			| Array<{ index: number; relevance_score?: number; score?: number }>;

		return withLoopPhase("mnemopi.rerank", () => {
			const list = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
			if (list.length === 0) return null;

			// Auto mode normalizes the whole response if any score falls outside probability range.
			const rawScores = list.map(item => Number(item.relevance_score ?? item.score));
			const scoreMode = options.scoreMode ?? rerankScoreMode();
			const useSigmoid =
				scoreMode === "logit" || (scoreMode === "auto" && rawScores.some(score => score < 0 || score > 1));

			return list.map((item, index) => {
				const rawScore = rawScores[index]!;
				const relevanceScore = useSigmoid && Number.isFinite(rawScore) ? 1 / (1 + Math.exp(-rawScore)) : rawScore;
				return {
					index: Number(item.index),
					relevanceScore,
				};
			});
		});
	} catch (error) {
		logger.debug("mnemopi rerank request threw", { error: String(error), url: targetUrl });
		return null;
	}
}
