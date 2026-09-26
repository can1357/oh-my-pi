import type { CompiledProviderDiscovery } from "../compat/types";
import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl } from "../types";

/** Config passed to a provider's runtime model-manager factory. */
export type ModelManagerConfig = {
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	/** The supplied fetch already applies provider-specific authentication. */
	authenticated?: boolean;
	/**
	 * Account residency region (e.g. `"eu"`) from the stored OAuth
	 * credential, when the provider is region-partitioned and the region is
	 * known. Region-aware discovery uses it to pick the regional API host and
	 * filter region-restricted models.
	 */
	region?: string;
};

/**
 * Catalog discovery configuration for providers that support endpoint-based
 * model listing: the KDL `discovery` node with `envVars` resolved to the
 * provider's `env` when the node omits its own.
 */
export interface CatalogDiscoveryConfig extends Omit<CompiledProviderDiscovery, "envVars"> {
	envVars: readonly string[];
}

/** Unified provider descriptor used by both runtime discovery and catalog generation. */
export interface ProviderDescriptor {
	providerId: string;
	createModelManagerOptions(config: ModelManagerConfig): ModelManagerOptions<Api>;
	/** Preferred model ID when no explicit selection is made. */
	defaultModel: string;
	/** When true, the runtime creates a model manager even without a valid API key (e.g. ollama). */
	allowUnauthenticated?: boolean;
	/** When true, successful runtime discovery replaces bundled provider models instead of merging fallback-only IDs. */
	dynamicModelsAuthoritative?: boolean;
	/** Catalog discovery configuration. Only providers with this field participate in generate-models.ts. */
	catalogDiscovery?: CatalogDiscoveryConfig;
	/**
	 * When true, generator backfills never copy reasoning/input/limits from
	 * same-id rows on other providers into this provider's rows. Set for
	 * providers whose endpoint discovery is the deployment truth and whose
	 * corrections live in KDL, so a stencil.so or canonical-family reference
	 * cannot reintroduce foreign metadata.
	 */
	skipCrossProviderReferenceFills?: boolean;
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
