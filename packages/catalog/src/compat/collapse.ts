/**
 * Effort-tier variant collapsing.
 *
 * Some providers expose one logical model as several effort- or
 * thinking-suffixed upstream ids (Antigravity CCA:
 * `gemini-3.5-flash-extra-low`/`-low`, `claude-*`/`claude-*-thinking` pairs;
 * aggregators: `X`/`X-thinking` twins). Collapsing replaces the member specs
 * with one logical spec whose `thinking.effortRouting` records the per-effort
 * upstream wire id; request-time code resolves the outbound id via
 * `resolveWireModelId` and everything local (selection, caching, usage
 * attribution) keys on the logical `id`.
 *
 * Families come from two sources:
 * - Reviewed `variant-family` nodes in `compat/rules/taxonomy/_collapse.kdl`
 *   (compiled into `rules.json`) for providers whose routing needs curation
 *   (Antigravity tier triplets, single-member renames, recycled ids).
 * - `deriveThinkingPairFamilies`: the global automatic rule — any live
 *   `X` + `X-thinking` pair (trailing or infix token) collapses into `X`,
 *   routing thinking-enabled requests to `X-thinking`. Gated on identical
 *   pricing and same api: price-divergent twins are distinct SKUs and stay
 *   separate so billing attribution never lies.
 *
 * Family invariants (hold for compiled, reviewed and derived tables):
 * - One axis per family. A second id axis (e.g. Cursor's `-fast` service
 *   tier) becomes a sibling family, never a second routing dimension.
 * - The collapsed spec inherits non-tier fields from the first present
 *   member; members must be cost-homogeneous.
 *
 * `collapseVariants` is pure, deterministic, and idempotent:
 * `collapse(collapse(x))` equals `collapse(x)`, and mixed raw+collapsed input
 * (stale cache rows, previous-snapshot fallbacks) dedupes to the collapsed
 * entry. That makes it safe at every source — discovery, the catalog
 * generator, and the model-manager merge point.
 */
import { buildModel } from "../build";
import { Effort, THINKING_EFFORTS } from "../effort";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "../types";
import { resolveModelPolicy } from "./resolve";
import { collapseVariantId, collapseVocabulary, stripThinkingVariantSuffix } from "./taxonomy";
import type { CompiledVariantFamily } from "./types";

const VARIANT_ROUTING_KEYS: readonly (Effort | "off")[] = ["off", ...THINKING_EFFORTS];
const DEFAULT_PAIR_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];

/**
 * Structural bound for collapse inputs: both raw `ModelSpec`s and built
 * `Model`s qualify. (`Model.compat` is the resolved record, not the sparse
 * config, so the two are not mutually assignable — collapsing never touches
 * `compat`.)
 */
export type VariantSpecLike = Omit<ModelSpec<Api>, "compat"> & { compat?: unknown };

/** One collapsed family: logical id + member wire ids + per-effort routing. */
export interface EffortVariantFamily {
	/** Collapsed logical id (may equal a member id — e.g. bare/thinking pairs). */
	id: string;
	/** Final display name, no tier marker. */
	name: string;
	/**
	 * Member wire ids in priority order. The first member present in the input
	 * becomes the collapsed spec's default wire id (`requestModelId`; omitted
	 * when it equals the logical id).
	 */
	members: readonly string[];
	/**
	 * Preferred default wire id: overrides the member-order default for the
	 * collapsed spec's `requestModelId` when this member is live. Lets a
	 * mandatory-reasoning family advertise a canonical tier that is not its
	 * numeric floor (Cursor Grok 4.5/4.6 default to `-medium`, the only tier the
	 * Start plan serves; the `-low` floor is refused). Ignored when absent from
	 * the input or retired.
	 */
	defaultMember?: string;
	/**
	 * Wire ids upstream no longer serves (e.g. a deployment killed while
	 * discovery still advertises it). Fresh collapsing never routes to them,
	 * and stale collapsed snapshots (bundled catalog, cache rows,
	 * previous-generation fallbacks) get routing/`requestModelId` entries that
	 * target them re-pointed through `routing`. Keep retired ids in `members`
	 * so the raw upstream spec is still consumed and aliased.
	 */
	retiredMembers?: readonly string[];
	/**
	 * Per-effort upstream wire id; `"off"` applies when thinking is disabled.
	 * Entries whose target member is absent from the input are dropped — those
	 * efforts fall back to `requestModelId ?? id`.
	 */
	routing: Readonly<Partial<Record<Effort | "off", string>>>;
	/**
	 * Explicit capability surface for the collapsed spec — no inference. Omit
	 * for single-wire-id renames on providers where effort is encoded in the
	 * upstream id itself (Devin): with one member and no routing there is no
	 * controllable surface, and the collapsed spec must carry no thinking
	 * rather than an effort ladder whose every tier resolves to one wire id.
	 */
	thinking?: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;
	/** Thinking-off requests must explicitly suppress thinking on the wire. */
	suppressWhenOff?: boolean;
	/**
	 * Preserve non-off effort routes even when discovery omits the backing member.
	 * Used for Cloud Code Assist `X`/`X-thinking` pairs where upstream accepts
	 * the `-thinking` wire id but the model-list endpoint may advertise only the
	 * bare id.
	 */
	preserveAbsentEffortRoutes?: boolean;
	/** Retired/recycled selector ids that alias to this family without being members. */
	extraAliases?: readonly string[];
}

