import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { AutocompleteItem, ModelMentionCompletion } from "../index";
import type { ModelBrowserRegistry, ModelBrowserSource } from "../overlays/model-browser";
import { subsequenceMatch } from "../autocomplete";
import type { ResolvedModelMention } from "./model-mention-syntax";
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

/** Supplies picker-ranked candidates and the session's mention acceptance boundary. */
export type ModelMentionCandidateSource = ((query: string) => ReadonlyArray<ModelBrowserItem>) & {
	resolveMention: (selector: string) => ResolvedModelMention | undefined;
	roles?: (query?: string) => ReadonlyArray<AutocompleteItem>;
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

function resolvedRow(value: string, resolved: ResolvedModelMention): AutocompleteItem {
	return mentionRow(value, resolved.warning ? `${resolved.name} · ${resolved.warning}` : resolved.name);
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
				const value = `${selector}:${effort}`;
				const resolved = candidates.resolveMention(value);
				if (resolved?.thinkingLevel === effort) levelRows.push(resolvedRow(value, resolved));
			}
		}
		if (levelRows.length > 0) {
			const lowered = query.toLowerCase();
			const literalRows: AutocompleteItem[] = [];
			for (const item of candidates(query)) {
				if (literalRows.length === MAX_MODEL_MENTION_SUGGESTIONS) break;
				if (!item.selector.toLowerCase().includes(lowered)) continue;
				const resolved = candidates.resolveMention(item.selector);
				if (resolved) literalRows.push(resolvedRow(item.selector, resolved));
			}
			const literalValues = new Set(literalRows.map(row => row.value));
			return [...literalRows, ...levelRows.filter(row => !literalValues.has(row.value))];
		}
	}
	const rows: AutocompleteItem[] = [];
	for (const item of candidates(query)) {
		const resolved = candidates.resolveMention(item.selector);
		if (resolved) rows.push(resolvedRow(item.selector, resolved));
		if (rows.length === MAX_MODEL_MENTION_SUGGESTIONS) break;
	}
	return rows;
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
	const roleRows = candidates.roles?.(query) ?? [];
	const items = [...roleRows, ...mentionRows(query, candidates)].slice(0, MAX_MODEL_MENTION_SUGGESTIONS);
	return items.length > 0 ? { kind: "matched", suggestions: { items, prefix } } : { kind: "no-match" };
}

/** Replace the live mention token with the selected selector and a trailing space. */
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
	resolveMention: (selector: string) => ResolvedModelMention | undefined;
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
	const roles = (query = ""): ReadonlyArray<AutocompleteItem> => {
		const colon = query.lastIndexOf(":");
		const roleQuery = (colon > 0 ? query.slice(0, colon) : query).toLowerCase();
		const typedEffort = colon > 0 ? query.slice(colon + 1).toLowerCase() : undefined;
		const items: AutocompleteItem[] = [];
		for (const role of host.source.knownRoleIds) {
			const info = host.source.getRoleInfo(role);
			if (info.hidden || info.section !== "chat") continue;
			const value = `@${role}`;
			if (!subsequenceMatch(roleQuery, value.toLowerCase())) continue;
			if (typedEffort !== undefined) {
				for (const effort of [...THINKING_EFFORTS, "auto"]) {
					if (!effort.startsWith(typedEffort)) continue;
					const selector = `${value}:${effort}`;
					const resolved = host.resolveMention(selector);
					if (resolved) items.push(resolvedRow(selector, resolved));
				}
			} else {
				const resolved = host.resolveMention(value);
				if (resolved) items.push(resolvedRow(value, resolved));
			}
		}
		return items;
	};
	return Object.assign(rank, { resolveMention: host.resolveMention, roles });
}
