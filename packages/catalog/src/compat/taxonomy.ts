/**
 * Runtime model-identity taxonomy: classifies wire model ids into
 * `(class, family, revision)` ranks, applies reviewed identity overrides, and
 * exposes the collapse/discovery vocabularies.
 *
 * Faithful port of the o2 reference (`taxonomy.rs` / `classify.rs`):
 * matchers rank `exact(4) > bounded(3) > namespace(2) > prefix(1) > glob(0)`
 * with token byte length as tiebreak; equal cross-class or cross-family ranks
 * throw unless classification is `lenient` (discovery normalization).
 */
import type { Effort } from "../effort";
import { globMatch } from "./cascade";
import { formatRevision, parseRevisionPrefix } from "./revision";
import rules from "./rules.json";
import type { CompiledClass, CompiledIdentityOverride, CompiledMatcher, ModelIdentity } from "./types";

/** Two classes (or two families) tie for one model id. */
export class AmbiguousIdentityError extends Error {
	constructor(
		readonly model: string,
		readonly first: string,
		readonly second: string,
		kind: "class" | "family",
	) {
		super(`ambiguous ${kind} for \`${model}\`: \`${first}\` and \`${second}\` tie`);
		this.name = "AmbiguousIdentityError";
	}
}

/** Options for {@link classifyModel}. */
export interface ClassifyOptions {
	/** Observation time for override expiry; absent keeps expiring overrides active. */
	observedAtMs?: number;
	/**
	 * Swallow ambiguity instead of throwing: an ambiguous class resolves to
	 * `unknown`, an ambiguous family to no family. Discovery normalization
	 * uses this; catalog compilation stays strict.
	 */
	lenient?: boolean;
}

const MATCHER_RANK: Record<CompiledMatcher["kind"], number> = {
	exact: 4,
	bounded: 3,
	namespace: 2,
	prefix: 1,
	glob: 0,
};

