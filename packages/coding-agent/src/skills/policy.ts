const TYPESAFE_PROVIDER = "typesafe";

export type SkillSuggestionMode = "auto" | "typesafe" | "off";

interface SuggestionSettings {
	get(path: "skills.enabled" | "skills.suggestion" | "providers.judgmentProvider"): unknown;
}

interface SuggestionRegistry {
	authStorage?: { hasAuth(provider: string): boolean };
}

function hasTypeSafeAuth(registry: SuggestionRegistry): boolean {
	return registry.authStorage?.hasAuth(TYPESAFE_PROVIDER) ?? false;
}

/** TypeSafe is the judgment backend (same rule as `usesTypeSafeJudge`, inlined to keep this module light). */
function typesafeJudgmentArmed(settings: SuggestionSettings, registry: SuggestionRegistry): boolean {
	const mode = settings.get("providers.judgmentProvider");
	if (mode === "llm") return false;
	return mode === "typesafe" || hasTypeSafeAuth(registry);
}

/** Whether this turn should call System One for a skill name. Never falls back to a chat model. */
export function shouldRunSkillSuggestion(settings: SuggestionSettings, registry: SuggestionRegistry): boolean {
	if (settings.get("skills.enabled") === false) return false;
	const mode = settings.get("skills.suggestion");
	if (mode === "off") return false;
	if (mode === "typesafe") return hasTypeSafeAuth(registry);
	return typesafeJudgmentArmed(settings, registry);
}