export interface VariantCollapseTable {
	families: readonly EffortVariantFamily[];
	/**
	 * Provider-scoped selector aliases: short native-CLI names and dotted
	 * upstream spellings → logical model id. Unlike family members and
	 * `extraAliases` these are deliberately invisible to the bare-id lookup
	 * ({@link resolveBareVariantSelector}) and to the reverse index — a generic
	 * label like `gpt` or `opus` only means something once a provider is
	 * named, and must never hijack an unqualified selector or re-key config.
	 */
	providerAliases?: Readonly<Record<string, string>>;
}

type TierRoutes = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>>;

/**
 * Build one effort-tier family from a tier→wire-id map: routing keeps only the
 * listed efforts, `members` dedupes the targets in tier order, and thinking is
 * `mode: "effort"` (mandatory when the family has no `off` route). Shared by the
 * Devin and Cursor tables, whose per-effort siblings follow the same shape.
 */
function tierFamily(
	id: string,
	name: string,
	routes: TierRoutes,
	efforts: readonly Effort[],
	defaultMember?: string,
): EffortVariantFamily {
	const routing: Partial<Record<Effort | "off", string>> = {};
	if (routes.off) routing.off = routes.off;
	for (const effort of efforts) {
		switch (effort) {
			case Effort.Minimal:
				if (routes.minimal) routing[effort] = routes.minimal;
				break;
			case Effort.Low:
				if (routes.low) routing[effort] = routes.low;
				break;
			case Effort.Medium:
				if (routes.medium) routing[effort] = routes.medium;
				break;
			case Effort.High:
				if (routes.high) routing[effort] = routes.high;
				break;
			case Effort.XHigh:
				if (routes.xhigh) routing[effort] = routes.xhigh;
				break;
			case Effort.Max:
				if (routes.max) routing[effort] = routes.max;
				break;
		}
	}
	const members = [
		routes.off,
		routes.minimal,
		routes.low,
		routes.medium,
		routes.high,
		routes.xhigh,
		routes.max,
	].filter((member, index, items): member is string => typeof member === "string" && items.indexOf(member) === index);
	return {
		id,
		name,
		members,
		routing,
		thinking: {
			mode: "effort",
			efforts,
			...(routes.off ? undefined : { requiresEffort: true }),
		},
		...(defaultMember !== undefined ? { defaultMember } : undefined),
	};
}

/** One reviewed family from the compiled collapse vocabulary → runtime shape. */
function compiledFamily(compiled: CompiledVariantFamily): EffortVariantFamily {
	const family: EffortVariantFamily = {
		id: compiled.id,
		name: compiled.name,
		members: compiled.members,
		routing: compiled.routing,
	};
	if (compiled.defaultMember !== undefined) family.defaultMember = compiled.defaultMember;
	if (compiled.retiredMembers?.length) family.retiredMembers = compiled.retiredMembers;
	if (!compiled.noThinking && compiled.mode !== undefined) {
		family.thinking = {
			mode: compiled.mode,
			efforts: compiled.efforts ?? [],
			...(compiled.effortBudgets !== undefined && {
				effortBudgets: compiled.effortBudgets,
			}),
			...(compiled.defaultLevel !== undefined && { defaultLevel: compiled.defaultLevel }),
			...(compiled.requiresEffort === true && { requiresEffort: true }),
		};
	}
	if (compiled.suppressWhenOff) family.suppressWhenOff = true;
	if (compiled.preserveAbsentEffortRoutes) family.preserveAbsentEffortRoutes = true;
	if (compiled.extraAliases?.length) family.extraAliases = compiled.extraAliases;
	return family;
}

/** Provider id → reviewed collapse table, built once from the compiled vocabulary. */
function buildCompiledTables(): Readonly<Record<string, VariantCollapseTable>> {
	const { variantFamilies, providerAliases } = collapseVocabulary();
	const tables: Record<string, { families: EffortVariantFamily[]; providerAliases?: Record<string, string> }> = {};
	for (const compiled of variantFamilies) {
		tables[compiled.provider] ??= { families: [] };
		tables[compiled.provider].families.push(compiledFamily(compiled));
	}
	for (const [provider, aliases] of Object.entries(providerAliases)) {
		tables[provider] ??= { families: [] };
		tables[provider].providerAliases = aliases;
	}
	return tables;
}

type CursorTierToken = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface CursorTierMember<TSpec extends VariantSpecLike> {
	baseId: string;
	fast: boolean;
	spec: TSpec;
	tier: CursorTierToken;
}

const CURSOR_TIER_ID_PATTERN = /^(.+?)-(extra-high|none|minimal|low|medium|high|xhigh|max)(-fast)?$/;
const CURSOR_TIER_BASE_PATTERN = /-(extra-high|none|minimal|low|medium|high|xhigh|max)$/;
const CURSOR_THINKING_TOKEN_PATTERN = /(^|-)thinking($|-)/;
const CURSOR_TIER_BY_TOKEN: Readonly<Record<string, CursorTierToken | undefined>> = {
	none: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	"extra-high": "xhigh",
	xhigh: "xhigh",
	max: "max",
};

