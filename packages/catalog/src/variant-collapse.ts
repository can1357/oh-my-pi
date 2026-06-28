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
 * - Hand tables (`VARIANT_COLLAPSE_TABLES`) for providers whose routing needs
 *   curation (Antigravity tier triplets, single-member renames, recycled ids).
 * - `deriveThinkingPairFamilies`: the global automatic rule — any live
 *   `X` + `X-thinking` pair (trailing or infix token) collapses into `X`,
 *   routing thinking-enabled requests to `X-thinking`. Gated on identical
 *   pricing and same api: price-divergent twins are distinct SKUs and stay
 *   separate so billing attribution never lies.
 *
 * Family invariants (hold for hand-written and derived tables):
 * - One axis per family. A second id axis (e.g. Cursor's `-fast` service
 *   tier) becomes a sibling family, never a second routing dimension.
 * - The collapsed spec inherits non-tier fields from the first present
 *   member; members must be cost-homogeneous.
 *
 * `collapseEffortVariants` is pure, deterministic, and idempotent:
 * `collapse(collapse(x))` equals `collapse(x)`, and mixed raw+collapsed input
 * (stale cache rows, previous-snapshot fallbacks) dedupes to the collapsed
 * entry. That makes it safe at every source — discovery, the catalog
 * generator, and the model-manager merge point.
 */
import { buildCompat, buildModel } from "./build";
import { Effort } from "./effort";
import { stripThinkingVariantToken } from "./identity/family";
import { resolveModelThinking } from "./model-thinking";
import type { Api, Model, ModelSpec, Provider, ThinkingConfig } from "./types";

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
	/** Explicit capability surface for the collapsed spec — no inference. */
	thinking: Readonly<Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff">>;
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
}

/** `X` + `X-thinking` hand family: off routes to the bare id, efforts to `-thinking`. */
function thinkingPair(baseId: string, name: string): EffortVariantFamily {
	return {
		id: baseId,
		name,
		members: [baseId, `${baseId}-thinking`],
		routing: {
			off: baseId,
			[Effort.Minimal]: `${baseId}-thinking`,
			[Effort.Low]: `${baseId}-thinking`,
			[Effort.Medium]: `${baseId}-thinking`,
			[Effort.High]: `${baseId}-thinking`,
		},
		// Thinking-off routes to the non-thinking backing id, where omitting
		// thinkingConfig is already correct — no suppressWhenOff.
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		preserveAbsentEffortRoutes: true,
	};
}

type DevinTierRoutes = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string>>;

function devinTierFamily(
	id: string,
	name: string,
	routes: DevinTierRoutes,
	efforts: readonly Effort[],
): EffortVariantFamily {
	const routing: Partial<Record<Effort | "off", string>> = {};
	if (routes.off) routing.off = routes.off;
	for (const effort of efforts) {
		switch (effort) {
			case Effort.Minimal:
				if (routes.minimal) {
					routing[effort] = routes.minimal;
				} else if (routes.low) {
					routing[effort] = routes.low;
				}
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
		}
	}
	const members = [routes.off, routes.minimal, routes.low, routes.medium, routes.high, routes.xhigh].filter(
		(member, index, items): member is string => typeof member === "string" && items.indexOf(member) === index,
	);
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
	};
}

const GEMINI_3_FLASH_FAMILY_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const GEMINI_3_PRO_FAMILY_EFFORTS: readonly Effort[] = [Effort.Low, Effort.High];

/**
 * Antigravity Cloud Code Assist sends an explicit `thinkingBudget` per tier
 * (verified against captured `daily-cloudcode-pa` requests). Flash uses round
 * budgets; Pro offsets every budget by +1. Minimal mirrors Low (the Antigravity
 * UI exposes Low/Medium/High only) so the effort stays selectable.
 */
const GEMINI_3_FLASH_FAMILY_BUDGETS: Readonly<Partial<Record<Effort, number>>> = {
	[Effort.Minimal]: 1000,
	[Effort.Low]: 1000,
	[Effort.Medium]: 4000,
	[Effort.High]: 10000,
};
const GEMINI_3_PRO_FAMILY_BUDGETS: Readonly<Partial<Record<Effort, number>>> = {
	[Effort.Low]: 1001,
	[Effort.High]: 10001,
};

