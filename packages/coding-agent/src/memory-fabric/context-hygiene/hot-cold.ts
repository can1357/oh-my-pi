/**
 * Adaptive Context Hygiene — hot-cold progressive expansion (ACF CH5).
 *
 * The counterpart to CH4. CH4 renders an F2 item COLD: a compact set of
 * signatures plus a RETAINED POINTER to the full evidence. CH5 is the on-demand
 * inverse: given a cold item and an injectable resolver that can fetch the full
 * ("hot") evidence behind that pointer, promote the item back to hot. This is
 * the plan's F2 promise made operational — "Expandable on demand" (plan §3, F2
 * row; §5 gate step "expand fidelity where confidence/coverage is insufficient";
 * §7 CH5 exit criterion "one expandable cold handle that can be expanded to hot
 * on demand").
 *
 * This is a DELIBERATELY THIN layer. The repository already has a large
 * progressive-context / expansion-triggers / expansion-thresholds stack; CH5
 * does NOT touch or duplicate it. It operates purely on the CH4 cold-item shape
 * (`ProjectedContextItem` + the `projectionPointer` provenance) and a single
 * injectable `HotEvidenceResolver` port, so it is testable in isolation and can
 * be wired to Memvid / Graphify / RetrievalBroker later without coupling.
 *
 * Safety posture (plan §3/§4):
 *   - Expansion only ever ADDS detail; it never removes, reorders, or rewrites
 *     truth. A non-cold item (no retained pointer) is returned untouched.
 *   - No new source of truth / no new parser (rule #10): the hot content comes
 *     exclusively from the injectable resolver (Memvid/Graphify/broker later).
 *   - Fail-open (rule #4): a null/empty/throwing resolver leaves the item COLD,
 *     flagged with a machine-readable skip reason. Expansion can never crash or
 *     blank out a packet.
 *   - Reversible & auditable (rule #1): the cold pointer is preserved on the
 *     hot item's provenance, so a later pass can re-collapse it (CH4) if needed.
 *   - Non-mutating: inputs are cloned.
 *   - Model-aware budgets (rule #16): `expandWithinBudget` promotes cold items
 *     to hot only while an added-token budget allows — capacity is not a target.
 *
 * Additive, injectable, disabled by default (the default resolver expands
 * nothing). Not wired into any hot path.
 */

import { countTokens, heuristicTokenCounter, type TokenCounter } from "../token-accounting/token-accounting";
import type { ProjectedContextItem, ProjectionInfo } from "./project";
import type { ClassifiedContextItem } from "./types";

export const EXPANDER_NAME = "acf-hot-cold-expander";
export const EXPANDER_VERSION = "ch5-1";

/**
 * Fetches the full ("hot") evidence for a cold item's pointer. The one seam CH5
 * needs from the outside world; a real implementation is backed by Memvid /
 * Graphify / the RetrievalBroker. MUST be pure and SHOULD be fast; it may throw
 * or return null — callers go through {@link expandItem}, which fails open.
 *
 * @returns the full evidence text, or null when the pointer cannot be resolved.
 */
export interface HotEvidenceResolver {
	resolve(pointer: string, item: ClassifiedContextItem): string | null;
}

/** Default resolver: resolves nothing (everything stays cold). */
export const nullHotEvidenceResolver: HotEvidenceResolver = {
	resolve: () => null,
};

/** A compact, read-only view of an item's cold state (its expandable handle). */
export interface ColdHandle {
	id: string;
	/** The retained pointer to the full evidence (the expand-on-demand handle). */
	pointer: string;
	/** The current compact (cold) content. */
	coldContent: string;
	coldTokens: number;
	source?: string;
	/** Signature count recorded by CH4, when available. */
	symbolCount?: number;
	/** Hot token count recorded at projection time by CH4, when available. */
	originalTokens?: number;
}

/** Metadata describing a successful expansion (retained on the hot item). */
export interface ExpansionInfo {
	expander: string;
	expanderVersion: string;
	expandedAt: string;
	/** The pointer that was resolved. */
	pointer: string;
	coldTokens: number;
	hotTokens: number;
	/** hotTokens - coldTokens (the cost of promoting to hot; may be negative). */
	addedTokens: number;
}

