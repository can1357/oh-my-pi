import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";
import type { ModelManagerConfig } from "./descriptor-types";

export const KENARI_BASE_URL = "https://kenari.id/v1";

/** Stand-in output cap. The public list has no max output. */
const KENARI_OUTPUT_CAP = 8192;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function kenariInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modalities = entry.modalities;
	const raw = isRecord(modalities) && Array.isArray(modalities.input) ? modalities.input : [];
	const input: ("text" | "image")[] = [];
	for (const item of raw) {
		if ((item === "text" || item === "image") && !input.includes(item)) input.push(item);
	}
	if (!input.includes("text")) input.unshift("text");
	return input;
}

function kenariModel(entry: unknown, baseUrl: string): ModelSpec<"openai-completions"> | undefined {
	if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return undefined;
	if (entry.id === "kenari/auto" || entry.tool_call !== true) return undefined;
	const contextWindow = positiveNumber(entry.context_length);
	if (contextWindow === undefined) return undefined;
	const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
	return {
		id: entry.id,
		name,
		api: "openai-completions",
		provider: "kenari",
		baseUrl,
		reasoning: entry.reasoning === true,
		input: kenariInput(entry),
		// pricing.* is micro-rupiah per 1M tokens. cost is USD per 1M. Leave it at 0.
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens: Math.min(KENARI_OUTPUT_CAP, contextWindow),
	};
}

/** Map a `GET /v1/models` body. Null when the body is not a model list. */
export function kenariModelsFromPayload(
	payload: unknown,
	baseUrl: string = KENARI_BASE_URL,
): ModelSpec<"openai-completions">[] | null {
	if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
	const models: ModelSpec<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const entry of payload.data) {
		const model = kenariModel(entry, baseUrl);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	models.sort((left, right) => left.id.localeCompare(right.id));
	return models;
}

export function kenariModelManagerOptions(config?: ModelManagerConfig): ModelManagerOptions<"openai-completions"> {
	const baseUrl = (config?.baseUrl ?? KENARI_BASE_URL).replace(/\/$/, "");
	const fetchImpl: FetchImpl = config?.fetch ?? fetch;
	return {
		providerId: "kenari",
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: async () => {
			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}/models`, {
					headers: { Accept: "application/json" },
				});
			} catch {
				return null;
			}
			if (!response.ok) return null;
			try {
				return kenariModelsFromPayload(await response.json(), baseUrl);
			} catch {
				return null;
			}
		},
	};
}
