import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { AutocompleteItem, ModelMentionCompletion } from "../index";
import type { ModelBrowserRegistry, ModelBrowserSource, SessionModelScope } from "../overlays/model-browser";
import { sameItems } from "../native/memo";
import { subsequenceMatch } from "../autocomplete";
import { modelMentionDisplayName, modelMentionName } from "./model-mention-syntax";
import type {
	buildSearchAffinity as BuildSearchAffinity,
	ModelBrowserItem,
	ModelItemRanker as ModelItemRankerClass,
	SessionModelScopeCache as SessionModelScopeCacheClass,
} from "../overlays/model-browser";
import { theme } from "../theme/theme";

const MODEL_MENTION_CONTEXT_RE = /(?:^|\s)(\^[^\s]*)$/;
const MAX_MODEL_MENTION_SUGGESTIONS = 20;
const MAX_EFFORT_CANDIDATE_MODELS = 3;

/** A model or role choice with the concrete selector inserted on acceptance. */
export interface ModelMentionItem extends AutocompleteItem {
	modelSelector?: string;
}

/**
 * Supplies picker-ranked model candidates for the query after `^`. `availableModelIds`
 * lists every available model's selector, in or out of the picker scope.
 */
export type ModelMentionCandidateSource = ((query: string) => ReadonlyArray<ModelBrowserItem>) & {
	availableModelIds?: () => ReadonlySet<string>;
	roles?: () => ReadonlyArray<ModelMentionItem>;
};

interface ModelBrowserModules {
	SessionModelScopeCache: typeof SessionModelScopeCacheClass;
	buildSearchAffinity: typeof BuildSearchAffinity;
	ModelItemRanker: typeof ModelItemRankerClass;
}

/** Synchronous first-use boundary for the interactive model browser implementation. */
function loadModelBrowser(): ModelBrowserModules {
	return require("../overlays/model-browser");
}

/** Whether an autocomplete prefix belongs to a model mention. */
export function isModelMentionPrefix(prefix: string): boolean {
	return prefix.startsWith("^");
}

function mentionRow(value: string, description: string): AutocompleteItem {
	return { value, label: value, description, icon: theme.symbol("icon.model"), iconName: "model" };
}

/**
 * Some provider model ids contain a colon or end in a level name (`qwen3:8b`, `glm-4.7:max`),
 * so literal matches are listed before level rows.
 */
function mentionRows(query: string, candidates: ModelMentionCandidateSource): AutocompleteItem[] {
	const colon = query.lastIndexOf(":");
	if (colon > 0) {
		const typed = query.slice(colon + 1).toLowerCase();
		const levelRows: AutocompleteItem[] = [];
		for (const { selector, model } of candidates(query.slice(0, colon)).slice(0, MAX_EFFORT_CANDIDATE_MODELS)) {
			for (const effort of getSupportedEfforts(model)) {
				if (!effort.startsWith(typed)) continue;
				levelRows.push(
					mentionRow(`${selector}:${effort}`, modelMentionName(modelMentionDisplayName(model), effort)),
				);
			}
		}
		if (levelRows.length > 0) {
			const lowered = query.toLowerCase();
			const literalRows: AutocompleteItem[] = [];
			for (const item of candidates(query)) {
				if (literalRows.length === MAX_MODEL_MENTION_SUGGESTIONS) break;
				if (item.selector.toLowerCase().includes(lowered)) {
					literalRows.push(mentionRow(item.selector, modelMentionDisplayName(item.model)));
				}
			}
			const literalValues = new Set(literalRows.map(row => row.value));
			const available = candidates.availableModelIds?.();
			return [
				...literalRows,
				...levelRows.filter(row => !literalValues.has(row.value) && !available?.has(row.value)),
			];
		}
	}
	return candidates(query)
		.slice(0, MAX_MODEL_MENTION_SUGGESTIONS)
		.map(item => mentionRow(item.selector, modelMentionDisplayName(item.model)));
}

/** Build model mention choices for the whitespace-delimited token at the cursor. */
export function getModelMentionSuggestions(
	textBeforeCursor: string,
	candidates: ModelMentionCandidateSource | undefined,
): ModelMentionCompletion {
	if (!candidates) return { kind: "unhandled" };
	const prefix = textBeforeCursor.match(MODEL_MENTION_CONTEXT_RE)?.[1];
	if (!prefix) return { kind: "unhandled" };
	const query = prefix.slice(1);
	const roleQuery = query.toLowerCase();
	const roleRows = (candidates.roles?.() ?? []).filter(item => subsequenceMatch(roleQuery, item.label.toLowerCase()));
	const items = [...roleRows, ...mentionRows(query, candidates)].slice(0, MAX_MODEL_MENTION_SUGGESTIONS);
	return items.length > 0 ? { kind: "matched", suggestions: { items, prefix } } : { kind: "no-match" };
}

