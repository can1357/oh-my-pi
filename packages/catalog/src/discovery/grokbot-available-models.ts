/**
 * Grok Bot `AiService/AvailableModels` request/response helpers.
 *
 * Transport is Connect JSON unary (sand client) — same host as InferenceService,
 * not Cursor `GetUsableModels` / CLI client-type.
 */
export const GROKBOT_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

/** Request body matching the live sand / Cursor IDE parameterized catalog. */
export type GrokbotAvailableModelsRequest = {
	useModelParameters?: boolean;
	includeLongContextModels?: boolean;
	useCloudAgentEffortModes?: boolean;
};

export type GrokbotAvailableModelParameterDefinition = {
	id: string;
	values?: readonly { value?: string; displayName?: string }[];
};

export type GrokbotAvailableModelParameterValue = {
	id: string;
	value: string;
};

export type GrokbotAvailableModelVariant = {
	parameterValues?: readonly GrokbotAvailableModelParameterValue[];
	displayName?: string;
	isDefaultMaxConfig?: boolean;
	isDefaultNonMaxConfig?: boolean;
	variantStringRepresentation?: string;
	legacySlug?: string;
};

export type GrokbotAvailableModel = {
	name: string;
	clientDisplayName?: string;
	serverModelName?: string;
	supportsThinking?: boolean;
	supportsImages?: boolean;
	supportsMaxMode?: boolean;
	supportsNonMaxMode?: boolean;
	contextTokenLimit?: number;
	contextTokenLimitForMaxMode?: number;
	idAliases?: readonly string[];
	legacySlugs?: readonly string[];
	parameterDefinitions?: readonly GrokbotAvailableModelParameterDefinition[];
	variants?: readonly GrokbotAvailableModelVariant[];
	isHidden?: boolean;
	defaultOn?: boolean;
};

export type GrokbotAvailableModelsResponse = {
	models?: readonly GrokbotAvailableModel[];
};

export function encodeGrokbotAvailableModelsRequest(
	request: GrokbotAvailableModelsRequest = { useModelParameters: true },
): string {
	return JSON.stringify(request);
}

/**
 * Decode an AvailableModels JSON body.
 *
 * Returns `null` when the envelope is missing a `models` array (e.g. proxy
 * `{ "error": ... }` with HTTP 200) so callers do not cache a routers-only
 * catalog. A genuine empty catalog is `{ "models": [] }` → `[]`.
 */
export function decodeGrokbotAvailableModelsResponse(raw: unknown): GrokbotAvailableModel[] | null {
	if (!raw || typeof raw !== "object") return null;
	const models = (raw as GrokbotAvailableModelsResponse).models;
	if (!Array.isArray(models)) return null;
	const out: GrokbotAvailableModel[] = [];
	for (const entry of models) {
		if (!entry || typeof entry !== "object") continue;
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (!name) continue;
		out.push(entry as GrokbotAvailableModel);
	}
	return out;
}
