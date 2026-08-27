#!/usr/bin/env bun

// Copilot model premium request multipliers by model identifier.
const COPILOT_PREMIUM_MULTIPLIERS: Record<string, number> = {
	"github-copilot/claude-haiku-4.5": 0.33,
	"github-copilot/claude-opus-4.6": 3,
	"github-copilot/gpt-4o": 0,
	"github-copilot/gpt-5.4-mini": 0.33,
	"github-copilot/grok-code-fast-1": 0.25,
};

import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-ai/auth-broker/discover";
import type { OAuthAccess } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { getGitLabDuoModels } from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { $env } from "@oh-my-pi/pi-utils";
import { buildModel } from "../src/build";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, fetchAntigravityDiscoveryModels } from "../src/discovery/antigravity";
import { buildGitLabDuoWorkflowFallbackModel } from "../src/discovery/gitlab-duo-workflow";
import { createModelManager } from "../src/model-manager";
import prevModelsJson from "../src/models.json" with { type: "json" };
import { resolveOpenAIDaybreakStandardCost } from "../src/openai-pricing";
import { toModelSpec } from "../src/provider-models/bundled-references";
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
} from "../src/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import { filterModelsDevCatalogRows } from "../src/provider-models/models-dev-policies";
import {
	AIAND_STATIC_MODELS,
	ALIBABA_TOKEN_PLAN_STATIC_MODELS,
	ANTHROPIC_CURATED_FALLBACK_MODELS,
	applyXaiCatalogPricing,
	BEDROCK_MANTLE_STATIC_MODELS,
	buildFireworksFastSeed,
	buildXaiOAuthStaticSeed,
	clampFireworksKimiMaxTokens,
	clampKimiK27CodeMaxTokens,
	fetchWellKnownModels,
	GMI_CLOUD_STATIC_MODELS,
	isFireworksKimiK2ModelId,
	isKimiK27CodeModelId,
	kimiCodeMaxTokens,
	META_MUSE_STATIC_MODELS,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS,
	projectOpenAIProReasoningAliases,
	SAKANA_FUGU_STATIC_MODELS,
	stripFireworksDeepSeekThinkingToggle,
	YOLO_AUTO_STATIC_MODELS,
} from "../src/provider-models/openai-compat";
import { type OpenAICodexAccount, openaiCodexModelManagerOptions } from "../src/provider-models/special";
import type { Api, Model, ModelSpec } from "../src/types";
import { cleanModelName } from "../src/utils";
import { collapseEffortVariantsAcrossProviders } from "../src/variant-collapse";
import {
	applyAntigravityPricingFallback,
	applyCanonicalLimitFallback,
	applyGeneratedModelPolicies,
	applyOllamaCloudOutputCap,
	CLOUDFLARE_FALLBACK_MODEL,
	hasBillableCost,
	linkOpenAIPromotionTargets,
} from "./generated-policies";

const packageRoot = path.join(import.meta.dir, "..");

/**
 * Local/self-hosted providers (Ollama, vLLM, LM Studio, LiteLLM). Their model
 * catalogs are whatever happens to be running on the machine that invokes the
 * generator — bundling them would leak machine-specific endpoints (e.g.
 * `http://localhost:4000/v1`) into the committed snapshot. They are discovered
 * dynamically at runtime instead, so they are never fetched during generation
 * and never written to models.json.
 */
