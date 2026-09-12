import { runPauseScreen } from "../modes/components/pause-screen";
import type { AgentSession } from "../session/agent-session";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const RELOAD_CONFIG_KEY_PREVIEW = 8;

async function reloadConfigIntoSession(session: AgentSession): Promise<string> {
	const { report, rebind } = await session.reloadConfigAndReapplyRole();
	if (report === undefined) return "Config reload is unavailable for this session.";
	if (report.status === "failed") {
		return `Config reload failed, previous settings kept: ${report.error ?? "unknown error"}`;
	}
	if (report.status === "unchanged") return "Config already matches this session; nothing to apply.";

	const lines: string[] = [];
	const preview = report.changed.slice(0, RELOAD_CONFIG_KEY_PREVIEW).join(", ");
	const overflow = report.changed.length - RELOAD_CONFIG_KEY_PREVIEW;
	lines.push(
		`Config reloaded: ${report.changed.length} setting${report.changed.length === 1 ? "" : "s"} changed (${preview}${overflow > 0 ? `, +${overflow} more` : ""}).`,
	);

	if (rebind !== undefined) {
		switch (rebind) {
			case "switched": {
				const model = session.model;
				lines.push(`Model switched to ${model ? `${model.provider}/${model.id}` : "the new default role"}.`);
				break;
			}
			case "thinking-applied":
				lines.push(`Thinking level updated to ${session.configuredThinkingLevel() ?? "the model default"}.`);
				break;
			case "deferred-turn":
				lines.push("Model change will apply at the end of the current turn.");
				break;
			case "deferred-plan-mode":
				lines.push("Model change will apply when you leave plan mode.");
				break;
			case "fallback-retargeted":
				lines.push("Model change will apply when the active fallback is released.");
				break;
			case "declined":
				lines.push("Model roles changed but this session kept its model, which was chosen explicitly.");
				break;
			case "unchanged":
				break;
		}
	}

	for (const entry of report.partiallyApplied) {
		lines.push(`Caveat: ${entry.key}: ${entry.reason}.`);
	}
	if (report.restartRequired.length > 0) {
		lines.push(`Known to need a restart: ${report.restartRequired.join(", ")}.`);
	}
	return lines.join("\n");
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "reload-config",
		description: "Re-read ~/.omp/agent/config.yml into this session",
		acpDescription: "Reload global config",
		handle: async (_command, runtime) => {
			await runtime.output(await reloadConfigIntoSession(runtime.session));
			return commandConsumed();
		},
		handleTui: async (_command, runtime) => {
			runtime.ctx.showStatus(await reloadConfigIntoSession(runtime.ctx.session));
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