/** Whether an existing logical row already routes every live member in `members`. */
function collapsedCursorLogicalMatches<TSpec extends VariantSpecLike>(
	spec: TSpec,
	members: readonly CursorTierMember<TSpec>[],
): boolean {
	const routing = spec.thinking?.effortRouting;
	if (!routing) return false;
	for (const member of members) {
		if (spec.requestModelId === member.spec.id) continue;
		let matched = false;
		for (const effort of VARIANT_ROUTING_KEYS) {
			if (routing[effort] === member.spec.id) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}

/**
 * Derive safe Cursor per-effort families from live wire ids. A family is
 * intentionally left expanded when its base is an independent live SKU, any
 * member already has a thinking ladder, member metadata differs, or a tier
 * token is also part of a product name.
 */
function deriveCursorEffortFamilies<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	const groups = new Map<string, CursorTierMember<TSpec>[]>();
	const candidateBases = new Set<string>();

	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
		const match = CURSOR_TIER_ID_PATTERN.exec(spec.id);
		if (!match) continue;
		const baseId = match[1];
		const tier = CURSOR_TIER_BY_TOKEN[match[2] ?? ""];
		const fast = match[3] !== undefined;
		if (!baseId || !tier) continue;
		const member = { baseId, fast, spec, tier };
		const key = `${baseId}\0${fast ? "fast" : "standard"}`;
		const group = groups.get(key);
		if (group) {
			group.push(member);
		} else {
			groups.set(key, [member]);
		}
		candidateBases.add(baseId);
	}

	const unsafeBases = new Set<string>();
	for (const group of groups.values()) {
		const first = group[0];
		if (!first) continue;
		const { baseId } = first;
		const standardGroup = groups.get(`${baseId}\0standard`) ?? [];
		const standardBase = byId.get(baseId);
		const laneBase = byId.get(`${baseId}${first.fast ? "-fast" : ""}`);
		const independentStandardBase =
			standardBase !== undefined && !collapsedCursorLogicalMatches(standardBase, standardGroup);
		const independentLaneBase = laneBase !== undefined && !collapsedCursorLogicalMatches(laneBase, group);
		if (
			independentStandardBase ||
			independentLaneBase ||
			new Set(group.map(member => member.tier)).size !== group.length ||
			CURSOR_TIER_BASE_PATTERN.test(baseId) ||
			CURSOR_THINKING_TOKEN_PATTERN.test(baseId) ||
			candidateBases.has(`${baseId}-thinking`) ||
			byId.has(`${baseId}-thinking`) ||
			byId.has(`${baseId}-thinking-fast`) ||
			byId.has(`${baseId}-fast-thinking`) ||
			group.some(member => member.spec.thinking !== undefined || member.spec.requestModelId !== undefined) ||
			group.some(member => candidateBases.has(`${baseId}-${member.tier}`))
		) {
			unsafeBases.add(baseId);
		}
	}

	const families: EffortVariantFamily[] = [];
	for (const group of groups.values()) {
		const first = group[0];
		if (!first || group.length < 2 || unsafeBases.has(first.baseId)) continue;
		if (
			group.some(
				member =>
					member.spec.api !== first.spec.api ||
					member.spec.baseUrl !== first.spec.baseUrl ||
					member.spec.contextWindow !== first.spec.contextWindow ||
					member.spec.maxTokens !== first.spec.maxTokens ||
					member.spec.cursorMaxMode !== first.spec.cursorMaxMode ||
					!Bun.deepEquals(member.spec.cost, first.spec.cost) ||
					!Bun.deepEquals(member.spec.compat, first.spec.compat),
			)
		) {
			continue;
		}

		const routes: TierRoutes = {};
		for (const member of group) {
			if (member.tier === "none") {
				routes.off = member.spec.id;
			} else {
				routes[member.tier] = member.spec.id;
			}
		}
		const efforts = THINKING_EFFORTS.filter(effort => routes[effort] !== undefined);
		if (efforts.length === 0) continue;
		const strippedName = first.spec.name
			.replace(/\s+(extra-high|none|minimal|low|medium|high|xhigh|max)(\s+fast)?$/i, "")
			.trim();
		const baseName = strippedName === first.spec.id ? first.baseId : strippedName || first.baseId;
		const suffix = first.fast ? "-fast" : "";
		families.push(tierFamily(`${first.baseId}${suffix}`, `${baseName}${first.fast ? " Fast" : ""}`, routes, efforts));
	}
	return families;
}

/** Provider id → reviewed collapse table. The CCA providers diverge on thinking transport. */
const REVIEWED_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>> = buildCompiledTables();

/**
 * Return the reviewed collapse table compiled for `provider`, when declared.
 * Discovery uses this accessor to preserve injectable table seams.
 */
export function reviewedCollapseTable(provider: string): VariantCollapseTable | undefined {
	return REVIEWED_COLLAPSE_TABLES[provider] ?? REVIEWED_COLLAPSE_TABLES[provider.toLowerCase()];
}

/**
 * The global automatic rule: derive an `X` + `X-thinking` family for every
 * pair where both ids are live in `specs` (trailing or infix token). Gates:
 * - both members share the same `api`,
 * - known pricing must match — all-zero cost rows count as unknown
 *   (aggregators routinely ship them), but twins that BOTH carry real,
 *   differing prices are distinct SKUs and never merge,
 * - ids claimed by the provider's reviewed table are skipped (curation wins).
 * The capability surface prefers the thinking member's metadata, then the
 * bare member's, then the canonical deriver (aggregators often ship
 * `reasoning: false` and no thinking config on the twin), then a budget
 * default. `off` routes to the bare id; every supported effort routes to the
 * thinking id.
 */
