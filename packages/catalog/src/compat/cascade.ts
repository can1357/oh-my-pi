/**
 * Runtime compat cascade: resolves per-axis wire/thinking/catalog assignments
 * for one structured model target from the compiled rule tree.
 *
 * Faithful port of the o2 reference resolver (`cascade.rs`): rules are
 * conjunctions over `(class, provider, api, upstream, family, revision, models)`; per axis
 * the matching rule with the greatest `(model-selector exactness,
 * constrained-dimension count, priority)` tuple wins, and an equal-tuple
 * same-axis contest throws {@link AmbiguousOverlapError}. Declaration and
 * file order are never semantic.
 *
 * Runtime rules ({@link setRuntimeProviderRule}) join the bundled tree as a
 * second layer: the layer is the last rank component, so a runtime rule wins
 * a tie with a bundled rule and still loses to a more specific one.
 */
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { compileRuleDirectives } from "./axes";
import { parseRevision, type Revision, type RevisionTerm, revisionSatisfies } from "./revision";
import rules from "./rules.json";
import type { CompiledCascade, CompiledRule, CompiledSelector, ResolvedAxes, ResolveTarget } from "./types";

/**
 * Two equal-rank rules contest one axis for a target. CI-time for bundled
 * targets (the parity sweep exercises every catalog row); fix with an
 * explicit `priority=` in the KDL, never in code.
 */
export class AmbiguousOverlapError extends Error {
	constructor(
		readonly provider: string,
		readonly model: string,
		readonly axis: string,
		readonly first: string,
		readonly second: string,
	) {
		super(
			`ambiguous overlap for \`${provider}/${model}\` on axis \`${axis}\`: rules \`${first}\` and \`${second}\` tie; add an explicit priority`,
		);
		this.name = "AmbiguousOverlapError";
	}
}

/**
 * Anchored `*`-wildcard match; both sides must be pre-lowercased. `*` spans
 * any substring; non-wildcard text stays anchored in order.
 *
 * Rule-owned patterns are static after index build, so the split is memoized
 * per pattern string; derived/live patterns share the same bounded cache.
 */
const globSegmentsCache = new Map<string, readonly string[]>();
const GLOB_SEGMENTS_MAX = 4096;

function globSegments(pattern: string): readonly string[] {
	const cached = globSegmentsCache.get(pattern);
	if (cached !== undefined) return cached;
	const segments = pattern.split("*");
	if (globSegmentsCache.size >= GLOB_SEGMENTS_MAX) globSegmentsCache.clear();
	globSegmentsCache.set(pattern, segments);
	return segments;
}

export function globMatch(pattern: string, value: string): boolean {
	const segments = globSegments(pattern);
	const len = segments.length;
	if (len === 1) return value === pattern;
	const head = segments[0];
	if (head.length > 0 && !value.startsWith(head)) return false;
	const tail = segments[len - 1];
	const endLimit = value.length - tail.length;
	if (endLimit < head.length) return false;
	if (tail.length > 0 && !value.endsWith(tail)) return false;
	let pos = head.length;
	for (let i = 1; i < len - 1; i++) {
		const segment = segments[i];
		if (segment.length === 0) continue;
		const found = value.indexOf(segment, pos);
		if (found === -1 || found + segment.length > endLimit) return false;
		pos = found + segment.length;
	}
	return true;
}

interface IndexedRule {
	compiled: CompiledRule;
	revision?: RevisionTerm[];
	priority: number;
	dimensions: number;
	hasExactEffortsRule: boolean;
	order: number;
	/** `exact` model selector values, compared with the raw model id. */
	exactModels?: ReadonlySet<string>;
	/** `glob` and `token` model selectors, compared with the lowercased id. */
	patternModels?: readonly CompiledSelector[];
	/** This rule ranked at model-selector exactness 0, 1 and 2; shared by every target. */
	ranked: readonly RankedRule[];
}

interface RuleIndex {
	globals: IndexedRule[];
	byClass: Map<string, IndexedRule[]>;
	byProvider: Map<string, IndexedRule[]>;
	byClassProvider: Map<string, Map<string, IndexedRule[]>>;
	/**
	 * Rules passing every selector except `models`, in rule order, per identity
	 * key (every target fact except the model id). Lives on the index, so a new
	 * rule set starts with an empty memo.
	 */
	plans?: LRUCache<string, readonly IndexedRule[]>;
}