const DISCOVERY_ONLY_PROVIDERS = new Set(["ollama", "vllm", "lm-studio", "litellm"]);
const RETIRED_PROVIDERS = new Set(["wafer-pass", "wandb"]);

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars ?? []) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const authStorage = await discoverAuthStorage();
		try {
			const storedApiKey = await authStorage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				// AuthStorage.getApiKey refreshes through the broker-aware
				// single-flighted machinery, so a build-time invocation no
				// longer silently falls back to bundled models when an
				// expired-but-refreshable OAuth credential is on disk.
				const oauthKey = await authStorage.getApiKey(catalog.oauthProvider);
				if (oauthKey) {
					return oauthKey;
				}
			}
		} finally {
			authStorage.close();
		}
	} catch (err) {
		console.warn(
			`Warning: Failed to retrieve credentials for ${providerId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}

	return undefined;
}
type CatalogProviderFetchResult = { models: ModelSpec[]; succeeded: boolean };

async function fetchProviderModelsFromCatalog(
	descriptor: CatalogProviderDescriptor,
): Promise<CatalogProviderFetchResult> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return { models: [], succeeded: false };
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const discoveryConfig = { apiKey };
		const preparedConfig =
			getProviderDefinition(descriptor.providerId)?.prepareModelDiscovery?.(discoveryConfig) ?? discoveryConfig;
		const managerOptions = descriptor.createModelManagerOptions(preparedConfig);
		const manager = createModelManager(managerOptions);
		const result = await manager.refresh("online");
		// `stale: true` means the dynamic fetch failed and the manager fell back
		// to merging the local agent.db model cache over the static catalog —
		// fine for a live session ("stale state remains visible"), poison for a
		// committed bundle: cache rows written by older code leak outdated
		// limits into models.json (e.g. the xai-oauth maxTokens regression).
		// Treat it like missing credentials so the prev-snapshot/curated-seed
		// fallback applies instead.
		if (result.stale) {
			console.warn(
				`${descriptor.catalogDiscovery.label} dynamic fetch failed (stale cache merge), using fallback models`,
			);
			return { models: [], succeeded: false };
		}
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models`);
			return { models: [], succeeded: true };
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);
		// Keep discovery rows as specs until policies finish; the final bundle is fully materialized below.
		return { models: models.map(model => toModelSpec(model)), succeeded: true };
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return { models: [], succeeded: false };
	}
}

async function loadModelsDevData(): Promise<ModelSpec[]> {
	try {
		console.log("Fetching stencil.so catalog from catalog.stencil.so...");
		const data = await fetchWellKnownModels();
		const models = mapModelsDevToModels(data as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS);
		models.sort((a, b) => a.id.localeCompare(b.id));
		console.log(`Loaded ${models.length} tool-capable models from stencil.so`);
		return models;
	} catch (error) {
		console.error("Failed to load stencil.so data:", error);
		return [];
	}
}

function createGlobalModelsDevReferenceMap(modelsDevModels: readonly ModelSpec[]): Map<string, ModelSpec> {
	const references = new Map<string, ModelSpec>();
	for (const model of modelsDevModels) {
		const existing = references.get(model.id);
		if (!existing) {
			references.set(model.id, model);
			continue;
		}
		if ((model.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(model.id, model);
			continue;
		}
		if (
			(model.contextWindow ?? 0) === (existing.contextWindow ?? 0) &&
			(model.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(model.id, model);
		}
	}
	return references;
}

function applyGlobalModelsDevFallback(
	models: readonly ModelSpec[],
	modelsDevModels: readonly ModelSpec[],
): ModelSpec[] {
	const providerScopedKeys = new Set(modelsDevModels.map(model => `${model.provider}/${model.id}`));
	const globalReferences = createGlobalModelsDevReferenceMap(modelsDevModels);
	return models.map(model => {
		if (
			providerScopedKeys.has(`${model.provider}/${model.id}`) ||
			model.provider === "devin" ||
			model.provider === "baseten"
		) {
			return model;
		}
		const reference = globalReferences.get(model.id);
		if (!reference) {
			return model;
		}
		return {
			...model,
			name: reference.name,
			reasoning: reference.reasoning,
			input: reference.input,
			// Fill unknown endpoint limits from same-id stencil.so references, but keep
			// provider-specific values when discovery returned them explicitly.
			contextWindow: model.contextWindow ?? reference.contextWindow,
			maxTokens: model.maxTokens ?? reference.maxTokens,
		};
	});
}

function applyPremiumMultiplierOverrides(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		const premiumMultiplier = COPILOT_PREMIUM_MULTIPLIERS[`${model.provider}/${model.id}`];
		if (premiumMultiplier === undefined) {
			return model;
		}
		if (model.premiumMultiplier === premiumMultiplier) {
			return model;
		}
		return {
			...model,
			premiumMultiplier,
		};
	});
}