export function deriveThinkingPairFamilies<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table?: VariantCollapseTable,
	provider?: string,
): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}
	const claimed = table ? getAliasIndex(table) : undefined;
	const families: EffortVariantFamily[] = [];
	for (const spec of specs) {
		const collapsed = provider === undefined ? undefined : collapseVariantId(provider, spec.id);
		const baseId = collapsed?.thinkingVariant ? collapsed.logicalId : stripThinkingVariantSuffix(spec.id);
		if (baseId === undefined || baseId === spec.id) continue;
		const base = byId.get(baseId);
		if (!base) continue;
		if (claimed) {
			const forward = claimed.forward;
			if (
				forward.has(spec.id.toLowerCase()) ||
				forward.has(baseId.toLowerCase()) ||
				claimed.familyIds.has(spec.id) ||
				claimed.familyIds.has(baseId)
			) {
				continue;
			}
		}
		if (spec.api !== base.api) continue;
		const specPriced = spec.cost.input !== 0 || spec.cost.output !== 0;
		const basePriced = base.cost.input !== 0 || base.cost.output !== 0;
		if (
			specPriced &&
			basePriced &&
			(spec.cost.input !== base.cost.input ||
				spec.cost.output !== base.cost.output ||
				spec.cost.cacheRead !== base.cost.cacheRead ||
				spec.cost.cacheWrite !== base.cost.cacheWrite)
		) {
			continue;
		}
		const surface = derivePairThinkingSurface(spec, base);
		const routing: Partial<Record<Effort | "off", string>> = { off: base.id };
		for (const effort of surface.efforts) {
			routing[effort] = spec.id;
		}
		families.push({
			id: base.id,
			name: base.name,
			members: [base.id, spec.id],
			routing,
			thinking: surface,
		});
	}
	return families;
}

function derivePairThinkingSurface(
	thinkingSpec: VariantSpecLike,
	baseSpec: VariantSpecLike,
): Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff" | "requiresEffort"> {
	const baked = thinkingSpec.thinking ?? baseSpec.thinking;
	if (baked && baked.efforts.length > 0) {
		const { effortRouting: _routing, suppressWhenOff: _suppress, requiresEffort: _required, ...surface } = baked;
		return surface;
	}
	const { compat: _compat, ...policySpec } = thinkingSpec;
	const derived = resolveModelPolicy({
		...policySpec,
		reasoning: true,
		thinking: undefined,
	}).thinking;
	if (derived && derived.efforts.length > 0) {
		const { effortRouting: _dRouting, suppressWhenOff: _dSuppress, requiresEffort: _dRequired, ...surface } = derived;
		return surface;
	}
	return { mode: "budget", efforts: DEFAULT_PAIR_EFFORTS };
}

/**
 * True when `spec` is the output of collapsing rather than a raw upstream
 * member. `thinking.effortRouting` is written only by collapsing; the
 * `requestModelId` arm is scoped to the provider's reviewed-table family ids so
 * unrelated carriers (GitHub Copilot `-1m` context variants) never match.
 */
export function isCollapsedVariantSpec(spec: VariantSpecLike): boolean {
	if (spec.thinking?.effortRouting !== undefined) {
		return true;
	}
	if (spec.requestModelId === undefined) {
		return false;
	}
	const table = reviewedCollapseTable(spec.provider);
	return table !== undefined && getAliasIndex(table).familyIds.has(spec.id);
}

/**
 * Re-point a stale collapsed spec whose `requestModelId` or routing still
 * targets a retired wire id. Collapsed snapshots (bundled catalog, cache
 * rows, previous-generation fallbacks) pass through collapsing untouched, so
 * a reviewed-table routing fix would otherwise never reach them. Only retired
 * targets are rewritten — presence-filtered routing decisions from live
 * discovery stay authoritative for everything else. Per retired entry the
 * table's route for that effort wins, then the off/first-live-member wire id,
 * then the route is dropped (falls back to `requestModelId ?? id`). Returns
 * `spec` by reference when nothing targets a retired id.
 */
function reconcileRetiredRouting<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string>,
): TSpec {
	const currentThinking = spec.thinking;
	const routing = currentThinking?.effortRouting;
	const requestRetired = spec.requestModelId !== undefined && retired.has(spec.requestModelId);
	let routingRetired = false;
	if (routing !== undefined) {
		for (const key of VARIANT_ROUTING_KEYS) {
			const target = routing[key];
			if (target !== undefined && retired.has(target)) {
				routingRetired = true;
				break;
			}
		}
	}
	if (!requestRetired && !routingRetired) return spec;

	const offTarget = family.routing.off;
	const fallbackWireId =
		offTarget !== undefined && !retired.has(offTarget) ? offTarget : family.members.find(id => !retired.has(id));
	const next: TSpec = { ...spec };
	if (routingRetired && routing !== undefined && currentThinking !== undefined) {
		const nextRouting: Partial<Record<Effort | "off", string>> = {};
		for (const effortKey of VARIANT_ROUTING_KEYS) {
			const target = routing[effortKey];
			if (target === undefined) continue;
			if (!retired.has(target)) {
				nextRouting[effortKey] = target;
				continue;
			}
			const tableTarget = family.routing[effortKey];
			if (tableTarget !== undefined && !retired.has(tableTarget)) {
				nextRouting[effortKey] = tableTarget;
			} else if (fallbackWireId !== undefined) {
				nextRouting[effortKey] = fallbackWireId;
			}
		}
		next.thinking = { ...currentThinking, effortRouting: nextRouting };
	}
	if (requestRetired) {
		if (fallbackWireId !== undefined && fallbackWireId !== spec.id) {
			next.requestModelId = fallbackWireId;
		} else {
			delete next.requestModelId;
		}
	}
	return next;
}