/** A cold item promoted back to its full hot representation. */
export interface HotContextItem extends ClassifiedContextItem {
	/** True when this item's content is the expanded (hot) evidence. */
	expanded: boolean;
	/** Present only when `expanded` is true. */
	expansion?: ExpansionInfo;
}

export interface ExpandOptions {
	/** Hot-evidence source. Default: {@link nullHotEvidenceResolver} (identity). */
	resolver?: HotEvidenceResolver;
	/** Token counter for telemetry (default heuristic; CH0). */
	counter?: TokenCounter;
	/** Injectable clock for deterministic telemetry timestamps. */
	now?: () => Date;
}

export interface ExpansionReport {
	expander: string;
	expanderVersion: string;
	items: ClassifiedContextItem[];
	/** How many cold items were promoted to hot. */
	expandedCount: number;
	/** Per-item skip reasons (id → why it was not expanded). */
	skipped: Array<{ id: string; reason: string }>;
	tokensBefore: number;
	tokensAfter: number;
	/** tokensAfter - tokensBefore (>= 0; expansion adds tokens by design). */
	added: number;
	failedOpen: boolean;
	generatedAt: string;
}

function tokensOf(text: string, counter: TokenCounter): number {
	return countTokens(text, counter).tokens;
}

function provenanceRecord(item: ClassifiedContextItem): Record<string, unknown> {
	return (item.provenance ?? {}) as unknown as Record<string, unknown>;
}

