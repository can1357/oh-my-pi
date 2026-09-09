import { fetchWithRetry } from "@oh-my-pi/pi-utils";
import { compareRevision, parseRevision } from "../compat/revision";
import { classifyModel } from "../compat/taxonomy";
import { Effort } from "../effort";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec, ThinkingConfig } from "../types";
import { discoveryFetch } from "../utils";
import { createBundledReferenceMap, createReferenceResolver } from "./bundled-references";

export interface OllamaCloudModelManagerConfig {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

type OllamaTagEntry = {
	name?: string;
	model?: string;
};

type OllamaShowResponse = {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
};

const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
/**
 * Output-token ceiling that Ollama Cloud enforces for the DeepSeek V4 Pro/Flash
 * deployments: `/api/chat` rejects `num_predict` above it with HTTP 400
 * (`max_tokens (...) exceeds model's maximum output tokens (65536)`) even though
 * the model pages advertise a 1M context / 384K output. Ollama's `/api/show`
 * never reports this cap, so the catalog pins it for the affected models
 * (ollama/ollama#16890, #7266). The wire layer clamps `num_predict` to the same
 * value (`OLLAMA_CLOUD_NUM_PREDICT_CAP` in `packages/ai/src/providers/ollama.ts`,
 * #3392/#3394).
 */
export const OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536;

/**
 * Untagged base ids whose Ollama Cloud deployment enforces
 * {@link OLLAMA_CLOUD_MAX_OUTPUT_TOKENS}. Only DeepSeek V4 Pro/Flash are known
 * to cap output below their advertised window (ollama/ollama#16890); other cloud
 * models keep their discovered limits.
 */
const OLLAMA_CLOUD_OUTPUT_CAPPED_BASE_IDS: Record<string, true> = {
	"deepseek-v4-flash": true,
	"deepseek-v4-pro": true,
};

/** Whether an Ollama Cloud model id (tagged or not) enforces the 65536 output cap. */
export function isOllamaCloudOutputCapped(id: string): boolean {
	const separator = id.indexOf(":");
	const baseId = separator > 0 ? id.slice(0, separator) : id;
	return OLLAMA_CLOUD_OUTPUT_CAPPED_BASE_IDS[baseId] === true;
}

const OLLAMA_CLOUD_GLM_52_THINKING: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.Max],
};

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function normalizeOllamaCloudBaseUrl(baseUrl?: string): string {
	const value = baseUrl?.trim();
	if (!value) {
		return "https://ollama.com";
	}
	const trimmed = trimTrailingSlash(value);
	return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function createCloudHeaders(apiKey: string): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
}

function getContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) {
		return undefined;
	}
	for (const [key, value] of Object.entries(modelInfo)) {
		if (typeof value !== "number") {
			continue;
		}
		if (key.endsWith(".context_length") || key.endsWith(".num_ctx") || key.endsWith(".context_window")) {
			return value;
		}
	}
}

function getThinkingConfig(modelId: string, capabilities: string[] | undefined): ThinkingConfig | undefined {
	if (!capabilities?.includes("thinking")) {
		return undefined;
	}
	const identity = classifyModel("ollama-cloud", modelId, { lenient: true });
	const revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
	const floor = parseRevision(identity.family === "flash" ? "5.3" : "5.2");
	const isGlmEffortModel =
		identity.class === "glm" &&
		(identity.family === undefined ||
			identity.family === "air" ||
			identity.family === "turbo" ||
			identity.family === "flash") &&
		revision !== undefined &&
		floor !== undefined &&
		compareRevision(revision, floor) >= 0;
	if (isGlmEffortModel) {
		return OLLAMA_CLOUD_GLM_52_THINKING;
	}
	return { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] };
}
async function fetchShowMetadata(
	baseUrl: string,
	apiKey: string,
	model: string,
	fetchImpl: FetchImpl = discoveryFetch(),
): Promise<OllamaShowResponse | undefined> {
	const response = await fetchImpl(`${baseUrl}/api/show`, {
		method: "POST",
		headers: {
			...createCloudHeaders(apiKey),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model }),
	});
	if (!response.ok) {
		return undefined;
	}
	return (await response.json()) as OllamaShowResponse;
}

export function ollamaCloudModelManagerOptions(
	config?: OllamaCloudModelManagerConfig,
): ModelManagerOptions<"ollama-chat"> {
	const apiKey = config?.apiKey;
	const baseUrl = normalizeOllamaCloudBaseUrl(config?.baseUrl);
	let providerReferences: Map<string, ModelSpec<"ollama-chat">> | undefined;
	const getProviderReferences = () =>
		(providerReferences ??= createBundledReferenceMap<"ollama-chat">("ollama-cloud"));
	const resolveReference = createReferenceResolver(getProviderReferences);
	return {
		providerId: "ollama-cloud",
		fetchDynamicModels: async () => {
			if (!apiKey) {
				return [];
			}
			const response = await fetchWithRetry(`${baseUrl}/api/tags`, {
				method: "GET",
				headers: createCloudHeaders(apiKey),
				fetch: discoveryFetch(config?.fetch),
				defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} from ${baseUrl}/api/tags`);
			}
			const payload = (await response.json()) as { models?: OllamaTagEntry[] };
			const entries = payload.models ?? [];
			const models = await Promise.all(
				entries.map(async entry => {
					const id = entry.model ?? entry.name;
					if (!id) {
						return undefined;
					}
					const reference = resolveReference(id);
					const providerReference = getProviderReferences().get(id);
					let metadata: OllamaShowResponse | undefined;
					try {
						metadata = await fetchShowMetadata(baseUrl, apiKey, id, config?.fetch);
					} catch {
						metadata = undefined;
					}
					const capabilities = metadata?.capabilities;
					const discoveredContextWindow = getContextWindow(metadata?.model_info);
					// `/api/show` reports the context length but never a per-model output
					// cap. DeepSeek V4 Pro/Flash deployments enforce a 65536 output ceiling
					// (ollama/ollama#16890, #7266); every other id keeps the trusted
					// reference limit, falling back to the historical safe cap otherwise.
					const contextWindow = discoveredContextWindow ?? 128000;
					const reasoning = capabilities ? capabilities.includes("thinking") : (reference?.reasoning ?? false);
					const thinking = capabilities ? getThinkingConfig(id, capabilities) : reference?.thinking;
					const input = capabilities
						? capabilities.includes("vision")
							? (["text", "image"] as Array<"text" | "image">)
							: (["text"] as Array<"text">)
						: ((reference?.input as Array<"text" | "image"> | undefined) ?? (["text"] as Array<"text">));
					const resolvedName = entry.name && entry.name !== id ? entry.name : (reference?.name ?? id);
					return {
						id,
						name: resolvedName,
						api: "ollama-chat" as const,
						provider: "ollama-cloud" as const,
						baseUrl,
						reasoning,
						thinking,
						input,
						cost: reference?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow,
						maxTokens: isOllamaCloudOutputCapped(id)
							? Math.min(contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)
							: discoveredContextWindow !== null && discoveredContextWindow !== undefined
								? (providerReference?.maxTokens ?? Math.min(contextWindow, 8192))
								: Math.min(contextWindow, 8192),
						omitMaxOutputTokens: true,
					};
				}),
			);
			return models
				.filter((model): model is NonNullable<(typeof models)[number]> => model !== undefined)
				.sort((left, right) => left.id.localeCompare(right.id));
		},
	};
}