/** Replace the live mention token with the selected canonical selector and a trailing space. */
export function applyModelMentionCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: ModelMentionItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	const liveMatch = textBeforeCursor.match(MODEL_MENTION_CONTEXT_RE);
	const livePrefix = liveMatch?.[1] ?? prefix;
	const prefixStart = liveMatch ? textBeforeCursor.length - livePrefix.length : Math.max(0, cursorCol - prefix.length);
	const replacement = `^${item.modelSelector ?? item.value} `;
	const newLines = [...lines];
	newLines[cursorLine] = currentLine.slice(0, prefixStart) + replacement + currentLine.slice(cursorCol);
	return {
		lines: newLines,
		cursorLine,
		cursorCol: prefixStart + replacement.length,
	};
}

/**
 * Create a session-scoped model candidate lookup using picker ordering. The
 * scope and its prepared ranker are reused across queries until their inputs change.
 */
export function createModelMentionSource(host: {
	source: ModelBrowserSource;
	registry: ModelBrowserRegistry;
	scopedModels: () => ReadonlyArray<Model>;
}): ModelMentionCandidateSource {
	let scopeCache: SessionModelScopeCacheClass | undefined;
	let ranker: ModelItemRankerClass | undefined;
	let rankerProviderOrder: readonly string[] | undefined;
	const rank = (query: string): ReadonlyArray<ModelBrowserItem> => {
		const { SessionModelScopeCache, buildSearchAffinity, ModelItemRanker } = loadModelBrowser();
		scopeCache ??= new SessionModelScopeCache(host.source, host.registry);
		const scope = scopeCache.get(host.scopedModels());
		if (!query.trim()) return scope.items;
		const providerOrder = host.source.modelProviderOrder;
		if (ranker?.items !== scope.items || rankerProviderOrder !== providerOrder) {
			ranker = new ModelItemRanker(scope.items, {
				roles: scope.roles,
				mruOrder: scope.mruOrder,
				affinity: buildSearchAffinity(providerOrder, scope.roles, scope.mruOrder),
			});
			rankerProviderOrder = providerOrder;
		}
		return ranker.rank(query);
	};
	let roleCache:
		| {
				scope: SessionModelScope;
				availableIds: ReadonlySet<string>;
				items: ReadonlyArray<ModelMentionItem>;
		  }
		| undefined;
	const roles = (): ReadonlyArray<ModelMentionItem> => {
		const { SessionModelScopeCache } = loadModelBrowser();
		scopeCache ??= new SessionModelScopeCache(host.source, host.registry);
		const scope = scopeCache.get(host.scopedModels());
		const availableIds = availableModelIds();
		if (roleCache?.scope === scope && roleCache.availableIds === availableIds) return roleCache.items;

		const scopedSelectors = new Set<string>();
		for (const item of scope.items) scopedSelectors.add(item.selector);
		const items: ModelMentionItem[] = [];
		for (const role of host.source.knownRoleIds) {
			const info = host.source.getRoleInfo(role);
			if (info.hidden || info.section !== "chat") continue;
			const assignment = scope.roles[role];
			if (!assignment) continue;
			const { model } = assignment;
			const thinkingLevel =
				assignment.thinkingLevel === ThinkingLevel.Inherit ? undefined : assignment.thinkingLevel;
			const selector = `${model.provider}/${model.id}`;
			if (!scopedSelectors.has(selector)) continue;
			const effort = getSupportedEfforts(model).find(level => level === thinkingLevel);
			const value = effort ? `${selector}:${effort}` : selector;
			if (effort && availableIds.has(value)) continue;
			const name = modelMentionDisplayName(model);
			const description = effort
				? modelMentionName(name, effort)
				: thinkingLevel && thinkingLevel !== "auto"
					? `${name} · ${thinkingLevel} unsupported; effort omitted`
					: name;
			items.push({
				...mentionRow(`@${role}`, description),
				modelSelector: value,
			});
		}
		roleCache = { scope, availableIds, items };
		return items;
	};
	let availableModels: readonly Model[] | undefined;
	let availableIds: ReadonlySet<string> = new Set();
	const availableModelIds = (): ReadonlySet<string> => {
		const models = host.registry.getAvailable();
		if (!sameItems(availableModels, models)) {
			availableModels = models;
			availableIds = new Set(models.map(model => `${model.provider}/${model.id}`));
		}
		return availableIds;
	};
	return Object.assign(rank, { availableModelIds, roles });
}
