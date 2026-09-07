/**
 * Runtime compat cascade: resolves per-axis wire/thinking/catalog assignments
 * for one structured model target from the compiled rule tree.
 *
 * Faithful port of the o2 reference resolver (`cascade.rs`): rules are
 * conjunctions over `(class, provider, family, revision, models)`; per axis
 * the matching rule with the greatest `(model-selector exactness,
 * constrained-dimension count, priority)` tuple wins, and an equal-tuple
 * same-axis contest throws {@link AmbiguousOverlapError}. Declaration and
 * file order are never semantic.
 */
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
}

let ruleIndex: IndexedRule[] | undefined;

function buildRuleIndex(cascade: CompiledCascade): IndexedRule[] {
	return cascade.rules.map(compiled => {
		const revision = compiled.revision?.map(term => {
			const parsed = parseRevision(term.revision);
			if (!parsed) throw new Error(`invalid compiled revision term in ${compiled.source}`);
			return { op: term.op, revision: parsed } satisfies RevisionTerm;
		});
		const dimensions =
			Number(compiled.class !== undefined) +
			Number(compiled.providers !== undefined) +
			Number(compiled.family !== undefined) +
			Number(compiled.revision !== undefined) +
			Number(compiled.models !== undefined);
		return {
			compiled,
			revision,
			priority: compiled.priority ?? 0,
			dimensions,
			hasExactEffortsRule: compiled.thinking !== undefined && "efforts" in compiled.thinking,
		};
	});
}

function getRuleIndex(): IndexedRule[] {
	ruleIndex ??= buildRuleIndex(rules.cascade);
	return ruleIndex;
}

function selectorMatches(selector: CompiledSelector, model: string, modelLower: string): boolean {
	switch (selector.kind) {
		case "exact":
			return selector.value === model;
		case "glob":
			return globMatch(selector.value, modelLower);
		case "token": {
			for (const part of modelLower.split(/[^a-z0-9]+/)) {
				if (part === selector.value) return true;
			}
			return false;
		}
	}
}

/** `(exactness, dimensions, priority)` when the rule matches, else undefined. */
function rankRule(
	rule: IndexedRule,
	target: ResolveTarget,
	revision: Revision | undefined,
	modelLower: string,
): readonly [number, number, number] | undefined {
	const { compiled } = rule;
	if (compiled.class !== undefined && compiled.class !== target.class) return undefined;
	if (compiled.providers !== undefined && !compiled.providers.includes(target.provider)) return undefined;
	if (compiled.family !== undefined && compiled.family !== target.family) return undefined;
	if (rule.revision !== undefined && (!revision || !revisionSatisfies(revision, rule.revision))) return undefined;
	let exactness = 0;
	if (compiled.models !== undefined) {
		let best = -1;
		for (const selector of compiled.models) {
			if (!selectorMatches(selector, target.model, modelLower)) continue;
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

/**
 * Resolves wire, thinking, and catalog assignments for one structured target.
 *
 * Thinking axes are gated on `target.reasoning`, except that an exact model
 * selector declaring `thinking-efforts` upgrades the target (a reviewed
 * correction to stale capability metadata). Family and revision selectors
 * never match targets missing that identity rank. Unmatched targets resolve
 * to empty maps.
 *
 * @throws AmbiguousOverlapError when two equal-rank rules contest one axis.
 */
export function resolveCascade(target: ResolveTarget): ResolvedAxes {
	return resolveOverIndex(getRuleIndex(), target);
}

/**
 * Resolves a target against an arbitrary compiled cascade (test seam and
 * scratch evaluations); `resolveCascade` delegates here with the bundled
 * rule index.
 */
export function resolveCascadeRules(cascade: CompiledCascade, target: ResolveTarget): ResolvedAxes {
	return resolveOverIndex(buildRuleIndex(cascade), target);
}

function resolveOverIndex(index: IndexedRule[], target: ResolveTarget): ResolvedAxes {
	const modelLower = target.model.toLowerCase();
	const revision = target.revision === undefined ? undefined : parseRevision(target.revision);
	const wire: WinnerTable = {};
	const thinking: WinnerTable = {};
	const catalog: WinnerTable = {};
	let reasoning = target.reasoning;
	if (!reasoning) {
		for (const rule of index) {
			if (!rule.hasExactEffortsRule) continue;
			const rank = rankRule(rule, target, revision, modelLower);
			if (rank && rank[0] === 2) {
				reasoning = true;
				break;
			}
		}
	}
	for (const rule of index) {
		const rank = rankRule(rule, target, revision, modelLower);
		if (!rank) continue;
		contest(wire, rule.compiled.wire, rank, rule, target);
		contest(catalog, rule.compiled.catalog, rank, rule, target);
		if (reasoning) contest(thinking, rule.compiled.thinking, rank, rule, target);
	}
	return {
		wire: collect(wire, rule => rule.wire),
		thinking: collect(thinking, rule => rule.thinking),
		catalog: collect(catalog, rule => rule.catalog),
	};
}
