/**
 * Unified mention source for models (+ thinking effort).
 *
 * Reuses the model browser's scope, search affinity, provider-scoped queries,
 * `ModelItemRanker`, role assignments, provider marks, and pricing facts so `@`
 * and `^` carry 100% of the model selector's intelligence synchronously on frame 0.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import {
	buildSearchAffinity,
	buildSessionModelScope,
	compactModelSearchText,
	type ModelBrowserItem,
	type ModelBrowserSource,
	ModelItemRanker,
	ModelSearchIndex,
	parseProviderScopedQuery,
	pickerPrice,
	providerMark,
	type RoleAssignments,
	type SessionModelScope,
	thinkingDotToken,
} from "../../../modes/view-model/overlays/model-browser";
import { modelMentionDisplayName, modelMentionName } from "../../../session/model-mention-syntax";
import { AUTO_THINKING } from "../../../thinking/levels";
import type { DiscoveryRetryRegistry } from "../../model-mention";
import {
	MATCH_TIER,
	type MatchTier,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceResult,
} from "../types";

const MAX_MODEL_ITEMS = 25;
const MAX_EFFORT_CANDIDATE_MODELS = 3;

export interface ModelsMentionHost {
	readonly source: ModelBrowserSource;
	readonly registry: DiscoveryRetryRegistry;
	readonly scopedModels: () => ReadonlyArray<Model>;
}

function formatContextShort(tokens: number | null | undefined): string {
	if (!tokens || tokens <= 0) return "";
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
	}
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
}

/** Collect role chips pointing at `model` (explicitly configured roles first). */
function roleChipsFor(
	selector: string,
	roles: RoleAssignments,
	source: ModelBrowserSource,
): Array<{ text: string; on?: boolean; auto?: boolean; dot?: string }> {
	const chips: Array<{ text: string; on?: boolean; auto?: boolean; dot?: string }> = [];
	for (const role of source.knownRoleIds) {
		const assignment = roles[role];
		if (!assignment || assignment.autoSelected) continue;
		const assignedSelector = `${assignment.model.provider}/${assignment.model.id}`;
		if (assignedSelector !== selector) continue;
		const info = source.getRoleInfo(role);
		if (info.hidden) continue;
		const dot = thinkingDotToken(assignment.thinkingLevel);
		chips.push({
			text: info.tag ?? role,
			on: true,
			...(dot ? { dot } : {}),
		});
		if (chips.length >= 2) break;
	}
	return chips;
}

/** Classify match tier for a ranked model hit so the Intent Arbiter can suppress weak noise. */
function classifyModelTier(query: string, item: ModelBrowserItem, matchedRole: boolean): MatchTier {
	const trimmed = query.trim();
	if (!trimmed) return MATCH_TIER.Medium;
	if (matchedRole) return MATCH_TIER.Exact;

	const scoped = parseProviderScopedQuery(trimmed);
	if (scoped) {
		const compactModel = compactModelSearchText(scoped.model);
		const compactId = compactModelSearchText(item.id);
		if (!compactModel || compactId === compactModel) return MATCH_TIER.Exact;
		if (compactId.startsWith(compactModel) || compactId.includes(compactModel)) return MATCH_TIER.Strong;
		return MATCH_TIER.Medium;
	}

	const qKey = compactModelSearchText(trimmed);
	const idKey = compactModelSearchText(item.id);
	const selKey = compactModelSearchText(item.selector);
	const nameKey = compactModelSearchText(item.model.name);
	if (qKey === idKey || qKey === selKey || qKey === nameKey) return MATCH_TIER.Exact;

	const lower = trimmed.toLowerCase();
	const lowerId = item.id.toLowerCase();
	const lowerName = item.model.name.toLowerCase();
	if (
		idKey.startsWith(qKey) ||
		nameKey.startsWith(qKey) ||
		lowerId.includes(`-${lower}`) ||
		lowerId.includes(`/${lower}`) ||
		lowerName.includes(` ${lower}`) ||
		lowerName.startsWith(lower)
	) {
		return MATCH_TIER.Strong;
	}
	if (idKey.includes(qKey) || selKey.includes(qKey) || nameKey.includes(qKey)) {
		return MATCH_TIER.Medium;
	}
	return MATCH_TIER.Weak;
}

