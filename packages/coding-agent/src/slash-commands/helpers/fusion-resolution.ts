import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import type { SlashCommandRuntime } from "../types";

export function resolutionNote(selector: string, runtime: SlashCommandRuntime): string {
	const resolved = resolveModelRoleValue(selector, runtime.session.modelRegistry.getAvailable(), {
		settings: runtime.settings,
		matchPreferences: getModelMatchPreferences(runtime.settings),
		modelRegistry: runtime.session.modelRegistry,
	}).model;
	return resolved
		? ` (resolves to ${resolved.provider}/${resolved.id})`
		: " (warning: does not resolve to an available model right now)";
}
