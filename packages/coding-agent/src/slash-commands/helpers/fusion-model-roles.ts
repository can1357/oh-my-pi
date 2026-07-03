import type { SlashCommandResult, SlashCommandRuntime } from "../types";
import { resolutionNote } from "./fusion-resolution";
import { commandConsumed } from "./parse";

const FUSION_MODEL_ROLES = {
	sidekick: { setting: "fusion.sidekickModel", label: "Sidekick model", fallback: "pi/smol", clearable: false },
	strong: { setting: "fusion.sidekickStrongModel", label: "Strong sidekick model", fallback: "", clearable: true },
	compact: { setting: "fusion.compactModel", label: "Compact model", fallback: "", clearable: true },
} as const;

type FusionModelRole = keyof typeof FUSION_MODEL_ROLES;

export async function handleModelRoleVerb(
	role: FusionModelRole,
	rest: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { setting, label, fallback, clearable } = FUSION_MODEL_ROLES[role];
	const selector = rest.trim();
	if (!selector) {
		const current = runtime.settings.get(setting)?.trim() || fallback;
		await runtime.output(
			`${label}: ${current || "(unset)"}. Usage: /fusion ${role} <model-or-alias${clearable ? "|clear" : ""}>`,
		);
		return commandConsumed();
	}
	if (clearable && selector.toLowerCase() === "clear") {
		runtime.settings.set(setting, "");
		await runtime.output(`${label} cleared.`);
		return commandConsumed();
	}
	runtime.settings.set(setting, selector);
	await runtime.output(`${label} → ${selector}${resolutionNote(selector, runtime)}`);
	return commandConsumed();
}