interface PreparedTarget {
	target: ResolveTarget;
	/** Parsed `target.revision`; `null` when absent or unparsable. Computed on first use. */
	revision?: Revision | null;
	modelLower: string;
	/** Computed on first use; only `token` selectors read it. */
	modelTokens?: readonly string[];
}

/** `(model-selector exactness, constrained dimensions, priority, layer)`; layer 1 is a runtime rule. */
type Rank = readonly [number, number, number, number];

interface RankedRule {
	rule: IndexedRule;
	rank: Rank;
}

let bundledRuleIndex: RuleIndex | undefined;
let ruleIndex: RuleIndex | undefined;
/** Nesting depth of {@link bypassCascadeMemoForTesting}. */
let cascadeMemoBypassDepth = 0;

function appendRule(map: Map<string, IndexedRule[]>, key: string, rule: IndexedRule): void {
	const bucket = map.get(key);
	if (bucket) bucket.push(rule);
	else map.set(key, [rule]);
}

function indexCompiledRule(compiled: CompiledRule, order: number, layer: number): IndexedRule {
	const revision = compiled.revision?.map(term => {
		const parsed = parseRevision(term.revision);
		if (!parsed) throw new Error(`invalid compiled revision term in ${compiled.source}`);
		return { op: term.op, revision: parsed } satisfies RevisionTerm;
	});
	const priority = compiled.priority ?? 0;
	const dimensions =
		Number(compiled.class !== undefined) +
		Number(compiled.providers !== undefined) +
		Number(compiled.apis !== undefined) +
		Number(compiled.upstreams !== undefined) +
		Number(compiled.family !== undefined) +
		Number(compiled.revision !== undefined) +
		Number(compiled.models !== undefined);
	const ranked: RankedRule[] = [];
	const rule: IndexedRule = {
		compiled,
		revision,
		priority,
		dimensions,
		hasExactEffortsRule: compiled.thinking !== undefined && "efforts" in compiled.thinking,
		order,
		ranked,
	};
	for (let exactness = 0; exactness <= 2; exactness++) {
		ranked.push({ rule, rank: [exactness, dimensions, priority, layer] });
	}
	if (compiled.models !== undefined) {
		let exact: Set<string> | undefined;
		let patterns: CompiledSelector[] | undefined;
		for (const selector of compiled.models) {
			if (selector.kind === "exact") {
				(exact ??= new Set()).add(selector.value);
			} else {
				(patterns ??= []).push(selector);
			}
		}
		if (exact !== undefined) rule.exactModels = exact;
		if (patterns !== undefined) rule.patternModels = patterns;
	}
	return rule;
}

function insertIndexedRule(index: RuleIndex, rule: IndexedRule): void {
	const compiled = rule.compiled;
	if (compiled.class === undefined) {
		if (compiled.providers === undefined) {
			index.globals.push(rule);
		} else if (compiled.providers.length === 1) {
			appendRule(index.byProvider, compiled.providers[0], rule);
		} else {
			for (const provider of new Set(compiled.providers)) appendRule(index.byProvider, provider, rule);
		}
		return;
	}
	if (compiled.providers === undefined) {
		appendRule(index.byClass, compiled.class, rule);
		return;
	}
	let providers = index.byClassProvider.get(compiled.class);
	if (!providers) {
		providers = new Map();
		index.byClassProvider.set(compiled.class, providers);
	}
	if (compiled.providers.length === 1) {
		appendRule(providers, compiled.providers[0], rule);
	} else {
		for (const provider of new Set(compiled.providers)) appendRule(providers, provider, rule);
	}
}

function buildRuleIndex(bundled: readonly CompiledRule[], runtime: readonly CompiledRule[] = []): RuleIndex {
	const index: RuleIndex = {
		globals: [],
		byClass: new Map(),
		byProvider: new Map(),
		byClassProvider: new Map(),
	};
	for (let order = 0; order < bundled.length; order++) {
		insertIndexedRule(index, indexCompiledRule(bundled[order], order, 0));
	}
	for (let i = 0; i < runtime.length; i++) {
		insertIndexedRule(index, indexCompiledRule(runtime[i], bundled.length + i, 1));
	}
	return index;
}

