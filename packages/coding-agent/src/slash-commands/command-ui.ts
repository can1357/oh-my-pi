/**
 * Slash-command UI copy resolution for the builtin command registry.
 *
 * The ui-strings registry (`resolveUiString`) is the single source of localized
 * copy; this module adds the stable `command.*` key convention the builtin
 * slash-command materialize/consume paths use to swap in localized
 * descriptions, hints, and subcommand copy. When no override is registered,
 * the original English text is returned unchanged.
 *
 * Key convention (all fields fall back to the original copy):
 * - `command.<name>.description` — the command's canonical description.
 *   Consumed by both the TUI autocomplete description and the ACP-advertised
 *   description (against the effective `acpDescription ?? description`).
 * - `command.<name>.hint` — the inline hint / usage line: the TUI static
 *   `inlineHint` and the ACP-advertised input hint (against the effective
 *   `acpInputHint ?? inlineHint`).
 * - `command.<name>.subcommand.<sub>.description` — a subcommand's
 *   description (dropdown + ghost text).
 *
 * Command names, aliases, and argument syntax are never translated; only the
 * human-readable description/hint copy is.
 */

import { resolveUiString } from "../extensibility/extensions/ui-strings";
import type { SubcommandDef } from "./types";

/** Resolve the canonical description for a command. */
export function resolveCommandDescription(name: string, fallback: string): string {
	return resolveUiString(`command.${name}.description`, fallback);
}

/**
 * Resolve the inline hint for a command: the TUI static `inlineHint` and the
 * ACP-advertised input hint (`acpInputHint ?? inlineHint`).
 */
export function resolveCommandHint(name: string, fallback: string): string {
	return resolveUiString(`command.${name}.hint`, fallback);
}

/**
 * Return a copy of `subcommands` with each subcommand's description resolved
 * against the ui-strings registry. The original array is not mutated; the
 * builder closures capture this resolved copy. Argument-syntax `usage` ghost
 * text is never translated and passes through untouched.
 */
export function resolveCommandSubcommands(
	name: string,
	subcommands: SubcommandDef[],
): SubcommandDef[] {
	return subcommands.map(sub => ({
		...sub,
		description: resolveUiString(`command.${name}.subcommand.${sub.name}.description`, sub.description),
	}));
}