function buildModelItem(
	item: ModelBrowserItem,
	tier: MatchTier,
	roles: RoleAssignments,
	source: ModelBrowserSource,
	effort?: Effort,
): MentionItem {
	const displayName = modelMentionDisplayName(item.model);
	const supported = getSupportedEfforts(item.model);
	const canonicalSelector = effort ? `${item.selector}:${effort}` : item.selector;
	const label = effort ? modelMentionName(displayName, effort) : displayName;
	const ctx = formatContextShort(item.model.contextWindow);
	const price = pickerPrice(item.model);
	const chips = roleChipsFor(item.selector, roles, source);
	if (effort) {
		const dot = thinkingDotToken(effort);
		chips.push({ text: effort, on: true, ...(dot ? { dot } : {}) });
	}
	const facts: Record<string, string> = {};
	if (ctx) facts.meta = ctx;
	if (price) facts.right = price;

	return {
		category: "models",
		tier,
		value: canonicalSelector,
		insertText: `^${canonicalSelector}`,
		appendSpace: true,
		label: canonicalSelector,
		description: label,
		nativeDetail: item.provider,
		state: [ctx, price].filter(Boolean).join(" · ") || undefined,
		icon: currentTheme().symbols.symbol("mention.model"),
		iconName: "model",
		pickerItem: {
			id: `model:${canonicalSelector}`,
			label: displayName,
			detail: item.selector,
			mark: providerMark(item.provider),
			...(chips.length > 0 ? { chips } : {}),
			...(ctx || price ? { facts } : {}),
		},
		...(supported.length > 0
			? {
					modelEffort: {
						selector: item.selector,
						displayName,
						supported,
						selected: effort ?? AUTO_THINKING,
						provider: item.provider,
					},
				}
			: {}),
	};
}

/**
 * Unified model + thinking mention source backed by the session's model browser scope
 * and `ModelItemRanker`. Exposes {@link hasProviderPrefix} for slash disambiguation.
 */
export class ModelsMentionSource implements MentionSource {
	readonly id = "models" as const;
	readonly label = "Models";

	readonly #host: ModelsMentionHost;
	#ranker?: ModelItemRanker;
	#searchIndex = new ModelSearchIndex();
	#rankerProviderOrder?: readonly string[];
	#providerCache?: { items: ReadonlyArray<ModelBrowserItem>; keys: ReadonlySet<string> };
	#availableCache?: { models: readonly Model[]; ids: ReadonlySet<string> };

	constructor(host: ModelsMentionHost) {
		this.#host = host;
	}

	#scope(): SessionModelScope {
		return buildSessionModelScope(this.#host.source, this.#host.registry, this.#host.scopedModels());
	}