function cloneRuleIndexWithRuntime(base: RuleIndex, baseCount: number, runtime: readonly CompiledRule[]): RuleIndex {
	const byProvider = new Map<string, IndexedRule[]>(base.byProvider);
	const index: RuleIndex = {
		globals: base.globals,
		byClass: base.byClass,
		byProvider,
		byClassProvider: base.byClassProvider,
	};
	for (let i = 0; i < runtime.length; i++) {
		const rule = indexCompiledRule(runtime[i], baseCount + i, 1);
		const providers = rule.compiled.providers;
		if (rule.compiled.class === undefined && providers !== undefined) {
			const unique = providers.length === 1 ? providers : new Set(providers);
			for (const provider of unique) {
				const existing = byProvider.get(provider);
				byProvider.set(provider, existing ? [...existing, rule] : [rule]);
			}
		} else {
			// Fallback for any non-provider-only runtime rule.
			return buildRuleIndex(rules.cascade.rules, runtime);
		}
	}
	return index;
}

function getRuleIndex(): RuleIndex {
	if (ruleIndex !== undefined) return ruleIndex;
	bundledRuleIndex ??= buildRuleIndex(rules.cascade.rules);
	if (runtimeRules.size === 0) {
		ruleIndex = bundledRuleIndex;
	} else {
		ruleIndex = cloneRuleIndexWithRuntime(bundledRuleIndex, rules.cascade.rules.length, [...runtimeRules.values()]);
	}
	return ruleIndex;
}

/** Rules bucketed under the target's class and provider, merged back into rule order. */
function relevantRules(index: RuleIndex, target: ResolveTarget): IndexedRule[] {
	const b0 = index.globals;
	const b1 = index.byClass.get(target.class);
	const b2 = index.byProvider.get(target.provider);
	const b3 = index.byClassProvider.get(target.class)?.get(target.provider);
	const total = b0.length + (b1?.length ?? 0) + (b2?.length ?? 0) + (b3?.length ?? 0);
	if (total === 0) return [];
	const relevant: IndexedRule[] = [];
	if (b0.length > 0) for (let i = 0; i < b0.length; i++) relevant.push(b0[i]);
	if (b1 !== undefined) for (let i = 0; i < b1.length; i++) relevant.push(b1[i]);
	if (b2 !== undefined) for (let i = 0; i < b2.length; i++) relevant.push(b2[i]);
	if (b3 !== undefined) for (let i = 0; i < b3.length; i++) relevant.push(b3[i]);
	if (relevant.length > 1) relevant.sort((a, b) => a.order - b.order);
	return relevant;
}

/** Ranks every relevant rule against the target from scratch: the unmemoized reference path. */
function rankRelevantRules(index: RuleIndex, prepared: PreparedTarget): RankedRule[] {
	const ranked: RankedRule[] = [];
	for (const rule of relevantRules(index, prepared.target)) {
		const rank = rankRule(rule, prepared);
		if (rank) ranked.push({ rule, rank });
	}
	return ranked;
}

/**
 * Distinct identity keys held per rule set. A catalog-wide pass sees a few
 * thousand (provider, api, class, family, revision) combinations at most;
 * each entry is an array of shared rule references.
 */
const IDENTITY_PLANS_MAX = 4096;

/** Every target fact a rule's non-model selectors (and its bucket) can read. */
function identityKey(target: ResolveTarget): string {
	return (
		keyPart(target.provider) +
		keyPart(target.api) +
		keyPart(target.upstream) +
		keyPart(target.class) +
		keyPart(target.family) +
		keyPart(target.revision)
	);
}

/**
 * Same ranking as {@link rankRelevantRules}, with the identity selectors
 * evaluated once per identity key: thousands of one provider's models sharing
 * an identity only match `models` selectors per target.
 */