/** Narrow an unknown provenance value to a number, or undefined when it is not one. */
function numberFrom(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/** The retained cold pointer for an item, from CH4 projection info or provenance. */
export function coldPointerOf(item: ClassifiedContextItem): string | undefined {
	const projection = (item as ProjectedContextItem).projection as ProjectionInfo | undefined;
	if (projection?.pointer) return projection.pointer;
	const fromProvenance = provenanceRecord(item).projectionPointer;
	return typeof fromProvenance === "string" ? fromProvenance : undefined;
}

/** True when an item carries an expandable cold handle (a CH4 projection). */
export function isProjectedCold(item: ClassifiedContextItem): boolean {
	return (item as ProjectedContextItem).projected === true || coldPointerOf(item) !== undefined;
}

/**
 * Read an item's cold handle, or null when it is not cold. Pure, non-mutating.
 */
export function readColdHandle(
	item: ClassifiedContextItem,
	counter: TokenCounter = heuristicTokenCounter,
): ColdHandle | null {
	if (!isProjectedCold(item)) return null;
	const pointer = coldPointerOf(item);
	if (!pointer) return null;
	const projection = (item as ProjectedContextItem).projection as ProjectionInfo | undefined;
	const prov = provenanceRecord(item);
	const originalTokens = projection?.originalTokens ?? numberFrom(prov.projectionOriginalTokens);
	const symbolCount = projection?.symbolCount ?? numberFrom(prov.projectionSymbolCount);
	return {
		id: item.id,
		pointer,
		coldContent: item.content,
		coldTokens: tokensOf(item.content, counter),
		source: item.source,
		symbolCount,
		originalTokens,
	};
}

/**
 * Promote one cold item back to its full hot representation on demand. Only
 * items carrying a CH4 cold handle are ever expanded; everything else is
 * returned as an untouched clone. Pure, deterministic, non-mutating, fail-open.
 *
 * @returns the hot item, or a clone of the original when not expanded, plus a
 *          machine-readable skip reason.
 */
export function expandItem(
	item: ClassifiedContextItem,
	options: ExpandOptions = {},
): { item: HotContextItem; skipped?: string } {
	const now = options.now ?? (() => new Date());
	const counter = options.counter ?? heuristicTokenCounter;
	const clone = (): HotContextItem => ({ ...item, expanded: false });

	try {
		const projected = (item as ProjectedContextItem).projected === true;
		const pointer = coldPointerOf(item);
		// Not cold: no retained pointer and never projected → nothing to expand.
		if (!projected && !pointer) return { item: clone(), skipped: "not-cold" };
		// Projected but somehow missing a pointer → cannot expand (fail closed to cold).
		if (!pointer) return { item: clone(), skipped: "no-pointer" };

		const resolver = options.resolver ?? nullHotEvidenceResolver;
		const hot = resolver.resolve(pointer, item);
		// Unresolved or empty → stay cold (fail open).
		if (hot == null) return { item: clone(), skipped: "unresolved" };
		if (hot.trim().length === 0) return { item: clone(), skipped: "empty-hot" };

		const coldTokens = tokensOf(item.content, counter);
		const hotTokens = tokensOf(hot, counter);
		const expandedAt = now().toISOString();
		const expansion: ExpansionInfo = {
			expander: EXPANDER_NAME,
			expanderVersion: EXPANDER_VERSION,
			expandedAt,
			pointer,
			coldTokens,
			hotTokens,
			addedTokens: hotTokens - coldTokens,
		};

		return {
			item: {
				...item,
				content: hot,
				expanded: true,
				expansion,
				provenance: {
					...item.provenance,
					// Preserve the cold handle so a later pass can re-collapse (CH4).
					expander: EXPANDER_NAME,
					expanderVersion: EXPANDER_VERSION,
					expandedAt,
					expandedFromPointer: pointer,
					coldTokens,
					hotTokens,
				},
			},
		};
	} catch {
		// Fail open (rule #4): never blank out or alter content on error.
		return { item: clone(), skipped: "failed-open" };
	}
}

export interface PlanExpandOptions extends ExpandOptions {
	/**
	 * Selector for WHICH cold items to expand (default: all cold items). Use this
	 * to expand only the items a coverage/confidence check (CH6) flagged as short.
	 */
	shouldExpand?: (item: ClassifiedContextItem) => boolean;
}

/**
 * Expand a batch of items on demand, preserving order. By default every cold
 * item is expanded; pass `shouldExpand` to target only the ones a coverage gate
 * needs promoted. Returns a full report. Fail-open.
 */
export function planExpansion(items: ClassifiedContextItem[], options: PlanExpandOptions = {}): ExpansionReport {
	const now = options.now ?? (() => new Date());
	const counter = options.counter ?? heuristicTokenCounter;
	const generatedAt = now().toISOString();

	try {
		const out: ClassifiedContextItem[] = [];
		const skipped: Array<{ id: string; reason: string }> = [];
		let expandedCount = 0;
		let tokensBefore = 0;
		let tokensAfter = 0;

		for (const item of items) {
			tokensBefore += tokensOf(item.content, counter);
			if (options.shouldExpand !== undefined && !options.shouldExpand(item)) {
				out.push({ ...item });
				tokensAfter += tokensOf(item.content, counter);
				if (isProjectedCold(item)) skipped.push({ id: item.id, reason: "not-selected" });
				continue;
			}
			const result = expandItem(item, options);
			out.push(result.item);
			tokensAfter += tokensOf(result.item.content, counter);
			if (result.item.expanded) expandedCount++;
			else if (result.skipped) skipped.push({ id: item.id, reason: result.skipped });
		}

		return {
			expander: EXPANDER_NAME,
			expanderVersion: EXPANDER_VERSION,
			items: out,
			expandedCount,
			skipped,
			tokensBefore,
			tokensAfter,
			added: tokensAfter - tokensBefore,
			failedOpen: false,
			generatedAt,
		};
	} catch {
		return {
			expander: EXPANDER_NAME,
			expanderVersion: EXPANDER_VERSION,
			items: items.map(i => ({ ...i })),
			expandedCount: 0,
			skipped: [],
			tokensBefore: 0,
			tokensAfter: 0,
			added: 0,
			failedOpen: true,
			generatedAt,
		};
	}
}

export interface BudgetExpandOptions extends ExpandOptions {
	/**
	 * Priority comparator for which cold items to promote first (lower sorts
	 * earlier). Default: cheapest expansion first (smallest recorded hot size),
	 * so a fixed budget promotes as many items as possible. Ties keep input order.
	 */
	priority?: (a: ColdHandle, b: ColdHandle) => number;
}

/** Default priority: cheapest expansion first (smallest recorded hot size). */
function defaultPriority(a: ColdHandle, b: ColdHandle): number {
	return (a.originalTokens ?? Infinity) - (b.originalTokens ?? Infinity);
}

/**
 * Promote cold items to hot only while an ADDED-token budget allows (rule #16:
 * capacity is not a target). Order is preserved in the output; the budget is
 * spent by priority. An item whose expansion would exceed the remaining budget
 * is left cold and flagged "over-budget". Fail-open.
 *
 * @param budgetTokens maximum number of ADDED tokens expansion may spend.
 */
export function expandWithinBudget(
	items: ClassifiedContextItem[],
	budgetTokens: number,
	options: BudgetExpandOptions = {},
): ExpansionReport {
	const now = options.now ?? (() => new Date());
	const counter = options.counter ?? heuristicTokenCounter;
	const generatedAt = now().toISOString();
	const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? Math.floor(budgetTokens) : 0;

	try {
		// Pre-compute cold handles + candidate ordering.
		const handles = new Map<string, ColdHandle>();
		const byId = new Map<string, ClassifiedContextItem>();
		for (const item of items) {
			byId.set(item.id, item);
			const h = readColdHandle(item, counter);
			if (h) handles.set(item.id, h);
		}
		const priority = options.priority ?? defaultPriority;
		const order = [...handles.values()].sort(priority);

		// Greedily select which cold items to promote within budget.
		const selected = new Set<string>();
		let spent = 0;
		for (const h of order) {
			const candidate = byId.get(h.id);
			if (!candidate) continue;
			const trial = expandItem(candidate, options);
			if (!trial.item.expanded || !trial.item.expansion) continue; // unresolvable → skip silently here
			const cost = Math.max(0, trial.item.expansion.addedTokens);
			if (spent + cost <= budget) {
				selected.add(h.id);
				spent += cost;
			}
		}

		// Emit in original order, expanding only the selected ids.
		const out: ClassifiedContextItem[] = [];
		const skipped: Array<{ id: string; reason: string }> = [];
		let expandedCount = 0;
		let tokensBefore = 0;
		let tokensAfter = 0;

		for (const item of items) {
			tokensBefore += tokensOf(item.content, counter);
			const isCold = handles.has(item.id);
			if (isCold && selected.has(item.id)) {
				const result = expandItem(item, options);
				out.push(result.item);
				tokensAfter += tokensOf(result.item.content, counter);
				if (result.item.expanded) expandedCount++;
				else if (result.skipped) skipped.push({ id: item.id, reason: result.skipped });
			} else {
				out.push({ ...item });
				tokensAfter += tokensOf(item.content, counter);
				if (isCold) skipped.push({ id: item.id, reason: "over-budget" });
			}
		}

		return {
			expander: EXPANDER_NAME,
			expanderVersion: EXPANDER_VERSION,
			items: out,
			expandedCount,
			skipped,
			tokensBefore,
			tokensAfter,
			added: tokensAfter - tokensBefore,
			failedOpen: false,
			generatedAt,
		};
	} catch {
		return {
			expander: EXPANDER_NAME,
			expanderVersion: EXPANDER_VERSION,
			items: items.map(i => ({ ...i })),
			expandedCount: 0,
			skipped: [],
			tokensBefore: 0,
			tokensAfter: 0,
			added: 0,
			failedOpen: true,
			generatedAt,
		};
	}
}

/**
 * Build a drop-in expander hook (item → possibly-hot item). Symmetric with
 * CH4's `makeGraphifyProjector`; HotContextItem extends ClassifiedContextItem,
 * so the result is assignable wherever a `ClassifiedContextItem` is expected.
 */
export function makeExpander(options: ExpandOptions = {}): (item: ClassifiedContextItem) => ClassifiedContextItem {
	return item => expandItem(item, options).item;
}

/**
 * Build a {@link HotEvidenceResolver} from a `pointer → full evidence` map. The
 * simplest real resolver: CH4 writes the pointer, a store keyed by that pointer
 * returns the hot content. Proves the CH4 → CH5 round-trip end to end.
 */
export function resolverFromMap(map: Record<string, string> | Map<string, string>): HotEvidenceResolver {
	const lookup = map instanceof Map ? map : new Map<string, string>(Object.entries(map));
	return {
		resolve(pointer: string): string | null {
			const hit = lookup.get(pointer);
			return hit == null ? null : hit;
		},
	};
}