/**
 * Refresh a collapsed snapshot's thinking surface in place. Bundled catalog and
 * prev-generation snapshots freeze a family's transport, budgets, and routing;
 * discovery emits the canonical id but the exact-id merge never overwrites a
 * stale `family.id` row (e.g. `gemini-3.1-pro`) nor a recycled `extraAliases`
 * row (e.g. `gemini-3-flash`). This re-applies the reviewed-table family's thinking,
 * routing, and default wire id while keeping the spec id (load-bearing for exact
 * selectors and bundled lookups). Returns `spec` by reference when unchanged.
 */
function refreshCollapsedThinking<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	retired: ReadonlySet<string> | undefined,
): TSpec {
	// Scope snapshot self-heal to families carrying a curated per-effort budget
	// contract (Antigravity gemini-3.x). Their routing targets are all verified
	// live, so rebuilding routing here is safe; families without `effortBudgets`
	// (derived `X`/`X-thinking` pairs, claude pairs, surface-less renames) keep
	// their presence-filtered snapshot routing untouched.
	const familyThinking = family.thinking;
	if (!spec.reasoning || familyThinking?.effortBudgets === undefined) return spec;
	const routing: Partial<Record<Effort | "off", string>> = {};
	let hasRouting = false;
	for (const effortKey of VARIANT_ROUTING_KEYS) {
		const target = family.routing[effortKey];
		if (target !== undefined && !retired?.has(target)) {
			routing[effortKey] = target;
			hasRouting = true;
		}
	}
	const thinking: ThinkingConfig = { ...familyThinking };
	if (hasRouting) thinking.effortRouting = routing;
	if (family.suppressWhenOff) thinking.suppressWhenOff = true;
	const offTarget = family.routing.off;
	const requestModelId =
		offTarget !== undefined && !retired?.has(offTarget) && offTarget !== spec.id ? offTarget : spec.requestModelId;
	if (Bun.deepEquals(thinking, spec.thinking) && requestModelId === spec.requestModelId) {
		return spec;
	}
	return { ...spec, thinking, ...(requestModelId !== undefined ? { requestModelId } : {}) };
}

/**
 * Re-point a collapsed snapshot's default wire id to the family's declared
 * {@link EffortVariantFamily.defaultMember} when the snapshot still advertises a
 * different default. Bundled catalog and cache rows freeze `requestModelId` from
 * before a family gained a preferred default (Cursor Grok 4.5/4.6 → `-medium`),
 * and neither the existing-collapsed pass-through nor `refreshCollapsedThinking`
 * (scoped to `effortBudgets` families) would otherwise correct them — leaving an
 * effort-less request clamped to the refused `-low` tier (issue #9478). Only
 * re-points when the target is a live route in the snapshot's own
 * `effortRouting`. Returns `spec` by reference when unchanged.
 */
function reconcileDefaultMember<TSpec extends VariantSpecLike>(
	spec: TSpec,
	family: EffortVariantFamily,
	presentMembers?: ReadonlySet<string>,
): TSpec {
	const defaultMember = family.defaultMember;
	if (defaultMember === undefined || defaultMember === spec.id) return spec;
	const target =
		presentMembers === undefined || presentMembers.has(defaultMember)
			? defaultMember
			: family.members.find(id => presentMembers.has(id));
	if (target === undefined || spec.requestModelId === target) return spec;
	const routing = spec.thinking?.effortRouting;
	if (routing === undefined) return spec;
	for (const key of VARIANT_ROUTING_KEYS) {
		if (routing[key] === target) return { ...spec, requestModelId: target };
	}
	return spec;
}

/**
 * Collapse every family in `table` found in `specs`. Non-member specs pass
 * through verbatim (by reference), order preserved; the collapsed spec
 * replaces the first occurrence of its family.
 */
