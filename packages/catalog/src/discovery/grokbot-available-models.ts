/**
 * Grok Bot rich catalog and optional account wire-roster helpers.
 *
 * Transport is Connect JSON unary (sand client) — same host as InferenceService,
 * The roster uses GetUsableModels with the same Sand account/client metadata.
 */
export const GROKBOT_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
export const GROKBOT_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

/** Account-advertised wire identifiers, not evidence that a Stream request succeeded. */
export function decodeGrokbotUsableModelIds(raw: unknown): Set<string> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const rows = (raw as { models?: unknown }).models;
	if (!Array.isArray(rows)) return undefined;
	const ids = new Set<string>();
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const record = row as { modelId?: unknown; model_id?: unknown };
		const id = record.modelId ?? record.model_id;
		if (typeof id === "string" && id.trim()) ids.add(id.trim());
	}
	return rows.length > 0 && ids.size === 0 ? undefined : ids;
}

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
	return models.length > 0 && out.length === 0 ? null : out;
}