function applyUmansPricingFallback(models: readonly ModelSpec[], modelsDevModels: readonly ModelSpec[]): ModelSpec[] {
	const paygCosts = new Map<string, ModelSpec["cost"]>();
	for (const model of modelsDevModels) {
		if (model.provider === "umans" && hasBillableCost(model.cost)) {
			paygCosts.set(model.id, model.cost);
		}
	}

	// The public endpoint exposes this technical alias for Umans Flash, but
	// stencil.so publishes pricing only for the recommended `umans-flash` id.
	const flashCost = paygCosts.get("umans-flash");
	if (flashCost) {
		paygCosts.set("umans-qwen3.6-35b-a3b", flashCost);
	}

	return models.map(model => {
		if (model.provider !== "umans" || hasBillableCost(model.cost)) {
			return model;
		}
		const cost = paygCosts.get(model.id);
		return cost ? { ...model, cost: { ...cost } } : model;
	});
}

function applyCodexPricingFallback(models: readonly ModelSpec[]): ModelSpec[] {
	const openAIModels = new Map(
		models
			.filter(model => model.provider === "openai" && hasBillableCost(model.cost))
			.map(model => [model.id, model.cost]),
	);

	return models.map(model => {
		if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
			return model;
		}
		if (hasBillableCost(model.cost)) {
			return model;
		}

		const openAICost = openAIModels.get(model.id) ?? resolveOpenAIDaybreakStandardCost(model.id);
		if (!openAICost) {
			return model;
		}

		return {
			...model,
			cost: { ...openAICost },
		};
	});
}

/**
 * Provider discovery sometimes reports context-sized Kimi output ceilings. Keep
 * the bundled catalog at the documented/provider-safe caps so request builders
 * that always send `max_tokens` do not over-allocate.
 */
function applyKimiMaxTokensCap(models: readonly ModelSpec[]): ModelSpec[] {
	const FIREWORKS_KIMI_PROVIDERS = new Set(["fireworks", "firepass"]);
	return models.map(model => {
		if (FIREWORKS_KIMI_PROVIDERS.has(model.provider) && isFireworksKimiK2ModelId(model.id)) {
			const capped = clampFireworksKimiMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		if (model.provider === "venice" && isKimiK27CodeModelId(model.id)) {
			const capped = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		if (model.provider === "kimi-code") {
			// Discovery snapshots carried maxTokens=32000 uniformly (#6711); pin the
			// documented per-family output ceilings and leave legacy K2 rows as-is.
			const capped = kimiCodeMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		return model;
	});
}

/**
 * Fireworks' DeepSeek V4 endpoint accepts the user's effort through
 * `reasoning_effort` and rejects the DeepSeek-native binary `thinking` toggle
 * when both are present. Strip stale reference metadata from generated fallbacks.
 */
function applyFireworksDeepSeekReasoningShape(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider !== "fireworks" || model.api !== "openai-completions") return model;
		// `.api` equality doesn't narrow the generic; the guard makes this cast sound.
		return stripFireworksDeepSeekThinkingToggle(model as ModelSpec<"openai-completions">, model.id);
	});
}

function normalizeAntigravityEndpoint(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider === "google-antigravity" && model.baseUrl) {
			return { ...model, baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT };
		}
		return model;
	});
}

const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_PRIMARY_ENDPOINT;

async function getOAuthAccessFromStorage(provider: OAuthProvider): Promise<OAuthAccess | null> {
	try {
		const authStorage = await discoverAuthStorage();
		try {
			// `getOAuthAccess` runs the full AuthStorage refresh pipeline so an
			// expired-but-refreshable credential gets rotated before discovery,
			// and identity metadata (accountId/projectId/email) flows through
			// for Codex/Antigravity downstream calls.
			let access = await authStorage.getOAuthAccess(provider);
			if (!access && provider === "google-antigravity") {
				access = await authStorage.getOAuthAccess("google-gemini-cli");
			}
			return access ?? null;
		} finally {
			authStorage.close();
		}
	} catch (err) {
		console.warn(
			`Warning: Failed to retrieve credentials for ${provider}:`,
			err instanceof Error ? err.message : String(err),
		);
		return null;
	}
}

/**
 * Fetch available Antigravity models from the API using the discovery module.
 * Returns empty array if no auth is available (previous models used as fallback).
 */
