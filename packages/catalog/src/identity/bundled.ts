/**
 * Memoized proxy-reference index over the bundled model catalog.
 *
 * Lazy: walking every bundled model (~12K) triggers thinking enrichment, so the
 * walk is deferred off module load and performed once. Consumers that need
 * non-bundled reference data use the pure builder directly
 * ({@link buildModelReferenceIndex}).
 */
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model } from "../types";
import { buildModelReferenceIndex, type ModelReferenceIndex } from "./reference";

let bundledModels: readonly Model<Api>[] | undefined;

function getBundledModelList(): readonly Model<Api>[] {
	bundledModels ??= getBundledProviders().flatMap(
		provider => getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[],
	);
	return bundledModels;
}

let referenceIndex: ModelReferenceIndex | undefined;

/** Proxy-reference index over the bundled catalog. */
export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(getBundledModelList());
	return referenceIndex;
}
