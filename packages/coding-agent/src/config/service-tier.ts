import {
	serviceTierFamily,
	type Model,
	type ServiceTier,
	type ServiceTierByFamily,
	type ServiceTierFamily,
} from "@oh-my-pi/pi-ai";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { toReasoningEffort } from "../thinking";
import type { SubmenuOption } from "./settings-schema";

/**
 * Per-family service-tier setting values. `"none"` is the omit-the-parameter
 * sentinel; the rest mirror the wire {@link ServiceTier} values each provider
 * family actually realizes. OpenAI accepts the full set; Anthropic realizes
 * only `priority` (fast mode); Google (Gemini API + Vertex) realizes
 * `flex`/`priority`.
 */
export const SERVICE_TIER_OPENAI_VALUES = ["none", "auto", "default", "flex", "scale", "priority"] as const;
export const SERVICE_TIER_ANTHROPIC_VALUES = ["none", "priority"] as const;
export const SERVICE_TIER_GOOGLE_VALUES = ["none", "flex", "priority"] as const;

export type ServiceTierOpenAISettingValue = (typeof SERVICE_TIER_OPENAI_VALUES)[number];
export type ServiceTierAnthropicSettingValue = (typeof SERVICE_TIER_ANTHROPIC_VALUES)[number];
export type ServiceTierGoogleSettingValue = (typeof SERVICE_TIER_GOOGLE_VALUES)[number];

/** Whether a runtime value is a supported OpenAI service-tier setting. */
export function isServiceTierOpenAISettingValue(value: string): value is ServiceTierOpenAISettingValue {
	return SERVICE_TIER_OPENAI_VALUES.some(tier => tier === value);
}

/** Whether a runtime value names a provider family with an independent service-tier knob. */
export function isServiceTierFamily(value: unknown): value is ServiceTierFamily {
	return value === "openai" || value === "anthropic" || value === "google";
}

/** Whether a runtime value is a supported service tier for one provider family. */
export function isServiceTierForFamily(family: string, tier: unknown): tier is ServiceTier {
	if (typeof tier !== "string" || tier === "none") return false;
	let values: readonly string[];
	switch (family) {
		case "openai":
			values = SERVICE_TIER_OPENAI_VALUES;
			break;
		case "anthropic":
			values = SERVICE_TIER_ANTHROPIC_VALUES;
			break;
		case "google":
			values = SERVICE_TIER_GOOGLE_VALUES;
			break;
		default:
			return false;
	}
	return values.includes(tier);
}

/**
 * Inherit-capable single value for the subagent/advisor tiers. The chosen tier
 * is broadcast across families and applied to whichever family the spawned
 * model belongs to (clamped to what that family realizes); `"inherit"` defers
 * to the main agent's live per-family selection.
 */
export const SERVICE_TIER_INHERIT_SETTING_VALUES = [
	"inherit",
	"none",
	"auto",
	"default",
	"flex",
	"scale",
	"priority",
] as const;

export type ServiceTierInheritSettingValue = (typeof SERVICE_TIER_INHERIT_SETTING_VALUES)[number];

export const SERVICE_TIER_OPENAI_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierOpenAISettingValue>> = [
	{ value: "none", label: "None", description: "Omit service_tier (standard processing)" },
	{ value: "auto", label: "Auto", description: "Provider default tier selection" },
	{ value: "default", label: "Default", description: "Standard priority processing" },
	{ value: "flex", label: "Flex", description: "Lower cost, higher latency when available" },
	{ value: "scale", label: "Scale", description: "Scale Tier credits when available" },
	{ value: "priority", label: "Priority", description: "Faster, higher cost (premium request)" },
];

export const SERVICE_TIER_ANTHROPIC_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierAnthropicSettingValue>> = [
	{ value: "none", label: "None", description: "Standard processing" },
	{
		value: "priority",
		label: "Priority",
		description: 'Fast mode (`speed: "fast"`) on supported direct Claude models; ignored on Bedrock/Vertex',
	},
];

export const SERVICE_TIER_GOOGLE_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierGoogleSettingValue>> = [
	{ value: "none", label: "None", description: "Standard processing" },
	{ value: "flex", label: "Flex", description: "Lower cost, higher latency (Gemini API + Vertex)" },
	{ value: "priority", label: "Priority", description: "Faster, higher reliability (Gemini API + Vertex)" },
];

