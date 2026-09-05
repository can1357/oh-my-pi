/**
 * High-performance Model Pool Manager.
 *
 * Discovers duplicate equivalent models across authenticated providers,
 * indexes user manual overrides/vetoes, enforces context limit compatibility,
 * and maintains lock-free in-memory health and round-robin cursors.
 */

import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import type { CanonicalModelIndex } from "@pk-nerdsaver-ai/pi-catalog/identity";
import type {
	DynamicRoutingConfig,
	PoolCandidateEvaluation,
	PoolHealthState,
	ResolvedModelPool,
	RoutingStrategy,
} from "./types";

export class ModelPoolManager {
	readonly #config: DynamicRoutingConfig;
	readonly #health = new Map<string, PoolHealthState>();
	readonly #cursors = new Map<string, number>();
	readonly #affinities = new Map<string, string>(); // sessionId -> targetKey

	constructor(config: DynamicRoutingConfig = {}) {
		this.#config = config;
	}

	get isEnabled(): boolean {
		return !!this.#config.enabled;
	}

	get config(): DynamicRoutingConfig {
		return this.#config;
	}

	/** Generate a stable key for a model candidate (e.g. `anthropic/claude-3-7-sonnet`). */
	static getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	/**
	 * Check if two models have an explicit user veto against being pooled.
	 */
	isVetoed(modelA: Model | string, modelB: Model | string): boolean {
		const keyA = typeof modelA === "string" ? modelA : ModelPoolManager.getModelKey(modelA);
		const keyB = typeof modelB === "string" ? modelB : ModelPoolManager.getModelKey(modelB);
		if (keyA === keyB) return false;

		const vetoes = this.#config.vetoes ?? [];
		for (const pair of vetoes) {
			if (pair.length >= 2) {
				if ((pair[0] === keyA && pair[1] === keyB) || (pair[0] === keyB && pair[1] === keyA)) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * Find or resolve a pool for a given selected model.
	 *
	 * The opt-in master switch gates both sources. When enabled, precedence is:
	 * 1. User manual pool where this model is a member.
	 * 2. Canonical model index across authenticated models.
	 */
	resolvePool(
		selectedModel: Model,
		authenticatedModels: readonly Model[],
		canonicalIndex?: CanonicalModelIndex,
	): ResolvedModelPool | null {
		if (!this.isEnabled) return null;

		const selectedKey = ModelPoolManager.getModelKey(selectedModel);
		const defaultStrategy: RoutingStrategy = this.#config.strategy ?? "affinity-fallback";

		// 1. Check user manual pools first (user overwrite power)
		const userPools = this.#config.pools ?? {};
		for (const [poolId, poolConfig] of Object.entries(userPools)) {
			if (poolConfig.enabled === false) continue;
			if (poolConfig.members.includes(selectedKey) || poolConfig.members.includes(selectedModel.id)) {
				// Resolve candidate models matching the configured members
				const candidateMap = new Map<string, Model>();
				for (const member of poolConfig.members) {
					const matched = authenticatedModels.find(
						m => ModelPoolManager.getModelKey(m) === member || m.id === member,
					);
					if (matched && !this.isVetoed(selectedModel, matched)) {
						candidateMap.set(ModelPoolManager.getModelKey(matched), matched);
					}
				}
				// Make sure selectedModel is included
				candidateMap.set(selectedKey, selectedModel);

				if (candidateMap.size > 1) {
					return {
						id: poolId,
						name: poolConfig.name ?? poolId,
						strategy: poolConfig.strategy ?? defaultStrategy,
						candidates: [...candidateMap.values()],
					};
				}
			}
		}

		// 2. Dynamic grouping via CanonicalModelIndex
		if (canonicalIndex) {
			const canonicalId =
				canonicalIndex.bySelector.get(selectedKey) ?? canonicalIndex.bySelector.get(selectedModel.id);
			if (canonicalId) {
				const record = canonicalIndex.byId.get(canonicalId);
				if (record && record.variants.length > 1) {
					// Collect all authenticated models that map to this canonical ID
					const candidates: Model[] = [];
					for (const m of authenticatedModels) {
						const key = ModelPoolManager.getModelKey(m);
						const mCanon = canonicalIndex.bySelector.get(key) ?? canonicalIndex.bySelector.get(m.id);
						if (mCanon === canonicalId) {
							if (!this.isVetoed(selectedModel, m)) {
								candidates.push(m);
							}
						}
					}

					// Deduplicate by provider/id
					const unique = new Map<string, Model>();
					for (const c of candidates) {
						unique.set(ModelPoolManager.getModelKey(c), c);
					}
					unique.set(selectedKey, selectedModel);

					if (unique.size > 1) {
						return {
							id: canonicalId,
							name: record.name || canonicalId,
							strategy: defaultStrategy,
							candidates: [...unique.values()],
						};
					}
				}
			}
		}

		return null;
	}

	/**
	 * Evaluate candidate models in a pool against the current context tokens.
	 *
	 * Context Limit Rule:
	 * An inference provider is only eligible if its contextWindow is sufficient
	 * to hold the current prompt context (contextWindow >= currentContextTokens).
	 */
	evaluateCandidates(pool: ResolvedModelPool, currentContextTokens = 0, now = Date.now()): PoolCandidateEvaluation[] {
		return pool.candidates.map(model => {
			const key = ModelPoolManager.getModelKey(model);
			const health = this.#health.get(key);
			const coolingUntil = health?.coolingUntil ?? 0;
			const isCooling = coolingUntil > now;
			const coolingRemainingMs = isCooling ? coolingUntil - now : 0;

			// Context check: if contextWindow is defined (> 0), it must be >= currentContextTokens
			const window = model.contextWindow ?? 0;
			const isContextSufficient = currentContextTokens <= 0 || window <= 0 || window >= currentContextTokens;

			return {
				model,
				isCooling,
				isContextSufficient,
				coolingRemainingMs,
			};
		});
	}

	/**
	 * Select the next target model from the pool for a turn:
	 *
	 * - Filter for context-sufficient candidates.
	 * - Filter for non-cooling candidates (or fallback to least-cooling if all are cooling).
	 * - Apply Strategy:
	 *   - "affinity-fallback": stick with previous target for this session if healthy (protect KV cache TTFT),
	 *     otherwise take the primary or next available.
	 *   - "round-robin": increment pool cursor.
	 */
	selectTarget(
		pool: ResolvedModelPool,
		options: {
			sessionId?: string;
			currentContextTokens?: number;
			preferredModel?: Model;
		} = {},
		now = Date.now(),
	): Model {
		const evaluations = this.evaluateCandidates(pool, options.currentContextTokens ?? 0, now);

		// Eligible = context limit is sufficient
		const eligible = evaluations.filter(e => e.isContextSufficient);
		const targetPool = eligible.length > 0 ? eligible : evaluations;

		// Healthy = not in cooldown
		const healthy = targetPool.filter(e => !e.isCooling);
		const candidates = healthy.length > 0 ? healthy.map(e => e.model) : targetPool.map(e => e.model);

		if (candidates.length === 1) {
			return candidates[0];
		}

		const preferredKey = options.preferredModel ? ModelPoolManager.getModelKey(options.preferredModel) : undefined;
		const sessionId = options.sessionId ?? "default";

		if (pool.strategy === "round-robin") {
			const cursor = this.#cursors.get(pool.id) ?? 0;
			const selected = candidates[cursor % candidates.length];
			this.#cursors.set(pool.id, (cursor + 1) % candidates.length);
			return selected;
		}

		// Affinity-fallback strategy (optimal for prompt-cache hits):
		// 1. Check if the session has an affinity to an active healthy candidate
		const sessionAffinity = this.#affinities.get(sessionId);
		if (sessionAffinity) {
			const matched = candidates.find(c => ModelPoolManager.getModelKey(c) === sessionAffinity);
			if (matched) {
				return matched;
			}
		}

		// 2. Try preferred model (e.g. what user explicitly clicked or configured as primary)
		if (preferredKey) {
			const matched = candidates.find(c => ModelPoolManager.getModelKey(c) === preferredKey);
			if (matched) {
				this.#affinities.set(sessionId, preferredKey);
				return matched;
			}
		}

		// 3. Pick first healthy candidate and remember affinity
		const selected = candidates[0];
		this.#affinities.set(sessionId, ModelPoolManager.getModelKey(selected));
		return selected;
	}

	/**
	 * Mark a provider/model target as cooling down after a rate-limit / capacity failure.
	 */
	markFailure(model: Model, error?: unknown, now = Date.now()): void {
		const key = ModelPoolManager.getModelKey(model);
		const current = this.#health.get(key) ?? { coolingUntil: 0, consecutiveFailures: 0 };
		const failures = current.consecutiveFailures + 1;

		// Base cooldown: default 60s, exponential backoff with a cap at 10 minutes
		const baseCooldown = this.#config.cooldownDurationMs ?? 60_000;
		const duration = Math.min(baseCooldown * 2 ** (failures - 1), 600_000);

		this.#health.set(key, {
			coolingUntil: now + duration,
			consecutiveFailures: failures,
			lastError: error instanceof Error ? error.message : String(error ?? "Rate limit or capacity error"),
		});
	}

	/**
	 * Reset failure status on a successful request.
	 */
	markSuccess(model: Model): void {
		const key = ModelPoolManager.getModelKey(model);
		const current = this.#health.get(key);
		if (current && current.consecutiveFailures > 0) {
			this.#health.set(key, {
				coolingUntil: 0,
				consecutiveFailures: 0,
			});
		}
	}

	/**
	 * Reset health status for all or a specific model.
	 */
	resetHealth(targetKey?: string): void {
		if (targetKey) {
			this.#health.delete(targetKey);
		} else {
			this.#health.clear();
		}
	}

	/** Get current health snapshot for reporting. */
	getHealthSnapshot(): ReadonlyMap<string, PoolHealthState> {
		return this.#health;
	}
}