/**
 * The two Cloud Code Assist providers share the same Antigravity discovery list
 * but disagree on the thinking transport: `google-antigravity` (daily-cloudcode-pa)
 * sends an explicit `thinkingBudget` (verified against captured requests), while
 * `google-gemini-cli` (cloudcode-pa) follows the official Gemini CLI and uses
 * `thinkingLevel`. The Gemini 3.x families therefore differ only in thinking
 * transport (and, for Flash, the per-tier wire-id routing); everything else is
 * shared verbatim.
 */
function geminiFlashFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		members: ["gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3-flash-agent"],
		routing: budget
			? {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3.5-flash-extra-low",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-low",
					[Effort.High]: "gemini-3-flash-agent",
				}
			: {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3-flash-agent",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-extra-low",
					[Effort.High]: "gemini-3.5-flash-low",
				},
		thinking: budget
			? { mode: "budget", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS, effortBudgets: GEMINI_3_FLASH_FAMILY_BUDGETS }
			: { mode: "google-level", efforts: GEMINI_3_FLASH_FAMILY_EFFORTS },
		suppressWhenOff: true,
		// Retired bare id; the alias only fires when no live model holds it
		// (exact match wins in every resolver).
		extraAliases: ["gemini-3-flash"],
	};
}

function geminiProFamily(mode: "budget" | "google-level"): EffortVariantFamily {
	const budget = mode === "budget";
	return {
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		// High routes to `gemini-pro-agent` — the upstream `gemini-3.1-pro-high`
		// deployment returns INVALID_ARGUMENT on every streamGenerateContent
		// request (both CCA endpoints) while discovery still lists it;
		// `gemini-pro-agent` is the same model ("Gemini 3.1 Pro (High)", same
		// thinking budget/caps) and accepts the identical request body.
		// `gemini-3.1-pro-high` stays a member so the dead raw id is consumed.
		members: ["gemini-3.1-pro-low", "gemini-pro-agent", "gemini-3.1-pro-high"],
		retiredMembers: ["gemini-3.1-pro-high"],
		routing: {
			off: "gemini-3.1-pro-low",
			[Effort.Low]: "gemini-3.1-pro-low",
			[Effort.High]: "gemini-pro-agent",
		},
		thinking: budget
			? { mode: "budget", efforts: GEMINI_3_PRO_FAMILY_EFFORTS, effortBudgets: GEMINI_3_PRO_FAMILY_BUDGETS }
			: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
		suppressWhenOff: true,
	};
}

/** CCA families shared verbatim by both providers (transport-agnostic). */
const SHARED_CCA_FAMILIES: readonly EffortVariantFamily[] = [
	{
		// Legacy static family — covers stale snapshots and caches. Stale ids are
		// unverified against the budget-mode CCA contract; keep them on level.
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		members: ["gemini-3-pro-low", "gemini-3-pro-high"],
		routing: {
			off: "gemini-3-pro-low",
			[Effort.Low]: "gemini-3-pro-low",
			[Effort.High]: "gemini-3-pro-high",
		},
		thinking: { mode: "google-level", efforts: GEMINI_3_PRO_FAMILY_EFFORTS },
		suppressWhenOff: true,
	},
	{
		// Rename-only collapse: every effort and off fall back to the wire id.
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		members: ["gpt-oss-120b-medium"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},
	// Antigravity Cloud Code Assist exposes Claude 4.6 asymmetrically: only the
	// bare `claude-sonnet-4-6` wire id (no `-thinking` twin) and only the
	// `claude-opus-4-6-thinking` wire id (no bare twin). Per-effort thinking is
	// carried in the request body via `thinkingBudget`, so both ids accept on/off
	// requests. Listing both candidates in `members` (priority order) keeps the
	// collapse correct if the backend mix ever rebalances; `retiredMembers`
	// re-points stale collapsed snapshots (bundled catalog rows, cache rows
	// written by prior generations) away from the dead wire id via
	// `reconcileRetiredRouting`.
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		members: ["claude-sonnet-4-6", "claude-sonnet-4-6-thinking"],
		retiredMembers: ["claude-sonnet-4-6-thinking"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},

	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		members: ["claude-opus-4-6-thinking", "claude-opus-4-6"],
		retiredMembers: ["claude-opus-4-6"],
		routing: {},
		thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
	},
	thinkingPair("claude-sonnet-4-5", "Claude Sonnet 4.5"),
	thinkingPair("claude-opus-4-5", "Claude Opus 4.5"),
	thinkingPair("gemini-2.5-flash", "Gemini 2.5 Flash"),
];