function collapseWithTable<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table: VariantCollapseTable,
): TSpec[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}

	/** family id → spec to emit at the family's first occurrence. */
	const replacement = new Map<string, TSpec>();
	/** spec ids that belong to a touched family (members + logical id). */
	const familyIdBySpecId = new Map<string, string>();

	for (const family of table.families) {
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		const existing = byId.get(family.id);
		const existingCollapsed =
			existing !== undefined &&
			(existing.requestModelId !== undefined || existing.thinking?.effortRouting !== undefined);
		const reconciled =
			existing !== undefined && existingCollapsed && retired !== undefined
				? reconcileRetiredRouting(existing, family, retired)
				: existing;
		const rawPresent = family.members.filter(id => byId.has(id) && !(id === family.id && existingCollapsed));
		if (rawPresent.length === 0) {
			// Inert (no members) or already collapsed (pass-through). A stale
			// family.id-keyed snapshot is refreshed in place from the current
			// reviewed-table family (transport/budgets/routing); retired targets drop.
			// Recycled extraAliases rows are healed in a later pass.
			const refreshed =
				existing !== undefined && existingCollapsed
					? reconcileDefaultMember(refreshCollapsedThinking(reconciled ?? existing, family, retired), family)
					: reconciled;
			if (refreshed !== undefined && refreshed !== existing) {
				familyIdBySpecId.set(family.id, family.id);
				replacement.set(family.id, refreshed);
			}
			continue;
		}

		for (const id of rawPresent) familyIdBySpecId.set(id, family.id);
		if (existing) familyIdBySpecId.set(family.id, family.id);

		if (existingCollapsed && reconciled !== undefined) {
			// Mixed input: the collapsed entry wins; stale raw members are deduped
			// away. Retired targets are re-pointed first, then the default wire id
			// prefers the family's declared member when live and otherwise falls
			// back to the first member the account actually advertised.
			replacement.set(family.id, reconcileDefaultMember(reconciled, family, new Set(rawPresent)));
			continue;
		}

		const memberSpecs: TSpec[] = [];
		for (const id of rawPresent) {
			const member = byId.get(id);
			if (member !== undefined) memberSpecs.push(member);
		}
		const firstMember = memberSpecs[0];
		if (firstMember === undefined) continue;
		const presentSet = new Set(rawPresent);
		const routing: Partial<Record<Effort | "off", string>> = {};
		let hasRouting = false;
		let hasEffortRoute = false;
		let usedAbsentEffortRoute = false;
		for (const effort of VARIANT_ROUTING_KEYS) {
			const target = family.routing[effort];
			const targetPresent = target !== undefined && presentSet.has(target);
			const preserveAbsentEffort =
				target !== undefined && effort !== "off" && family.preserveAbsentEffortRoutes === true;
			if (target !== undefined && (targetPresent || preserveAbsentEffort) && !retired?.has(target)) {
				routing[effort] = target;
				hasRouting = true;
				if (effort !== "off") hasEffortRoute = true;
				if (!targetPresent && effort !== "off") usedAbsentEffortRoute = true;
			}
		}

		// A family that routes efforts to a live thinking backing id reasons
		// even when upstream metadata forgot to mark the members.
		const reasoning = memberSpecs.some(spec => spec.reasoning) || hasEffortRoute;
		const familyThinking = family.thinking;
		const thinking: ThinkingConfig | undefined = familyThinking ? { ...familyThinking } : undefined;
		if (thinking !== undefined) {
			if (hasRouting) thinking.effortRouting = routing;
			if (family.suppressWhenOff) thinking.suppressWhenOff = true;
		}

		const input: ("text" | "image")[] = [];
		if (memberSpecs.some(spec => spec.input.includes("text"))) input.push("text");
		if (memberSpecs.some(spec => spec.input.includes("image"))) input.push("image");

		const collapsed: TSpec = {
			...firstMember,
			id: family.id,
			name: family.name,
			reasoning,
			input,
			contextWindow: maxOrNull(memberSpecs.map(spec => spec.contextWindow)),
			maxTokens: maxOrNull(memberSpecs.map(spec => spec.maxTokens)),
		};
		// The default wire id is the family's declared `defaultMember` when live,
		// else the highest-priority live member. Omitted when it equals the
		// logical id (bare/thinking pairs) — `resolveWireModelId` falls back.
		// Retired members never become the default.
		const preferredDefault =
			family.defaultMember !== undefined &&
			presentSet.has(family.defaultMember) &&
			!retired?.has(family.defaultMember)
				? family.defaultMember
				: undefined;
		const defaultWireId = preferredDefault ?? rawPresent.find(id => !retired?.has(id)) ?? rawPresent[0];
		if (defaultWireId === undefined) continue;
		if (defaultWireId === family.id) {
			if (usedAbsentEffortRoute) {
				collapsed.requestModelId = defaultWireId;
			} else {
				delete collapsed.requestModelId;
			}
		} else {
			collapsed.requestModelId = defaultWireId;
		}
		// A surface-less family (single wire id, uid-encoded effort) keeps
		// `reasoning` but carries no thinking: every tier would resolve to the
		// same upstream id, so there is nothing to select.
		if (reasoning && thinking !== undefined) {
			collapsed.thinking = thinking;
		} else {
			delete collapsed.thinking;
		}
		replacement.set(family.id, collapsed);
	}

	// Refresh stale alias-keyed snapshots in place (recycled bare ids). Runs even
	// when the canonical family.id row is also present, since the exact-id merge
	// keeps the stale alias row alongside the discovered canonical one.
	for (const family of table.families) {
		if (family.extraAliases === undefined) continue;
		const retired =
			family.retiredMembers !== undefined && family.retiredMembers.length > 0
				? new Set(family.retiredMembers)
				: undefined;
		for (const alias of family.extraAliases) {
			if (alias === family.id || familyIdBySpecId.has(alias)) continue;
			const aliasSpec = byId.get(alias);
			if (aliasSpec === undefined) continue;
			const refreshed = refreshCollapsedThinking(aliasSpec, family, retired);
			if (refreshed !== aliasSpec) {
				familyIdBySpecId.set(alias, alias);
				replacement.set(alias, refreshed);
			}
		}
	}

	if (replacement.size === 0) return [...specs];

	const emitted = new Set<string>();
	const out: TSpec[] = [];
	for (const spec of specs) {
		const familyId = familyIdBySpecId.get(spec.id);
		if (familyId === undefined) {
			out.push(spec);
			continue;
		}
		if (emitted.has(familyId)) continue;
		emitted.add(familyId);
		const familySpec = replacement.get(familyId);
		if (familySpec !== undefined) out.push(familySpec);
	}
	return out;
}

