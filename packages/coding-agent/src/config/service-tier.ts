import type { ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import type { SubmenuOption } from "./settings-schema";

/**
 * Service-tier setting values shared by every "Service Tier" setting. `"none"`
 * is the omit-the-parameter sentinel; the remaining values mirror
 * {@link ServiceTier}.
 */
export const SERVICE_TIER_SETTING_VALUES = [
	"none",
	"auto",
	"default",
	"flex",
	"scale",
	"priority",
	"openai-only",
	"claude-only",
] as const;

export type ServiceTierSettingValue = (typeof SERVICE_TIER_SETTING_VALUES)[number];

/** Variant value set for scoped service-tier settings (subagent/advisor) that can defer to the main agent. */
export const SERVICE_TIER_INHERIT_SETTING_VALUES = ["inherit", ...SERVICE_TIER_SETTING_VALUES] as const;

export type ServiceTierInheritSettingValue = (typeof SERVICE_TIER_INHERIT_SETTING_VALUES)[number];

/** Submenu descriptions shared by the base `serviceTier` setting. */
export const SERVICE_TIER_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierSettingValue>> = [
	{ value: "none", label: "None", description: "Omit service_tier parameter" },
	{ value: "auto", label: "Auto", description: "Use provider default tier selection (OpenAI)" },
	{ value: "default", label: "Default", description: "Standard priority processing (OpenAI)" },
	{ value: "flex", label: "Flex", description: "Flexible capacity tier when available (OpenAI)" },
	{ value: "scale", label: "Scale", description: "Scale Tier credits when available (OpenAI)" },
	{
		value: "priority",
		label: "Priority",
		description: "Fast routing on every supported provider, including OpenRouter `:nitro`",
	},
	{
		value: "openai-only",
		label: "Priority (OpenAI only)",
		description: "Priority on OpenAI/OpenAI-Codex requests; ignored elsewhere",
	},
	{
		value: "claude-only",
		label: "Priority (Claude only)",
		description: "Anthropic fast mode on direct Claude requests; ignored elsewhere (incl. Bedrock/Vertex)",
	},
];

/** Submenu descriptions for inherit-capable service-tier settings. */
export const SERVICE_TIER_INHERIT_OPTIONS: ReadonlyArray<SubmenuOption<ServiceTierInheritSettingValue>> = [
	{ value: "inherit", label: "Inherit", description: "Use the main agent's Service Tier" },
	...SERVICE_TIER_OPTIONS,
];

/**
 * Resolve a service-tier setting value to the wire {@link ServiceTier} (or
 * `undefined` to omit). `"inherit"` defers to `inherited`; `"none"` omits.
 */
export function resolveServiceTierSetting(value: string, inherited: ServiceTier | undefined): ServiceTier | undefined {
	if (value === "inherit") return inherited;
	if (value === "none" || value === "") return undefined;
	return value as ServiceTier;
}

/**
 * Resolve a per-role service tier from the `modelRoleTiers` record
 * (role name → setting value, e.g. `{ smol: "priority" }`).
 *
 * `"none"` and `"inherit"` (and unknown values) yield `undefined` so callers
 * fall back to their ambient tier chain; a concrete tier value is returned
 * as-is. Lets a fast lane (e.g. `smol`) ride a different processing tier than
 * the main agent without touching the global `serviceTier` setting. Use
 * {@link hasExplicitRoleServiceTier} where an explicit `"none"` must suppress
 * an ambient fallback rather than defer to it.
 */
export function resolveRoleServiceTier(
	roleTiers: Record<string, string> | undefined,
	role: string,
): ServiceTier | undefined {
	const value = roleTiers?.[role];
	if (!value || value === "none" || value === "inherit") return undefined;
	if (!(SERVICE_TIER_SETTING_VALUES as readonly string[]).includes(value)) return undefined;
	return value as ServiceTier;
}

/**
 * Whether `modelRoleTiers` carries an explicit, recognized entry for `role` —
 * including the `"none"` sentinel. Explicit entries win over ambient fallbacks:
 * `{ smol: "none" }` really omits the tier for the smol lane instead of letting
 * `serviceTierSubagent` or the global `serviceTier` apply.
 */
export function hasExplicitRoleServiceTier(roleTiers: Record<string, string> | undefined, role: string): boolean {
	const value = roleTiers?.[role];
	if (!value) return false;
	return (SERVICE_TIER_SETTING_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve the `serviceTier` *setting value* to stamp onto a subagent's settings
 * snapshot.
 *
 * - A concrete `subagentSetting` (`"none"` or a tier) wins outright.
 * - `"inherit"` defers to the parent's live effective tier when the caller has a
 *   live session (`inherited` passed as `ServiceTier | null`, where `null` means
 *   the parent explicitly has no tier — e.g. `/fast off`). When no live session
 *   is available (`inherited === undefined`, e.g. cold subagent revive) it falls
 *   back to the parent's configured `serviceTier` setting so behavior matches a
 *   plain settings snapshot.
 */
export function resolveSubagentServiceTier(
	subagentSetting: string,
	configuredTier: ServiceTierSettingValue,
	inherited: ServiceTier | null | undefined,
): ServiceTierSettingValue {
	if (subagentSetting !== "inherit") return subagentSetting as ServiceTierSettingValue;
	if (inherited === undefined) return configuredTier;
	return inherited ?? "none";
}
