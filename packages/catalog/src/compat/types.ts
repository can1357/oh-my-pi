/**
 * Shared type vocabulary of the compiled compat rules: the JSON shape emitted
 * by `scripts/compat-compiler` into `rules.json`, plus the structured
 * identity/resolve types the runtime engine (`taxonomy.ts`, `cascade.ts`,
 * `behavior.ts`, `resolve.ts`) exposes to consumers.
 */
import type { Effort } from "../effort";
import type { ThinkingControlMode } from "../types";
import type { RevisionOp } from "./revision";

/** Class-membership matcher kinds, most to least specific. */
export type MatcherKind = "exact" | "bounded" | "namespace" | "prefix" | "glob";

/** One compiled class-membership matcher (token pre-lowercased). */
export interface CompiledMatcher {
	kind: MatcherKind;
	token: string;
	/** Namespace matchers only: accept dot/colon segments with token boundaries. */
	bounded?: boolean;
}

/** One compiled product-family rule (glob pre-lowercased). */
export interface CompiledFamily {
	id: string;
	glob: string;
	priority: number;
}

/** One compiled revision-extraction prefix (pre-lowercased). */
export interface CompiledRevisionPrefix {
	prefix: string;
	anywhere?: boolean;
}

/** One compiled reviewed identity correction. */
export interface CompiledIdentityOverride {
	id: string;
	provider?: string;
	model: string;
	logical?: string;
	class?: string;
	family?: string;
	/** Canonical `major.minor.patch`. */
	revision?: string;
	effort?: Effort | "off";
	thinkingVariant?: boolean;
	rationale: string;
	provenance: string;
	expiresAtMs?: number;
}

/** One compiled model class: matchers, families, revision rules, overrides. */
export interface CompiledClass {
	id: string;
	matchers: CompiledMatcher[];
	families: CompiledFamily[];
	revisionPrefixes: CompiledRevisionPrefix[];
	skipBare: string[];
	overrides: CompiledIdentityOverride[];
}

/** One collapse suffix rule (thinking or effort variant). */
export interface CompiledCollapseSuffix {
	suffix: string;
	/** Present on `effort-suffix` rules. */
	effort?: Effort | "off";
	/** True on `thinking-suffix` rules. */
	thinking?: boolean;
	exceptBarePrefix?: string;
}

/** One provider-scoped effort-lane suffix rule. */
export interface CompiledEffortLane {
	suffix: string;
	providers: string[];
	barePrefix?: string;
}

/** One provider-scoped routing-variant suffix rule. */
export interface CompiledRoutingVariant {
	suffix: string;
	providers: string[];
}

/** One reviewed provider-scoped effort-sibling family seed. */
export interface CompiledEffortFamily {
	provider: string;
	logical: string;
	aliases: string[];
}
/** Per-effort routing tier keys (`"off"` = thinking disabled). */
export type VariantTier = Effort | "off";

/**
 * Revision placeholder in a templated `variant-family` (`gemini-{rev}-flash`).
 * A family whose id carries it is instantiated once per live revision that
 * discovery advertises, so new generations of a lineage collapse without a
 * new reviewed entry.
 */
export const REVISION_PLACEHOLDER = "{rev}";

/**
 * One reviewed provider-scoped variant family: a logical model whose provider
 * serves per-effort/thinking sibling wire ids, with explicit routing, ladder,
 * and wire facts. Compiled from `variant-family` nodes in `_collapse.kdl`.
 */
export interface CompiledVariantFamily {
	provider: string;
	id: string;
	name: string;
	/**
	 * Revision constraint (`">=3.6"`) gating instantiation of a
	 * {@link REVISION_PLACEHOLDER} template; absent on concrete families.
	 */
	revision?: string;
	/** Member wire ids in priority order. */
	members: string[];
	/** Preferred default wire id when live. */
	defaultMember?: string;
	/** Wire ids upstream no longer serves. */
	retiredMembers?: string[];
	/** Per-effort upstream wire id. */
	routing: Partial<Record<VariantTier, string>>;
	/** Explicit per-effort thinking budgets (budget-mode families). */
	effortBudgets?: Partial<Record<Effort, number>>;
	/** Thinking control mode of the collapsed surface. */
	mode?: ThinkingControlMode;
	/** Effort ladder of the collapsed surface, least → most intensive. */
	efforts?: Effort[];
	defaultLevel?: Effort;
	requiresEffort?: boolean;
	suppressWhenOff?: boolean;
	/** Collapsed spec carries no thinking surface (single-wire-id renames). */
	noThinking?: boolean;
	preserveAbsentEffortRoutes?: boolean;
	/** Retired/recycled selector ids aliasing to this family without membership. */
	extraAliases?: string[];
}

