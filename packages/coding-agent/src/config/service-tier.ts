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
		description: "Priority on every supported provider (OpenAI `service_tier`, Anthropic fast mode)",
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
