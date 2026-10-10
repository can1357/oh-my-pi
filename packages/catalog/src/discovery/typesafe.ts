import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch, isRecord } from "../utils";

/** Public TypeSafe API root shared by discovery and judgment requests. */
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** Wire card returned by TypeSafe's authenticated `GET /v1/models`. */
export interface TypeSafeModelCard {
	name: string;
	description: string;
	release_date: string;
}

/** Credentials and transport overrides for TypeSafe account model discovery. */
export interface FetchTypeSafeModelsOptions {
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

function parseModelCard(value: unknown): TypeSafeModelCard | null {
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

/** Validate and de-duplicate the official `{ models: [...] }` response. */
export function parseTypeSafeModelCards(payload: unknown): TypeSafeModelCard[] | null {
	if (!isRecord(payload) || !Array.isArray(payload.models)) return null;
	const cards: TypeSafeModelCard[] = [];
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
 * Fetch TypeSafe's account-visible judge models.
 *
 * Returns `null` for transport, HTTP, or envelope failures. A valid empty
 * roster returns `[]`, allowing the model manager to distinguish it from an
 * unavailable discovery endpoint.
 */
export async function fetchTypeSafeModels(
	options: FetchTypeSafeModelsOptions,
): Promise<ModelSpec<"typesafe">[] | null> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL);
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
	const cards = parseTypeSafeModelCards(payload);
	if (cards === null) return null;

	const models: ModelSpec<"typesafe">[] = [];
	for (const card of cards) {
		models.push({
			id: card.name,
			name: card.description || card.name,
			api: "typesafe",
			provider: "typesafe",
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
