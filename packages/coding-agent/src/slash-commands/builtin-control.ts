import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import { all as allSettings, settingValuesEqual } from "../config/registry";
import type { AgentSession } from "../session/agent-session";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

async function reloadConfigIntoSession(session: AgentSession): Promise<string> {
	const settings = session.settings;
	const entries = allSettings();
	const snapshot = entries.map(setting => setting.get(settings));
	try {
		await settings.reloadFromDisk();
	} catch (error) {
		return sanitizeErrorLine(`Config reload failed, previous settings kept: ${errorMessage(error)}`);
	}
	const changed = entries
		.filter((setting, index) => !settingValuesEqual(snapshot[index], setting.get(settings)))
		.map(setting => setting.id);
	if (changed.length === 0) return "Config already matches this session; nothing to apply.";

	const preview = changed.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS).join(", ");
	const overflow = changed.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
	return `Config reloaded: ${changed.length} setting${changed.length === 1 ? "" : "s"} changed (${preview}${overflow > 0 ? `, +${overflow} more` : ""}).`;
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "reload-config",
		description: "Reload persisted configuration and report changed settings",
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
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
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