/**
 * Re-key model-to-model configuration after collapse removes a referenced
 * member id. Qualified targets keep their provider; bare targets remain bare.
 */
function retargetCollapsedModelReferences<TSpec extends VariantSpecLike>(specs: TSpec[]): void {
	const liveIdsByProvider = new Map<string, Set<string>>();
	for (const spec of specs) {
		const provider = spec.provider.toLowerCase();
		let liveIds = liveIdsByProvider.get(provider);
		if (!liveIds) {
			liveIds = new Set<string>();
			liveIdsByProvider.set(provider, liveIds);
		}
		liveIds.add(spec.id.toLowerCase());
	}

	for (let index = 0; index < specs.length; index++) {
		const spec = specs[index];
		if (!spec) continue;
		const contextPromotionTarget = resolveCollapsedModelReference(
			spec.contextPromotionTarget,
			spec.provider,
			liveIdsByProvider,
		);
		const compactionModel = resolveCollapsedModelReference(spec.compactionModel, spec.provider, liveIdsByProvider);
		if (contextPromotionTarget === spec.contextPromotionTarget && compactionModel === spec.compactionModel) continue;
		specs[index] = { ...spec, contextPromotionTarget, compactionModel };
	}
}

function resolveCollapsedModelReference(
	target: string | undefined,
	currentProvider: Provider,
	liveIdsByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
	if (target === undefined) return undefined;
	const separator = target.indexOf("/");
	const provider = separator >= 0 ? target.slice(0, separator) : currentProvider;
	const providerId = provider.toLowerCase();
	const modelId = separator >= 0 ? target.slice(separator + 1) : target;
	const normalizedModelId = modelId.trim().toLowerCase();
	const liveIds = liveIdsByProvider.get(providerId);
	if (liveIds?.has(normalizedModelId)) return target;
	const alias = resolveRegisteredVariantAlias(provider, normalizedModelId);
	if (alias === undefined || !liveIds?.has(alias.toLowerCase())) return target;
	return separator >= 0 ? `${provider}/${alias}` : alias;
}

/**
 * Collapse a full mixed-provider list: per provider, the compiled reviewed table, Cursor's
 * conservative live effort-sibling rule, and the automatic `X`/`X-thinking`
 * pair rule. Used by the catalog generator; the runtime equivalent lives at
 * the model-manager merge point. Output is regrouped by provider — callers
 * re-sort.
 */
export function collapseVariants<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	opts?: { table?: VariantCollapseTable },
): TSpec[] {
	if (opts?.table !== undefined) return collapseWithTable(specs, opts.table);
	const byProvider = new Map<string, TSpec[]>();
	for (const spec of specs) {
		const slice = byProvider.get(spec.provider);
		if (slice) {
			slice.push(spec);
		} else {
			byProvider.set(spec.provider, [spec]);
		}
	}
	const out: TSpec[] = [];
	for (const [provider, slice] of byProvider) {
		const table = reviewedCollapseTable(provider);
		let result = table ? collapseWithTable(slice, table) : slice;
		if (provider === "cursor") {
			const cursorDerived = deriveCursorEffortFamilies(result);
			if (cursorDerived.length > 0) {
				result = collapseWithTable(result, { families: cursorDerived });
			}
		}
		const derived = deriveThinkingPairFamilies(result, table, provider);
		if (derived.length > 0) {
			result = collapseWithTable(result, { families: derived });
		}
		registerCollapsedVariantAliases(provider, result);
		out.push(...result);
	}
	retargetCollapsedModelReferences(out);
	return out;
}

/**
 * Runtime entry point for already-built `Model` lists (the model-manager
 * merge point, coding-agent registry custom providers): collapses hand
 * tables plus derived pairs, then re-runs `buildModel` on freshly created
 * logical specs so thinking wire defaults stay resolved. Untouched entries
 * pass through by reference.
 */
export function collapseBuiltVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	const collapsed = collapseVariants(models);
	const inputRefs = new Set<Model<TApi>>(models);
	return collapsed.map(model => (inputRefs.has(model) ? model : buildModel(projectModelSpec(model))));
}

function projectModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	const {
		compat: _resolvedCompat,
		compatConfig,
		identity: _identity,
		requiresGlyphTokenization: _requiresGlyphTokenization,
		supportsComputerUseConfig: _supportsComputerUseConfig,
		...spec
	} = model;
	return { ...spec, compat: compatConfig };
}

class VariantAliasIndex {
	/** lowercased retired id → replacement model id. */
	readonly forward = new Map<string, string>();
	/**
	 * lowercased provider-scoped alias → replacement model id. Kept apart from
	 * `forward` so bare-id and reverse lookups never see it.
	 */
	readonly providerScoped = new Map<string, string>();
	/** replacement model id → retired ids that resolve to it. */
	readonly reverse = new Map<string, string[]>();
	/** Collapsed logical ids declared by the table or observed at runtime. */
	readonly familyIds = new Set<string>();
}

const dynamicAliasIndexes = new Map<string, VariantAliasIndex>();
const kAliasIndex = Symbol("compat-collapse.aliasIndex");

function createAliasIndex(): VariantAliasIndex {
	return new VariantAliasIndex();
}

