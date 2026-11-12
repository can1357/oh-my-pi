import type { Api, FetchImpl, ModelSpec, Provider } from "../types";
import { discoveryFetch, isRecord } from "../utils";

/** Public Nace API root shared by discovery and judgment requests. */
export const NACE_DEFAULT_BASE_URL = "https://console.nace.ai";

/** Wire card returned by System One `GET /v1/models` endpoints. */
export interface SystemOneModelCard {
	name: string;
	description: string;
	release_date: string;
}

/** Credentials, target metadata, and transport overrides for System One model discovery. */
export interface FetchSystemOneModelsOptions<TApi extends Api> {
	api: TApi;
	provider: Provider;
	defaultBaseUrl: string;
	apiKey: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

function normalizeBaseUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function parseModelCard(value: unknown): SystemOneModelCard | null {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		value.name.trim().length === 0 ||
		typeof value.description !== "string" ||
		typeof value.release_date !== "string"
	) {
		return null;
	}
	return {
		name: value.name.trim(),
		description: value.description.trim(),
		release_date: value.release_date,
	};
}

/** Validate and de-duplicate a `{ models: [...] }` System One discovery response. */
export function parseSystemOneModelCards(payload: unknown): SystemOneModelCard[] | null {
	if (!isRecord(payload) || !Array.isArray(payload.models)) return null;
	const cards: SystemOneModelCard[] = [];
	const seen = new Set<string>();
	for (const raw of payload.models) {
		const card = parseModelCard(raw);
		if (card === null) return null;
		if (seen.has(card.name)) continue;
		seen.add(card.name);
		cards.push(card);
	}
	return cards;
}

/**
 * Fetch account-visible System One judge models from `GET /v1/models`.
 *
 * Returns `null` for transport, HTTP, or envelope failures. A valid empty
 * roster returns `[]`, allowing the model manager to distinguish it from an
 * unavailable discovery endpoint.
 */
export async function fetchSystemOneModels<TApi extends Api>(
	options: FetchSystemOneModelsOptions<TApi>,
): Promise<ModelSpec<TApi>[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? options.defaultBaseUrl);
	if (baseUrl === null) return null;

	let response: Response;
	try {
		response = await discoveryFetch(options.fetch)(`${baseUrl}/v1/models`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			signal: options.signal,
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	const cards = parseSystemOneModelCards(payload);
	if (cards === null) return null;

	const models: ModelSpec<TApi>[] = [];
	for (const card of cards) {
		models.push({
			id: card.name,
			name: card.description || card.name,
			api: options.api,
			provider: options.provider,
			baseUrl,
			kind: "judge",
			reasoning: false,
			input: ["text"],
			supportsTools: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
	}
	return models;
}