/** The single collapse vocabulary. */
export interface CompiledCollapse {
	suffixes: CompiledCollapseSuffix[];
	/** Bounded (possibly infix) tokens naming the thinking sibling of a bare twin; pair derivation only. */
	pairTokens: string[];
	lanes: CompiledEffortLane[];
	routingVariants: CompiledRoutingVariant[];
	effortFamilies: CompiledEffortFamily[];
	/** Reviewed per-provider variant families (hand-curated routing). */
	variantFamilies: CompiledVariantFamily[];
	/** Provider-scoped selector aliases: `provider → { alias → logical id }`. */
	providerAliases: Record<string, Record<string, string>>;
}

/** The discovery vocabulary. */
export interface CompiledDiscovery {
	canonicalRecovery: string[];
	responsesHintGroups: string[][];
	responsesRouteModels: Record<string, string[]>;
	billingVariantSuffixes: string[];
	/** Routing/quantization markers resellers append without changing identity. */
	trailingMarkers: string[];
	/** Markers stripped only for proxy-reference recovery, never canonical coalescing. */
	referenceOnlyTrailingMarkers: string[];
	/** Provider → reviewed base ids the generator projects `-pro` reasoning aliases from. */
	proReasoningAliases: Record<string, string[]>;
	/** Providers swept for stale generated pro aliases during regeneration. */
	proReasoningSweep: string[];
	/** Vendor-lineage tokens anchoring canonical-family extraction and version-separator insertion. */
	canonicalFamilyTokens: string[];
	/** Reseller wrapper prefixes stripped during canonical candidate expansion. */
	wrapperPrefixes: string[];
	/** Synthetic namespace prefixes (`hf:`) stripped during canonical candidate expansion. */
	syntheticPrefixes: string[];
}

/** Compiled taxonomy: identity classes plus collapse/discovery vocabularies. */
export interface CompiledTaxonomy {
	classes: CompiledClass[];
	collapse: CompiledCollapse;
	discovery: CompiledDiscovery;
}

/** One compiled `models` selector alternative. */
export interface CompiledSelector {
	kind: "exact" | "glob" | "token";
	value: string;
}

/** One comparison term of a compiled revision constraint. */
export interface CompiledRevisionTerm {
	op: RevisionOp;
	revision: string;
}

/** One compiled cascade conjunction rule. */
export interface CompiledRule {
	/** `file:line` diagnostic label. */
	source: string;
	class?: string;
	providers?: string[];
	family?: string;
	revision?: CompiledRevisionTerm[];
	models?: CompiledSelector[];
	priority?: number;
	/** Wire axis assignments keyed by resolved camelCase field. */
	wire?: Record<string, unknown>;
	/** Thinking axis assignments keyed by `ThinkingConfig` field. */
	thinking?: Record<string, unknown>;
	/** Catalog-data axis assignments. */
	catalog?: Record<string, unknown>;
}

/** Compiled cascade: flat rule list in file order. */
export interface CompiledCascade {
	rules: CompiledRule[];
}

/** Exact/prefix/substring/glob matcher token list used by behavior nodes. */
export interface CompiledMatchList {
	exact?: string[];
	prefix?: string[];
	substring?: string[];
	glob?: string[];
	/** Bounded identifier tokens: match when a non-alphanumeric-delimited part equals the token. */
	token?: string[];
}

/** Conservative include/exclude prefix heuristic for discovered OpenAI ids. */
export interface CompiledResponsesHeuristic {
	includePrefixes: string[];
	excludePrefixes: string[];
	excludeSubstrings: string[];
}

/** Extra declared operations for discovered provider models. */
export interface CompiledModelOperations {
	provider: string;
	models: CompiledMatchList;
	operations: string[];
}

