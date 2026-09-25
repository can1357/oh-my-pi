/**
 * Catalog metric lookup (intelligence / speed scores) across provider id
 * dialects. The shared catalog scores a model once under its vendor id
 * (`claude-fable-5-1`); hosts re-spell it (`anthropic/claude-fable-5.1`,
 * `global.anthropic.claude-fable-5-1`, `claude-fable-5-1-high`, `k3`), so an
 * index keyed by exact id leaves most of the picker blank.
 *
 * Resolution order, first hit wins:
 * 1. exact lowercased id;
 * 2. candidate ids derived from the wire id (namespace and dotted vendor/region
 *    prefixes, bracket affixes, date/`vN:0` suffixes, declared markers, the
 *    taxonomy logical id) compared on a dot/colon-folded bare name, accepted
 *    only when the classified identities agree.
 *
 * Identity alone (class/family/revision) is deliberately not a key: it
 * conflates `gpt-5.5` with `gpt-5.5-pro` and every Llama with the one that
 * happens to be scored.
 */
import type { ModelIdentity } from "../compat/types";
import type { Api, Model } from "../types";
import { bareModelId } from "./id";
import { getReferenceCandidateIds } from "./reference";

/** Catalog-delivered intelligence score and output speed for one model. */
export interface CatalogMetrics {
	int?: number;
	tps?: number;
}

interface ScoredEntry extends CatalogMetrics {
	identity: ModelIdentity;
}

/** Trailing tokens Bedrock-style ids append without changing the model: `-v1:0`, `-v2`, `:0`, `-20251001`, `-2026-04-23`. */
const STRIPPABLE_SUFFIX_PATTERN = /(?:-v\d+(?::\d+)?|:\d+|-\d{2,})$/;
/** Leading alphabetic dotted namespaces: `global.anthropic.`, `us-gov.`, `openai.`. */
const DOTTED_PREFIX_PATTERN = /^[a-z][a-z-]*\./;

function canonicalKey(id: string): string {
	return bareModelId(id).toLowerCase().replace(/[.:]/g, "-");
}

/** Whether two classified identities may describe the same scored model. Unset ranks on either side are not evidence. */
function identitiesAgree(left: ModelIdentity, right: ModelIdentity): boolean {
	if (left.class !== right.class || left.class === "unknown") return false;
	if (left.family !== undefined && right.family !== undefined && left.family !== right.family) return false;
	if (left.revision !== undefined && right.revision !== undefined && left.revision !== right.revision) return false;
	if (left.effort !== undefined && right.effort !== undefined && left.effort !== right.effort) return false;
	return (left.thinkingVariant ?? false) === (right.thinkingVariant ?? false);
}

/** The catalog metrics a model carries, or undefined when it reports none. A zero speed is "unmeasured", not a score. */
export function catalogMetricsOf(model: Model<Api>): CatalogMetrics | undefined {
	const int = model.int != null && Number.isFinite(model.int) ? model.int : undefined;
	const tps = model.tps != null && Number.isFinite(model.tps) && model.tps > 0 ? model.tps : undefined;
	if (int === undefined && tps === undefined) return undefined;
	return { ...(int !== undefined ? { int } : {}), ...(tps !== undefined ? { tps } : {}) };
}

// Wire ids form a bounded set (bundled + discovered), so no eviction is needed.
const candidateCache = new Map<string, string[]>();

/** Candidate ids for `modelId`, least-stripped first, each already canonical-keyed. */
function metricCandidateKeys(modelId: string): string[] {
	const cached = candidateCache.get(modelId);
	if (cached) return cached;
	const keys: string[] = [];
	const seen = new Set<string>();
	const queue = getReferenceCandidateIds(modelId);
	for (let index = 0; index < queue.length; index++) {
		const candidate = queue[index].toLowerCase();
		const key = canonicalKey(candidate);
		if (!seen.has(key)) {
			seen.add(key);
			keys.push(key);
		}
		const bare = bareModelId(candidate);
		const withoutPrefix = bare.replace(DOTTED_PREFIX_PATTERN, "");
		if (withoutPrefix !== bare && withoutPrefix.length > 0) queue.push(withoutPrefix);
		const withoutSuffix = bare.replace(STRIPPABLE_SUFFIX_PATTERN, "");
		if (withoutSuffix !== bare && withoutSuffix.length > 0) queue.push(withoutSuffix);
	}
	candidateCache.set(modelId, keys);
	return keys;
}

/**
 * Index of catalog metrics over every scored model seen so far. Built once per
 * discovery cycle by the model registry and per provider by the model manager;
 * `add` accumulates across providers so a proxy id resolves against any host's
 * scored row.
 */
export class CatalogMetricsIndex {
	#exact = new Map<string, CatalogMetrics>();
	#canonical = new Map<string, ScoredEntry>();

	constructor(models?: Iterable<Model<Api>>) {
		if (models) this.add(models);
	}

	get isEmpty(): boolean {
		return this.#exact.size === 0;
	}

	/** Record the metrics of every scored model; later rows fill fields earlier rows left unset. */
	add(models: Iterable<Model<Api>>): void {
		for (const model of models) {
			const metrics = catalogMetricsOf(model);
			if (!metrics) continue;
			const exactKey = model.id.toLowerCase();
			const existing = this.#exact.get(exactKey);
			this.#exact.set(exactKey, existing ? { ...metrics, ...existing } : metrics);

			const canonical = canonicalKey(model.id);
			const scored = this.#canonical.get(canonical);
			if (!scored) this.#canonical.set(canonical, { ...metrics, identity: model.identity });
			else if (scored.int === undefined || scored.tps === undefined) {
				this.#canonical.set(canonical, { ...metrics, ...scored });
			}
		}
	}

	/** Metrics for `model` by exact id, else by dialect-normalized id when the classified identities agree. */
	resolve(model: Model<Api>): CatalogMetrics | undefined {
		const exact = this.#exact.get(model.id.toLowerCase());
		if (exact) return exact;
		const identity = model.identity;
		const ids = identity.logicalId ? [model.id, identity.logicalId] : [model.id];
		for (const id of ids) {
			for (const key of metricCandidateKeys(id)) {
				const scored = this.#canonical.get(key);
				if (scored && identitiesAgree(identity, scored.identity)) return scored;
			}
		}
		return undefined;
	}
}

/**
 * Fill each model's `int`/`tps` from `index`. Returns the input array when no
 * model changed so callers can keep identity-based caches.
 */
export function applyCatalogMetrics<TApi extends Api>(
	models: Model<TApi>[],
	index: CatalogMetricsIndex,
): Model<TApi>[] {
	if (index.isEmpty) return models;
	let changed: Model<TApi>[] | undefined;
	for (let position = 0; position < models.length; position++) {
		const model = models[position];
		if (model.int != null && model.tps != null) continue;
		const metrics = index.resolve(model);
		if (!metrics) continue;
		const int = metrics.int ?? model.int;
		const tps = metrics.tps ?? model.tps;
		if (int === model.int && tps === model.tps) continue;
		changed ??= [...models];
		changed[position] = {
			...model,
			...(int != null ? { int } : {}),
			...(tps != null ? { tps } : {}),
		};
	}
	return changed ?? models;
}