async function fetchAntigravityModels(): Promise<ModelSpec<"google-gemini-cli">[]> {
	const access = await getOAuthAccessFromStorage("google-antigravity");
	if (!access) {
		console.log("No Antigravity or Gemini CLI credentials found, will use previous models.");
		console.log("Tip: If you are logged in under a specific profile, run with OMP_PROFILE=<name>.");
		return [];
	}
	try {
		console.log("Fetching models from Antigravity API...");
		const discovered = await fetchAntigravityDiscoveryModels({
			token: access.accessToken,
			endpoint: ANTIGRAVITY_ENDPOINT,
		});
		if (discovered === null) {
			console.warn("Antigravity API fetch failed, will use previous models");
			return [];
		}
		if (discovered.length > 0) {
			console.log(`Fetched ${discovered.length} models from Antigravity API`);
			return discovered;
		}
		console.warn("Antigravity API returned no models, will use previous models");
		return [];
	} catch (error) {
		console.error("Failed to fetch Antigravity models:", error);
		return [];
	}
}

/**
 * Resolve every stored Codex OAuth account and union their account-scoped
 * `/models` catalogs through the same manager path the runtime uses (#6265).
 * Fails closed: any account that cannot resolve or fetch aborts discovery and
 * returns [] (non-authoritative), so a partial per-account snapshot never
 * replaces the previous bundle's model set.
 */
async function fetchCodexDiscoveryModels(): Promise<ModelSpec<"openai-codex-responses">[]> {
	const accounts: OpenAICodexAccount[] = [];
	try {
		const authStorage = await discoverAuthStorage();
		try {
			const accesses = await authStorage.getOAuthAccesses("openai-codex");
			for (const access of accesses) {
				if (!access.ok) {
					console.warn(`Codex account failed to resolve (${access.error}), keeping previous models.`);
					return [];
				}
				accounts.push({ accessToken: access.accessToken, accountId: access.accountId });
			}
		} finally {
			authStorage.close();
		}
	} catch (error) {
		console.warn(
			"Warning: Failed to retrieve Codex credentials:",
			error instanceof Error ? error.message : String(error),
		);
		return [];
	}
	if (accounts.length === 0) {
		console.log("No Codex credentials found, will use previous models.");
		console.log("Tip: If you are logged in under a specific profile, run with OMP_PROFILE=<name>.");
		return [];
	}
	console.log(`Fetching models from Codex API for ${accounts.length} account(s)...`);
	const options = openaiCodexModelManagerOptions({ resolveAccounts: async () => accounts });
	const models = await options.fetchDynamicModels?.();
	if (!models) {
		console.warn("Codex API fetch failed, keeping previous models.");
		return [];
	}
	console.log(`Fetched ${models.length} models from Codex API`);
	return [...models];
}

