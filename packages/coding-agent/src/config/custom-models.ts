import type { Api, Model, ModelSpec, RemoteCompactionConfig } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getVariantAliasSources, resolveVariantSelector } from "@oh-my-pi/pi-catalog/compat/collapse";
import {
	getBundledModelReferenceIndex,
	inheritReferenceThinking,
	resolveModelReference,
} from "@oh-my-pi/pi-catalog/identity";
import type { ComfyUIConfig, ComfyUIWorkflowConfig } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";
import { type ConfigHeaderResolver, type ConfigHeaderSource, createConfigHeaderResolver } from "./resolve-config-value";
import { type ModelPatch, mergeCompat, mergeRemoteCompactionConfig } from "./model-patch";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ModelOverride, ProviderAuthMode } from "./models-config-schema";
export interface CustomModelDefinitionLike extends ModelPatch {
	id: string;
	api?: Api;
	baseUrl?: string;
	cost?: Model<Api>["cost"];
}

export interface CustomModelBuildOptions {
	useDefaults: boolean;
}

export interface CustomModelOverlay extends ModelPatch {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost?: Model<Api>["cost"];
	isOAuth?: boolean;
}

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): ConfigHeaderResolver | undefined {
	return createConfigHeaderResolver([providerHeaders, modelHeaders], { authHeader, apiKeyConfig });
}

export function mergeAuthHeaderSources(
	sources: readonly ConfigHeaderSource[],
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): ConfigHeaderResolver | undefined {
	return createConfigHeaderResolver(sources, { authHeader, apiKeyConfig });
}

/**
 * Decide whether a custom-yaml model should force OAuth-style request shaping.
 * - Explicit `auth: oauth` → force on.
 *   endpoints are typically Claude-Code-style proxies (e.g. CLIProxyAPI) that expect
 *   the cloaked request shape regardless of how the proxy itself is authenticated.
 * - Otherwise → unset.
 */
function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

/**
 * Resolve one declared workflow path against the directory holding the
 * models.yml that declared it, so a config-relative workflow loads the same
 * way regardless of the session cwd. A leading `~` expands to the home
 * directory, mirroring the config layer's own expansion in
 * `config/settings.ts` rather than reaching into the tools layer.
 */
function resolveWorkflowPath(workflow: ComfyUIWorkflowConfig, baseDir: string): ComfyUIWorkflowConfig {
	const declared = workflow.path;
	const expanded =
		declared === "~"
			? os.homedir()
			: declared.startsWith("~/") || declared.startsWith("~\\")
				? path.join(os.homedir(), declared.slice(2))
				: declared;
	return { ...workflow, path: path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded) };
}

/** Resolve every workflow path of a model's ComfyUI config against `baseDir`. */
function resolveComfyUIConfigPaths(config: ComfyUIConfig | undefined, baseDir: string): ComfyUIConfig | undefined {
	if (!config) return undefined;
	return {
		...config,
		generation: resolveWorkflowPath(config.generation, baseDir),
		...(config.edit ? { edit: resolveWorkflowPath(config.edit, baseDir) } : {}),
	};
}

export function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: ModelSpec<Api>["compat"] | undefined,
	providerAuth: ProviderAuthMode | undefined,
	providerRemoteCompaction: RemoteCompactionConfig<Api> | undefined,
	modelDef: CustomModelDefinitionLike,
	/** Directory of the config declaring this model; anchors relative workflow paths. */
	workflowBaseDir: string,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		kind: modelDef.kind,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking,
		input: modelDef.input,
		imageInputDecoder: modelDef.imageInputDecoder,
		tokenizer: modelDef.tokenizer,
		supportsTools: modelDef.supportsTools,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
		preferWebsockets: modelDef.preferWebsockets,
		resolveHeaders: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		compactionModel: modelDef.compactionModel,
		remoteCompaction: mergeRemoteCompactionConfig(providerRemoteCompaction, modelDef.remoteCompaction),
		comfyui: resolveComfyUIConfigPaths(modelDef.comfyui, workflowBaseDir),
		premiumMultiplier: modelDef.premiumMultiplier,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

export function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults
		? resolveModelReference(resolvedModel.id, getBundledModelReferenceIndex())
		: undefined;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? reference?.input ?? (options.useDefaults ? ["text"] : undefined);
	const supportsTools = resolvedModel.supportsTools ?? reference?.supportsTools;
	const built = buildModel({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		kind: resolvedModel.kind,
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? reference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: inheritReferenceThinking(resolvedModel.thinking, reference, resolvedModel.provider),
		input: input as ("text" | "image")[],
		imageInputDecoder: resolvedModel.imageInputDecoder,
		...(supportsTools !== undefined ? { supportsTools } : {}),
		cost,
		contextWindow: resolvedModel.contextWindow ?? reference?.contextWindow ?? (options.useDefaults ? 128000 : null),
		maxTokens: resolvedModel.maxTokens ?? reference?.maxTokens ?? (options.useDefaults ? 16384 : null),
		headers: resolvedModel.headers,
		resolveHeaders: resolvedModel.resolveHeaders,
		omitMaxOutputTokens: resolvedModel.omitMaxOutputTokens ?? reference?.omitMaxOutputTokens,
		preferWebsockets: resolvedModel.preferWebsockets,
		comfyui: resolvedModel.comfyui,
		compat: mergeCompat(reference?.compatConfig, resolvedModel.compat),
		tokenizer: resolvedModel.tokenizer,
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		compactionModel: resolvedModel.compactionModel,
		remoteCompaction: resolvedModel.remoteCompaction,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as ModelSpec<Api>);
	if (resolvedModel.cost) {
		// Explicit custom prices outrank catalog corrections and schedules, just
		// as they do for same-id model patches.
		built.cost = { ...resolvedModel.cost };
		delete built.cost.timeBased;
	}
	return built;
}

export function normalizeSuppressedSelector(
	selector: string,
	hasLiveModel?: (provider: string, id: string) => boolean,
): string {
	const trimmed = selector.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => hasLiveModel?.(provider, id) === true,
	});
	if (!parsed) return trimmed;
	// Retired effort-tier variant ids normalize to their collapsed logical id
	// so persisted suppressions keyed by raw member ids still bind.
	const aliasId = resolveVariantSelector(parsed.provider, parsed.id);
	return `${parsed.provider}/${aliasId ?? parsed.id}`;
}

/**
 * Look up a model's override, falling back to entries keyed by retired
 * effort-tier variant ids (models.yml authored before collapsing). A raw key
 * only re-binds when no live model holds that id.
 */
export function resolveModelOverrideWithAliases(
	overrides: Map<string, ModelOverride>,
	model: Model<Api>,
	hasLiveModel: (provider: string, id: string) => boolean,
): ModelOverride | undefined {
	const direct = overrides.get(model.id);
	if (direct) return direct;
	for (const rawId of getVariantAliasSources(model.provider, model.id)) {
		if (hasLiveModel(model.provider, rawId)) continue;
		const remapped = overrides.get(rawId);
		if (remapped) {
			logger.debug("model override re-keyed through variant alias", {
				provider: model.provider,
				from: rawId,
				to: model.id,
			});
			return remapped;
		}
	}
	return undefined;
}