function addVariantAlias(index: VariantAliasIndex, from: string, to: string): boolean {
	if (from === to || index.forward.has(from.toLowerCase())) return false;
	index.forward.set(from.toLowerCase(), to);
	const sources = index.reverse.get(to);
	if (sources) {
		sources.push(from);
	} else {
		index.reverse.set(to, [from]);
	}
	return true;
}

/**
 * Persist aliases embedded in collapsed routing so generated catalog rows and
 * newly discovered families expose the same selector migrations as reviewed tables.
 */
function registerCollapsedVariantAliases(provider: Provider, specs: readonly VariantSpecLike[]): void {
	const providerId = provider.toLowerCase();
	let index = dynamicAliasIndexes.get(providerId);
	for (const spec of specs) {
		const routing = spec.thinking?.effortRouting;
		if (!routing) continue;
		let registered = false;
		for (const effort of VARIANT_ROUTING_KEYS) {
			const source = routing[effort];
			if (!source || source === spec.id) continue;
			index ??= createAliasIndex();
			registered = addVariantAlias(index, source, spec.id) || registered;
		}
		if (spec.requestModelId && spec.requestModelId !== spec.id) {
			index ??= createAliasIndex();
			registered = addVariantAlias(index, spec.requestModelId, spec.id) || registered;
		}
		if (registered) index?.familyIds.add(spec.id);
	}
	if (index) dynamicAliasIndexes.set(providerId, index);
}

function resolveRegisteredVariantAlias(provider: Provider, normalizedModelId: string): string | undefined {
	const providerId = provider.toLowerCase();
	const table = reviewedCollapseTable(provider) ?? reviewedCollapseTable(providerId);
	return (
		(table ? getAliasIndex(table).forward.get(normalizedModelId) : undefined) ??
		dynamicAliasIndexes.get(providerId)?.forward.get(normalizedModelId)
	);
}

function getAliasIndex(table: VariantCollapseTable): VariantAliasIndex {
	const cached: unknown = Reflect.get(table, kAliasIndex);
	if (cached instanceof VariantAliasIndex) return cached;
	const index = createAliasIndex();
	for (const family of table.families) {
		index.familyIds.add(family.id);
		for (const member of family.members) addVariantAlias(index, member, family.id);
		for (const alias of family.extraAliases ?? []) addVariantAlias(index, alias, family.id);
	}
	for (const alias in table.providerAliases) {
		const target = table.providerAliases[alias];
		if (target !== undefined && alias !== target) index.providerScoped.set(alias.toLowerCase(), target);
	}
	Reflect.set(table, kAliasIndex, index);
	return index;
}

/**
 * Resolve a retired effort-tier variant id, registered live alias, or
 * provider-scoped native alias to its replacement model id for `provider`.
 * Returns `undefined` when the id is unknown. Callers must try an exact model
 * lookup first because a live model always wins over an alias.
 */
export function resolveVariantSelector(provider: Provider, modelId: string): string | undefined {
	const normalized = modelId.trim().toLowerCase();
	const registered = resolveRegisteredVariantAlias(provider, normalized);
	if (registered !== undefined) return registered;
	const table = reviewedCollapseTable(provider);
	return table ? getAliasIndex(table).providerScoped.get(normalized) : undefined;
}

/** Bare-id alias hit: replacement id plus the providers declaring it. */
export interface BareVariantAliasHit {
	id: string;
	/** Providers declaring the alias — candidates from these win ties. */
	providers: readonly Provider[];
}

/**
 * Provider-agnostic alias lookup for bare-id selectors. Returns the declaring
 * providers so callers can prefer their models when the replacement id exists
 * on unrelated providers too (e.g. a retired Cursor tier id must not resolve
 * to `openai/gpt-5.4`).
 */
export function resolveBareVariantSelector(modelId: string): BareVariantAliasHit | undefined {
	const normalized = modelId.trim().toLowerCase();
	const providerIds = new Set<string>();
	for (const provider in REVIEWED_COLLAPSE_TABLES) providerIds.add(provider);
	for (const provider of dynamicAliasIndexes.keys()) providerIds.add(provider);
	for (const provider of providerIds) {
		const hit = resolveRegisteredVariantAlias(provider, normalized);
		if (hit === undefined) continue;
		const providers: Provider[] = [];
		for (const candidate of providerIds) {
			if (resolveRegisteredVariantAlias(candidate, normalized) === hit) {
				providers.push(candidate);
			}
		}
		return { id: hit, providers };
	}
	return undefined;
}

/**
 * Reverse alias lookup: the retired ids that resolve to `modelId` for
 * `provider` via reviewed-table or registered live aliases. Used to re-key config
 * keyed by raw member ids (models.yml `modelOverrides`, suppressed selectors)
 * onto the collapsed model.
 */
export function getVariantAliasSources(provider: Provider, modelId: string): readonly string[] {
	const providerId = provider.toLowerCase();
	const table = reviewedCollapseTable(provider) ?? reviewedCollapseTable(providerId);
	const staticSources = table ? getAliasIndex(table).reverse.get(modelId) : undefined;
	const dynamicSources = dynamicAliasIndexes.get(providerId)?.reverse.get(modelId);
	if (!staticSources) return dynamicSources ?? [];
	if (!dynamicSources) return staticSources;
	return [...new Set([...staticSources, ...dynamicSources])];
}

function maxOrNull(values: ReadonlyArray<number | null>): number | null {
	const known = values.filter((v): v is number => v != null);
	return known.length ? Math.max(...known) : null;
}
