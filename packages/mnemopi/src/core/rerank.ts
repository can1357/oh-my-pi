import { type ApiKey, getOpenRouterHeaders, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import { fetchWithRetry, logger, withLoopPhase } from "@oh-my-pi/pi-utils";
import { combineSignals } from "@oh-my-pi/pi-utils/ptree";

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

function isLogitRerankModel(model?: string): boolean {
	if (!model) return false;
	const lower = model.toLowerCase();
	return lower.includes("bge-") || lower.includes("bce-") || lower.includes("cross-encoder");
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
		const response = await withAuth(
			apiKey,
			async key => {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "application/json",
					...(hostMatchesUrl(baseUrl, "openrouter") ? getOpenRouterHeaders() : {}),
				};
				if (key && key !== "N/A") {
					headers.Authorization = `Bearer ${key}`;
				}
				const res = await fetchWithRetry(targetUrl, {
					method: "POST",
					headers,
					body,
					signal,
					maxAttempts: options.maxAttempts ?? 3,
					defaultDelayMs: options.maxAttempts !== undefined ? () => 100 : attempt => 2 ** attempt * 1000,
				});
				if (res.status === 401) {
					const detail = (await res.text().catch(() => "")).trim();
					throw new ProviderHttpError(detail || "mnemopi rerank request unauthorized (401)", 401, {
						headers: res.headers,
					});
				}
				return res;
			},
			{ signal },
		);
		if (!response.ok) {
			logger.warn("mnemopi rerank request failed", {
				status: response.status,
				url: targetUrl,
				model: options.model,
			});
			return null;
		}

		const data = (await response.json()) as
			| { results?: Array<{ index: number; relevance_score?: number; score?: number }> }
			| Array<{ index: number; relevance_score?: number; score?: number }>;

		return withLoopPhase("mnemopi.rerank", () => {
			const list = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : [];
			if (list.length === 0) return null;
			const valid = list.filter(item => {
				const idx = Number(item.index);
				const score = Number(item.relevance_score ?? item.score);
				return Number.isInteger(idx) && idx >= 0 && idx < documents.length && Number.isFinite(score);
			});
			// Reject duplicate or incomplete indices to avoid mixing incompatible scoring scales.
			const uniqueIndices = new Set(valid.map(item => Number(item.index)));
			if (valid.length !== documents.length || uniqueIndices.size !== documents.length) {
				logger.warn(
					"mnemopi: reranker returned incomplete or duplicate scores; falling back to first-stage order",
					{
						expected: documents.length,
						received: valid.length,
						unique: uniqueIndices.size,
					},
				);
				return null;
			}

			// Use an explicit consistent scoring mode: models known to emit raw unbounded
			// logits (e.g. BGE, BCE) or configured as such always map through logistic sigmoid,
			// ensuring scores from different banks (such as singletons) remain strictly comparable.
			const useSigmoid =
				options.scoreMode === "logit" || (options.scoreMode !== "probability" && isLogitRerankModel(options.model));

			return valid.map(item => {
				const rawScore = Number(item.relevance_score ?? item.score);
				const relevanceScore = useSigmoid ? 1 / (1 + Math.exp(-rawScore)) : rawScore;
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
