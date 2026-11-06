/** Identifies Xiaomi Token Plan keys so login and discovery use regional hosts instead of the pay-as-you-go host. */
export function isXiaomiTokenPlanKey(apiKey: string): boolean {
	return apiKey.startsWith("tp-") || apiKey.startsWith("ttp-");
}
