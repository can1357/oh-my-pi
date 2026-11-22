import type { FetchImpl, ModelSpec } from "../types";
import { fetchSystemOneModels, parseSystemOneModelCards, type SystemOneModelCard } from "./systemone";

/** Public TypeSafe API root shared by discovery and judgment requests. */
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** Wire card returned by TypeSafe's authenticated `GET /v1/models`. */
export type TypeSafeModelCard = SystemOneModelCard;

/** Credentials and transport overrides for TypeSafe account model discovery. */
export interface FetchTypeSafeModelsOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}

/** Validate and de-duplicate the official `{ models: [...] }` response. */
export function parseTypeSafeModelCards(payload: unknown): TypeSafeModelCard[] | null {
	return parseSystemOneModelCards(payload);
}

/**
 * Fetch TypeSafe's account-visible judge models.
 *
 * Returns `null` for transport, HTTP, or envelope failures. A valid empty
 * roster returns `[]`, allowing the model manager to distinguish it from an
 * unavailable discovery endpoint.
 */
export function fetchTypeSafeModels(options: FetchTypeSafeModelsOptions): Promise<ModelSpec<"typesafe">[] | null> {
	return fetchSystemOneModels({
		api: "typesafe",
		provider: "typesafe",
		defaultBaseUrl: TYPESAFE_DEFAULT_BASE_URL,
		...options,
	});
}