function rankPlannedRules(index: RuleIndex, prepared: PreparedTarget): RankedRule[] {
	const plans = (index.plans ??= new LRUCache<string, readonly IndexedRule[]>({ max: IDENTITY_PLANS_MAX }));
	const key = identityKey(prepared.target);
	let plan = plans.get(key);
	if (plan === undefined) {
		const matched: IndexedRule[] = [];
		for (const rule of relevantRules(index, prepared.target)) {
			if (identityMatches(rule, prepared)) matched.push(rule);
		}
		plan = matched;
		plans.set(key, plan);
	}
	const ranked: RankedRule[] = [];
	for (const rule of plan) {
		const exactness = modelExactness(rule, prepared);
		if (exactness >= 0) ranked.push(rule.ranked[exactness]);
	}
	return ranked;
}

function prepareTarget(target: ResolveTarget): PreparedTarget {
	return { target, modelLower: target.model.toLowerCase() };
}

function targetRevision(prepared: PreparedTarget): Revision | null {
	if (prepared.revision !== undefined) return prepared.revision;
	const { revision } = prepared.target;
	const parsed = (revision === undefined ? undefined : parseRevision(revision)) ?? null;
	prepared.revision = parsed;
	return parsed;
}

function selectorMatches(selector: CompiledSelector, target: PreparedTarget): boolean {
	switch (selector.kind) {
		case "exact":
			return selector.value === target.target.model;
		case "glob":
			return globMatch(selector.value, target.modelLower);
		case "token":
			return (target.modelTokens ??= target.modelLower.split(/[^a-z0-9]+/)).includes(selector.value);
	}
}

/** Whether every selector except `models` admits the target. */
function identityMatches(rule: IndexedRule, prepared: PreparedTarget): boolean {
	const { compiled } = rule;
	const { target } = prepared;
	if (compiled.apis !== undefined && !compiled.apis.includes(target.api)) return false;
	if (
		compiled.upstreams !== undefined &&
		(target.upstream === undefined || !compiled.upstreams.includes(target.upstream))
	)
		return false;
	if (compiled.family !== undefined && compiled.family !== target.family) return false;
	if (rule.revision !== undefined) {
		const revision = targetRevision(prepared);
		if (!revision || !revisionSatisfies(revision, rule.revision)) return false;
	}
	return true;
}

/** Best `models` selector match: 2 exact, 1 glob or token, 0 without selectors, -1 when none matches. */
function modelExactness(rule: IndexedRule, prepared: PreparedTarget): number {
	if (rule.compiled.models === undefined) return 0;
	if (rule.exactModels?.has(prepared.target.model)) return 2;
	if (rule.patternModels) {
		for (const selector of rule.patternModels) {
			if (selectorMatches(selector, prepared)) return 1;
		}
	}
	return -1;
}

/** The rule's {@link Rank} against the target when it matches, else undefined. */
function rankRule(rule: IndexedRule, prepared: PreparedTarget): Rank | undefined {
	const { compiled } = rule;
	if (!identityMatches(rule, prepared)) return undefined;
	let exactness = 0;
	if (compiled.models !== undefined) {
		let best = -1;
		for (const selector of compiled.models) {
			if (!selectorMatches(selector, prepared)) continue;
			const value = selector.kind === "exact" ? 2 : 1;
			if (value > best) best = value;
		}
		if (best < 0) return undefined;
		exactness = best;
	}
	return rule.ranked[exactness].rank;
}

type WinnerTable = Record<string, { rank: Rank; rule: IndexedRule }>;

function rankCompare(a: Rank, b: Rank): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
}

function contestAxis(winners: WinnerTable, axis: string, rank: Rank, rule: IndexedRule, target: ResolveTarget): void {
	const held = winners[axis];
	if (held) {
		const order = rankCompare(held.rank, rank);
		if (order === 0) {
			throw new AmbiguousOverlapError(
				target.provider,
				target.model,
				axis,
				held.rule.compiled.source,
				rule.compiled.source,
			);
		}
		if (order > 0) return;
	}
	winners[axis] = { rank, rule };
}

function contest(
	winners: WinnerTable,
	axes: Record<string, unknown> | undefined,
	rank: Rank,
	rule: IndexedRule,
	target: ResolveTarget,
): void {
	if (!axes) return;
	for (const axis in axes) contestAxis(winners, axis, rank, rule, target);
}