function bareOf(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

function boundedMatch(value: string, token: string): boolean {
	if (value === token) return true;
	if (!value.startsWith(token)) return false;
	const next = value.charCodeAt(token.length);
	return next === 45 || next === 95 || next === 46 || next === 58 || (next >= 48 && next <= 57); // - _ . : 0-9
}

function matcherMatches(matcher: CompiledMatcher, lower: string, bare: string): boolean {
	switch (matcher.kind) {
		case "exact":
			return bare === matcher.token;
		case "bounded":
			return boundedMatch(bare, matcher.token);
		case "namespace": {
			const parts = matcher.bounded ? lower.split(/[/.:]/) : lower.split("/");
			for (const part of parts) {
				if (!part) continue;
				if (matcher.bounded ? boundedMatch(part, matcher.token) : part === matcher.token) return true;
			}
			return false;
		}
		case "prefix":
			return bare.startsWith(matcher.token);
		case "glob":
			return globMatch(matcher.token, bare);
	}
}

function nonWildcardBytes(glob: string): number {
	let count = 0;
	for (let i = 0; i < glob.length; i++) {
		if (glob[i] !== "*") count++;
	}
	return count;
}

interface FamilyRanking {
	winner?: { rank: readonly [number, number]; id: string };
	tied?: readonly [string, string];
}

function rankFamilies(cls: CompiledClass, subject: string): FamilyRanking {
	let winner: { rank: readonly [number, number]; id: string } | undefined;
	let tied: readonly [string, string] | undefined;
	for (const family of cls.families) {
		if (!globMatch(family.glob, subject)) continue;
		const rank = [family.priority, nonWildcardBytes(family.glob)] as const;
		if (winner && winner.rank[0] === rank[0] && winner.rank[1] === rank[1] && winner.id !== family.id) {
			tied = [winner.id, family.id];
		} else if (!winner || winner.rank[0] < rank[0] || (winner.rank[0] === rank[0] && winner.rank[1] < rank[1])) {
			winner = { rank, id: family.id };
			tied = undefined;
		}
	}
	return { winner, tied };
}

function stripClassNamespace(cls: CompiledClass, bare: string): string | undefined {
	const separator = bare.search(/[.:]/);
	if (separator <= 0 || separator === bare.length - 1) return undefined;
	const namespace = bare.slice(0, separator);
	if (!cls.matchers.some(matcher => matcher.token === namespace)) return undefined;
	return bare.slice(separator + 1);
}

function classifyFamily(cls: CompiledClass, bare: string, model: string, lenient: boolean): string | undefined {
	const initial = rankFamilies(cls, bare);
	const tied = initial.tied;
	if (!tied) return initial.winner?.id;

	// A Bedrock-style `vendor.model` id names the product after the class
	// namespace. Rescore only ambiguities so existing classifications stay put.
	const scoped = stripClassNamespace(cls, bare);
	if (scoped !== undefined) {
		const rescored = rankFamilies(cls, scoped);
		if (rescored.winner && !rescored.tied) return rescored.winner.id;
	}
	if (lenient) return undefined;
	throw new AmbiguousIdentityError(model, tied[0], tied[1], "family");
}

function extractRevision(cls: CompiledClass, bare: string): string | undefined {
	if (cls.skipBare.includes(bare)) return undefined;
	for (const rule of cls.revisionPrefixes) {
		let tail: string | undefined;
		if (rule.anywhere) {
			const start = bare.indexOf(rule.prefix);
			if (start !== -1) tail = bare.slice(start + rule.prefix.length);
		} else if (bare.startsWith(rule.prefix)) {
			tail = bare.slice(rule.prefix.length);
		}
		if (tail === undefined) continue;
		const digit = tail.search(/[0-9]/);
		if (digit === -1) return undefined;
		const revision = parseRevisionPrefix(tail.slice(digit));
		return revision ? formatRevision(revision) : undefined;
	}
	return undefined;
}

interface ClassRanks {
	class: string;
	family?: string;
	revision?: string;
}

function classifyRanks(model: string, lenient: boolean): ClassRanks {
	const lower = model.trim().toLowerCase();
	const bare = bareOf(lower);
	let winner: { rank: readonly [number, number]; cls: CompiledClass } | undefined;
	let tied: readonly [string, string] | undefined;
	for (const cls of rules.taxonomy.classes) {
		for (const matcher of cls.matchers) {
			if (!matcherMatches(matcher, lower, bare)) continue;
			const rank = [MATCHER_RANK[matcher.kind], matcher.token.length] as const;
			if (winner && winner.rank[0] === rank[0] && winner.rank[1] === rank[1] && winner.cls.id !== cls.id) {
				tied = [winner.cls.id, cls.id];
			} else if (!winner || winner.rank[0] < rank[0] || (winner.rank[0] === rank[0] && winner.rank[1] < rank[1])) {
				winner = { rank, cls };
				tied = undefined;
			}
		}
	}
	if (tied) {
		if (lenient) return { class: "unknown" };
		throw new AmbiguousIdentityError(lower, tied[0], tied[1], "class");
	}
	if (!winner) return { class: "unknown" };
	const ranks: ClassRanks = { class: winner.cls.id };
	const family = classifyFamily(winner.cls, bare, lower, lenient);
	if (family !== undefined) ranks.family = family;
	const revision = extractRevision(winner.cls, bare);
	if (revision !== undefined) ranks.revision = revision;
	return ranks;
}

function ranksInClass(classId: string, model: string, lenient: boolean): Omit<ClassRanks, "class"> {
	const cls = rules.taxonomy.classes.find(candidate => candidate.id === classId);
	if (!cls) return {};
	const lower = model.trim().toLowerCase();
	const bare = bareOf(lower);
	const out: Omit<ClassRanks, "class"> = {};
	const family = classifyFamily(cls, bare, lower, lenient);
	if (family !== undefined) out.family = family;
	const revision = extractRevision(cls, bare);
	if (revision !== undefined) out.revision = revision;
	return out;
}

function findIdentityOverride(
	provider: string,
	bareModel: string,
	observedAtMs: number | undefined,
): CompiledIdentityOverride | undefined {
	const lowerModel = bareModel.toLowerCase();
	const lowerProvider = provider.toLowerCase();
	let agnostic: CompiledIdentityOverride | undefined;
	for (const cls of rules.taxonomy.classes) {
		for (const override of cls.overrides) {
			if (override.model.toLowerCase() !== lowerModel) continue;
			if (override.expiresAtMs !== undefined && observedAtMs !== undefined && observedAtMs >= override.expiresAtMs) {
				continue;
			}
			if (override.provider !== undefined) {
				if (override.provider.toLowerCase() === lowerProvider) return override;
			} else {
				agnostic ??= override;
			}
		}
	}
	return agnostic;
}

/** Result of collapsing a wire id through the suffix vocabulary. */
export interface CollapsedVariant {
	/** Logical id after suffix collapse (original bytes preserved where possible). */
	logicalId: string;
	/** Effort tier collapsed out of the id, when it was an effort variant. */
	effort?: Effort | "off";
	/** Whether the id carried a thinking-variant suffix. */
	thinkingVariant: boolean;
}

/**
 * Collapses a declared thinking or effort suffix from a model identifier.
 * Exact `effort-family` aliases collapse to the family's logical model
 * without assigning an effort; provider-scoped effort lanes additionally
 * collapse an effort suffix wedged before the lane token.
 */
export function collapseVariantId(provider: string, model: string): CollapsedVariant {
	const { collapse } = rules.taxonomy;
	const lower = model.toLowerCase();
	for (const family of collapse.effortFamilies) {
		if (family.provider === provider.toLowerCase() && family.aliases.includes(lower)) {
			return { logicalId: family.logical, thinkingVariant: false };
		}
	}
	const bare = bareOf(lower);
	let winner: (typeof collapse.suffixes)[number] | undefined;
	for (const rule of collapse.suffixes) {
		if (!lower.endsWith(rule.suffix)) continue;
		if (rule.exceptBarePrefix !== undefined && bare.startsWith(rule.exceptBarePrefix)) continue;
		if (!winner || rule.suffix.length > winner.suffix.length) winner = rule;
	}
	if (winner) {
		const collapsed: CollapsedVariant = {
			logicalId: model.slice(0, model.length - winner.suffix.length),
			thinkingVariant: winner.thinking === true,
		};
		if (winner.effort !== undefined) collapsed.effort = winner.effort;
		return collapsed;
	}
	for (const lane of collapse.lanes) {
		if (!lane.providers.some(candidate => candidate === provider.toLowerCase()) || !lower.endsWith(lane.suffix)) {
			continue;
		}
		const trimmed = lower.slice(0, lower.length - lane.suffix.length);
		const trimmedBare = bareOf(trimmed);
		if (lane.barePrefix !== undefined && !trimmedBare.startsWith(lane.barePrefix)) continue;
		// The lane wraps effort tiers only; thinking variants never lane.
		let effortRule: (typeof collapse.suffixes)[number] | undefined;
		for (const rule of collapse.suffixes) {
			if (rule.effort === undefined || !trimmed.endsWith(rule.suffix)) continue;
			if (rule.exceptBarePrefix !== undefined && trimmedBare.startsWith(rule.exceptBarePrefix)) continue;
			if (!effortRule || rule.suffix.length > effortRule.suffix.length) effortRule = rule;
		}
		if (!effortRule) continue;
		const base = model.slice(0, trimmed.length - effortRule.suffix.length);
		if (!base || base.endsWith("/")) continue;
		// Preserve the caller's original lane bytes on the logical id.
		return {
			logicalId: `${base}${model.slice(trimmed.length)}`,
			effort: effortRule.effort,
			thinkingVariant: false,
		};
	}
	return { logicalId: model, thinkingVariant: false };
}

/**
 * Removes the first declared thinking-variant suffix token from a model id.
 *
 * Unlike {@link collapseVariantId}, this vocabulary-only helper also handles an
 * infix token used to pair live discovery siblings. Negated forms such as
 * `non-thinking` and `no-thinking` are not variants.
 */
export function stripThinkingVariantSuffix(model: string): string | undefined {
	const lower = model.toLowerCase();
	for (const token of rules.taxonomy.collapse.pairTokens) {
		const needle = `-${token}`;
		let searchFrom = 0;
		while (searchFrom < lower.length) {
			const index = lower.indexOf(needle, searchFrom);
			if (index === -1) break;
			const end = index + needle.length;
			const next = lower.charCodeAt(end);
			const followedByTokenCharacter = (next >= 48 && next <= 57) || (next >= 97 && next <= 122);
			let wordStart = index;
			while (wordStart > 0) {
				const code = lower.charCodeAt(wordStart - 1);
				if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 122))) break;
				wordStart--;
			}
			const preceding = lower.slice(wordStart, index);
			if (!followedByTokenCharacter && preceding !== "non" && preceding !== "no") {
				const stripped = model.slice(0, index) + model.slice(end);
				return stripped.length > 0 ? stripped : undefined;
			}
			searchFrom = index + 1;
		}
	}
	return undefined;
}

