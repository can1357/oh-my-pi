/**
 * Catalog half of the pi-native auth-gateway protocol: `GET /v1/pi/models`.
 *
 * A gateway serves every model it can route as a {@link PiNativeModelSpec}:
 * the facts a client acts on locally (identity, limits, thinking ladder,
 * pricing). Routing state stays on the gateway: base URLs, headers, account
 * entitlements and provider wire profiles never cross the wire, so a client
 * learns no credential or account detail.
 *
 * A client whose provider rides `transport: "pi-native"` takes that provider's
 * roster from here ({@link fetchPiNativeModels}, wired by
 * `piNativeModelManagerOptions`), so models the gateway discovered at runtime
 * are selectable without being bundled in the client.
 */
import { toModelSpec } from "../provider-models/bundled-references";
import type { Api, FetchImpl, Model, ModelSpec } from "../types";
import { discoveryFetch, isRecord } from "../utils";

/** One routable model on the `/v1/pi/models` wire. */
export type PiNativeModelSpec = Pick<
	ModelSpec<Api>,
	| "id"
	| "name"
	| "kind"
	| "api"
	| "provider"
	| "reasoning"
	| "thinking"
	| "input"
	| "contextWindow"
	| "maxContextWindow"
	| "contextWindowAuthoritative"
	| "maxTokens"
	| "cost"
	| "pricingStatus"
	| "premiumMultiplier"
	| "supportsTools"
	| "serviceTiers"
	| "priority"
	| "description"
	| "isNew"
	| "isBeta"
	| "isRecommended"
>;

/** `GET /v1/pi/models` response body. */
export interface PiNativeModelsResponse {
	models: PiNativeModelSpec[];
}

/** The {@link PiNativeModelSpec} fields of `spec`; both ends drop everything else. */
function pickPiNativeSpec(spec: PiNativeModelSpec): PiNativeModelSpec {
	return {
		id: spec.id,
		name: spec.name,
		kind: spec.kind,
		api: spec.api,
		provider: spec.provider,
		reasoning: spec.reasoning,
		thinking: spec.thinking,
		input: spec.input,
		contextWindow: spec.contextWindow,
		maxContextWindow: spec.maxContextWindow,
		contextWindowAuthoritative: spec.contextWindowAuthoritative,
		maxTokens: spec.maxTokens,
		cost: spec.cost,
		pricingStatus: spec.pricingStatus,
		premiumMultiplier: spec.premiumMultiplier,
		supportsTools: spec.supportsTools,
		serviceTiers: spec.serviceTiers,
		priority: spec.priority,
		description: spec.description,
		isNew: spec.isNew,
		isBeta: spec.isBeta,
		isRecommended: spec.isRecommended,
	};
}

/**
 * Project a gateway-served model onto the `/v1/pi/models` wire. Goes through
 * {@link toModelSpec}, so unverified thinking never reaches a client as
 * reasoning capability.
 */
export function toPiNativeModelSpec(model: Model<Api>): PiNativeModelSpec {
	return pickPiNativeSpec(toModelSpec(model));
}

/** Where and as whom to read one provider's roster from a gateway. */
export interface PiNativeModelDiscoveryOptions {
	/** Provider whose rows to keep; the gateway lists every provider it routes. */
	providerId: string;
	/** Gateway root: the `baseUrl` the provider's `/v1/pi/stream` requests post to. */
	baseUrl: string;
	/** Gateway bearer; omitted for a gateway serving without auth. */
	apiKey?: string;
	fetch?: FetchImpl;
}

/**
 * Read `providerId`'s roster from a gateway's `GET /v1/pi/models`, as specs
 * routed at the gateway.
 *
 * Returns `null` when the gateway predates the route (404): the provider then
 * keeps its bundled roster. Malformed rows are skipped.
 *
 * @throws when the request fails, the gateway answers any other non-2xx
 * status (e.g. 401 for a wrong bearer), or the body is not a model list.
 */
export async function fetchPiNativeModels(options: PiNativeModelDiscoveryOptions): Promise<ModelSpec<Api>[] | null> {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const url = `${baseUrl}/v1/pi/models`;
	const response = await discoveryFetch(options.fetch)(url, {
		headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`auth-gateway answered ${response.status} for ${url}`);
	const payload: unknown = await response.json();
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		throw new Error(`auth-gateway sent no model list from ${url}`);
	}
	const models: ModelSpec<Api>[] = [];
	for (const row of payload.models) {
		if (
			row?.provider !== options.providerId ||
			typeof row.id !== "string" ||
			typeof row.name !== "string" ||
			typeof row.api !== "string" ||
			!Array.isArray(row.input) ||
			typeof row.cost !== "object" ||
			row.cost === null
		) {
			continue;
		}
		models.push({ ...pickPiNativeSpec(row), baseUrl });
	}
	return models;
}