/** `google-antigravity` (daily-cloudcode-pa): Gemini 3.x on the budget transport. */
export const ANTIGRAVITY_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [geminiFlashFamily("budget"), geminiProFamily("budget"), ...SHARED_CCA_FAMILIES],
};

/** `google-gemini-cli` (cloudcode-pa): Gemini 3.x on the level transport (official CLI parity). */
export const GEMINI_CLI_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [geminiFlashFamily("google-level"), geminiProFamily("google-level"), ...SHARED_CCA_FAMILIES],
};
export const DEVIN_VARIANT_COLLAPSE_TABLE: VariantCollapseTable = {
	families: [
		{
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			members: [
				"claude-opus-4-7-low",
				"claude-opus-4-7-medium",
				"claude-opus-4-7-high",
				"claude-opus-4-7-xhigh",
				"claude-opus-4-7-max",
			],
			routing: {
				[Effort.Minimal]: "claude-opus-4-7-low",
				[Effort.Low]: "claude-opus-4-7-medium",
				[Effort.Medium]: "claude-opus-4-7-high",
				[Effort.High]: "claude-opus-4-7-xhigh",
				[Effort.XHigh]: "claude-opus-4-7-max",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
		},
		{
			id: "claude-opus-4-7-fast",
			name: "Claude Opus 4.7 Fast",
			members: [
				"claude-opus-4-7-low-fast",
				"claude-opus-4-7-medium-fast",
				"claude-opus-4-7-high-fast",
				"claude-opus-4-7-xhigh-fast",
				"claude-opus-4-7-max-fast",
			],
			routing: {
				[Effort.Minimal]: "claude-opus-4-7-low-fast",
				[Effort.Low]: "claude-opus-4-7-medium-fast",
				[Effort.Medium]: "claude-opus-4-7-high-fast",
				[Effort.High]: "claude-opus-4-7-xhigh-fast",
				[Effort.XHigh]: "claude-opus-4-7-max-fast",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
		},
		{
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			members: [
				"claude-opus-4-8-low",
				"claude-opus-4-8-medium",
				"claude-opus-4-8-high",
				"claude-opus-4-8-xhigh",
				"claude-opus-4-8-max",
			],
			routing: {
				[Effort.Minimal]: "claude-opus-4-8-low",
				[Effort.Low]: "claude-opus-4-8-medium",
				[Effort.Medium]: "claude-opus-4-8-high",
				[Effort.High]: "claude-opus-4-8-xhigh",
				[Effort.XHigh]: "claude-opus-4-8-max",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
		},
		{
			id: "claude-opus-4-8-fast",
			name: "Claude Opus 4.8 Fast",
			members: [
				"claude-opus-4-8-low-fast",
				"claude-opus-4-8-medium-fast",
				"claude-opus-4-8-high-fast",
				"claude-opus-4-8-xhigh-fast",
				"claude-opus-4-8-max-fast",
			],
			routing: {
				[Effort.Minimal]: "claude-opus-4-8-low-fast",
				[Effort.Low]: "claude-opus-4-8-medium-fast",
				[Effort.Medium]: "claude-opus-4-8-high-fast",
				[Effort.High]: "claude-opus-4-8-xhigh-fast",
				[Effort.XHigh]: "claude-opus-4-8-max-fast",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
		},
		devinTierFamily(
			"gpt-5-2",
			"GPT-5.2",
			{
				off: "MODEL_GPT_5_2_NONE",
				low: "MODEL_GPT_5_2_LOW",
				medium: "MODEL_GPT_5_2_MEDIUM",
				high: "MODEL_GPT_5_2_HIGH",
				xhigh: "MODEL_GPT_5_2_XHIGH",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-3-codex",
			"GPT-5.3 Codex",
			{
				low: "gpt-5-3-codex-low",
				medium: "gpt-5-3-codex-medium",
				high: "gpt-5-3-codex-high",
				xhigh: "gpt-5-3-codex-xhigh",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-3-codex-fast",
			"GPT-5.3 Codex Fast",
			{
				low: "gpt-5-3-codex-low-priority",
				medium: "gpt-5-3-codex-medium-priority",
				high: "gpt-5-3-codex-high-priority",
				xhigh: "gpt-5-3-codex-xhigh-priority",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-4",
			"GPT-5.4",
			{
				off: "gpt-5-4-none",
				low: "gpt-5-4-low",
				medium: "gpt-5-4-medium",
				high: "gpt-5-4-high",
				xhigh: "gpt-5-4-xhigh",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-4-fast",
			"GPT-5.4 Fast",
			{
				off: "gpt-5-4-none-priority",
				low: "gpt-5-4-low-priority",
				medium: "gpt-5-4-medium-priority",
				high: "gpt-5-4-high-priority",
				xhigh: "gpt-5-4-xhigh-priority",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-4-mini",
			"GPT-5.4 Mini",
			{
				low: "gpt-5-4-mini-low",
				medium: "gpt-5-4-mini-medium",
				high: "gpt-5-4-mini-high",
				xhigh: "gpt-5-4-mini-xhigh",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-5",
			"GPT-5.5",
			{
				off: "gpt-5-5-none",
				low: "gpt-5-5-low",
				medium: "gpt-5-5-medium",
				high: "gpt-5-5-high",
				xhigh: "gpt-5-5-xhigh",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gpt-5-5-fast",
			"GPT-5.5 Fast",
			{
				off: "gpt-5-5-none-priority",
				low: "gpt-5-5-low-priority",
				medium: "gpt-5-5-medium-priority",
				high: "gpt-5-5-high-priority",
				xhigh: "gpt-5-5-xhigh-priority",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		),
		devinTierFamily(
			"gemini-3-1-pro",
			"Gemini 3.1 Pro",
			{
				low: "gemini-3-1-pro-low",
				high: "gemini-3-1-pro-high",
			},
			[Effort.Low, Effort.High],
		),
		devinTierFamily(
			"gemini-3-5-flash",
			"Gemini 3.5 Flash",
			{
				minimal: "gemini-3-5-flash-minimal",
				low: "gemini-3-5-flash-low",
				medium: "gemini-3-5-flash-medium",
				high: "gemini-3-5-flash-high",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),
		devinTierFamily(
			"gemini-3-flash",
			"Gemini 3 Flash",
			{
				minimal: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
				low: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
				medium: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM",
				high: "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
			},
			[Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		),
	],
};

/** Provider id → hand collapse table. The CCA providers diverge on thinking transport. */
export const VARIANT_COLLAPSE_TABLES: Readonly<Record<string, VariantCollapseTable>> = {
	"google-antigravity": ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	"google-gemini-cli": GEMINI_CLI_VARIANT_COLLAPSE_TABLE,
	devin: DEVIN_VARIANT_COLLAPSE_TABLE,
};

/**
 * The global automatic rule: derive an `X` + `X-thinking` family for every
 * pair where both ids are live in `specs` (trailing or infix token). Gates:
 * - both members share the same `api`,
 * - known pricing must match — all-zero cost rows count as unknown
 *   (aggregators routinely ship them), but twins that BOTH carry real,
 *   differing prices are distinct SKUs and never merge,
 * - ids claimed by the provider's hand `table` are skipped (curation wins).
 * The capability surface prefers the thinking member's metadata, then the
 * bare member's, then the canonical deriver (aggregators often ship
 * `reasoning: false` and no thinking config on the twin), then a budget
 * default. `off` routes to the bare id; every supported effort routes to the
 * thinking id.
 */
export function deriveThinkingPairFamilies<TSpec extends VariantSpecLike>(
	specs: readonly TSpec[],
	table?: VariantCollapseTable,
): EffortVariantFamily[] {
	const byId = new Map<string, TSpec>();
	for (const spec of specs) {
		if (!byId.has(spec.id)) byId.set(spec.id, spec);
	}
	const claimed = table ? getAliasIndex(table) : undefined;
	const families: EffortVariantFamily[] = [];
	for (const spec of specs) {
		const baseId = stripThinkingVariantToken(spec.id);
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

const DEFAULT_PAIR_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];

/**
 * Surface fallback chain: thinking member → bare member → canonical deriver →
 * budget default. `requiresEffort` is dropped from every source: the COLLAPSED
 * pair can disable thinking (off routes to the bare backing id), even though
 * the thinking member alone cannot.
 */
function derivePairThinkingSurface(
	thinkingSpec: VariantSpecLike,
	baseSpec: VariantSpecLike,
): Omit<ThinkingConfig, "effortRouting" | "suppressWhenOff" | "requiresEffort"> {
	const baked = thinkingSpec.thinking ?? baseSpec.thinking;
	if (baked && baked.efforts.length > 0) {
		const { effortRouting: _routing, suppressWhenOff: _suppress, requiresEffort: _required, ...surface } = baked;
		return surface;
	}
	const derived = resolveModelThinking(
		{ ...(thinkingSpec as unknown as ModelSpec<Api>), reasoning: true, thinking: undefined },
		buildCompat(thinkingSpec as unknown as ModelSpec<Api>),
	);
	if (derived && derived.efforts.length > 0) {
		const { effortRouting: _dRouting, suppressWhenOff: _dSuppress, requiresEffort: _dRequired, ...surface } = derived;
		return surface;
	}
	return { mode: "budget", efforts: DEFAULT_PAIR_EFFORTS };
}

/**
 * True when `spec` is the output of collapsing rather than a raw upstream
 * member. `thinking.effortRouting` is written only by collapsing; the
 * `requestModelId` arm is scoped to the provider's hand-table family ids so
 * unrelated carriers (GitHub Copilot `-1m` context variants) never match.
 */
export function isVariantCollapsedSpec(spec: VariantSpecLike): boolean {
	if (spec.thinking?.effortRouting !== undefined) {
		return true;
	}
	if (spec.requestModelId === undefined) {
		return false;
	}
	const table = VARIANT_COLLAPSE_TABLES[spec.provider];
	return table !== undefined && getAliasIndex(table).familyIds.has(spec.id);
}

/**
 * Re-point a stale collapsed spec whose `requestModelId` or routing still
 * targets a retired wire id. Collapsed snapshots (bundled catalog, cache
 * rows, previous-generation fallbacks) pass through collapsing untouched, so
 * a hand-table routing fix would otherwise never reach them. Only retired
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
	const routing = spec.thinking?.effortRouting;
	const requestRetired = spec.requestModelId !== undefined && retired.has(spec.requestModelId);
	let routingRetired = false;
	if (routing !== undefined) {
		for (const key in routing) {
			const target = routing[key as Effort | "off"];
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
	if (routingRetired && routing !== undefined) {
		const nextRouting: Partial<Record<Effort | "off", string>> = {};
		for (const key in routing) {
			const effortKey = key as Effort | "off";
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
		next.thinking = { ...(spec.thinking as ThinkingConfig), effortRouting: nextRouting };
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
 * row (e.g. `gemini-3-flash`). This re-applies the hand-table family's thinking,
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
	// (derived `X`/`X-thinking` pairs, claude pairs) keep their presence-filtered
	// snapshot routing untouched.
	if (!spec.reasoning || family.thinking.effortBudgets === undefined) return spec;
	const routing: Partial<Record<Effort | "off", string>> = {};
	let hasRouting = false;
	for (const effortKey in family.routing) {
		const target = family.routing[effortKey as Effort | "off"];
		if (target !== undefined && !retired?.has(target)) {
			routing[effortKey as Effort | "off"] = target;
			hasRouting = true;
		}
	}
	const thinking: ThinkingConfig = { ...family.thinking };
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
 * Collapse every family in `table` found in `specs`. Non-member specs pass
 * through verbatim (by reference), order preserved; the collapsed spec
 * replaces the first occurrence of its family.
 */
export function collapseEffortVariants<TSpec extends VariantSpecLike>(
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
			// hand-table family (transport/budgets/routing); retired targets drop.
			// Recycled extraAliases rows are healed in a later pass.
			const refreshed =
				existing !== undefined && existingCollapsed
					? refreshCollapsedThinking(reconciled ?? existing, family, retired)
					: reconciled;
			if (refreshed !== undefined && refreshed !== existing) {
				familyIdBySpecId.set(family.id, family.id);
				replacement.set(family.id, refreshed);
			}
			continue;
		}

		for (const id of rawPresent) familyIdBySpecId.set(id, family.id);
		if (existing) familyIdBySpecId.set(family.id, family.id);

		if (existingCollapsed) {
			// Mixed input: the collapsed entry (live truth) wins; stale raw
			// members are deduped away. Retired targets are re-pointed first.
			replacement.set(family.id, reconciled as TSpec);
			continue;
		}

		const memberSpecs = rawPresent.map(id => byId.get(id) as TSpec);
		const presentSet = new Set(rawPresent);
		const routing: Partial<Record<Effort | "off", string>> = {};
		let hasRouting = false;
		let hasEffortRoute = false;
		let usedAbsentEffortRoute = false;
		for (const effortKey in family.routing) {
			const target = family.routing[effortKey as Effort | "off"];
			const effort = effortKey as Effort | "off";
			const targetPresent = target !== undefined && presentSet.has(target);
			const preserveAbsentEffort =
				target !== undefined && effort !== "off" && family.preserveAbsentEffortRoutes === true;
			if (target !== undefined && (targetPresent || preserveAbsentEffort) && !retired?.has(target)) {
				routing[effort] = target;
				hasRouting = true;
				if (effortKey !== "off") hasEffortRoute = true;
				if (!targetPresent && effort !== "off") usedAbsentEffortRoute = true;
			}
		}

		// A family that routes efforts to a live thinking backing id reasons
		// even when upstream metadata forgot to mark the members.
		const reasoning = memberSpecs.some(spec => spec.reasoning) || hasEffortRoute;
		const thinking: ThinkingConfig = { ...family.thinking };
		if (hasRouting) thinking.effortRouting = routing;
		if (family.suppressWhenOff) thinking.suppressWhenOff = true;

		const input: ("text" | "image")[] = [];
		if (memberSpecs.some(spec => spec.input.includes("text"))) input.push("text");
		if (memberSpecs.some(spec => spec.input.includes("image"))) input.push("image");

		const collapsed: TSpec = {
			...(memberSpecs[0] as TSpec),
			id: family.id,
			name: family.name,
			reasoning,
			input,
			contextWindow: maxOrNull(memberSpecs.map(spec => spec.contextWindow)),
			maxTokens: maxOrNull(memberSpecs.map(spec => spec.maxTokens)),
		};
		// The default wire id is the highest-priority live member; omit when it
		// equals the logical id (bare/thinking pairs) — `resolveWireModelId`
		// falls back. Retired members never become the default.
		const defaultWireId = rawPresent.find(id => !retired?.has(id)) ?? rawPresent[0];
		if (defaultWireId === family.id) {
			if (usedAbsentEffortRoute) {
				collapsed.requestModelId = defaultWireId as string;
			} else {
				delete collapsed.requestModelId;
			}
		} else {
			collapsed.requestModelId = defaultWireId as string;
		}
		if (reasoning) {
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
		out.push(replacement.get(familyId) as TSpec);
	}
	return out;
}

/**
 * Collapse a full mixed-provider list: per provider, the hand table (when
 * registered) plus the automatic `X`/`X-thinking` pair rule. Used by the
 * catalog generator; the runtime equivalent lives at the model-manager merge
 * point. Output is regrouped by provider — callers re-sort.
 */
export function collapseEffortVariantsAcrossProviders<TSpec extends VariantSpecLike>(specs: readonly TSpec[]): TSpec[] {
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
		const table = VARIANT_COLLAPSE_TABLES[provider];
		let result = table ? collapseEffortVariants(slice, table) : slice;
		const derived = deriveThinkingPairFamilies(result, table);
		if (derived.length > 0) {
			result = collapseEffortVariants(result, { families: derived });
		}
		out.push(...result);
	}
	return out;
}

/**
 * Runtime entry point for already-built `Model` lists (the model-manager
 * merge point, coding-agent registry custom providers): collapses hand
 * tables plus derived pairs, then re-runs `buildModel` on freshly created
 * logical specs so thinking wire defaults stay resolved. Untouched entries
 * pass through by reference.
 */
export function collapseBuiltModelVariants<TApi extends Api>(models: readonly Model<TApi>[]): Model<TApi>[] {
	const collapsed = collapseEffortVariantsAcrossProviders(models);
	const inputRefs = new Set<Model<TApi>>(models);
	return collapsed.map(model =>
		// Resolved compat re-fed as override config resolves to itself.
		inputRefs.has(model) ? model : buildModel(model as unknown as ModelSpec<TApi>),
	);
}

interface VariantAliasIndex {
	/** lowercased retired id → replacement model id. */
	forward: Map<string, string>;
	/** replacement model id → retired ids that resolve to it. */
	reverse: Map<string, readonly string[]>;
	/** Collapsed logical ids declared by the table. */
	familyIds: Set<string>;
}

const kAliasIndex = Symbol("variant-collapse.aliasIndex");

interface TableWithAliasIndex extends VariantCollapseTable {
	[kAliasIndex]?: VariantAliasIndex;
}

function getAliasIndex(table: VariantCollapseTable): VariantAliasIndex {
	const tagged = table as TableWithAliasIndex;
	const cached = tagged[kAliasIndex];
	if (cached) return cached;
	const forward = new Map<string, string>();
	const reverse = new Map<string, string[]>();
	const add = (from: string, to: string) => {
		if (from === to) return;
		forward.set(from.toLowerCase(), to);
		const sources = reverse.get(to);
		if (sources) {
			sources.push(from);
		} else {
			reverse.set(to, [from]);
		}
	};
	const familyIds = new Set<string>();
	for (const family of table.families) {
		familyIds.add(family.id);
		for (const member of family.members) add(member, family.id);
		for (const alias of family.extraAliases ?? []) add(alias, family.id);
	}
	const index: VariantAliasIndex = { forward, reverse, familyIds };
	tagged[kAliasIndex] = index;
	return index;
}

/**
 * Resolve a retired effort-tier variant id (collapsed member, recycled id) to
 * its replacement model id for `provider` via the hand table. Returns
 * `undefined` when the id is not a known alias; derived `X-thinking` members
 * resolve through `stripThinkingVariantToken` instead. Callers must try an
 * exact model lookup first — a live model always wins over an alias.
 */
export function resolveVariantAlias(provider: Provider, modelId: string): string | undefined {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return undefined;
	return getAliasIndex(table).forward.get(modelId.trim().toLowerCase());
}

/** Bare-id alias hit: replacement id plus the providers declaring it. */
export interface BareVariantAliasHit {
	id: string;
	/** Providers whose table declares the alias — candidates from these win ties. */
	providers: readonly Provider[];
}

/**
 * Provider-agnostic hand-table alias lookup for bare-id selectors. Returns
 * the declaring providers so callers can prefer their models when the
 * replacement id exists on unrelated providers too (e.g. a retired Cursor
 * tier id must not resolve to `openai/gpt-5.4`).
 */
export function resolveBareVariantAlias(modelId: string): BareVariantAliasHit | undefined {
	const normalized = modelId.trim().toLowerCase();
	for (const provider in VARIANT_COLLAPSE_TABLES) {
		const table = VARIANT_COLLAPSE_TABLES[provider] as VariantCollapseTable;
		const hit = getAliasIndex(table).forward.get(normalized);
		if (hit === undefined) continue;
		const providers: Provider[] = [];
		for (const candidate in VARIANT_COLLAPSE_TABLES) {
			// Match by resolved alias target, not table identity: the CCA providers
			// now hold distinct table objects that still share these aliases.
			if (
				getAliasIndex(VARIANT_COLLAPSE_TABLES[candidate] as VariantCollapseTable).forward.get(normalized) === hit
			) {
				providers.push(candidate);
			}
		}
		return { id: hit, providers };
	}
	return undefined;
}

/**
 * Reverse alias lookup: the retired ids that resolve to `modelId` for
 * `provider` via the hand table. Used to re-key config keyed by raw member
 * ids (models.yml `modelOverrides`, suppressed selectors) onto the collapsed
 * model. Empty for providers without a table.
 */
export function getVariantAliasSources(provider: Provider, modelId: string): readonly string[] {
	const table = VARIANT_COLLAPSE_TABLES[provider] ?? VARIANT_COLLAPSE_TABLES[provider.toLowerCase()];
	if (!table) return [];
	return getAliasIndex(table).reverse.get(modelId) ?? [];
}

function maxOrNull(values: ReadonlyArray<number | null>): number | null {
	const known = values.filter((v): v is number => v != null);
	return known.length ? Math.max(...known) : null;
}
