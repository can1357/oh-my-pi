import { isZeroCostXaiOAuthReference } from "../identity/reference";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model, ModelSpec } from "../types";

/**
 * Project a built `Model` back to spec stage: `compat` becomes the verbatim
 * sparse override record (`compatConfig`), never the resolved view. Discovery
 * mappers spread these references into the specs they hand to the model
 * manager, which rebuilds via `buildModel`.
 */
export function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	const {
		compat: _compat,
		compatConfig,
		supportsComputerUse: _derivedComputerUse,
		supportsComputerUseConfig,
		...rest
	} = model;
	return {
		...rest,
		...(supportsComputerUseConfig !== undefined ? { supportsComputerUse: supportsComputerUseConfig } : {}),
		compat: compatConfig,
	} as ModelSpec<TApi>;
}

export function createBundledReferenceMap<TApi extends Api>(
	provider: Parameters<typeof getBundledModels>[0],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of getBundledModels(provider)) {
		references.set(model.id, toModelSpec(model as Model<TApi>));
	}
	return references;
}

type ProviderReferenceSource<TApi extends Api> = Map<string, ModelSpec<TApi>> | (() => Map<string, ModelSpec<TApi>>);

let globalReferences: Map<string, Model<Api>> | undefined;

function getGlobalReferences(): Map<string, Model<Api>> {
	if (globalReferences) {
		return globalReferences;
	}
	const references = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			if (isZeroCostXaiOAuthReference(candidate)) {
				continue;
			}
			const existing = references.get(candidate.id);
			if (!existing) {
				references.set(candidate.id, candidate);
			} else if (candidate.contextWindow !== existing.contextWindow) {
				if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
					references.set(candidate.id, candidate);
				}
			} else if (candidate.maxTokens !== existing.maxTokens) {
				if ((candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)) {
					references.set(candidate.id, candidate);
				}
			} else if (existing.provider !== "openai" && candidate.provider === "openai") {
				references.set(candidate.id, candidate);
			}
		}
	}
	globalReferences = references;
	return references;
}

export function createReferenceResolver<TApi extends Api>(
	providerReferenceSource: ProviderReferenceSource<TApi>,
): (modelId: string) => ModelSpec<TApi> | undefined {
	let lazyProviderReferences: Map<string, ModelSpec<TApi>> | undefined;
	const getProviderReferences =
		typeof providerReferenceSource === "function"
			? () => (lazyProviderReferences ??= providerReferenceSource())
			: () => providerReferenceSource;
	return (modelId: string) => {
		const providerRefs = getProviderReferences();
		const globalRefs = getGlobalReferences();
		const providerRef = providerRefs.get(modelId);
		if (providerRef) return providerRef;
		const globalRef = globalRefs.get(modelId);
		return globalRef ? toModelSpec(globalRef as Model<TApi>) : undefined;
	};
}
