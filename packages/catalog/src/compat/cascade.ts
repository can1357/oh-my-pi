/**
 * Runtime compat cascade: resolves per-axis wire/thinking/catalog assignments
 * for one structured model target from the compiled rule tree.
 *
 * Faithful port of the o2 reference resolver (`cascade.rs`): rules are
 * conjunctions over `(class, provider, api, family, revision, models)`; per axis
 * the matching rule with the greatest `(model-selector exactness,
 * constrained-dimension count, priority)` tuple wins, and an equal-tuple
 * same-axis contest throws {@link AmbiguousOverlapError}. Declaration and
 * file order are never semantic.
 */
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
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
 */
export function globMatch(pattern: string, value: string): boolean {
	const segments = pattern.split("*");
	if (segments.length === 1) return value === pattern;
	const head = segments[0];
	if (!value.startsWith(head)) return false;
	let remainder = value.slice(head.length);
	for (let i = 1; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!segment) continue;
		const found = remainder.indexOf(segment);
		if (found === -1) return false;
		remainder = remainder.slice(found + segment.length);
	}
	const last = segments[segments.length - 1];
	return last === "" || remainder.endsWith(last);
}

interface IndexedRule {
	compiled: CompiledRule;
	revision?: RevisionTerm[];
	priority: number;
	dimensions: number;
	hasExactEffortsRule: boolean;
	order: number;
}

interface RuleIndex {
	globals: IndexedRule[];
	byClass: Map<string, IndexedRule[]>;
	byProvider: Map<string, IndexedRule[]>;
	byClassProvider: Map<string, Map<string, IndexedRule[]>>;
}

interface PreparedTarget {
	target: ResolveTarget;
	revision: Revision | undefined;
	modelLower: string;
	modelTokens: readonly string[];
}

interface RankedRule {
	rule: IndexedRule;
	rank: readonly [number, number, number];
}

let ruleIndex: RuleIndex | undefined;

function appendRule(map: Map<string, IndexedRule[]>, key: string, rule: IndexedRule): void {
	const bucket = map.get(key);
	if (bucket) bucket.push(rule);
	else map.set(key, [rule]);
}

function buildRuleIndex(cascade: CompiledCascade): RuleIndex {
	const index: RuleIndex = {
		globals: [],
		byClass: new Map(),
		byProvider: new Map(),
		byClassProvider: new Map(),
	};
	for (let order = 0; order < cascade.rules.length; order++) {
		const compiled = cascade.rules[order];
		const revision = compiled.revision?.map(term => {
			const parsed = parseRevision(term.revision);
			if (!parsed) throw new Error(`invalid compiled revision term in ${compiled.source}`);
			return { op: term.op, revision: parsed } satisfies RevisionTerm;
		});
		const rule: IndexedRule = {
			compiled,
			revision,
			priority: compiled.priority ?? 0,
			dimensions:
				Number(compiled.class !== undefined) +
				Number(compiled.providers !== undefined) +
				Number(compiled.apis !== undefined) +
				Number(compiled.family !== undefined) +
				Number(compiled.revision !== undefined) +
				Number(compiled.models !== undefined),
			hasExactEffortsRule: compiled.thinking !== undefined && "efforts" in compiled.thinking,
			order,
		};
		if (compiled.class === undefined) {
			if (compiled.providers === undefined) {
				index.globals.push(rule);
			} else {
				for (const provider of new Set(compiled.providers)) appendRule(index.byProvider, provider, rule);
			}
			continue;
		}
		if (compiled.providers === undefined) {
			appendRule(index.byClass, compiled.class, rule);
			continue;
		}
		let providers = index.byClassProvider.get(compiled.class);
		if (!providers) {
			providers = new Map();
			index.byClassProvider.set(compiled.class, providers);
		}
		for (const provider of new Set(compiled.providers)) appendRule(providers, provider, rule);
	}
	return index;
}

function getRuleIndex(): RuleIndex {
	ruleIndex ??= buildRuleIndex(rules.cascade);
	return ruleIndex;
}

function rankRelevantRules(index: RuleIndex, prepared: PreparedTarget): RankedRule[] {
	const { target } = prepared;
	const buckets = [
		index.globals,
		index.byClass.get(target.class),
		index.byProvider.get(target.provider),
		index.byClassProvider.get(target.class)?.get(target.provider),
	];
	const positions = [0, 0, 0, 0];
	const ranked: RankedRule[] = [];
	while (true) {
		let nextBucket = -1;
		let nextOrder = Number.POSITIVE_INFINITY;
		for (let bucket = 0; bucket < buckets.length; bucket++) {
			const candidate = buckets[bucket]?.[positions[bucket]];
			if (candidate && candidate.order < nextOrder) {
				nextBucket = bucket;
				nextOrder = candidate.order;
			}
		}
		if (nextBucket < 0) return ranked;
		const rule = buckets[nextBucket]![positions[nextBucket]++];
		const rank = rankRule(rule, prepared);
		if (rank) ranked.push({ rule, rank });
	}
}

