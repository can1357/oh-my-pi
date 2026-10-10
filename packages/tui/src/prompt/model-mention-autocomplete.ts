import type { Model } from "@oh-my-pi/pi-ai";
import type { AutocompleteItem } from "../index";
import type { ModelBrowserRegistry, ModelBrowserSource } from "../overlays/model-browser";
import { modelMentionDisplayName } from "./model-mention-syntax";
import type {
	buildSearchAffinity as BuildSearchAffinity,
	ModelBrowserItem,
	ModelItemRanker as ModelItemRankerClass,
	SessionModelScopeCache as SessionModelScopeCacheClass,
} from "../overlays/model-browser";
import { theme } from "../theme/theme";

const MODEL_MENTION_CONTEXT_RE = /(?:^|\s)(\^[^\s]*)$/;
const MAX_MODEL_MENTION_SUGGESTIONS = 20;

/** Supplies picker-ranked model candidates for the query after `^`. */
export type ModelMentionCandidateSource = (query: string) => ReadonlyArray<ModelBrowserItem>;

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

/** Build model mention choices for the whitespace-delimited token at the cursor. */
export function getModelMentionSuggestions(
	textBeforeCursor: string,
	candidates: ModelMentionCandidateSource | undefined,
): { items: AutocompleteItem[]; prefix: string } | null {
	if (!candidates) return null;
	const match = textBeforeCursor.match(MODEL_MENTION_CONTEXT_RE);
	const prefix = match?.[1];
	if (!prefix) return null;
	const items = candidates(prefix.slice(1))
		.slice(0, MAX_MODEL_MENTION_SUGGESTIONS)
		.map(item => ({
			value: item.selector,
			label: item.selector,
			description: modelMentionDisplayName(item.model),
			icon: theme.symbol("icon.model"),
			iconName: "model",
		}));
	return items.length > 0 ? { items, prefix } : null;
}

/** Replace the live mention token with the selected canonical selector and a trailing space. */
export function applyModelMentionCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	const liveMatch = textBeforeCursor.match(MODEL_MENTION_CONTEXT_RE);
	const livePrefix = liveMatch?.[1] ?? prefix;
	const prefixStart = liveMatch ? textBeforeCursor.length - livePrefix.length : Math.max(0, cursorCol - prefix.length);
	const replacement = `^${item.value} `;
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
	scopedModelsConfigured?: () => boolean;
}): ModelMentionCandidateSource {
	let scopeCache: SessionModelScopeCacheClass | undefined;
	let ranker: ModelItemRankerClass | undefined;
	let rankerProviderOrder: readonly string[] | undefined;
	return query => {
		const { SessionModelScopeCache, buildSearchAffinity, ModelItemRanker } = loadModelBrowser();
		scopeCache ??= new SessionModelScopeCache(host.source, host.registry);
		const scope = scopeCache.get(host.scopedModels(), host.scopedModelsConfigured?.());
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
}
