import { usage } from "../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../slash-commands/types";
import { parsePanelSettings } from "./config";
import { formatPanelCompletionStatus } from "./status";
import type { PanelSettings, PanelTaskMode } from "./types";

const PANEL_USAGE = "Usage: /panel <answer|plan> [@role] <request>";
const PANEL_LINEUP_USAGE = "Usage: /panel lineup <answer|plan> <request>";

interface ParsedPanelInvocation {
	readonly taskMode: PanelTaskMode;
	readonly request: string;
	readonly requestedRole?: string;
}

interface ParsedPanelLineupInvocation {
	readonly taskMode: PanelTaskMode;
	readonly request: string;
}

/** Split the first token without normalizing the remainder. */
function splitFirstToken(input: string): { readonly token: string; readonly remainder: string } {
	const separatorIndex = input.search(/\s/);
	if (separatorIndex === -1) return { token: input, remainder: "" };
	return {
		token: input.slice(0, separatorIndex),
		remainder: input.slice(separatorIndex + 1),
	};
}

/** Parse `/panel <answer|plan> [@role] <request>` while retaining request whitespace. */
function parsePanelInvocation(args: string): ParsedPanelInvocation | undefined {
	const { token: modeToken, remainder: afterMode } = splitFirstToken(args);
	const mode = modeToken.toLowerCase();
	if (mode !== "answer" && mode !== "plan") return undefined;
	if (!afterMode.trim()) return undefined;

	const firstNonWhitespace = afterMode.search(/\S/);
	const candidate = afterMode.slice(firstNonWhitespace);
	if (!candidate.startsWith("@")) {
		return { taskMode: mode, request: afterMode };
	}

	const { token: roleToken, remainder: request } = splitFirstToken(candidate);
	const requestedRole = roleToken.slice(1);
	if (!requestedRole || !request.trim()) return undefined;
	return { taskMode: mode, request, requestedRole };
}

/** Parse `/panel lineup <answer|plan> <request>` (no `@role`: the lineup is always one-off). */
function parsePanelLineupInvocation(args: string): ParsedPanelLineupInvocation | undefined {
	const { token: modeToken, remainder } = splitFirstToken(args);
	const mode = modeToken.toLowerCase();
	if (mode !== "answer" && mode !== "plan") return undefined;
	if (!remainder.trim()) return undefined;
	return { taskMode: mode, request: remainder };
}

/**
 * Shared text/ACP `/panel` command. `lineup` (one-off builder) and `personas`
 * (persona editor) are TUI-only: ACP/text mode gets a clear status here and
 * never a false success. `handleTui` below fully overrides this for the TUI
 * dispatcher, including the `answer`/`plan` paths (adding the saved-role
 * picker fallback when no `@role` and no default role are configured).
 */
export const PANEL_SLASH_COMMAND: SlashCommandSpec = {
	name: "panel",
	description: "Ask a saved panel role for an answer or plan",
	inlineHint: "<answer|plan> [@role] <request>",
	allowArgs: true,
	subcommands: [
		{ name: "answer", description: "Answer a question with a saved panel role", usage: "[@role] <question>" },
		{ name: "plan", description: "Plan a goal with a saved panel role", usage: "[@role] <goal>" },
		{
			name: "lineup",
			description: "Build a one-off panel lineup (interactive TUI only)",
			usage: "<answer|plan> <request>",
		},
		{ name: "personas", description: "Edit saved panel personas (interactive TUI only)" },
	],
	handle: async (command, runtime) => {
		const { token: subToken } = splitFirstToken(command.args);
		const sub = subToken.toLowerCase();
		if (sub === "lineup" || sub === "personas") {
			return usage(`/panel ${sub} requires the interactive TUI.`, runtime);
		}

		const parsed = parsePanelInvocation(command.args);
		if (!parsed) return usage(PANEL_USAGE, runtime);

		const result = await runtime.session.runPanel({
			taskMode: parsed.taskMode,
			request: parsed.request,
			...(parsed.requestedRole !== undefined ? { requestedRole: parsed.requestedRole } : {}),
		});
		if (result.cancelled) {
			const completed = result.results.some(member => member.status === "completed");
			await runtime.output(
				completed
					? `${formatPanelCompletionStatus(result)} Partial synthesis requires confirmation in the interactive TUI.`
					: `${formatPanelCompletionStatus(result)} No member completed; synthesis was skipped.`,
			);
			return;
		}
		await runtime.output(formatPanelCompletionStatus(result));
		return { prompt: result.synthesisInput };
	},
	handleTui: async (command, runtime) => {
		const ctx = runtime.ctx;
		const { token: subToken, remainder } = splitFirstToken(command.args);
		const sub = subToken.toLowerCase();

		if (sub === "personas") {
			ctx.showPanelPersonaEditor();
			ctx.editor.setText("");
			return;
		}

		if (sub === "lineup") {
			const parsedLineup = parsePanelLineupInvocation(remainder);
			if (!parsedLineup) {
				ctx.showStatus(PANEL_LINEUP_USAGE);
				ctx.editor.setText("");
				return;
			}
			const result = await ctx.showPanelLineupBuilder(parsedLineup.taskMode, parsedLineup.request);
			ctx.editor.setText("");
			if (!result) return;
			return { prompt: result.synthesisInput };
		}

		const parsed = parsePanelInvocation(command.args);
		if (!parsed) {
			ctx.showStatus(PANEL_USAGE);
			ctx.editor.setText("");
			return;
		}

		if (parsed.requestedRole !== undefined) {
			const result = await ctx.runPanelWithConfirmation({
				taskMode: parsed.taskMode,
				request: parsed.request,
				requestedRole: parsed.requestedRole,
			});
			ctx.editor.setText("");
			if (!result) return;
			return { prompt: result.synthesisInput };
		}

		let panelSettings: PanelSettings;
		try {
			panelSettings = parsePanelSettings(ctx.settings.get("panel"));
		} catch (error) {
			ctx.showStatus(error instanceof Error ? error.message : String(error));
			ctx.editor.setText("");
			return;
		}

		if (panelSettings.defaultRole !== undefined) {
			const result = await ctx.runPanelWithConfirmation({ taskMode: parsed.taskMode, request: parsed.request });
			ctx.editor.setText("");
			if (!result) return;
			return { prompt: result.synthesisInput };
		}

		const roleId = await ctx.showPanelRolePicker(panelSettings);
		ctx.editor.setText("");
		if (roleId === undefined) return;

		const result = await ctx.runPanelWithConfirmation({
			taskMode: parsed.taskMode,
			request: parsed.request,
			requestedRole: roleId,
		});
		if (!result) return;
		return { prompt: result.synthesisInput };
	},
};
