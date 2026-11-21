/**
 * `get_model_picker`: omp's session model picker (alt+p, `/switch`) served over RPC, so a remote picker such as the
 * Chrome side panel lists models exactly as the TUI does. Browsing puts the Recent block (role-held and recently used
 * models) ahead of the rest; a query ranks by relevance, then the user's role and usage affinity (`provider/` limits it
 * to a provider); a query starting with `@` lists the ctrl+p quick roles. Rows carry the roles a model holds and its
 * thinking slider. Every ordering, ranking and slider rule comes from the TUI picker's own helpers.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { fuzzyRank } from "@oh-my-pi/pi-tui/fuzzy";
import {
	buildSearchAffinity,
	heldRoles,
	type ModelBrowserItem,
	type ModelBrowserSource,
	ModelItemRanker,
	modelSearchText,
	recentBlockLength,
	roleChipLabel,
	type SessionModelScope,
	SessionModelScopeCache,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { thinkingSlider } from "@oh-my-pi/pi-tui/overlays/model-picker";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { cfgCycleOrder } from "../../config/model-settings";
import type { AgentSession } from "../../session/agent-session";
import { createModelBrowserSource } from "../model-browser-source";

/** Rows a picker query returns when the client names no `limit`. */
export const DEFAULT_MODEL_PICKER_LIMIT = 100;

/** A role a model holds, as picker rows chip it. */
export interface RpcModelPickerRole {
	role: string;
	/** The role's display tag. */
	label: string;
	/** Auto-selected: the role has no configured model. */
	auto?: boolean;
}

/** One row of the session model picker. */
export interface RpcModelPickerRow {
	provider: string;
	id: string;
	name: string;
	/** The quick role this row applies (`@` search); the client passes it to `set_model`. */
	role?: string;
	/** Visible roles the model holds, built-in order first. */
	roles?: RpcModelPickerRole[];
	/** Steps of the model's thinking slider, low to high; absent when it has no effort to pick. */
	thinking?: ConfiguredThinkingLevel[];
	/** Model rows: the session's level as this model would run it. Quick-role rows: the role's explicit level. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** The session's context exceeds the model's window. */
	overContext?: boolean;
	/** The session runs this row: its model, or under `@` its active quick role. */
	current?: boolean;
}

/** `get_model_picker` result. */
export interface RpcModelPickerResult {
	rows: RpcModelPickerRow[];
	/** Leading rows in the Recent block; 0 when there is no such split. */
	recent: number;
	/** Matching rows before the limit. */
	total: number;
}

/** The picker for one RPC session; keeps the catalog scope and its search ranker between keystrokes. */
export class RpcModelPicker {
	readonly #session: AgentSession;
	readonly #source: ModelBrowserSource;
	readonly #scopes: SessionModelScopeCache;
	#ranker:
		| { items: readonly ModelBrowserItem[]; providerOrder: readonly string[]; ranker: ModelItemRanker }
		| undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#source = createModelBrowserSource(session.settings, model => session.effectiveServiceTier(model));
		this.#scopes = new SessionModelScopeCache(this.#source, session.modelRegistry);
	}

	/**
	 * Rows for `query`, at most `limit`.
	 * @throws Error when the catalog failed to load and no model is listed.
	 */
	query(query: string, limit: number): RpcModelPickerResult {
		return query.startsWith("@") ? this.#quickRoles(query, limit) : this.#models(query, limit);
	}

	#models(query: string, limit: number): RpcModelPickerResult {
		const session = this.#session;
		const scope = this.#scopes.get(session.scopedModels.map(entry => entry.model));
		if (scope.error !== undefined && scope.items.length === 0) throw new Error(scope.error);
		const ranked = query.trim() ? this.#rank(scope, query) : scope.items;
		const shown = ranked.slice(0, limit);
		// The untouched slider shows the level the session runs at: auto's resolved effort once a turn settled it.
		const level = session.autoResolvedThinkingLevel() ?? session.configuredThinkingLevel();
		const tokens = session.getContextUsage()?.tokens ?? 0;
		const current = session.model;
		const rows = shown.map(({ model }): RpcModelPickerRow => {
			const roles = heldRoles(model, scope.roles, this.#source).map(({ role, assignment }): RpcModelPickerRole => ({
				role,
				label: roleChipLabel(role, this.#source),
				...(assignment.autoSelected ? { auto: true } : {}),
			}));
			const slider = thinkingSlider(model, level);
			const window = model.contextWindow ?? 0;
			return {
				...modelFields(model),
				...(roles.length > 0 ? { roles } : {}),
				...(slider.disabled ? {} : { thinking: [...slider.steps], thinkingLevel: slider.value }),
				...(tokens > 0 && window > 0 && tokens > window ? { overContext: true } : {}),
				...(modelsAreEqual(current, model) ? { current: true } : {}),
			};
		});
		return {
			rows,
			recent: Math.min(recentBlockLength(ranked, scope.roles, scope.mruOrder), rows.length),
			total: ranked.length,
		};
	}

	/** Search ranking, reused while the scope's items and the provider order stand. */
	#rank(scope: SessionModelScope, query: string): ModelBrowserItem[] {
		const providerOrder = this.#source.modelProviderOrder;
		let cached = this.#ranker;
		if (cached?.items !== scope.items || cached.providerOrder !== providerOrder) {
			cached = {
				items: scope.items,
				providerOrder,
				ranker: new ModelItemRanker(scope.items, {
					roles: scope.roles,
					mruOrder: scope.mruOrder,
					affinity: buildSearchAffinity(providerOrder, scope.roles, scope.mruOrder),
				}),
			};
			this.#ranker = cached;
		}
		return cached.ranker.rank(query);
	}

	/** The ctrl+p quick roles in cycle order, fuzzy-filtered by the `@` query as the TUI picker does. */
	#quickRoles(query: string, limit: number): RpcModelPickerResult {
		const cycle = this.#session.getRoleModelCycle(cfgCycleOrder.get(this.#session.settings));
		if (!cycle) return { rows: [], recent: 0, total: 0 };
		const items = cycle.models.map((entry, index): ModelBrowserItem & { index: number } => ({
			provider: "",
			id: `@${entry.role}`,
			model: entry.model,
			selector: `@${entry.role}`,
			index,
		}));
		const matched = query.trim() ? fuzzyRank(items, query, modelSearchText).map(result => result.item) : items;
		const rows = matched.slice(0, limit).map(({ index }): RpcModelPickerRow => {
			const entry = cycle.models[index]!;
			return {
				...modelFields(entry.model),
				role: entry.role,
				...(entry.explicitThinkingLevel && entry.thinkingLevel !== undefined
					? { thinkingLevel: entry.thinkingLevel }
					: {}),
				...(index === cycle.currentIndex ? { current: true } : {}),
			};
		});
		return { rows, recent: 0, total: matched.length };
	}
}

function modelFields(model: Model): Pick<RpcModelPickerRow, "provider" | "id" | "name"> {
	return { provider: model.provider, id: model.id, name: model.name };
}