function collect(winners: WinnerTable, pick: (rule: CompiledRule) => Record<string, unknown> | undefined) {
	const out: Record<string, unknown> = {};
	for (const axis in winners) {
		out[axis] = pick(winners[axis].rule.compiled)?.[axis];
	}
	return out;
}

/**
 * Sized above the bundled catalog (~5.6k targets) plus discovered rows so a
 * catalog-wide buildModel pass (discovery, then merge rebuilding the same ids)
 * hits instead of thrashing. Entries share rule values: a few hundred bytes each.
 */
const resolveCache = new LRUCache<string, ResolvedAxes>({ max: 16384 });

/** Runtime rule per provider id, in registration order ({@link setRuntimeProviderRule}). */
const runtimeRules = new Map<string, CompiledRule>();
const rulesChangeListeners: Array<() => void> = [];

/**
 * Adds, replaces, or (with `undefined`) removes the runtime rule assigning
 * `directives` to every model of `provider`: what a KDL `provider "<id>" { … }`
 * block's axis lines would set, keyed by directive (`{ "prompt-perturbation": true }`).
 * The rule ranks as a provider-scoped rule in the runtime layer, so it
 * overrides bundled provider-wide assignments but not model-scoped ones.
 * Clears every memo derived from rule resolution.
 *
 * @throws Error from {@link compileRuleDirectives} when a directive is unknown or its value invalid.
 */
export function setRuntimeProviderRule(
	provider: string,
	directives: Readonly<Record<string, unknown>> | undefined,
): void {
	if (directives === undefined) {
		if (!runtimeRules.delete(provider)) return;
	} else {
		runtimeRules.set(provider, {
			source: `runtime:${provider}`,
			providers: [provider],
			...compileRuleDirectives(directives),
		});
	}
	if (bundledRuleIndex !== undefined && ruleIndex === bundledRuleIndex) {
		bundledRuleIndex.plans = undefined;
	}
	ruleIndex = undefined;
	resolveCache.clear();
	for (const listener of rulesChangeListeners) listener();
}

/** Calls `listener` after every runtime rule change; modules memoizing rule resolution clear their caches there. */
export function onCascadeRulesChange(listener: () => void): void {
	rulesChangeListeners.push(listener);
}

function keyPart(value: string | undefined): string {
	return value === undefined ? "-1:" : `${value.length}:${value}`;
}

function targetKey(target: ResolveTarget): string {
	return (
		keyPart(target.provider) +
		keyPart(target.api) +
		keyPart(target.upstream) +
		keyPart(target.class) +
		keyPart(target.family) +
		keyPart(target.revision) +
		keyPart(target.model) +
		(target.reasoning ? "1" : "0")
	);
}

function cloneAxisValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(cloneAxisValue);
	return cloneAxisRecord(value as Record<string, unknown>);
}

function cloneAxisRecord(source: Record<string, unknown>): Record<string, unknown> {
	const cloned: Record<string, unknown> = {};
	for (const key in source) cloned[key] = cloneAxisValue(source[key]);
	return cloned;
}

function cloneAxes(axes: ResolvedAxes): ResolvedAxes {
	return {
		wire: cloneAxisRecord(axes.wire),
		thinking: cloneAxisRecord(axes.thinking),
		catalog: cloneAxisRecord(axes.catalog),
		reasoning: axes.reasoning,
	};
}

/**
 * Resolve wire, thinking, and catalog assignments for one structured target.
 * Exact model effort corrections and identity-scoped neutral-upgrade policies
 * can enable reasoning; absent family/revision facts never satisfy selectors
 * that require them. Returned axes are caller-owned.
 *
 * @throws AmbiguousOverlapError when equal-rank rules contest one axis.
 */
export function resolveCascade(target: ResolveTarget): ResolvedAxes {
	if (cascadeMemoBypassDepth > 0) {
		return cloneAxes(resolveRanked(target, rankRelevantRules(getRuleIndex(), prepareTarget(target))));
	}
	const key = targetKey(target);
	const cached = resolveCache.get(key);
	if (cached) {
		// Nested rule values are applied to mutable compat records; the cached
		// canonical graph must never escape to those consumers.
		return cloneAxes(cached);
	}
	const resolved = resolveRanked(target, rankPlannedRules(getRuleIndex(), prepareTarget(target)));
	resolveCache.set(key, resolved);
	return cloneAxes(resolved);
}

