import { $env } from "@oh-my-pi/pi-utils";

export function isFoundryEnabled(): boolean {
	const value = $env.CLAUDE_CODE_USE_FOUNDRY;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