	#getRanker(scope: SessionModelScope): ModelItemRanker {
		const providerOrder = this.#host.source.modelProviderOrder;
		if (this.#ranker?.items !== scope.items || this.#rankerProviderOrder !== providerOrder) {
			this.#ranker = new ModelItemRanker(scope.items, {
				roles: scope.roles,
				mruOrder: scope.mruOrder,
				affinity: buildSearchAffinity(providerOrder, scope.roles, scope.mruOrder),
			});
			this.#searchIndex = new ModelSearchIndex();
			this.#rankerProviderOrder = providerOrder;
		}
		return this.#ranker;
	}

	#availableIds(): ReadonlySet<string> {
		const models = this.#host.registry.getAvailable();
		if (
			this.#availableCache &&
			this.#availableCache.models.length === models.length &&
			this.#availableCache.models.every((m, i) => m === models[i])
		) {
			return this.#availableCache.ids;
		}
		const ids = new Set(models.map(m => `${m.provider}/${m.id}`));
		this.#availableCache = { models, ids };
		return ids;
	}

	/** Whether `head` prefixes any available model provider id (used to disambiguate `anthropic/…` vs `src/…`). */
	hasProviderPrefix(head: string): boolean {
		const key = compactModelSearchText(head);
		if (!key) return false;
		const scope = this.#scope();
		if (this.#providerCache?.items !== scope.items) {
			const keys = new Set<string>();
			for (const item of scope.items) keys.add(compactModelSearchText(item.provider));
			this.#providerCache = { items: scope.items, keys };
		}
		for (const providerKey of this.#providerCache.keys) {
			if (providerKey === key || providerKey.startsWith(key)) return true;
		}
		return false;
	}

	querySync(q: MentionQuery): MentionSourceResult {
		const scope = this.#scope();
		if (scope.items.length === 0) {
			return { category: "models", items: [], bestTier: MATCH_TIER.None, total: 0, available: false };
		}

		const ranker = this.#getRanker(scope);
		const trimmed = q.query.trim();

		// Bare query: return session scope items in MRU/role order.
		if (!trimmed && q.modelEffortSuffix === undefined) {
			const items = scope.items
				.slice(0, MAX_MODEL_ITEMS)
				.map(item => buildModelItem(item, MATCH_TIER.Medium, scope.roles, this.#host.source));
			return {
				category: "models",
				items,
				bestTier: MATCH_TIER.Medium,
				total: scope.items.length,
				available: true,
			};
		}

		// Handle typed `:effort` suffix (e.g. `@opus:h` or `^anthropic/claude-opus-4-6:high`),
		// keeping literal colon model ids (`qwen3:8b`, `glm-4.7:max`) ahead of effort rows.
		if (q.modelEffortSuffix !== undefined) {
			const typedEffort = q.modelEffortSuffix;
			const baseCandidates = trimmed ? ranker.rank(trimmed, this.#searchIndex) : scope.items;
			const levelItems: MentionItem[] = [];
			for (const candidate of baseCandidates.slice(0, MAX_EFFORT_CANDIDATE_MODELS)) {
				for (const effort of getSupportedEfforts(candidate.model)) {
					if (!effort.startsWith(typedEffort)) continue;
					const tier =
						effort === typedEffort
							? MATCH_TIER.Exact
							: (Math.min(MATCH_TIER.Strong, classifyModelTier(trimmed, candidate, false)) as MatchTier);
					levelItems.push(buildModelItem(candidate, tier, scope.roles, this.#host.source, effort));
				}
			}
			const fullQuery = `${trimmed}:${typedEffort}`;
			const lowered = fullQuery.toLowerCase();
			const literalItems: MentionItem[] = [];
			for (const candidate of ranker.rank(fullQuery, this.#searchIndex)) {
				if (literalItems.length >= MAX_MODEL_ITEMS) break;
				if (!candidate.selector.toLowerCase().includes(lowered)) continue;
				literalItems.push(
					buildModelItem(
						candidate,
						classifyModelTier(fullQuery, candidate, false),
						scope.roles,
						this.#host.source,
					),
				);
			}
			if (levelItems.length > 0 || literalItems.length > 0) {
				const literalValues = new Set(literalItems.map(item => item.value));
				const available = this.#availableIds();
				const combined = [
					...literalItems,
					...levelItems.filter(item => !literalValues.has(item.value) && !available.has(item.value)),
				].slice(0, MAX_MODEL_ITEMS);
				const bestTier = combined.reduce<MatchTier>(
					(best, item) => (item.tier < best ? item.tier : best),
					MATCH_TIER.None,
				);
				return {
					category: "models",
					items: combined,
					bestTier,
					total: combined.length,
					available: true,
				};
			}
		}

		// Check direct role alias matches (`@slow`, `@smol`, `@plan`, `@task`, …).
		const lowerQuery = trimmed.toLowerCase();
		const roleMatchedSelectors = new Set<string>();
		const roleItems: MentionItem[] = [];
		const itemBySelector = new Map<string, ModelBrowserItem>();
		for (const item of scope.items) itemBySelector.set(item.selector, item);

		for (const role of this.#host.source.knownRoleIds) {
			const assignment = scope.roles[role];
			if (!assignment) continue;
			const info = this.#host.source.getRoleInfo(role);
			if (info.hidden) continue;
			const tag = (info.tag ?? role).toLowerCase();
			if (role.toLowerCase() === lowerQuery || tag === lowerQuery) {
				const selector = `${assignment.model.provider}/${assignment.model.id}`;
				const browserItem = itemBySelector.get(selector);
				if (browserItem && !roleMatchedSelectors.has(selector)) {
					roleMatchedSelectors.add(selector);
					// The role names the model only: like every default mention it inherits thinking,
					// so `@opus` with `opus: claude-opus-5-5:high` inserts the bare model.
					roleItems.push(buildModelItem(browserItem, MATCH_TIER.Exact, scope.roles, this.#host.source));
				}
			}
		}

		const explicit = q.trigger === "^" || q.syntaxLock === "models" || trimmed.includes("/");
		const qCompact = compactModelSearchText(trimmed);
		const ranked = ranker.rank(trimmed, this.#searchIndex);
		const items: MentionItem[] = [...roleItems];
		for (const candidate of ranked) {
			if (items.length >= MAX_MODEL_ITEMS) break;
			if (roleMatchedSelectors.has(candidate.selector)) continue;
			// Under unlocked `@`, ignore provider-only matches (e.g. `@co` matching `openai-codex/*`)
			// so unrelated models never drown out workspace files.
			if (!explicit && qCompact) {
				const idKey = compactModelSearchText(candidate.id);
				const nameKey = compactModelSearchText(candidate.model.name);
				if (!idKey.includes(qCompact) && !nameKey.includes(qCompact)) continue;
			}
			const tier = classifyModelTier(trimmed, candidate, false);
			if (!explicit && tier >= MATCH_TIER.Weak) continue;
			items.push(buildModelItem(candidate, tier, scope.roles, this.#host.source));
		}

		const bestTier = items.reduce<MatchTier>((best, item) => (item.tier < best ? item.tier : best), MATCH_TIER.None);
		return {
			category: "models",
			items,
			bestTier,
			total: Math.max(items.length, ranked.length),
			available: true,
		};
	}

	async queryAsync(
		q: MentionQuery,
		signal: AbortSignal,
		_onPartial: (result: MentionSourceResult) => void,
	): Promise<MentionSourceResult | null> {
		const pending = this.#host.registry.retryUnavailableDiscovery();
		if (!pending) return null;
		await untilAborted(signal, pending);
		if (signal.aborted) return null;
		return this.querySync(q);
	}
}