export const SERVICE_TIER_INHERIT_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierInheritSettingValue>> = [
	{ value: "inherit", label: "Inherit", description: "Match the main agent's live per-family tiers" },
	{ value: "none", label: "None", description: "Standard processing" },
	{ value: "auto", label: "Auto", description: "Provider default tier selection (OpenAI family)" },
	{ value: "default", label: "Default", description: "Standard priority processing (OpenAI family)" },
	{ value: "flex", label: "Flex", description: "Flexible capacity tier (OpenAI/Google families)" },
	{ value: "scale", label: "Scale", description: "Scale Tier credits (OpenAI family)" },
	{ value: "priority", label: "Priority", description: "Priority on every supported family of the spawned model" },
];

/** Map a per-family setting value to a wire {@link ServiceTier}, or `undefined` to omit. */
export function serviceTierSettingToTier(value: string): ServiceTier | undefined {
	if (value === "none" || value === "" || value === "inherit") return undefined;
	return value as ServiceTier;
}

/** Assemble the live per-family tier map from the three `tier.*` setting values. */
export function buildServiceTierByFamily(openai: string, anthropic: string, google: string): ServiceTierByFamily {
	const out: ServiceTierByFamily = {};
	const o = serviceTierSettingToTier(openai);
	if (o) out.openai = o;
	const a = serviceTierSettingToTier(anthropic);
	if (a) out.anthropic = a;
	const g = serviceTierSettingToTier(google);
	if (g) out.google = g;
	return out;
}

/**
 * Broadcast a single chosen tier across families, clamped to what each family
 * realizes: OpenAI takes any tier, Anthropic only `priority`, Google only
 * `flex`/`priority`. Used by the subagent/advisor single-value settings and the
 * `omp bench --service-tier` flag, which apply one tier to whatever family the
 * target model belongs to.
 */
export function serviceTierForAllFamilies(tier: ServiceTier | undefined): ServiceTierByFamily {
	if (!tier) return {};
	const out: ServiceTierByFamily = { openai: tier };
	if (tier === "priority") out.anthropic = "priority";
	if (tier === "flex" || tier === "priority") out.google = tier;
	return out;
}

/**
 * Resolve a subagent/advisor service-tier setting to a per-family map.
 *
 * - A concrete tier is broadcast across families (see
 *   {@link serviceTierForAllFamilies}).
 * - `"none"` yields an empty map.
 * - `"inherit"` defers to `inherited` — the parent's live per-family tiers when
 *   a live session supplied them, else the empty map.
 */
export function resolveSubagentServiceTier(setting: string, inherited: ServiceTierByFamily): ServiceTierByFamily {
	if (setting === "inherit") return inherited;
	return serviceTierForAllFamilies(serviceTierSettingToTier(setting));
}

// ── Per-model service-tier overrides ────────────────────────────────────────

/**
 * Per-family service-tier overrides carrying an explicit-off state: absent =
 * inherit the family policy, `null` = explicitly off for that family (shadow
 * the base selection). {@link ServiceTierByFamily} cannot express "off"
 * because an absent key already means "unset", so consumers that must
 * distinguish the two states (session persistence, live overrides) use this
 * shape instead.
 */
export type ServiceTierOverrides = Partial<Record<ServiceTierFamily, ServiceTier | null>>;

/**
 * Allowed `tier.modelOverrides` values: the union of what every tier family
 * realizes (a key may target any family's model) plus the `"none"` sentinel
 * that explicitly disables the tier for the keyed model.
 */
export const SERVICE_TIER_OVERRIDE_VALUES = ["none", "auto", "default", "flex", "scale", "priority"] as const;

export type ServiceTierOverrideSettingValue = (typeof SERVICE_TIER_OVERRIDE_VALUES)[number];

/** Whether a runtime value is a supported `tier.modelOverrides` value. */
export function isServiceTierOverrideValue(value: unknown): value is ServiceTierOverrideSettingValue {
	return SERVICE_TIER_OVERRIDE_VALUES.some(tier => tier === value);
}

