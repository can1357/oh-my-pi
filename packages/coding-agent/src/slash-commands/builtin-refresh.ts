import { sanitizeText } from "@oh-my-pi/pi-utils";
import { REFRESH_SCOPES, type RefreshScope } from "../extensibility/reload";
import { summarizeRefresh } from "../tools/refresh";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

/**
 * Make externally-supplied refresh text safe for a single TUI line. Both
 * callers below hand this arbitrary bytes: a settings reload throws with the
 * absolute config path and possibly multiline YAML-parser content, and a
 * rejected scope argument is whatever an ACP/RPC client or a TUI paste
 * supplied. Forwarding either verbatim leaks the home directory and injects
 * tabs / newlines / oversized lines into the renderer, so collapse newlines,
 * replace tabs, shorten any absolute path to `~`, and truncate to the standard
 * line width — the same treatment other tool renderers apply to wire-delivered
 * error text.
 *
 * `sanitizeText` runs FIRST and is what makes the rest safe: this text can
 * carry ANSI escapes and other C0/C1 control bytes, and the whitespace
 * replacements below match none of them, so without it those bytes ride through
 * truncation into `runtime.output` and can recolor, reposition, or otherwise
 * spoof the TUI. It must precede `truncateToWidth` too: escape sequences are
 * zero-width, so measuring an unsanitized string mismeasures the line and can
 * sever a sequence mid-way. Mirrors `mcp/startup-events.ts`, which composes the
 * same `replaceTabs(sanitizeText(...))` pair.
 */
function sanitizeRefreshText(text: string): string {
	const singleLine = replaceTabs(sanitizeText(text))
		.replace(/[\r\n]+/g, " ")
		// Windows absolute forms too (`C:\…`, `C:/…`, and UNC `\\server\share`):
		// `shortenPath` already resolves a drive-letter or UNC home, so leaving
		// them unmatched here was the only reason a Windows config path printed in
		// full. Drive letters are matched before the bare-`/` alternative so the
		// colon is not left stranded outside the replacement.
		.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'")\]]+/g, p => shortenPath(p));
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
				return usage(
					`Unknown refresh scope "${sanitizeRefreshText(arg)}". Use: ${validScopes.join(", ")}.`,
					runtime,
				);
			}
			try {
				const result = await runtime.session.refresh(scope);
				await runtime.output(summarizeRefresh(scope, result));
			} catch (err) {
				return usage(`Refresh failed: ${sanitizeRefreshText(errorMessage(err))}`, runtime);
			}
			return commandConsumed();
		},
	},
];
