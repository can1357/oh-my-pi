import { discoveryVocabulary } from "../src/compat/taxonomy";
import {
	getBracketStrippedModelIdCandidates,
	getLongestModelLikeIdSegment,
	getModelLikeIdSegments,
} from "../src/identity/id";
import type { Api, Model } from "../src/types";

export type CanonicalModelSource = "override" | "bundled" | "heuristic" | "fallback";

export interface ModelEquivalenceConfig {
	overrides?: Record<string, string>;
	exclude?: string[];
}

export interface CanonicalModelVariant {
	canonicalId: string;
	selector: string;
	model: Model<Api>;
	source: CanonicalModelSource;
}

export interface CanonicalModelRecord {
	id: string;
	name: string;
	variants: CanonicalModelVariant[];
}

export interface CanonicalModelIndex {
	records: CanonicalModelRecord[];
	byId: Map<string, CanonicalModelRecord>;
	bySelector: Map<string, string>;
}

export interface CanonicalReferenceData {
	references: ReadonlyMap<string, Model<Api>>;
	officialIds: ReadonlySet<string>;
	suffixAliases: ReadonlyMap<string, string>;
	[kResolutionCaches]?: WeakMap<CompiledEquivalenceConfig, Map<string, ResolvedCanonicalModel>>;
}

interface CompiledEquivalenceConfig {
	overrides: Map<string, string>;
	exclude: Set<string>;
}

interface ResolvedCanonicalModel {
	id: string;
	source: CanonicalModelSource;
}

// Canonical-id trailing markers come from the compiled discovery vocabulary
// (`trailing-marker` in `src/compat/rules/taxonomy/_discovery.kdl`).
// `search`-style reference-only markers are intentionally excluded — canonical
// coalescing treats e.g. `sonar-pro-search` as distinct from `sonar-pro`.
const CANONICAL_TRAILING_MARKERS = discoveryVocabulary().trailingMarkers;
const TRAILING_MARKER_PATTERN = new RegExp(`[-:](?:${CANONICAL_TRAILING_MARKERS.join("|")})$`, "i");
const WRAPPER_PREFIXES = discoveryVocabulary().wrapperPrefixes;

const EMPTY_COMPILED_EQUIVALENCE: CompiledEquivalenceConfig = {
	overrides: new Map<string, string>(),
	exclude: new Set<string>(),
};
const kResolutionCaches = Symbol("model-equivalence.resolutionCaches");
// Vendor-lineage alternation from the compiled discovery vocabulary
// (`canonical-family-token`); the o-series class stays algorithmic.
const FAMILY_TOKEN_ALTERNATION = `${discoveryVocabulary().canonicalFamilyTokens.join("|")}|o[1345]`;
const FAMILY_EXTRACTION_PATTERNS = [
	new RegExp(`(?:^|[/:._-])((?:${FAMILY_TOKEN_ALTERNATION})[-a-z0-9.]+)(?::|$)`, "i"),
	new RegExp(`(?:^|[/:._-])((?:${FAMILY_TOKEN_ALTERNATION})[-a-z0-9.]+(?:[-_/][a-z0-9.]+)*)(?::|$)`, "i"),
] as const;

function shouldReplaceReference(existing: Model<Api> | undefined, candidate: Model<Api>): boolean {
	if (!existing) return true;
	if (candidate.contextWindow !== existing.contextWindow) {
		return (candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0);
	}
	if (candidate.maxTokens !== existing.maxTokens) {
		return (candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0);
	}
	return existing.provider !== "openai" && candidate.provider === "openai";
}

function buildCanonicalSuffixAliasMap(references: ReadonlyMap<string, Model<Api>>): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const reference of references.values()) {
		const slashIndex = reference.id.lastIndexOf("/");
		if (slashIndex === -1) {
			continue;
		}
		const suffix = reference.id.slice(slashIndex + 1);
		const alias = getLongestModelLikeIdSegment(suffix);
		if (!alias) {
			continue;
		}
		const existing = aliases.get(alias);
		if (!existing || compareCandidatePreference(reference.id, existing) < 0) {
			aliases.set(alias, reference.id);
		}
	}
	return new Map([...aliases.entries()].map(([alias, referenceId]) => [normalizeCanonicalIdKey(alias), referenceId]));
}