function prepareTarget(target: ResolveTarget): PreparedTarget {
	const modelLower = target.model.toLowerCase();
	return {
		target,
		revision: target.revision === undefined ? undefined : parseRevision(target.revision),
		modelLower,
		modelTokens: modelLower.split(/[^a-z0-9]+/),
	};
}

function selectorMatches(selector: CompiledSelector, target: PreparedTarget): boolean {
	switch (selector.kind) {
		case "exact":
			return selector.value === target.target.model;
		case "glob":
			return globMatch(selector.value, target.modelLower);
		case "token":
			return target.modelTokens.includes(selector.value);
	}
}

/** `(exactness, dimensions, priority)` when the rule matches, else undefined. */
function rankRule(rule: IndexedRule, prepared: PreparedTarget): readonly [number, number, number] | undefined {
	const { compiled } = rule;
	const { target } = prepared;
	if (compiled.apis !== undefined && !compiled.apis.includes(target.api)) return undefined;
	if (compiled.family !== undefined && compiled.family !== target.family) return undefined;
	if (rule.revision !== undefined && (!prepared.revision || !revisionSatisfies(prepared.revision, rule.revision))) {
		return undefined;
	}
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
	return [exactness, rule.dimensions, rule.priority];
}

type WinnerTable = Record<string, { rank: readonly [number, number, number]; rule: IndexedRule }>;

function rankCompare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function contest(
	winners: WinnerTable,
	axes: Record<string, unknown> | undefined,
	rank: readonly [number, number, number],
	rule: IndexedRule,
	target: ResolveTarget,
): void {
	if (!axes) return;
	for (const axis in axes) {
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
			if (order > 0) continue;
		}
		winners[axis] = { rank, rule };
	}
}

function collect(winners: WinnerTable, pick: (rule: CompiledRule) => Record<string, unknown> | undefined) {
	const out: Record<string, unknown> = {};
	for (const axis in winners) {
		out[axis] = pick(winners[axis].rule.compiled)?.[axis];
	}
	return out;
}

const resolveCache = new LRUCache<string, ResolvedAxes>({ max: 512 });

function keyPart(value: string | undefined): string {
	return value === undefined ? "-1:" : `${value.length}:${value}`;
}

function targetKey(target: ResolveTarget): string {
	return (
		keyPart(target.provider) +
		keyPart(target.api) +
		keyPart(target.class) +
		keyPart(target.family) +
		keyPart(target.revision) +
		keyPart(target.model) +
		(target.reasoning ? "1" : "0")
	);
}

function cloneAxisValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneAxisValue);
	return isRecord(value) ? cloneAxisRecord(value) : value;
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
 * Exact model effort corrections can enable reasoning; absent family/revision
 * facts never satisfy selectors that require them. Returned axes are caller-owned.
 *
 * @throws AmbiguousOverlapError when equal-rank rules contest one axis.
 */
export function resolveCascade(target: ResolveTarget): ResolvedAxes {
	const key = targetKey(target);
	const cached = resolveCache.get(key);
	if (cached) {
		// Nested rule values are applied to mutable compat records; the cached
		// canonical graph must never escape to those consumers.
		return cloneAxes(cached);
	}
	const resolved = resolveOverIndex(getRuleIndex(), target);
	resolveCache.set(key, resolved);
	return cloneAxes(resolved);
}

/**
 * Resolve a target against a caller-owned compiled cascade without memoizing
 * mutable rule data. Bundled target lookups use {@link resolveCascade}.
 */
export function resolveCascadeRules(cascade: CompiledCascade, target: ResolveTarget): ResolvedAxes {
	return cloneAxes(resolveOverIndex(buildRuleIndex(cascade), target));
}

function resolveOverIndex(index: RuleIndex, target: ResolveTarget): ResolvedAxes {
	const ranked = rankRelevantRules(index, prepareTarget(target));
	let reasoning = target.reasoning === true;
	if (!reasoning) {
		for (const { rule, rank } of ranked) {
			if (rule.hasExactEffortsRule && rank[0] === 2) {
				reasoning = true;
				break;
			}
		}
	}
	const wire: WinnerTable = {};
	const thinking: WinnerTable = {};
	const catalog: WinnerTable = {};
	for (const { rule, rank } of ranked) {
		contest(wire, rule.compiled.wire, rank, rule, target);
		contest(catalog, rule.compiled.catalog, rank, rule, target);
		if (reasoning) contest(thinking, rule.compiled.thinking, rank, rule, target);
	}
	return {
		wire: collect(wire, rule => rule.wire),
		thinking: collect(thinking, rule => rule.thinking),
		catalog: collect(catalog, rule => rule.catalog),
		reasoning,
	};
}
