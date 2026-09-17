import type { Model } from "@oh-my-pi/pi-ai";
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { modelMentionDisplayName } from "../session/model-mentions";
import type {
	buildSearchAffinity as BuildSearchAffinity,
	buildSessionModelScope as BuildSessionModelScope,
	ModelBrowserItem,
	rankModelItems as RankModelItems,
} from "./components/model-browser";
import { theme } from "./theme/theme";

const MODEL_MENTION_CONTEXT_RE = /(?:^|\s)(\^[^\s]*)$/;
const MAX_MODEL_MENTION_SUGGESTIONS = 20;

/** Supplies picker-ranked model candidates for the query after `^`. */
export type ModelMentionCandidateSource = (query: string) => ReadonlyArray<ModelBrowserItem>;

interface ModelBrowserModules {
	buildSessionModelScope: typeof BuildSessionModelScope;
	buildSearchAffinity: typeof BuildSearchAffinity;
	rankModelItems: typeof RankModelItems;
}

/** Synchronous first-use boundary for the interactive model browser implementation. */
function loadModelBrowser(): ModelBrowserModules {
	return require("./components/model-browser");
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

/** Create a fresh session-scoped model candidate lookup using picker ordering. */
export function createModelMentionSource(host: {
	settings: Settings;
	registry: ModelRegistry;
	scopedModels: () => ReadonlyArray<Model>;
}): ModelMentionCandidateSource {
	return query => {
		const { buildSearchAffinity, buildSessionModelScope, rankModelItems } = loadModelBrowser();
		const scope = buildSessionModelScope(host.settings, host.registry, host.scopedModels());
		if (!query.trim()) return scope.items;
		return rankModelItems(query, scope.items, {
			roles: scope.roles,
			mruOrder: scope.mruOrder,
			affinity: buildSearchAffinity(host.settings.get("modelProviderOrder"), scope.roles, scope.mruOrder),
		});
	};
}