/** Cursor effort-suffix sibling vocabulary. */
export interface CompiledCursorEffort {
	familyMarker: string;
	tiers: string[];
}

/** One fixed Cursor `requestedModel` parameter. */
export interface CompiledCursorParameter {
	model: string;
	id: string;
	value: string;
}

/** One provider quota-scope table. */
export interface CompiledQuotaRule {
	provider: string;
	tiers: { label: string; models: string[] }[];
	fallbacks: { label: string; substring: string }[];
}

/** Provider-default wire model for model-less hosted operations. */
export interface CompiledHostedDefault {
	provider: string;
	model: string;
}

/** One API-routing alternative within an `api-routes` node. */
export interface CompiledApiRoute {
	api: string;
	match: CompiledMatchList;
	stripPrefix?: boolean;
}

/** Provider API-routing table for discovered model ids. */
export interface CompiledApiRoutes {
	provider: string;
	default?: string;
	routes: CompiledApiRoute[];
}

/** One provider model-limits pin. */
export interface CompiledModelLimits {
	provider: string;
	limits: { model: string; context?: number; maxTokens?: number }[];
}

/** Provider roster exclusion list (non-text SKUs, unsupported surfaces). */
export interface CompiledExcludeModels {
	provider: string;
	match: CompiledMatchList;
}

/** Provider plan-requirement tiers keyed by matcher token lists. */
export interface CompiledPlanRequirement {
	provider: string;
	tiers: { tier: string; match: CompiledMatchList }[];
}

/** Cross-provider pricing-peer aliases for one provider. */
export interface CompiledPricingPeer {
	provider: string;
	peers: string[];
	aliases: { model: string; peerId: string }[];
}

/** Compiled runtime behavior vocabulary (`runtime/behavior.kdl`). */
export interface CompiledBehavior {
	openaiResponsesHeuristic?: CompiledResponsesHeuristic;
	modelOperations: CompiledModelOperations[];
	cursorEffort?: CompiledCursorEffort;
	cursorParameters: CompiledCursorParameter[];
	quotaTiers: CompiledQuotaRule[];
	hostedDefaults: CompiledHostedDefault[];
	apiRoutes: CompiledApiRoutes[];
	modelLimits: CompiledModelLimits[];
	excludeModels: CompiledExcludeModels[];
	planRequirements: CompiledPlanRequirement[];
	pricingPeers: CompiledPricingPeer[];
	retiredProviders: string[];
}

/** The complete compiled rule tree persisted as `rules.json`. */
export interface CompiledCompatRules {
	/** Compiled-format version; bump on incompatible shape changes. */
	version: 1;
	/** Every compiled source file, `rules/`-relative, sorted. */
	files: string[];
	taxonomy: CompiledTaxonomy;
	cascade: CompiledCascade;
	behavior: CompiledBehavior;
}

/** Structured identity of one classified model. */
export interface ModelIdentity {
	/** Vendor lineage id, `"unknown"` when unclassified. */
	class: string;
	/** Product family within the class, when classified. */
	family?: string;
	/** Canonical `major.minor.patch`, when extracted. */
	revision?: string;
	/** Effort tier collapsed out of the id, when the id was an effort variant. */
	effort?: Effort | "off";
	/** Whether the id carried a thinking-variant suffix. */
	thinkingVariant?: boolean;
	/** Canonical logical id when it differs from the wire id. */
	logicalId?: string;
}

/** Structured identity and capability input to `resolveCascade`. */
export interface ResolveTarget {
	/** Deployment provider hosting the model. */
	provider: string;
	/** Centrally classified vendor lineage. */
	class: string;
	/** Classified product family within the class, when known. */
	family?: string;
	/** Parsed model revision, when present in the identity. */
	revision?: string;
	/** Provider-relative model identifier. */
	model: string;
	/** Whether the model exposes a reasoning control surface. */
	reasoning: boolean;
}

/** Wire, thinking, and catalog assignments resolved for one target. */
export interface ResolvedAxes {
	wire: Record<string, unknown>;
	thinking: Record<string, unknown>;
	catalog: Record<string, unknown>;
}
