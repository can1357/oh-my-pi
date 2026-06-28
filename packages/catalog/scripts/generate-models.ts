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
import { discoverAuthStorage } from "@pk-nerdsaver-ai/pi-ai/auth-broker/discover";
import type { OAuthAccess } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import type { OAuthProvider } from "@pk-nerdsaver-ai/pi-ai/oauth/types";
import { getGitLabDuoModels } from "@pk-nerdsaver-ai/pi-ai/providers/gitlab-duo";
import { $env } from "@pk-nerdsaver-ai/pi-utils";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, fetchAntigravityDiscoveryModels } from "../src/discovery/antigravity";
import { fetchCodexModels } from "../src/discovery/codex";
import { buildGitLabDuoWorkflowFallbackModel } from "../src/discovery/gitlab-duo-workflow";
import { createModelManager } from "../src/model-manager";
import prevModelsJson from "../src/models.json" with { type: "json" };
import { toModelSpec } from "../src/provider-models/bundled-references";
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
} from "../src/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";
import {
	ANTHROPIC_CURATED_FALLBACK_MODELS,
	buildFireworksFastSeed,
	buildXaiOAuthStaticSeed,
	clampFireworksKimiMaxTokens,
	clampKimiK27CodeMaxTokens,
	isFireworksKimiK2ModelId,
	isKimiK27CodeModelId,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	SAKANA_FUGU_STATIC_MODELS,
	stripFireworksDeepSeekThinkingToggle,
} from "../src/provider-models/openai-compat";
import type { ModelSpec } from "../src/types";
import { cleanModelName } from "../src/utils";
import { collapseEffortVariantsAcrossProviders } from "../src/variant-collapse";
import { JWT_CLAIM_PATH } from "../src/wire/codex";
import {
	applyCanonicalLimitFallback,
	applyGeneratedModelPolicies,
	CLOUDFLARE_FALLBACK_MODEL,
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

async function fetchProviderModelsFromCatalog(descriptor: CatalogProviderDescriptor): Promise<ModelSpec[]> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return [];
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const managerOptions = descriptor.createModelManagerOptions({ apiKey });
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
			return [];
		}
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models, using fallback models`);
			return [];
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);
		// The manager returns built models; models.json stores specs (sparse compat).
		return models.map(model => toModelSpec(model));
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return [];
	}
}

async function loadModelsDevData(): Promise<ModelSpec[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();
		const models = mapModelsDevToModels(data as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS);
		models.sort((a, b) => a.id.localeCompare(b.id));
		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
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
		if (providerScopedKeys.has(`${model.provider}/${model.id}`) || model.provider === "devin") {
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
			// Fill unknown endpoint limits from same-id models.dev references, but keep
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
function hasBillableCost(cost: ModelSpec["cost"]): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
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

		const openAICost = openAIModels.get(model.id);
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

/**
 * Z.AI's `/v1/models` advertises context-tier variants with a `[1m]` suffix
 * (e.g. `glm-5.2[1m]`). That suffix is a Claude Code-side convention — Z.AI's
 * own docs instruct users to append `[1m]` to enable 1M context *inside Claude
 * Code* — but the inference endpoint rejects the bracketed id outright with
 * `[1211][Unknown Model, please check the model code.]`. The base id
 * (`glm-5.2`) already carries the full 1M context window (pinned by
 * {@link applyGeneratedModelPolicy}), so drop the unusable bracketed siblings
 * from the bundled catalog rather than ship a model that 400s on first use.
 */
function dropUnusableZaiContextTierIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => !(model.provider === "zai" && model.id.endsWith("[1m]")));
}

/**
 * Fireworks discovery and prior snapshots can surface internal control-plane
 * resource ids (`accounts/fireworks/{models,routers}/...`) alongside the public
 * request ids (`kimi-k2.7-code`, `deepseek-v4-flash`, ...). The wire ids are an
 * implementation detail the request path reconstructs from the public id, so
 * drop them from the bundle outright.
 */
function dropFireworksWireIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(
		model =>
			!(
				(model.provider === "fireworks" || model.provider === "firepass") &&
				model.id.startsWith("accounts/fireworks/")
			),
	);
}

/**
 * Xiaomi's `/v1/models` can advertise ASR/TTS ids alongside chat/completions
 * models. Runtime discovery filters them, but previous bundled snapshots can
 * still resurrect those stale ids via the fallback merge. Drop them here so the
 * committed catalog matches the runtime surface.
 */
function dropXiaomiAudioOnlyIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => {
		const isXiaomiProvider = model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-");
		return !isXiaomiProvider || (!model.id.includes("-tts") && !model.id.includes("-asr"));
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
 * Extract accountId from a Codex JWT access token.
 */
function extractCodexAccountId(accessToken: string): string | null {
	try {
		const parts = accessToken.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
		const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
	} catch {
		return null;
	}
}

async function fetchCodexDiscoveryModels(): Promise<ModelSpec<"openai-codex-responses">[]> {
	const access = await getOAuthAccessFromStorage("openai-codex");
	if (!access) {
		console.log("No Codex credentials found, will use previous models.");
		console.log("Tip: If you are logged in under a specific profile, run with OMP_PROFILE=<name>.");
		return [];
	}
	try {
		console.log("Fetching models from Codex API...");
		const accessToken = access.accessToken;
		const accountId = access.accountId ?? extractCodexAccountId(accessToken);
		const codexDiscovery = await fetchCodexModels({
			accessToken,
			accountId: accountId ?? undefined,
		});
		if (codexDiscovery === null) {
			console.warn("Codex API fetch failed");
			return [];
		}
		if (codexDiscovery.models.length > 0) {
			console.log(`Fetched ${codexDiscovery.models.length} models from Codex API`);
			return codexDiscovery.models;
		}
		return [];
	} catch (error) {
		console.error("Failed to fetch Codex models:", error);
		return [];
	}
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
			models: await fetchProviderModelsFromCatalog(descriptor),
		})),
	);
	const authoritativeCatalogProviders = new Set(
		catalogProviderModelBatches
			.filter(batch => batch.descriptor.dynamicModelsAuthoritative === true && batch.models.length > 0)
			.map(batch => batch.descriptor.providerId),
	);
	const catalogProviderModels = catalogProviderModelBatches.flatMap(batch => batch.models);
	const bundledModelsDevModels = modelsDevModels.filter(model => !authoritativeCatalogProviders.has(model.provider));
	// getGitLabDuoModels returns built models; project back to spec stage for the bundle.
	const gitLabDuoModels = getGitLabDuoModels().map(model => toModelSpec(model));
	// Combine models. models.dev has priority unless a provider's successful endpoint
	// discovery is authoritative; those endpoint snapshots replace models.dev rows.
	let allModels = applyGlobalModelsDevFallback(
		[...bundledModelsDevModels, ...catalogProviderModels, ...gitLabDuoModels],
		modelsDevModels,
	);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL as ModelSpec<"anthropic-messages">);
	}

	// xai-oauth is not in models.dev; its descriptor's catalogDiscovery fetch
	// only succeeds with live SuperGrok OAuth credentials (and on success the
	// dynamic entries — already overlaid by applyXAIOAuthCuration — win dedup
	// below). Always push the curated seed so a regen without credentials, or
	// with a failed fetch, still bundles XAI_OAUTH_CURATED_MODELS verbatim:
	// ModelRegistry.#loadModels() picks them up synchronously at boot, so a
	// persisted `modelRoles.default = "xai-oauth/<id>"` is honored before the
	// async refresh fires (interactive boot does not await refresh).
	allModels.push(...buildXaiOAuthStaticSeed());
	// Seed Anthropic models that are live on the first-party API or in limited
	// release but that models.dev has not catalogued yet (e.g. Claude Fable 5 /
	// Mythos 5). Deduped behind upstream entries; metadata is pinned in
	// applyAnthropicCatalogPolicy.
	allModels.push(...ANTHROPIC_CURATED_FALLBACK_MODELS);
	// Seed Sakana's documented Fugu models so the provider is usable when
	// catalog generation has no live API key. If live `/v1/models` succeeds,
	// Sakana is authoritative and stale seed IDs must stay out.
	if (!authoritativeCatalogProviders.has("sakana")) {
		allModels.push(...SAKANA_FUGU_STATIC_MODELS);
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
		{ label: "Antigravity", fetch: fetchAntigravityModels },
		{ label: "Codex", fetch: fetchCodexDiscoveryModels },
	] as const;
	const specialDiscoveries = await Promise.all(
		specialDiscoverySources.map(async source => ({
			label: source.label,
			models: await source.fetch(),
		})),
	);
	for (const discovery of specialDiscoveries) {
		if (discovery.models.length > 0) {
			console.log(`Added ${discovery.models.length} models from ${discovery.label} discovery`);
			allModels.push(...discovery.models);
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
	// or authoritative models.dev sources keep that upstream list exactly, so
	// retired entries from the previous snapshot do not reappear during regeneration.
	// Discovery-only providers (local inference servers) — never bundle static models.
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	// Previous-snapshot entries may carry an older ThinkingConfig vocabulary;
	// applyGeneratedModelPolicies re-bakes `thinking` for every model, so the
	// inbound shape is irrelevant beyond identity/pricing/compat fields.
	for (const models of Object.values(prevModelsJson as unknown as Record<string, Record<string, ModelSpec>>)) {
		for (const model of Object.values(models)) {
			if (
				!fetchedKeys.has(`${model.provider}/${model.id}`) &&
				!DISCOVERY_ONLY_PROVIDERS.has(model.provider) &&
				!RETIRED_PROVIDERS.has(model.provider) &&
				!authoritativeCatalogProviders.has(model.provider) &&
				!modelsDevSnapshotExcludedProviders.has(model.provider)
			) {
				allModels.push(model);
			}
		}
	}

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyKimiMaxTokensCap(allModels);
	allModels = applyFireworksDeepSeekReasoningShape(allModels);
	allModels = dropFireworksWireIds(allModels);
	allModels = dropUnusableZaiContextTierIds(allModels);
	allModels = dropXiaomiAudioOnlyIds(allModels);
	allModels = normalizeAntigravityEndpoint(allModels);
	// Normalize display names: gateway author prefixes ("OpenAI: …"), alias
	// markers ("(latest)"), provider attribution ("(Antigravity)"), and
	// price/promo tags are model-extrinsic — strip them from the bundle.
	allModels = allModels.map(model => {
		const name = cleanModelName(model.name);
		return name === model.name ? model : { ...model, name };
	});
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);
	// Collapse effort-tier variants AFTER the policy re-bake: live-discovery
	// entries are already collapsed (rebake skips them); this pass folds
	// previous-snapshot raw members into their logical families.
	allModels = collapseEffortVariantsAcrossProviders(allModels);
	// Fill remaining null endpoint limits from each model's canonical-family
	// reference. Runs last so canonical ids and explicit policy limits are final.
	applyCanonicalLimitFallback(allModels);

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

	const MODELS: Record<string, Record<string, ModelSpec>> = sortObj(providers);
	for (const key in MODELS) {
		MODELS[key] = sortObj(MODELS[key]);
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

// Run the generator
generateModels().catch(console.error);