/**
 * Classifies a model into its structured identity: reviewed override first,
 * then suffix collapse, then class/family/revision ranks over the logical id.
 *
 * @throws AmbiguousIdentityError on equal-rank cross-class or cross-family
 * matches unless `opts.lenient`.
 */
export function classifyModel(provider: string, modelId: string, opts?: ClassifyOptions): ModelIdentity {
	const lenient = opts?.lenient === true;
	const trimmed = modelId.trim();
	const bare = bareOf(trimmed);
	const override = findIdentityOverride(provider, bare, opts?.observedAtMs);
	if (override) {
		const logical = override.logical ?? trimmed;
		const cls = override.class ?? classifyRanks(logical, lenient).class;
		const inferred = ranksInClass(cls, logical, lenient);
		const identity: ModelIdentity = { class: cls };
		const family = override.family ?? inferred.family;
		if (family !== undefined) identity.family = family;
		const revision = override.revision ?? inferred.revision;
		if (revision !== undefined) identity.revision = revision;
		if (override.effort !== undefined) identity.effort = override.effort;
		if (override.thinkingVariant) identity.thinkingVariant = true;
		if (logical !== trimmed) identity.logicalId = logical;
		return identity;
	}
	const collapsed =
		trimmed.length === modelId.length
			? collapseVariantId(provider, trimmed)
			: ({ logicalId: trimmed, thinkingVariant: false } satisfies CollapsedVariant);
	const ranks = classifyRanks(collapsed.logicalId, lenient);
	const identity: ModelIdentity = { class: ranks.class };
	if (ranks.family !== undefined) identity.family = ranks.family;
	if (ranks.revision !== undefined) identity.revision = ranks.revision;
	if (collapsed.effort !== undefined) identity.effort = collapsed.effort;
	if (collapsed.thinkingVariant) identity.thinkingVariant = true;
	if (collapsed.logicalId !== trimmed) identity.logicalId = collapsed.logicalId;
	return identity;
}

