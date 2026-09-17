const TYPESAFE_PROVIDER = "typesafe";

export type ComputerJevMode = "auto" | "on" | "off";

interface JevSettings {
	get(path: "computer.jev" | "providers.judgmentProvider"): unknown;
}

interface JevRegistry {
	authStorage?: { hasAuth(provider: string): boolean };
}

function hasTypeSafeAuth(registry: JevRegistry): boolean {
	return registry.authStorage?.hasAuth(TYPESAFE_PROVIDER) ?? false;
}

/** TypeSafe armed for judgments (mirrors skill suggestion / `usesTypeSafeJudge`). */
function typesafeJudgmentArmed(settings: JevSettings, registry: JevRegistry): boolean {
	const mode = settings.get("providers.judgmentProvider");
	if (mode === "llm") return false;
	return mode === "typesafe" || hasTypeSafeAuth(registry);
}

/** Whether computer-use steps may call Jev as the optional decision backend. */
export function shouldUseComputerJev(settings: JevSettings, registry: JevRegistry): boolean {
	const mode = settings.get("computer.jev") as ComputerJevMode | undefined;
	if (mode === "off") return false;
	if (mode === "on") return hasTypeSafeAuth(registry);
	return typesafeJudgmentArmed(settings, registry);
}