/**
 * Build canonical reference data from a model catalog (typically the bundled
 * models). Pure: callers are responsible for memoizing the result — the
 * canonical index keeps per-reference resolution caches internally.
 */
export function buildCanonicalReferenceData(models: Iterable<Model<Api>>): CanonicalReferenceData {
	const references = new Map<string, Model<Api>>();
	for (const candidate of models) {
		const existing = references.get(candidate.id);
		if (shouldReplaceReference(existing, candidate)) {
			references.set(candidate.id, candidate);
		}
	}
	const officialIds = new Set(references.keys());
	const suffixAliases = buildCanonicalSuffixAliasMap(references);
	return { references, officialIds, suffixAliases };
}

function normalizeSelectorKey(selector: string): string {
	return selector.trim().toLowerCase();
}

function normalizeCanonicalIdKey(canonicalId: string): string {
	return canonicalId.trim().toLowerCase();
}

function getCanonicalSuffixAliasKey(candidate: string): string {
	return PENALTY_HAS_UPPERCASE.test(candidate) ? normalizeCanonicalIdKey(candidate) : candidate;
}

export function formatCanonicalVariantSelector(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function getModelResolutionCacheKey(model: Model<Api>): string {
	return `${model.provider}\0${model.id}`;
}

function buildOverrideMap(overrides: Record<string, string> | undefined): Map<string, string> {
	const result = new Map<string, string>();
	if (!overrides) {
		return result;
	}
	for (const [selector, canonicalId] of Object.entries(overrides)) {
		const normalizedSelector = normalizeSelectorKey(selector);
		const normalizedCanonicalId = canonicalId.trim();
		if (!normalizedSelector || !normalizedCanonicalId) {
			continue;
		}
		result.set(normalizedSelector, normalizedCanonicalId);
	}
	return result;
}

function buildExclusionSet(exclusions: readonly string[] | undefined): Set<string> {
	const result = new Set<string>();
	for (const selector of exclusions ?? []) {
		const normalized = normalizeSelectorKey(selector);
		if (normalized) {
			result.add(normalized);
		}
	}
	return result;
}

const compiledEquivalenceCache = new WeakMap<ModelEquivalenceConfig, CompiledEquivalenceConfig>();
function compileEquivalenceConfig(config: ModelEquivalenceConfig | undefined): CompiledEquivalenceConfig {
	if (config) {
		const cached = compiledEquivalenceCache.get(config);
		if (cached) {
			return cached;
		}
	}
	const overrides = buildOverrideMap(config?.overrides);
	const exclude = buildExclusionSet(config?.exclude);
	if (overrides.size === 0 && exclude.size === 0) {
		return EMPTY_COMPILED_EQUIVALENCE;
	}
	const compiled: CompiledEquivalenceConfig = { overrides, exclude };
	if (config) {
		compiledEquivalenceCache.set(config, compiled);
	}
	return compiled;
}

function addCanonicalCandidate(candidates: Set<string>, candidate: string): void {
	const normalized = candidate.trim();
	if (normalized) {
		candidates.add(normalized);
	}
}

function stripTrailingMarker(candidate: string): string | undefined {
	const match = TRAILING_MARKER_PATTERN.exec(candidate);
	return match ? candidate.slice(0, match.index) : undefined;
}

function hasTrailingMarker(candidate: string): boolean {
	return TRAILING_MARKER_PATTERN.test(candidate);
}

function lowercaseCandidate(candidate: string): string | undefined {
	const lowercased = candidate.toLowerCase();
	return lowercased !== candidate ? lowercased : undefined;
}

const STRIP_SYNTHETIC_PREFIX_PATTERN = new RegExp(
	`^(?:${discoveryVocabulary()
		.syntheticPrefixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|")})`,
	"i",
);
const STRIP_LATEST_SUFFIX_PATTERN = /-latest$/i;
const STRIP_LEGACY_GLM_TURBO_PATTERN = /^(glm-4(?:\.\d+)?v?)-turbo$/i;
const REORDER_ANTHROPIC_FAMILY_PATTERN = /^claude-(\d+(?:[.-]\d+)+)-(opus|sonnet|haiku)$/i;
const STRIP_PROVIDER_VERSION_SUFFIX_PATTERN = /-v\d+(?::\d+)?$/i;
const STRIP_DATE_SUFFIX_PATTERN = /-\d{8}$/i;
const INSERT_ATTACHED_FAMILY_VERSION_SEPARATOR_PATTERN = new RegExp(
	`(^|[/:._-])((?:${discoveryVocabulary().canonicalFamilyTokens.join("|")}))(\\d+(?:[.-]\\d+)*)(?=$|[-_/.:a-z])`,
	"gi",
);
const SERIES_MINOR_DOT_TO_DASH_PATTERN = /(^|[/:._-])([a-z])(\d)\.(\d)(?=$|[-_/.:a-z])/gi;
const SERIES_MINOR_DASH_TO_DOT_PATTERN = /(^|[/:._-])([a-z])(\d)-(\d)(?=$|[-_/.:a-z])/gi;
const EXPAND_COMPACT_SERIES_MINOR_PATTERN = /(^|[/:._-])([a-z])(\d)(\d)(?=$|[-_/.:a-z])/gi;
const NAMESPACE_SUFFIX_BOUNDARY_PATTERN = /[/:.]/;
const NAMESPACE_SUFFIX_ALPHA_PATTERN = /[a-z]/i;
const NAMESPACE_SUFFIX_DIGIT_PATTERN = /\d/;
const SHORT_VERSION_DOT_TO_DASH_PATTERN = /(^|[-_/])(\d{1,2})\.(\d{1,2})(?=$|[-_a-z])/gi;
const SHORT_VERSION_DASH_TO_DOT_PATTERN = /(^|[-_/])(\d{1,2})-(\d{1,2})(?=$|[-_a-z])/gi;
const EXPAND_COMPACT_MINOR_PATTERN = /(^|[-_/])(\d)(\d)(?=$|[-_a-z])/g;

function stripSyntheticPrefix(candidate: string): string | undefined {
	const stripped = candidate.replace(STRIP_SYNTHETIC_PREFIX_PATTERN, "");
	return stripped !== candidate ? stripped : undefined;
}

function stripLatestSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(STRIP_LATEST_SUFFIX_PATTERN, "");
	return stripped !== candidate ? stripped : undefined;
}

function stripLegacyGlmTurboSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(STRIP_LEGACY_GLM_TURBO_PATTERN, "$1");
	return stripped !== candidate ? stripped : undefined;
}

function reorderAnthropicFamily(candidate: string): string | undefined {
	const match = REORDER_ANTHROPIC_FAMILY_PATTERN.exec(candidate);
	if (!match) {
		return undefined;
	}
	const [, version, family] = match;
	return `claude-${family.toLowerCase()}-${version}`;
}

function stripProviderVersionSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(STRIP_PROVIDER_VERSION_SUFFIX_PATTERN, "");
	return stripped !== candidate ? stripped : undefined;
}

function stripDateSuffix(candidate: string): string | undefined {
	const stripped = candidate.replace(STRIP_DATE_SUFFIX_PATTERN, "");
	return stripped !== candidate ? stripped : undefined;
}

function insertAttachedFamilyVersionSeparator(candidate: string): string | undefined {
	const inserted = candidate.replace(INSERT_ATTACHED_FAMILY_VERSION_SEPARATOR_PATTERN, "$1$2-$3");
	return inserted !== candidate ? inserted : undefined;
}

function toggleSeriesMinorVersionSeparators(candidate: string): string[] {
	const toggled = new Set<string>();
	const dotToDash = candidate.replace(SERIES_MINOR_DOT_TO_DASH_PATTERN, "$1$2$3-$4");
	if (dotToDash !== candidate) {
		toggled.add(dotToDash);
	}
	const dashToDot = candidate.replace(SERIES_MINOR_DASH_TO_DOT_PATTERN, "$1$2$3.$4");
	if (dashToDot !== candidate) {
		toggled.add(dashToDot);
	}
	return [...toggled];
}

function expandCompactSeriesMinorVersions(candidate: string): string[] {
	const expanded = new Set<string>();
	const compactToDash = candidate.replace(EXPAND_COMPACT_SERIES_MINOR_PATTERN, "$1$2$3-$4");
	if (compactToDash !== candidate) {
		expanded.add(compactToDash);
	}
	const compactToDot = candidate.replace(EXPAND_COMPACT_SERIES_MINOR_PATTERN, "$1$2$3.$4");
	if (compactToDot !== candidate) {
		expanded.add(compactToDot);
	}
	return [...expanded];
}

