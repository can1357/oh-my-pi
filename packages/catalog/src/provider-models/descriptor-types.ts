import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl } from "../types";

/** Config passed to a provider's runtime model-manager factory. */
export type ModelManagerConfig = {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	/** The supplied fetch already applies provider-specific authentication. */
	authenticated?: boolean;
};

/** Catalog discovery configuration for providers that support endpoint-based model listing. */
export interface CatalogDiscoveryConfig {
	/** Human-readable name for log messages. */
	label: string;
	/**
	 * Environment variables to check for API keys during catalog generation.
	 * Defaults to the entry-level `envVars` when omitted.
	 */
	envVars?: readonly string[];
	/** OAuth provider for credential refresh during catalog generation. */
	oauthProvider?: string;
	/** When true, catalog discovery proceeds even without credentials. */
	allowUnauthenticated?: boolean;
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: string;
	createModelManagerOptions(config: ModelManagerConfig): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/**
	 * True for local engines whose built-in discovery runs without a stored key
	 * once explicitly configured (settings/models.yml override, `auth: none`,
	 * or a nonempty {@link keylessBaseUrlEnv}).
	 */
	localDiscoveryWithoutKey?: boolean;
	/**
	 * Environment variable whose nonempty value marks this local engine
	 * keyless for availability and request auth when no credential is stored
	 * (and opts built-in discovery in). A stored key always wins for requests.
	 */
	keylessBaseUrlEnv?: string;
	/** When true, successful runtime discovery replaces bundled provider models instead of merging fallback-only IDs. */
	dynamicModelsAuthoritative?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
}

/** A provider descriptor that has catalog discovery configured. */
export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

/** Type guard for descriptors with catalog discovery. */
export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery != null;
}

/** Whether catalog discovery may run without provider credentials. */
export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

/**
 * One model provider's catalog-side description. The auth half of a provider
 * (env keys, OAuth login/refresh flows) lives in `@oh-my-pi/pi-ai`'s registry;
 * the catalog table below is the single source of truth for ids, default
 * models, and discovery wiring.
 *
 * - Every entry is a member of `KnownProvider`.
 * - `createModelManagerOptions` present (and not `specialModelManager`) ⇒
 *   appears in `PROVIDER_DESCRIPTORS` for runtime model discovery.
 * - \`catalogDiscovery\` present ⇒ participates in \`generate-models.ts\`.
 */
export interface ProviderCatalogEntry {
	readonly id: string;
	/** Preferred model ID when no explicit selection is made. */
	readonly defaultModel: string;
	/** Environment variables consulted (in order) for the provider's runtime API-key env fallback. */
	readonly envVars?: readonly string[];
	/** Runtime model-manager factory. Omitted for catalog-only providers. */
	readonly createModelManagerOptions?: (config: ModelManagerConfig) => ModelManagerOptions<Api>;
	/** When true, the runtime creates a model manager even without a valid API key. */
	readonly allowUnauthenticated?: boolean;
	/** Local engine whose built-in discovery runs without a key once explicitly configured. */
	readonly localDiscoveryWithoutKey?: boolean;
	/** Env var whose nonempty value marks this local engine keyless (no stored credential). */
	readonly keylessBaseUrlEnv?: string;
	/** When true, successful runtime discovery replaces bundled provider models. */
	readonly dynamicModelsAuthoritative?: boolean;
	/** Catalog discovery configuration for generate-models.ts. */
	readonly catalogDiscovery?: CatalogDiscoveryConfig;
	/**
	 * Built bespoke by the coding-agent runtime (OAuth-token-driven managers);
	 * excluded from `PROVIDER_DESCRIPTORS` even though models are discoverable.
	 */
	readonly specialModelManager?: boolean;
}
