import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";

export interface ParsedSubcommand {
	verb: string;
	rest: string;
}

export type ConfigScope = "user" | "project";

export interface NamedScopeArgs {
	name?: string;
	scope: ConfigScope;
	error?: string;
}

/**
 * Parse a slash-invocation string into `name`/`args`.
 *
 * The separator is the earliest whitespace or `:` character so that both
 * `/foo bar` and `/foo:bar` map to `{ name: "foo", args: "bar" }`.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
	if (!text.startsWith("/")) return null;
	const body = text.slice(1);
	if (!body) return null;
	const firstWhitespace = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const firstSeparator =
		firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);
	if (firstSeparator === -1) return { name: body, args: "", text };
	return {
		name: body.slice(0, firstSeparator),
		args: body.slice(firstSeparator + 1).trim(),
		text,
	};
}

/**
 * Mark a command as fully consumed in the ACP shape.
 *
 * Pass `agentInvoked` when the command scheduled a real agent turn whose events
 * will stream after it returns (e.g. `/retry`). RPC hosts use that marker to
 * tell local-only commands apart from work that starts a turn, so reporting
 * `agentInvoked: false` there would have them finalize the request while the
 * agent is still running.
 */
export function commandConsumed(options?: { agentInvoked?: boolean }): { consumed: true; agentInvoked?: boolean } {
	return options?.agentInvoked ? { consumed: true, agentInvoked: true } : { consumed: true };
}

/** Emit a usage/error message and consume the command. */
export async function usage(text: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	await runtime.output(text);
	return commandConsumed();
}

/** Split `<verb> <rest>` on the first whitespace; lowercases `verb`. */
export function parseSubcommand(input: string): ParsedSubcommand {
	const trimmed = input.trim();
	if (!trimmed) return { verb: "", rest: "" };
	const spaceIdx = trimmed.search(/\s/);
	if (spaceIdx === -1) return { verb: trimmed.toLowerCase(), rest: "" };
	return { verb: trimmed.slice(0, spaceIdx).toLowerCase(), rest: trimmed.slice(spaceIdx + 1).trim() };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Parse `<name?> [--scope project|user]`-style argument strings used by
 * remove/rm-style subcommands. `name` is optional so callers can surface
 * "name required" diagnostics with their own messaging.
 */
export function parseNamedScopeArgs(rest: string, invalidScopeMessage: string): NamedScopeArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	let name: string | undefined;
	let scope: ConfigScope = "project";
	let i = 0;
	if (tokens.length > 0 && !tokens[0]!.startsWith("-")) {
		name = tokens[0];
		i = 1;
	}
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (token !== "--scope") return { scope, error: `Unknown option: ${token}` };
		const value = tokens[i + 1];
		if (!value || (value !== "project" && value !== "user")) return { scope, error: invalidScopeMessage };
		scope = value;
		i += 2;
	}
	return { name, scope };
}

/**
 * Strict positive-integer argument for operator rollback commands. Partial
 * parses ("/undo 2junk") and non-positive values are rejected rather than
 * silently mapped to a default that would drop a turn.
 */
export function parsePositiveSteps(
	raw: string | undefined,
): { ok: true; steps: number } | { ok: false; error: string } {
	const text = raw?.trim() ?? "";
	if (text === "") return { ok: true, steps: 1 };
	if (!/^\d+$/.test(text) || Number(text) < 1) {
		return { ok: false, error: "Expected a positive integer number of steps (e.g. /undo 2)." };
	}
	return { ok: true, steps: Number(text) };
}

/** Strict 1-based turn number for `/revert <turn#>`. */
export function parseTurnNumber(raw: string): { ok: true; index: number } | { ok: false; error: string } {
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		return { ok: false, error: "Expected a positive turn number (see /revert for the listing)." };
	}
	return { ok: true, index: Number(raw) - 1 };
}