// Bounded FIFO memo: pure function of `candidate`. Cached arrays are read-only at
// every callsite (they are iterated to push into a queue — never mutated), so we
// safely return the same instance. Cap keeps memory bounded under adversarial
// model-id churn.
const QUALIFIED_NAMESPACE_SUFFIX_CACHE = new Map<string, string[]>();
const QUALIFIED_NAMESPACE_SUFFIX_CACHE_CAP = 4096;
function getQualifiedNamespaceSuffixes(candidate: string): string[] {
	const cached = QUALIFIED_NAMESPACE_SUFFIX_CACHE.get(candidate);
	if (cached !== undefined) {
		return cached;
	}
	const results = new Set<string>();
	for (let index = 1; index < candidate.length; index += 1) {
		if (!NAMESPACE_SUFFIX_BOUNDARY_PATTERN.test(candidate[index - 1]!)) {
			continue;
		}
		const suffix = candidate.slice(index);
		if (suffix.length < 4) {
			continue;
		}
		if (!NAMESPACE_SUFFIX_ALPHA_PATTERN.test(suffix) || !NAMESPACE_SUFFIX_DIGIT_PATTERN.test(suffix)) {
			continue;
		}
		addCanonicalCandidate(results, suffix);
	}
	const output = [...results];
	if (QUALIFIED_NAMESPACE_SUFFIX_CACHE.size >= QUALIFIED_NAMESPACE_SUFFIX_CACHE_CAP) {
		const oldest = QUALIFIED_NAMESPACE_SUFFIX_CACHE.keys().next().value;
		if (oldest !== undefined) {
			QUALIFIED_NAMESPACE_SUFFIX_CACHE.delete(oldest);
		}
	}
	QUALIFIED_NAMESPACE_SUFFIX_CACHE.set(candidate, output);
	return output;
}

function extractUpstreamFamilyCandidate(candidate: string): string | undefined {
	for (const pattern of FAMILY_EXTRACTION_PATTERNS) {
		const match = pattern.exec(candidate);
		if (match?.[1]) {
			return match[1];
		}
	}
	return undefined;
}

const PENALTY_DATE_SUFFIX = /-\d{8}$/i;
const PENALTY_PROVIDER_VERSION_SUFFIX = /-v\d+(?::\d+)?$/i;
const PENALTY_HAS_UPPERCASE = /[A-Z]/;
const PENALTY_CLAUDE_LEADING_VERSION = /^claude-\d/i;
const PENALTY_CLAUDE_LEGACY_DATE = /^claude-(?:opus|sonnet|haiku)-\d{2}(?=$|[-_a-z])/i;
const PENALTY_LETTER_DIGIT_DIGIT = /(?:^|[/:._-])[a-z]\d-\d(?=$|[-_/.:a-z])/i;
const PENALTY_DIGIT_DIGIT = /(?:^|[-_/])\d-\d(?=$|[-_a-z])/;
const PENALTY_CLAUDE_FAMILY_DIGIT_DIGIT = /^claude-(?:opus|sonnet|haiku)-\d-\d/i;

function getCandidatePenalty(candidate: string): number {
	let penalty = 0;
	if (candidate.includes("/")) {
		penalty += 100;
	}
	if (candidate.includes(":")) {
		penalty += 40;
	}
	if (PENALTY_DATE_SUFFIX.test(candidate)) {
		penalty += 25;
	}
	if (PENALTY_PROVIDER_VERSION_SUFFIX.test(candidate)) {
		penalty += 25;
	}
	if (hasTrailingMarker(candidate)) {
		penalty += 20;
	}
	if (PENALTY_HAS_UPPERCASE.test(candidate)) {
		penalty += 10;
	}
	if (PENALTY_CLAUDE_LEADING_VERSION.test(candidate)) {
		penalty += 20;
	}
	if (PENALTY_CLAUDE_LEGACY_DATE.test(candidate)) {
		penalty += 10;
	}
	if (PENALTY_LETTER_DIGIT_DIGIT.test(candidate)) {
		penalty += 6;
	}
	if (PENALTY_DIGIT_DIGIT.test(candidate) && !PENALTY_CLAUDE_FAMILY_DIGIT_DIGIT.test(candidate)) {
		penalty += 4;
	}
	penalty += candidate.length * 0.01;
	return penalty;
}