async function generateModels() {
	// Fetch models from dynamic sources.
	const modelsDevModels = await loadModelsDevData();
	const catalogProviderDescriptors = PROVIDER_DESCRIPTORS.filter(
		(descriptor): descriptor is CatalogProviderDescriptor =>
			isCatalogDescriptor(descriptor) && !DISCOVERY_ONLY_PROVIDERS.has(descriptor.providerId),
	);
	const catalogProviderModelBatches = await Promise.all(
		catalogProviderDescriptors.map(async descriptor => ({
			descriptor,
			...(await fetchProviderModelsFromCatalog(descriptor)),
		})),
	);
	// A provider is authoritative once its endpoint snapshot can replace the
	// stencil.so / previous-snapshot rows. Requiring fetched models keeps a
	// flaky empty-but-200 discovery from silently wiping another provider's
	// bundled catalog; only alibaba-token-plan treats an empty success as
	// authoritative, because its `/models` allowlist reflects the subscribed
	// edition and must not be widened by the curated seed below.
	const authoritativeCatalogProviders = new Set(
		catalogProviderModelBatches
			.filter(
				batch =>
					batch.descriptor.dynamicModelsAuthoritative === true &&
					(batch.models.length > 0 || (batch.succeeded && batch.descriptor.providerId === "alibaba-token-plan")),
			)
			.map(batch => batch.descriptor.providerId),
	);
	const catalogProviderModels = catalogProviderModelBatches.flatMap(batch => batch.models);
	const bundledModelsDevModels = modelsDevModels.filter(model => !authoritativeCatalogProviders.has(model.provider));
	// getGitLabDuoModels returns built models; project back to spec stage for the bundle.
	const gitLabDuoModels = getGitLabDuoModels().map(model => toModelSpec(model));
	// Combine models. stencil.so has priority unless a provider's successful endpoint
	// discovery is authoritative; those endpoint snapshots replace stencil.so rows.
	let allModels = applyGlobalModelsDevFallback(
		[...bundledModelsDevModels, ...catalogProviderModels, ...gitLabDuoModels],
		modelsDevModels,
	);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL as ModelSpec<"anthropic-messages">);
	}

	// xai-oauth is not in stencil.so; its descriptor's catalogDiscovery fetch
	// only succeeds with live SuperGrok OAuth credentials (and on success the
	// dynamic entries — already overlaid by applyXAIOAuthCuration — win dedup
	// below). Always push the curated seed so a regen without credentials, or
	// with a failed fetch, still bundles XAI_OAUTH_CURATED_MODELS verbatim:
	// ModelRegistry.#loadModels() picks them up synchronously at boot, so a
	// persisted `modelRoles.default = "xai-oauth/<id>"` is honored before the
	// async refresh fires (interactive boot does not await refresh).
	allModels.push(...buildXaiOAuthStaticSeed());
	// Daybreak is separately provisioned and absent from stencil.so. Keep its
	// documented aliases and current Cyber snapshot in every generated bundle.
	allModels.push(...OPENAI_DAYBREAK_CURATED_FALLBACK_MODELS);
	// Seed Anthropic models that are live on the first-party API or in limited
	// release but that stencil.so has not catalogued yet (e.g. Claude Fable 5 /
	// Mythos 5). Deduped behind upstream entries; metadata is pinned in
	// applyAnthropicCatalogPolicy.
	allModels.push(...ANTHROPIC_CURATED_FALLBACK_MODELS);
	// Seed GLM-5.3 on the z.AI provider. GLM-5.3 is live on the Anthropic and
	// coding endpoints but not yet advertised in `/v1/models` (which still tops
	// out at glm-5.2), so endpoint discovery misses it. The zai provider is not
	// authoritative, so the seed survives regeneration; thinking metadata
	// (low/high/max uniform ladder, mandatory reasoning, defaultLevel=max) is
	// derived by rebakeModelThinking from the identity classifiers.
	allModels.push({
		id: "glm-5.3",
		name: "GLM-5.3",
		api: "anthropic-messages",
		provider: "zai",
		baseUrl: "https://api.z.ai/api/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
	} as ModelSpec<"anthropic-messages">);
	// Seed Meta's documented Muse model so first-run selection does not depend on
	// credentials or live discovery.
	allModels.push(...META_MUSE_STATIC_MODELS);
	// Mantle's catalog endpoint is account/API-key scoped. Keep the generated
	// bundle deterministic; authenticated runtime discovery may replace this seed.
	allModels.push(...BEDROCK_MANTLE_STATIC_MODELS);
	// Seed Sakana's documented Fugu models so the provider is usable when
	// catalog generation has no live API key. If live `/v1/models` succeeds,
	// Sakana is authoritative and stale seed IDs must stay out.
	if (!authoritativeCatalogProviders.has("sakana")) {
		allModels.push(...SAKANA_FUGU_STATIC_MODELS);
	}
	// Seed ai&'s documented catalog so the provider is usable when generation
	// has no AIAND_API_KEY. A live org-scoped `/v1/models` snapshot is
	// authoritative and replaces the seed.
	if (!authoritativeCatalogProviders.has("aiand")) {
		allModels.push(...AIAND_STATIC_MODELS);
	}
	// Seed Yolo-Auto's documented catalog so the provider is usable when
	// generation has no YOLO_AUTO_API_KEY. A live `/v1/models` snapshot is
	// authoritative and replaces the seed.
	if (!authoritativeCatalogProviders.has("yolo-auto")) {
		allModels.push(...YOLO_AUTO_STATIC_MODELS);
	}
	// Seed the GMI Cloud default model so a fresh install (and a regen without a
	// `GMI_API_KEY`) still resolves the descriptor's `defaultModel` synchronously
	// at boot. If live `/v1/models` discovery succeeds, it is authoritative.
	if (!authoritativeCatalogProviders.has("gmi-cloud")) {
		allModels.push(...GMI_CLOUD_STATIC_MODELS);
	}
	// Seed the GitLab Duo Agent fallback model so a fresh install (no credentialed
	// dynamic discovery/cache yet) still surfaces the provider's default model in the
	// built-in catalog. The descriptor deliberately has NO `catalogDiscovery`, so it is
	// excluded from the generator's discovery loop (`isCatalogDescriptor` filter above):
	// generation never fetches `aiChatAvailableModels` for it. That is intentional —
	// Duo discovery is credential- and namespace-scoped, so running it during generation
	// would bundle one private account's pinned/selectable models (and its
	// `gitlabDuoWorkflowRootNamespaceId`) as authoritative for every fresh install.
	// The generic fallback is the only thing bundled; live namespace-scoped models are
	// discovered at runtime per credential/workspace. The `authoritativeCatalogProviders`
	// guard therefore always passes for this id, kept only to mirror the Sakana seed shape.
	if (!authoritativeCatalogProviders.has("gitlab-duo-agent")) {
		allModels.push(buildGitLabDuoWorkflowFallbackModel());
	}
	// Seed Fireworks "Fast" serving-path variants (`<id>-fast`). Fast routers are
	// not enumerated by the serverless control-plane list, so discovery never
	// surfaces them; the seed projects each base entry into a fast variant.
	// Deduped behind any identical previous-snapshot entry.
	allModels.push(...buildFireworksFastSeed());

	const specialDiscoverySources = [
		{ label: "Antigravity", providerId: "google-antigravity", authoritative: false, fetch: fetchAntigravityModels },
		{ label: "Codex", providerId: "openai-codex", authoritative: true, fetch: fetchCodexDiscoveryModels },
	] as const;
	const specialDiscoveries = await Promise.all(
		specialDiscoverySources.map(async source => ({
			label: source.label,
			providerId: source.providerId,
			authoritative: source.authoritative,
			models: await source.fetch(),
		})),
	);
	const authoritativeSpecialDiscoveryProviders = new Set<string>();
	for (const discovery of specialDiscoveries) {
		if (discovery.models.length > 0) {
			console.log(`Added ${discovery.models.length} models from ${discovery.label} discovery`);
			allModels.push(...discovery.models);
			if (discovery.authoritative) {
				authoritativeSpecialDiscoveryProviders.add(discovery.providerId);
			}
		}
	}

	const modelsDevSnapshotExcludedProviders = new Set<string>();
	for (const model of modelsDevModels) {
		if (model.provider === "google-vertex") {
			modelsDevSnapshotExcludedProviders.add(model.provider);
		}
	}
	// Merge previous models.json entries as fallback for provider/model pairs not
	// fetched dynamically. Providers covered by authoritative endpoint discovery
	// or authoritative stencil.so sources keep that upstream list exactly, so
	// retired entries from the previous snapshot do not reappear during regeneration.
	// Discovery-only providers (local inference servers) — never bundle static models.
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	// Previous-snapshot entries may carry an older ThinkingConfig vocabulary;
	// applyGeneratedModelPolicies re-bakes `thinking` for every model, so the
	// inbound shape is irrelevant beyond identity/pricing/compat fields.
	for (const models of Object.values(prevModelsJson as unknown as Record<string, Record<string, Model<Api>>>)) {
		for (const bundledModel of Object.values(models)) {
			const model = toModelSpec(bundledModel);
			if (
				!fetchedKeys.has(`${model.provider}/${model.id}`) &&
				!DISCOVERY_ONLY_PROVIDERS.has(model.provider) &&
				// Yolo-Auto's documented static seed is the complete fallback
				// catalog; never resurrect retired ids from the previous snapshot.
				model.provider !== "yolo-auto" &&
				!RETIRED_PROVIDERS.has(model.provider) &&
				!authoritativeCatalogProviders.has(model.provider) &&
				!authoritativeSpecialDiscoveryProviders.has(model.provider) &&
				!modelsDevSnapshotExcludedProviders.has(model.provider)
			) {
				allModels.push(model);
			}
		}
	}

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);
	// Seed QwenCloud's documented Token Plan models when credentialed
	// discovery is unavailable. A successful `/models` response is authoritative
	// for the subscribed edition and must not be widened by the fallback.
	// Deduplication keeps earlier rows, so prepend the curated seed to prevent
	// incomplete upstream metadata from replacing its capabilities.
	if (!authoritativeCatalogProviders.has("alibaba-token-plan")) {
		allModels.unshift(...ALIBABA_TOKEN_PLAN_STATIC_MODELS);
	}
	allModels = applyUmansPricingFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyXaiCatalogPricing(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyAntigravityPricingFallback(allModels);
	allModels = applyKimiMaxTokensCap(allModels);
	allModels = applyFireworksDeepSeekReasoningShape(allModels);
	allModels = filterModelsDevCatalogRows(allModels);
	allModels = normalizeAntigravityEndpoint(allModels);
	// Normalize display names: gateway author prefixes ("OpenAI: …"), alias
	// markers ("(latest)"), provider attribution ("(Antigravity)"), and
	// price/promo tags are model-extrinsic — strip them from the bundle.
	allModels = allModels.map(model => {
		const name = cleanModelName(model.name);
		return name === model.name ? model : { ...model, name };
	});
	// Re-derive the first-party gpt-5.6 pro-reasoning aliases from the current
	// base rows (stale previous-snapshot aliases are dropped inside), before the
	// policy re-bake so the aliases get the same baked thinking metadata.
	allModels = projectOpenAIProReasoningAliases(allModels);
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);
	// Collapse effort-tier variants AFTER the policy re-bake: live-discovery
	// entries are already collapsed (rebake skips them); this pass folds
	// previous-snapshot raw members into their logical families.
	allModels = collapseEffortVariantsAcrossProviders(allModels);
	// Fill remaining null endpoint limits from each model's canonical-family
	// reference. Runs last so canonical ids and explicit policy limits are final.
	applyCanonicalLimitFallback(allModels);
	// Pin every Ollama Cloud model's max-output to the enforced ceiling; runs
	// after canonical fallback so finalized context windows drive the cap.
	applyOllamaCloudOutputCap(allModels);

	for (const model of allModels) {
		canonicalizeModelCompat(model);
	}

	// Group by provider and sort each provider's models
	const providers: Record<string, Record<string, ModelSpec>> = {};
	for (const model of allModels) {
		if (DISCOVERY_ONLY_PROVIDERS.has(model.provider) || RETIRED_PROVIDERS.has(model.provider)) continue;
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to deduplicate the ordered sources assembled above.
		// Earlier sources win.
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Sort providers alphabetically and models within each provider by ID
	const sortObj = <V>(o: Record<string, V>): Record<string, V> => {
		return Object.fromEntries(
			Object.entries(o)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, model]) => [id, model]),
		);
	};

	const modelSpecs: Record<string, Record<string, ModelSpec>> = sortObj(providers);
	const MODELS: Record<string, Record<string, Model<Api>>> = {};
	for (const [provider, models] of Object.entries(modelSpecs)) {
		MODELS[provider] = Object.fromEntries(
			Object.entries(sortObj(models)).map(([id, model]) => [id, buildModel(model)]),
		);
	}

	// Generate JSON file
	await Bun.write(path.join(packageRoot, "src/models.json"), JSON.stringify(MODELS, null, "	"));
	console.log("Generated src/models.json");

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`
Model Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(MODELS)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

function canonicalizeModelCompat(model: ModelSpec<Api>): void {
	if (!model.compat) return;

	if ("disableStrictTools" in model.compat && model.compat.disableStrictTools === false) {
		delete model.compat.disableStrictTools;
	}

	let hasKeys = false;
	for (const _ in model.compat) {
		hasKeys = true;
		break;
	}
	if (!hasKeys) {
		delete model.compat;
	}
}

// Run the generator
generateModels().catch(console.error);
