import type { Model, ServiceTier, ServiceTierByFamily, ServiceTierFamily } from "@oh-my-pi/pi-ai";
// `settings-schema` pulls this module into CLI startup; import the classifier
// from the dependency-free types module so the `pi-ai` index (and the native
// addon behind it) stays lazy.
import { serviceTierFamily } from "@oh-my-pi/pi-ai/types";
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

/** Whether a runtime value is valid for an inherit-capable service-tier setting. */
export function isServiceTierInheritSettingValue(value: unknown): value is ServiceTierInheritSettingValue {
	return typeof value === "string" && SERVICE_TIER_INHERIT_SETTING_VALUES.some(serviceTier => serviceTier === value);
}

/**
 * Validate the sparse exact-agent-name tier map used by task dispatch. An absent
 * or empty (`null`) mapping means no overrides; any other non-mapping container is
 * a config typo that would otherwise silently disable every override.
 */
export function validateAgentServiceTierOverrides(value: unknown): Record<string, ServiceTierInheritSettingValue> {
	const overrides: Record<string, ServiceTierInheritSettingValue> = {};
	if (value === undefined || value === null) return overrides;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Invalid task.agentServiceTierOverrides: expected a map of agent name to service tier, got ${Array.isArray(value) ? "an array" : `a ${typeof value}`}.`,
		);
	}
	for (const [agentName, setting] of Object.entries(value)) {
		if (!isServiceTierInheritSettingValue(setting)) {
			throw new Error(
				`Invalid service tier for task.agentServiceTierOverrides.${agentName}: ${String(setting)}. Expected one of: ${SERVICE_TIER_INHERIT_SETTING_VALUES.join(", ")}.`,
			);
		}
		overrides[agentName] = setting;
	}
	return overrides;
}

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

/**
 * Resolve one exact-agent override against the model the child session settled
 * on. Concrete tiers populate only that model's provider family, so the session's
 * retry chain keeps the tier on same-family fallbacks and never carries it across
 * families. Without a resolved model there is no family to scope to, so a
 * concrete tier yields no entry rather than a cross-family broadcast.
 */
export function resolveAgentServiceTierOverride(
	setting: ServiceTierInheritSettingValue,
	model: Model | undefined,
	inherited: ServiceTierByFamily,
): ServiceTierByFamily {
	if (setting === "inherit") return inherited;
	const tier = serviceTierSettingToTier(setting);
	if (!tier || !model) return {};
	const family = serviceTierFamily(model);
	if (!family || !isServiceTierForFamily(family, tier)) return {};
	return { [family]: tier };
}