function compareCandidatePreference(left: string, right: string): number {
	const penaltyDiff = getCandidatePenalty(left) - getCandidatePenalty(right);
	if (penaltyDiff !== 0) {
		return penaltyDiff;
	}
	if (left.length !== right.length) {
		return left.length - right.length;
	}
	return left.localeCompare(right);
}

function selectBestOfficialCandidate(candidates: readonly string[]): string | undefined {
	if (candidates.length === 0) {
		return undefined;
	}
	let bestCandidate: string | undefined;
	let bestPenalty = 0;
	let bestLength = 0;
	for (const candidate of candidates) {
		const penalty = getCandidatePenalty(candidate);
		const length = candidate.length;
		if (bestCandidate === undefined) {
			bestCandidate = candidate;
			bestPenalty = penalty;
			bestLength = length;
			continue;
		}
		if (penalty < bestPenalty) {
			bestCandidate = candidate;
			bestPenalty = penalty;
			bestLength = length;
			continue;
		}
		if (penalty > bestPenalty) {
			continue;
		}
		if (length < bestLength) {
			bestCandidate = candidate;
			bestLength = length;
			continue;
		}
		if (length > bestLength) {
			continue;
		}
		if (candidate.localeCompare(bestCandidate) < 0) {
			bestCandidate = candidate;
		}
	}
	return bestCandidate;
}

function getWrapperCanonicalCandidates(candidate: string): string[] {
	const results = new Set<string>();
	for (const prefix of WRAPPER_PREFIXES) {
		if (!candidate.toLowerCase().startsWith(prefix)) {
			continue;
		}
		const stripped = candidate.slice(prefix.length);
		addCanonicalCandidate(results, stripped);
		if (/^(opus|sonnet|haiku)-/i.test(stripped)) {
			addCanonicalCandidate(results, `claude-${stripped}`);
		}
	}
	return [...results];
}

function getAnthropicAliasOfficial(candidate: string, officialIds: ReadonlySet<string>): string | undefined {
	const reordered = reorderAnthropicFamily(candidate);
	if (!reordered) {
		return undefined;
	}
	const candidates = [reordered, ...toggleShortVersionSeparators(reordered)].filter(officialId =>
		officialIds.has(officialId),
	);
	return selectBestOfficialCandidate(candidates);
}

