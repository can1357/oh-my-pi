const TYPESAFE_PROVIDER = "typesafe";

export type ComputerJevMode = "auto" | "on" | "off";

interface JevSettings {
	get(path: "computer.jev" | "providers.judgmentProvider"): unknown;
}

interface JevRegistry {
	authStorage: { hasAuth(provider: string): boolean };
}

/** TypeSafe armed for judgments (mirrors skill suggestion / `usesTypeSafeJudge`). */
function typesafeJudgmentArmed(settings: JevSettings, registry: JevRegistry): boolean {
	const mode = settings.get("providers.judgmentProvider");
	if (mode === "llm") return false;
	return mode === "typesafe" || registry.authStorage.hasAuth(TYPESAFE_PROVIDER);
}

/** Whether computer-use steps may call Jev as the optional decision backend. */
export function shouldUseComputerJev(settings: JevSettings, registry: JevRegistry): boolean {
	const mode = settings.get("computer.jev") as ComputerJevMode | undefined;
	if (mode === "off") return false;
	if (mode === "on") return registry.authStorage.hasAuth(TYPESAFE_PROVIDER);
	return typesafeJudgmentArmed(settings, registry);
}