/**
 * Whether a runtime key is a valid `tier.modelOverrides` target: an exact
 * `provider/model` or `provider/model:effort` string. Model ids may
 * themselves contain `:` — exact-first matching keeps those literal, so the
 * suffix is deliberately not interpreted here — and keys that name no real
 * model simply stay inert (absent catalog entries are deferred, not errors).
 */
export function isValidServiceTierOverrideKey(key: string): boolean {
	if (key.length === 0 || /\s/.test(key)) return false;
	// Resolution is exact identity matching only — no globs, aliases, or routing.
	if (key.includes("*") || key.includes("?")) return false;
	const slash = key.indexOf("/");
	return slash > 0 && slash < key.length - 1;
}

/**
 * Validate a `tier.modelOverrides` record, returning it unchanged when every
 * entry is well-formed and throwing with the offending entries listed
 * otherwise. Same contract as {@link validateProviderMaxInFlightRequests}:
 * wired into the settings hook so invalid values fail load and `set` loudly
 * instead of silently never matching. Catalog existence is deliberately not
 * consulted — validation is syntax plus tier value only.
 */
export function validateServiceTierOverrides(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const invalid: string[] = [];
	const validated: Record<string, string> = {};
	for (const [key, tier] of Object.entries(value)) {
		if (typeof tier !== "string" || !isServiceTierOverrideValue(tier)) {
			invalid.push(`${key} (value must be one of: ${SERVICE_TIER_OVERRIDE_VALUES.join(", ")})`);
			continue;
		}
		if (!isValidServiceTierOverrideKey(key)) {
			invalid.push(`${key} (key must be an exact "provider/model" or "provider/model:effort")`);
			continue;
		}
		validated[key] = tier;
	}
	if (invalid.length > 0) {
		throw new Error(`Invalid tier.modelOverrides entries — ${invalid.join("; ")}`);
	}
	return validated;
}

/** Outcome of per-model service-tier override resolution for one request. */
export type ModelServiceTierOverrideResolution = { matched: false } | { matched: true; tier: ServiceTier | undefined };

const NO_MODEL_SERVICE_TIER_OVERRIDE = Object.freeze({ matched: false as const });

/**
 * Resolve the per-model service-tier override for one concrete request.
 *
 * Lookup derives candidate keys from the model's actual resolved identity —
 * never by splitting configured keys — so literal model ids containing `:`
 * (e.g. `…:max`) keep exact-first semantics: the model+effort candidate
 * `provider/id:effort` is tried before the bare `provider/id`, and
 * `thinkingLevel` contributes an effort suffix only when it is a concrete
 * effort (`inherit`/`off`/undefined bind nothing; undefined never invents a
 * level like `max`). A model+effort entry shadows the model-only entry.
 *
 * A matched `"none"` returns `{ matched: true, tier: undefined }` — an
 * explicit off that must shadow the per-family tier. Entries the model's
 * family cannot realize stay inert and fall through to the next candidate,
 * and models with no tier family at all never match, which keeps Fireworks'
 * dedicated priority control authoritative. `{ matched: false }` means "no
 * opinion": family-aware callers keep their existing baseline
 * (`matched ? tier : existingTier`), previously untiered callers keep
 * omitting the tier.
 */
export function resolveModelServiceTierOverride(
	overrides: Readonly<Record<string, string>>,
	model: Model,
	thinkingLevel: ThinkingLevel | undefined,
): ModelServiceTierOverrideResolution {
	const family = serviceTierFamily(model);
	if (!family) return NO_MODEL_SERVICE_TIER_OVERRIDE;
	const baseKey = `${model.provider}/${model.id}`;
	const effort = toReasoningEffort(thinkingLevel);
	if (effort) {
		const effortKey = `${baseKey}:${effort}`;
		if (Object.hasOwn(overrides, effortKey)) {
			const tier = overrides[effortKey];
			if (tier === "none") return { matched: true, tier: undefined };
			if (isServiceTierForFamily(family, tier)) return { matched: true, tier };
		}
	}
	if (Object.hasOwn(overrides, baseKey)) {
		const tier = overrides[baseKey];
		if (tier === "none") return { matched: true, tier: undefined };
		if (isServiceTierForFamily(family, tier)) return { matched: true, tier };
	}
	return NO_MODEL_SERVICE_TIER_OVERRIDE;
}
