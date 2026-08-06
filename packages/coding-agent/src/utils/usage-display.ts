import type { UsageReport } from "@oh-my-pi/pi-ai";

/** Minimal settings surface the `/usage` model list reads. */
export interface UsageModelListSettings {
	get(path: "display.showUsageModels"): boolean;
}

/**
 * Models `/usage` lists per provider, honoring the `display.showUsageModels`
 * opt-out (default on, so only an explicit `false` hides the list).
 *
 * Both `/usage` surfaces resolve the list here (the TUI dashboard and the ACP
 * text builder) so the opt-out cannot drift between them, and neither walks the
 * model registry when the list is hidden: filtering it away in the renderer
 * instead would be wasted work.
 */
export function resolveUsageModelSelectors(
	reports: readonly UsageReport[],
	settings: UsageModelListSettings,
	getSelectors: (reports: readonly UsageReport[]) => string[],
): string[] {
	return settings.get("display.showUsageModels") === false ? [] : getSelectors(reports);
}
