import { sanitizeText } from "@oh-my-pi/pi-utils";
import { REFRESH_SCOPES, type RefreshScope } from "../extensibility/reload";
import { summarizeRefresh } from "../tools/refresh";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/**
 * Make a refresh failure safe for a single TUI line. A settings reload throws
 * with the absolute config path and possibly multiline YAML-parser content, so
 * forwarding it verbatim leaks the home directory and injects tabs / newlines /
 * oversized lines into the renderer. Collapse newlines, replace tabs, shorten
 * any absolute path to `~`, and truncate to the standard line width — the same
 * treatment other tool renderers apply to wire-delivered error text.
 *
 * `sanitizeText` runs FIRST and is what makes the rest safe: a YAML-parser or
 * filesystem message can carry ANSI escapes and other C0/C1 control bytes, and
 * the whitespace replacements below match none of them, so without it those
 * bytes ride through truncation into `runtime.output` and can recolor, reposition,
 * or otherwise spoof the TUI. It must precede `truncateToWidth` too: escape
 * sequences are zero-width, so measuring an unsanitized string mismeasures the
 * line and can sever a sequence mid-way. Mirrors `mcp/startup-events.ts`, which
 * composes the same `replaceTabs(sanitizeText(...))` pair.
 */
function sanitizeRefreshError(err: unknown): string {
	const singleLine = replaceTabs(sanitizeText(errorMessage(err)))
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, p => shortenPath(p));
	return truncateToWidth(singleLine, TRUNCATE_LENGTHS.LINE);
}

/**
 * `/refresh [scope]` — the human surface for the `refresh` tool. Re-reads the
 * frozen-at-session-start config surfaces (skills, rules, settings/model, MCP)
 * into the live session without a restart. The scope argument is validated
 * against the single-sourced {@link REFRESH_SCOPES} before ever calling
 * `session.refresh`, so an unknown scope never reaches the orchestrator.
 */
export const BUILTIN_REFRESH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "refresh",
		description: "Re-read skills, rules, settings, and MCP from disk (no restart)",
		acpDescription: "Re-read config surfaces from disk without restarting",
		subcommands: [
			{ name: "skills", description: "Re-scan the skill roster" },
			{ name: "rules", description: "Re-scan the rule roster" },
			{ name: "settings", description: "Re-read settings + default model" },
			{ name: "mcp", description: "Reconnect MCP servers" },
			{ name: "all", description: "Every config surface (default)" },
		],
		acpInputHint: "[skills|rules|settings|mcp|all]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			const validScopes: readonly RefreshScope[] = REFRESH_SCOPES;
			const scope: RefreshScope = arg === "" ? "all" : (arg as RefreshScope);
			if (!validScopes.includes(scope)) {
				return usage(`Unknown refresh scope "${arg}". Use: ${validScopes.join(", ")}.`, runtime);
			}
			try {
				const result = await runtime.session.refresh(scope);
				await runtime.output(summarizeRefresh(scope, result));
			} catch (err) {
				return usage(`Refresh failed: ${sanitizeRefreshError(err)}`, runtime);
			}
			return commandConsumed();
		},
	},
];