/**
 * Runs `fn` with every bundled-rule lookup ranked from scratch, skipping the
 * per-target and per-identity memos: the reference that memoized resolution
 * must equal by value. For tests.
 */
export function bypassCascadeMemoForTesting<T>(fn: () => T): T {
	cascadeMemoBypassDepth++;
	try {
		return fn();
	} finally {
		cascadeMemoBypassDepth--;
	}
}

/**
 * Resolve a target against a caller-owned compiled cascade without memoizing
 * mutable rule data. Bundled target lookups use {@link resolveCascade}.
 */
export function resolveCascadeRules(cascade: CompiledCascade, target: ResolveTarget): ResolvedAxes {
	return cloneAxes(resolveRanked(target, rankRelevantRules(buildRuleIndex(cascade.rules), prepareTarget(target))));
}

/**
 * Whether the effort ladder this target resolves to comes from a rule scoped
 * to the model's identity (a recognized class, family, revision, or an explicit
 * model selector), rather than a provider/api-wide or fallback unknown-class
 * rule that any unrecognized id at that provider inherits.
 *
 * Discovery reads this to tell reviewed tiers apart from a blanket default, so
 * catalog-published tiers can correct the latter and never the former.
 */
export function hasModelScopedEffortsRule(target: ResolveTarget): boolean {
	const winners: WinnerTable = {};
	const prepared = prepareTarget(target);
	const ranked =
		cascadeMemoBypassDepth > 0
			? rankRelevantRules(getRuleIndex(), prepared)
			: rankPlannedRules(getRuleIndex(), prepared);
	for (const { rule, rank } of ranked) {
		contest(winners, rule.compiled.thinking, rank, rule, target);
	}
	const winner = winners.efforts?.rule.compiled;
	if (winner === undefined) return false;
	return (
		(winner.class !== undefined && winner.class !== "unknown") ||
		winner.family !== undefined ||
		winner.revision !== undefined ||
		winner.models !== undefined
	);
}

/** Contest the target's ranked rules (in rule order) per axis. */
function resolveRanked(target: ResolveTarget, ranked: readonly RankedRule[]): ResolvedAxes {
	let reasoning = target.reasoning === true;
	if (!reasoning) {
		const upgrade: WinnerTable = {};
		let hasEfforts = false;
		for (const { rule, rank } of ranked) {
			const thinking = rule.compiled.thinking;
			if (thinking === undefined) continue;
			if ("upgradeNeutral" in thinking) contestAxis(upgrade, "upgradeNeutral", rank, rule, target);
			if ("efforts" in thinking) hasEfforts = true;
			if (rule.hasExactEffortsRule && rank[0] === 2) reasoning = true;
		}
		const upgradeRule = upgrade.upgradeNeutral?.rule.compiled;
		const identityScoped =
			upgradeRule !== undefined &&
			((upgradeRule.class !== undefined && upgradeRule.class !== "unknown") ||
				upgradeRule.family !== undefined ||
				upgradeRule.revision !== undefined ||
				upgradeRule.models !== undefined);
		if (identityScoped && upgradeRule?.thinking?.upgradeNeutral === true && hasEfforts) {
			reasoning = true;
		}
	}
	// Unclassified targets get their provider's ladder too: it is offered as
	// unverified thinking (`resolveThinkingPolicy`), never as reasoning capability.
	const offersThinking = reasoning || target.class === "unknown";
	const wire: WinnerTable = {};
	const thinking: WinnerTable = {};
	const catalog: WinnerTable = {};
	for (const { rule, rank } of ranked) {
		contest(wire, rule.compiled.wire, rank, rule, target);
		contest(catalog, rule.compiled.catalog, rank, rule, target);
		if (offersThinking) contest(thinking, rule.compiled.thinking, rank, rule, target);
	}
	return {
		wire: collect(wire, rule => rule.wire),
		thinking: collect(thinking, rule => rule.thinking),
		catalog: collect(catalog, rule => rule.catalog),
		reasoning,
	};
}
