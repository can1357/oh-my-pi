import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import { cfgDisplayShowUsageModels } from "../modes/settings";

export function resolveUsageModelSelectors(
	reports: readonly UsageReport[],
	settings: Settings,
	getSelectors: (reports: readonly UsageReport[]) => string[],
): string[] {
	return cfgDisplayShowUsageModels.get(settings) === false ? [] : getSelectors(reports);
}