/**
 * Strips a declared billing-variant suffix (`-free`, `-contributor`) from a
 * wire identifier, returning the base id it shares a transport with.
 */
export function billingVariantPlain(wireModel: string): string | undefined {
	for (const suffix of rules.taxonomy.discovery.billingVariantSuffixes) {
		const split = wireModel.length - suffix.length;
		if (split <= 0) continue;
		if (wireModel.slice(split).toLowerCase() === suffix) return wireModel.slice(0, split);
	}
	return undefined;
}

/**
 * Returns the plain wire identifier when `wireModel` is a declared
 * provider-scoped routing variant (`gpt-5.6-luna-wm` → `gpt-5.6-luna`).
 */
export function routingVariantPlain(provider: string, wireModel: string): string | undefined {
	const lowerProvider = provider.toLowerCase();
	for (const rule of rules.taxonomy.collapse.routingVariants) {
		if (!rule.providers.includes(lowerProvider)) continue;
		const split = wireModel.length - rule.suffix.length;
		if (split <= 0) continue;
		if (wireModel.slice(split).toLowerCase() === rule.suffix) return wireModel.slice(0, split);
	}
	return undefined;
}

/** Whether any routing-variant suffix is declared for `provider`. */
export function hasRoutingVariants(provider: string): boolean {
	const lower = provider.toLowerCase();
	return rules.taxonomy.collapse.routingVariants.some(rule => rule.providers.includes(lower));
}

/** Whether `provider`'s discovery recovers canonical intrinsic parameters. */
export function recoversCanonicalParams(provider: string): boolean {
	const lower = provider.toLowerCase();
	return rules.taxonomy.discovery.canonicalRecovery.includes(lower);
}

/** The full responses-route hint group containing `provider`, when declared. */
export function responsesHintGroup(provider: string): readonly string[] | undefined {
	const lower = provider.toLowerCase();
	return rules.taxonomy.discovery.responsesHintGroups.find(group => group.includes(lower));
}

/** Exact model ids authored onto a provider's responses route. */
export function responsesRouteModels(provider: string): readonly string[] | undefined {
	return rules.taxonomy.discovery.responsesRouteModels[provider.toLowerCase()];
}

/** Whether `provider` declares dynamic effort-sibling families. */
export function supportsDynamicEffortSiblings(provider: string): boolean {
	const lower = provider.toLowerCase();
	return rules.taxonomy.collapse.effortFamilies.some(family => family.provider === lower && family.logical.length > 0);
}

/** The reviewed effort-family seeds declared for `provider`. */
export function effortFamiliesFor(provider: string): readonly { logical: string; aliases: readonly string[] }[] {
	const lower = provider.toLowerCase();
	return rules.taxonomy.collapse.effortFamilies.filter(family => family.provider === lower);
}

/** The standard-lane id when `model` ends in a declared effort lane for `provider`. */
export function stripEffortLane(provider: string, model: string): string {
	const lowerProvider = provider.toLowerCase();
	for (const lane of rules.taxonomy.collapse.lanes) {
		if (!lane.providers.includes(lowerProvider)) continue;
		const split = model.length - lane.suffix.length;
		if (split < 0) continue;
		if (model.slice(split).toLowerCase() === lane.suffix) return model.slice(0, split);
	}
	return model;
}

/** The declared collapse suffix vocabulary (read-only view for collapse logic). */
export function collapseVocabulary() {
	return rules.taxonomy.collapse;
}

/** The declared discovery vocabulary (read-only view). */
export function discoveryVocabulary() {
	return rules.taxonomy.discovery;
}
