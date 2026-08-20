import { type ApiKey, getOpenRouterHeaders, withAuth } from "@pk-nerdsaver-ai/pi-ai";
import { ProviderHttpError } from "@pk-nerdsaver-ai/pi-ai/error";
import { hostMatchesUrl } from "@pk-nerdsaver-ai/pi-catalog/hosts";
import { $env, extractHttpStatusFromError, fetchWithRetry, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { MnemopiRerankerProvider, MnemopiRerankScore } from "./runtime-options";
import { getMnemopiRuntimeOptions, mnemopiDebugEnabled } from "./runtime-options";

export type { MnemopiRerankerProvider, MnemopiRerankScore } from "./runtime-options";

export const DEFAULT_RERANKER_MODEL = "qwen/qwen3-reranker-8b";

let providerOverride: MnemopiRerankerProvider | null = null;

function activeRerankerOptions() {
	return getMnemopiRuntimeOptions()?.reranker;
}

function rerankerApiKey(): ApiKey {
	const active = activeRerankerOptions();
	if (active?.apiKey !== undefined) return active.apiKey;
	return $env.MNEMOPI_RERANKER_API_KEY || $env.OPENROUTER_API_KEY || $env.OPENAI_API_KEY || "";
}

function rerankerBaseUrl(): string {
	const active = activeRerankerOptions();
	if (active?.apiUrl !== undefined) return active.apiUrl;
	return $env.MNEMOPI_RERANKER_API_URL || $env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
}

function rerankerModel(): string {
	const active = activeRerankerOptions();
	if (active?.model !== undefined) return active.model;
	return $env.MNEMOPI_RERANKER_MODEL || DEFAULT_RERANKER_MODEL;
}

function keyConfigured(key: ApiKey): boolean {
	return typeof key === "function" || key !== "";
}

function parseScores(value: unknown, documentCount: number): MnemopiRerankScore[] | null {
	if (!Array.isArray(value)) return null;
	const scores: MnemopiRerankScore[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || !("index" in entry)) continue;
		const index = typeof entry.index === "number" ? entry.index : Number(entry.index);
		const rawScore =
			"relevance_score" in entry
				? entry.relevance_score
				: "relevanceScore" in entry
					? entry.relevanceScore
					: "score" in entry
						? entry.score
						: undefined;
		const relevanceScore = typeof rawScore === "number" ? rawScore : Number(rawScore);
		if (!Number.isInteger(index) || index < 0 || index >= documentCount || !Number.isFinite(relevanceScore)) continue;
		if (scores.some(score => score.index === index)) continue;
		scores.push({ index, relevanceScore });
	}
	return scores.length > 0 ? scores : null;
}

async function apiRerank(query: string, documents: readonly string[]): Promise<readonly MnemopiRerankScore[] | null> {
	const baseUrl = rerankerBaseUrl();
	const apiKey = rerankerApiKey();
	if (!hostMatchesUrl(baseUrl, "openrouter") && !keyConfigured(apiKey)) return null;
	const body = JSON.stringify({ model: rerankerModel(), query, documents });
	try {
		const response = await withAuth(apiKey, async key => {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				...getOpenRouterHeaders(),
			};
			if (key !== "") headers.Authorization = `Bearer ${key}`;
			const result = await fetchWithRetry(`${baseUrl.replace(/\/+$/, "")}/rerank`, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(30000),
				maxAttempts: 3,
				defaultDelayMs: attempt => 2 ** attempt * 1000,
			});
			if (result.status === 401) {
				throw new ProviderHttpError("mnemopi reranker request unauthorized (401)", 401, {
					headers: result.headers,
				});
			}
			return result;
		});
		if (!response.ok) return null;
		const payload: unknown = await response.json();
		if (typeof payload !== "object" || payload === null || !("results" in payload)) return null;
		return parseScores(payload.results, documents.length);
	} catch (error) {
		logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi reranker request failed", {
			status: extractHttpStatusFromError(error),
		});
		return null;
	}
}

async function providerAvailable(provider: MnemopiRerankerProvider): Promise<boolean> {
	if (provider.available === undefined) return true;
	try {
		return await provider.available();
	} catch {
		return false;
	}
}

export function setRerankerProviderForTests(provider: MnemopiRerankerProvider | null | undefined): void {
	providerOverride = provider ?? null;
}

export const setRerankerProvider = setRerankerProviderForTests;

export function resetRerankerProviderForTests(): void {
	providerOverride = null;
}

export const resetRerankerStateForTests = resetRerankerProviderForTests;

function currentProvider(): MnemopiRerankerProvider | null {
	return providerOverride ?? activeRerankerOptions()?.provider ?? null;
}

export async function available(): Promise<boolean> {
	const options = activeRerankerOptions();
	if (options?.disabled === true) return false;
	const provider = currentProvider();
	if (provider !== null) return providerAvailable(provider);
	return keyConfigured(rerankerApiKey());
}

export async function rerank(
	query: string,
	documents: readonly string[],
): Promise<readonly MnemopiRerankScore[] | null> {
	if (documents.length === 0 || query.trim().length === 0) return null;
	if (activeRerankerOptions()?.disabled === true) return null;
	const provider = currentProvider();
	if (provider !== null) {
		if (!(await providerAvailable(provider))) return null;
		try {
			return parseScores(await provider.rerank(query, documents), documents.length);
		} catch (error) {
			logger[mnemopiDebugEnabled() ? "warn" : "debug"]("mnemopi reranker provider failed", { error: String(error) });
			return null;
		}
	}
	return await apiRerank(query, documents);
}

export function currentRerankerModel(): string {
	return rerankerModel();
}
