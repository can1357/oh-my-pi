import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	deleteSnippet,
	parseDeleteArgs,
	parseSaveArgs,
	resolveSnippetText,
	SNIPPETS_USAGE,
	type SnippetScope,
	saveSnippet,
	snippetExists,
	snippetsDir,
} from "../config/snippets";
import { clearSubmittedText } from "./helpers/draft";
import { parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SNIPPETS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "snippets",
		icon: "prompt",
		description: "Insert, save, or delete reusable prompt snippets (prompt templates)",
		subcommands: [
			{
				name: "save",
				description: "Save text as a snippet (default: your last prompt)",
				usage: "<name> [--scope user|project] [--force] [text]",
			},
			{ name: "delete", description: "Delete a saved snippet", usage: "<name> [--scope user|project]" },
		],
		subcommandOptional: true,
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			clearSubmittedText(runtime);
			const { verb, rest } = parseSubcommand(command.args);
			const cwd = ctx.sessionManager.getCwd();
			const agentDir = ctx.settings.getAgentDir();
			try {
				switch (verb) {
					case "": {
						await ctx.showSnippetPicker();
						return;
					}
					case "save": {
						const parsed = parseSaveArgs(rest);
						if ("error" in parsed) {
							ctx.showError(parsed.error);
							return;
						}
						const text = resolveSnippetText(
							parsed.text,
							ctx.session.getUserMessagesForBranching({ activeBranchOnly: true }),
						);
						if (!text) {
							ctx.showError("Nothing to save: add text after the name, or send a prompt first.");
							return;
						}
						const result = await saveSnippet({
							dir: snippetsDir(parsed.scope, cwd, agentDir),
							name: parsed.name,
							text,
							force: parsed.force,
						});
						if (result.kind === "exists") {
							ctx.showError(
								`Snippet "${parsed.name}" already exists (${parsed.scope}); pass --force to overwrite.`,
							);
							return;
						}
						await ctx.refreshPromptTemplates();
						ctx.showStatus(
							sanitizeErrorLine(
								`Saved snippet "${parsed.name}" (${parsed.scope}): ${shortenPath(result.path)}. Insert it with /snippets.`,
							),
						);
						return;
					}
					case "delete": {
						const parsed = parseDeleteArgs(rest);
						if ("error" in parsed) {
							ctx.showError(parsed.error);
							return;
						}
						const candidates: SnippetScope[] = parsed.scope ? [parsed.scope] : ["user", "project"];
						const present = await Promise.all(
							candidates.map(scope => snippetExists(snippetsDir(scope, cwd, agentDir), parsed.name)),
						);
						const found = candidates.filter((_, i) => present[i]);
						if (found.length === 0) {
							ctx.showError(`No snippet "${parsed.name}" in ${parsed.scope ?? "user or project"} prompts.`);
							return;
						}
						if (found.length > 1) {
							ctx.showError(`Snippet "${parsed.name}" exists in both scopes; pass --scope user|project.`);
							return;
						}
						const scope = found[0]!;
						await deleteSnippet(snippetsDir(scope, cwd, agentDir), parsed.name);
						await ctx.refreshPromptTemplates();
						ctx.showStatus(`Deleted snippet "${parsed.name}" (${scope}).`);
						return;
					}
					default:
						ctx.showError(`Unknown /snippets subcommand: ${verb}\n\n${SNIPPETS_USAGE}`);
						return;
				}
			} catch (error) {
				ctx.showError(`Snippets: ${sanitizeErrorLine(error)}`);
			}
		},
	},
];