function compareVersionSegments(left: readonly number[], right: readonly number[]): number {
	const maxLength = Math.max(left.length, right.length);
	for (let index = 0; index < maxLength; index += 1) {
		const diff = (left[index] ?? Number.NEGATIVE_INFINITY) - (right[index] ?? Number.NEGATIVE_INFINITY);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

function parseClaudeFamilyVersionSegments(candidate: string, prefix: string): number[] {
	const normalizedCandidate = candidate.toLowerCase();
	const normalizedPrefix = prefix.toLowerCase();
	if (!normalizedCandidate.startsWith(`${normalizedPrefix}-`)) {
		return [];
	}
	const rawSuffix = normalizedCandidate.slice(normalizedPrefix.length + 1);
	if (!rawSuffix) {
		return [];
	}
	const versionSegments: number[] = [];
	for (const token of rawSuffix.split("-")) {
		if (!token) {
			break;
		}
		if (/^\d{8}$/.test(token)) {
			break;
		}
		if (/^\d{2}$/.test(token)) {
			versionSegments.push(Number(token[0]), Number(token[1]));
			continue;
		}
		if (/^\d+(?:\.\d+)*$/.test(token)) {
			versionSegments.push(...token.split(".").map(part => Number(part)));
			continue;
		}
		break;
	}
	return versionSegments;
}

const CLAUDE_FAMILY_ALIAS_PATTERN = /^(?:anthropic\/)?(claude(?:-\d(?:[.-]\d+)?)?-(?:haiku|opus|sonnet))(?:-latest)?$/i;
const CLAUDE_DATE_SUFFIX_PATTERN = /-\d{8}(?:$|-)/i;

function getClaudeFamilyAliasOfficial(candidate: string, officialIds: ReadonlySet<string>): string | undefined {
	const match = CLAUDE_FAMILY_ALIAS_PATTERN.exec(candidate);
	if (!match?.[1]) {
		return undefined;
	}
	const familyPrefix = match[1].toLowerCase();
	const familyPrefixWithDash = `${familyPrefix}-`;

	let best: string | undefined;
	let bestVersion: number[] = [];
	let bestHasDate = false;
	let bestHasMarker = false;

	for (const officialId of officialIds) {
		const normalized = officialId.toLowerCase();
		if (normalized !== familyPrefix && !normalized.startsWith(familyPrefixWithDash)) {
			continue;
		}
		const version = parseClaudeFamilyVersionSegments(officialId, familyPrefix);
		const hasDate = CLAUDE_DATE_SUFFIX_PATTERN.test(officialId);
		const hasMarker = hasTrailingMarker(officialId);

		if (best === undefined) {
			best = officialId;
			bestVersion = version;
			bestHasDate = hasDate;
			bestHasMarker = hasMarker;
			continue;
		}

		const versionDiff = compareVersionSegments(version, bestVersion);
		if (versionDiff !== 0) {
			if (versionDiff > 0) {
				best = officialId;
				bestVersion = version;
				bestHasDate = hasDate;
				bestHasMarker = hasMarker;
			}
			continue;
		}
		if (hasDate !== bestHasDate) {
			if (!hasDate) {
				best = officialId;
				bestVersion = version;
				bestHasDate = hasDate;
				bestHasMarker = hasMarker;
			}
			continue;
		}
		if (hasMarker !== bestHasMarker) {
			if (!hasMarker) {
				best = officialId;
				bestVersion = version;
				bestHasMarker = hasMarker;
			}
			continue;
		}
		if (compareCandidatePreference(officialId, best) < 0) {
			best = officialId;
			bestVersion = version;
		}
	}
	return best;
}

function toggleShortVersionSeparators(candidate: string): string[] {
	const toggled = new Set<string>();
	const dotToDash = candidate.replace(SHORT_VERSION_DOT_TO_DASH_PATTERN, "$1$2-$3");
	if (dotToDash !== candidate) {
		toggled.add(dotToDash);
	}
	const dashToDot = candidate.replace(SHORT_VERSION_DASH_TO_DOT_PATTERN, "$1$2.$3");
	if (dashToDot !== candidate) {
		toggled.add(dashToDot);
	}
	return [...toggled];
}

function expandCompactMinorVersions(candidate: string): string[] {
	const expanded = new Set<string>();
	const compactToDash = candidate.replace(EXPAND_COMPACT_MINOR_PATTERN, "$1$2-$3");
	if (compactToDash !== candidate) {
		expanded.add(compactToDash);
	}
	const compactToDot = candidate.replace(EXPAND_COMPACT_MINOR_PATTERN, "$1$2.$3");
	if (compactToDot !== candidate) {
		expanded.add(compactToDot);
	}
	return [...expanded];
}

function expandCheapCanonicalCandidates(normalized: string, queue: string[]): void {
	const lowercased = lowercaseCandidate(normalized);
	if (lowercased) {
		queue.push(lowercased);
	}

	const pathSegments = normalized.split("/");
	for (let index = 1; index < pathSegments.length; index += 1) {
		queue.push(pathSegments.slice(index).join("/"));
	}

	for (const suffix of getQualifiedNamespaceSuffixes(normalized)) {
		queue.push(suffix);
	}
}

function expandHeavyCanonicalCandidates(normalized: string, queue: string[]): void {
	for (const toggled of toggleShortVersionSeparators(normalized)) {
		queue.push(toggled);
	}

	const attachedFamilyVersion = insertAttachedFamilyVersionSeparator(normalized);
	if (attachedFamilyVersion) {
		queue.push(attachedFamilyVersion);
	}

	for (const toggledSeriesVersion of toggleSeriesMinorVersionSeparators(normalized)) {
		queue.push(toggledSeriesVersion);
	}

	for (const expandedVersion of expandCompactMinorVersions(normalized)) {
		queue.push(expandedVersion);
	}

	for (const expandedSeriesVersion of expandCompactSeriesMinorVersions(normalized)) {
		queue.push(expandedSeriesVersion);
	}

	for (const wrapperCandidate of getWrapperCanonicalCandidates(normalized)) {
		queue.push(wrapperCandidate);
	}

	for (const strippedAffixCandidate of getBracketStrippedModelIdCandidates(normalized)) {
		queue.push(strippedAffixCandidate);
	}
	for (const segment of getModelLikeIdSegments(normalized)) {
		queue.push(segment);
	}

	const strippedSyntheticPrefix = stripSyntheticPrefix(normalized);
	if (strippedSyntheticPrefix) {
		queue.push(strippedSyntheticPrefix);
	}

	const strippedLatest = stripLatestSuffix(normalized);
	if (strippedLatest) {
		queue.push(strippedLatest);
	}

	const strippedLegacyGlmTurbo = stripLegacyGlmTurboSuffix(normalized);
	if (strippedLegacyGlmTurbo) {
		queue.push(strippedLegacyGlmTurbo);
	}

	const extractedFamily = extractUpstreamFamilyCandidate(normalized);
	if (extractedFamily) {
		queue.push(extractedFamily);
	}

	const strippedProviderVersion = stripProviderVersionSuffix(normalized);
	if (strippedProviderVersion) {
		queue.push(strippedProviderVersion);
	}

	const strippedDate = stripDateSuffix(normalized);
	if (strippedDate) {
		queue.push(strippedDate);
	}

	const strippedMarker = stripTrailingMarker(normalized);
	if (strippedMarker) {
		queue.push(strippedMarker);
	}

	const reorderedAnthropic = reorderAnthropicFamily(normalized);
	if (reorderedAnthropic) {
		queue.push(reorderedAnthropic);
	}
}

// Bounded FIFO memo: result depends only on `modelId` (the `_officialIds` param
// is unused — kept for signature stability). The returned array is consumed via
// `.filter` at every callsite, so sharing the cached instance is safe.
const HEURISTIC_CANDIDATES_CACHE = new Map<string, string[]>();
const HEURISTIC_CANDIDATES_CACHE_CAP = 4096;
function getHeuristicCanonicalCandidates(modelId: string, _officialIds?: ReadonlySet<string>): string[] {
	const cached = HEURISTIC_CANDIDATES_CACHE.get(modelId);
	if (cached !== undefined) {
		return cached;
	}
	const candidates = new Set<string>();
	const queue: string[] = [modelId];
	const visited = new Set<string>();

	for (let qi = 0; qi < queue.length; qi += 1) {
		const candidate = queue[qi];
		if (!candidate) {
			continue;
		}
		const normalized = candidate.trim();
		if (!normalized || visited.has(normalized)) {
			continue;
		}
		visited.add(normalized);
		addCanonicalCandidate(candidates, normalized);
		expandCheapCanonicalCandidates(normalized, queue);
		expandHeavyCanonicalCandidates(normalized, queue);
	}

	const output = [...candidates];
	if (HEURISTIC_CANDIDATES_CACHE.size >= HEURISTIC_CANDIDATES_CACHE_CAP) {
		const oldest = HEURISTIC_CANDIDATES_CACHE.keys().next().value;
		if (oldest !== undefined) {
			HEURISTIC_CANDIDATES_CACHE.delete(oldest);
		}
	}
	HEURISTIC_CANDIDATES_CACHE.set(modelId, output);
	return output;
}

function getPreferredFallbackCanonicalCandidate(modelId: string, candidates: readonly string[]): string | undefined {
	if (!/[/:.]/.test(modelId)) {
		return undefined;
	}
	const cleanCandidates = candidates.filter(candidate => {
		if (!candidate || candidate === modelId) {
			return false;
		}
		if (candidate.includes("/") || candidate.includes(":")) {
			return false;
		}
		if (candidate.toLowerCase() !== candidate) {
			return false;
		}
		const extractedFamily = extractUpstreamFamilyCandidate(candidate);
		return extractedFamily?.toLowerCase() === candidate;
	});
	return selectBestOfficialCandidate(cleanCandidates);
}

function resolveCanonicalIdForModel(
	model: Model<Api>,
	selector: string,
	equivalence: CompiledEquivalenceConfig,
	referenceData: CanonicalReferenceData,
): ResolvedCanonicalModel {
	const normalizedSelector = normalizeSelectorKey(selector);

	if (equivalence.overrides.has(normalizedSelector)) {
		return { id: equivalence.overrides.get(normalizedSelector)!, source: "override" };
	}

	if (equivalence.exclude.has(normalizedSelector)) {
		return { id: model.id, source: "fallback" };
	}

	const anthropicAlias = getAnthropicAliasOfficial(model.id, referenceData.officialIds);
	if (anthropicAlias) {
		return { id: anthropicAlias, source: anthropicAlias === model.id ? "bundled" : "heuristic" };
	}

	const claudeFamilyAlias = getClaudeFamilyAliasOfficial(model.id, referenceData.officialIds);
	if (claudeFamilyAlias) {
		return { id: claudeFamilyAlias, source: claudeFamilyAlias === model.id ? "bundled" : "heuristic" };
	}

	const heuristicCandidates = getHeuristicCanonicalCandidates(model.id, referenceData.officialIds);
	const officialMatches = new Set<string>();
	for (const candidate of heuristicCandidates) {
		if (referenceData.officialIds.has(candidate)) {
			officialMatches.add(candidate);
		}
		const aliased = referenceData.suffixAliases.get(getCanonicalSuffixAliasKey(candidate));
		if (aliased) {
			officialMatches.add(aliased);
		}
	}
	const preferredFallback = getPreferredFallbackCanonicalCandidate(model.id, heuristicCandidates);
	const match = selectBestOfficialCandidate([...officialMatches]);
	if (match) {
		if (
			preferredFallback &&
			(match.includes("/") || match.includes(":")) &&
			compareCandidatePreference(preferredFallback, match) < 0
		) {
			return { id: preferredFallback, source: "heuristic" };
		}
		return { id: match, source: match === model.id ? "bundled" : "heuristic" };
	}

	if (preferredFallback) {
		return { id: preferredFallback, source: "heuristic" };
	}

	return { id: model.id, source: "fallback" };
}

function getCanonicalRecordName(
	record: CanonicalModelRecord | undefined,
	canonicalId: string,
	variant: CanonicalModelVariant,
	referenceData: CanonicalReferenceData,
): string {
	if (record) {
		return record.name;
	}
	return referenceData.references.get(canonicalId)?.name ?? variant.model.name ?? canonicalId;
}

function compareCanonicalRecords(left: CanonicalModelRecord, right: CanonicalModelRecord): number {
	return left.id.localeCompare(right.id);
}

function compareCanonicalVariants(left: CanonicalModelVariant, right: CanonicalModelVariant): number {
	const leftSelector = left.selector;
	const rightSelector = right.selector;
	return leftSelector.localeCompare(rightSelector);
}

export function buildCanonicalModelIndex(
	models: readonly Model<Api>[],
	reference: CanonicalReferenceData,
	equivalence?: ModelEquivalenceConfig,
): CanonicalModelIndex {
	const referenceData = reference;
	const compiledEquivalence = compileEquivalenceConfig(equivalence);
	const byId = new Map<string, CanonicalModelRecord>();
	const bySelector = new Map<string, string>();

	// Resolution results depend on (model, equivalence, reference); cache them on
	// the reference data keyed by the compiled equivalence config so neither a
	// different reference dataset nor a different override set can poison entries.
	let caches = referenceData[kResolutionCaches];
	if (!caches) {
		caches = new WeakMap();
		referenceData[kResolutionCaches] = caches;
	}
	let modelCache = caches.get(compiledEquivalence);
	if (!modelCache) {
		modelCache = new Map<string, ResolvedCanonicalModel>();
		caches.set(compiledEquivalence, modelCache);
	}

	for (const model of models) {
		const selector = formatCanonicalVariantSelector(model);
		const cacheKey = getModelResolutionCacheKey(model);
		let canonical = modelCache.get(cacheKey);
		if (!canonical) {
			canonical = resolveCanonicalIdForModel(model, selector, compiledEquivalence, referenceData);
			modelCache.set(cacheKey, canonical);
		}
		const variant: CanonicalModelVariant = {
			canonicalId: canonical.id,
			selector,
			model,
			source: canonical.source,
		};
		const canonicalKey = normalizeCanonicalIdKey(canonical.id);
		const existing = byId.get(canonicalKey);
		const nextRecord: CanonicalModelRecord = existing ?? {
			id: canonical.id,
			name: getCanonicalRecordName(undefined, canonical.id, variant, referenceData),
			variants: [],
		};
		nextRecord.variants.push(variant);
		byId.set(canonicalKey, nextRecord);
		bySelector.set(normalizeSelectorKey(selector), canonical.id);
	}

	const records = [...byId.values()].sort(compareCanonicalRecords);
	for (const record of records) {
		record.variants.sort(compareCanonicalVariants);
	}

	return { records, byId, bySelector };
}
