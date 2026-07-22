import type { AgentPolicyFields, AgentTier } from "../../orchestration/agent-execution-profile";
import { resolveAgentExecutionProfile } from "../../orchestration/agent-execution-profile";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";

type TierSetting = "auto" | AgentTier;

export function getTierStatusText(settingsTier: unknown, defaultPolicy?: AgentPolicyFields): string {
	const configuredTier: TierSetting =
		settingsTier === "light" || settingsTier === "mid" || settingsTier === "frontier" ? settingsTier : "auto";
	const effectiveProfile = resolveAgentExecutionProfile({ override: defaultPolicy });
	const overrideLabel = configuredTier === "auto" ? "no interactive override" : "interactive override active";
	const lines = [
		`Default spawned-agent tier: ${configuredTier.toUpperCase()} (${overrideLabel})`,
		`Effective default envelope: ${effectiveProfile.tier}`,
		`  - Edit mode: ${effectiveProfile.editMode}`,
		`  - Autonomy: ${effectiveProfile.autonomy}`,
		`  - Collaboration: ${effectiveProfile.collaboration}`,
		`  - Model pool: ${effectiveProfile.modelPoolConstrained ? effectiveProfile.modelPool.join(", ") : "unconstrained"}`,
		effectiveProfile.tier === "light"
			? "  - Tool ceiling: read/search/report controls only; no execution, editing, delegation, or discovery"
			: effectiveProfile.tier === "mid"
				? "  - Tool ceiling: basic execution/delegation tools with replace-only editing"
				: "  - Tool ceiling: frontier capabilities permitted; more-specific policies may still restrict them",
		"Changes apply to newly spawned agents. Existing child sessions keep their immutable execution profile.",
	];
	return lines.join("\n");
}

export async function handleTierSlashCommand(args: string, runtime: SlashCommandRuntime): Promise<void> {
	const arg = args.trim().toLowerCase();

	if (!arg || arg === "status") {
		await runtime.output(
			getTierStatusText(runtime.settings.get("agent.tier"), runtime.settings.resolveAgentPolicy("", undefined)),
		);
		return;
	}

	if (arg === "light" || arg === "mid" || arg === "frontier") {
		runtime.settings.set("agent.tier", arg);
		await runtime.output(
			`Default spawned-agent tier set to "${arg}". Newly spawned agents—including stronger models—will use the ${arg.toUpperCase()} capability envelope.`,
		);
		return;
	}

	if (arg === "auto" || arg === "reset" || arg === "clear") {
		runtime.settings.set("agent.tier", "auto");
		await runtime.output(
			'Default spawned-agent tier reset to "auto". Agent/workflow-specific policies still apply; otherwise the normal frontier default is used.',
		);
		return;
	}

	await runtime.output(`Unknown tier "${args}". Usage: /tier [status|light|mid|frontier|auto]`);
}

export function handleTierSlashCommandTui(args: string, runtime: TuiSlashCommandRuntime): void {
	const arg = args.trim().toLowerCase();
	const settings = runtime.ctx.settings;

	if (!arg || arg === "status") {
		runtime.ctx.showStatus(getTierStatusText(settings.get("agent.tier"), settings.resolveAgentPolicy("", undefined)));
		runtime.ctx.editor.setText("");
		return;
	}

	if (arg === "light" || arg === "mid" || arg === "frontier") {
		settings.set("agent.tier", arg);
		runtime.ctx.showStatus(
			`Default spawned-agent tier set to "${arg}". Newly spawned agents—including stronger models—will use the ${arg.toUpperCase()} capability envelope.`,
		);
		runtime.ctx.editor.setText("");
		return;
	}

	if (arg === "auto" || arg === "reset" || arg === "clear") {
		settings.set("agent.tier", "auto");
		runtime.ctx.showStatus(
			'Default spawned-agent tier reset to "auto". Agent/workflow-specific policies still apply.',
		);
		runtime.ctx.editor.setText("");
		return;
	}

	runtime.ctx.showWarning(`Unknown tier "${args}". Usage: /tier [status|light|mid|frontier|auto]`);
	runtime.ctx.editor.setText("");
}
