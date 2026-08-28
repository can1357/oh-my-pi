import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "./builtin-registry";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "./types";

export type { AcpBuiltinSlashCommandResult } from "./types";

/**
 * All names (primary + aliases) that are reserved by ACP builtins. Used to
 * filter out extension commands that would shadow a builtin or its alias at
 * dispatch time (e.g. `models` is an alias for `/model`, so an extension
 * registering `models` would appear in the palette but execute the builtin).
 */
export const ACP_BUILTIN_RESERVED_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMANDS_INTERNAL.filter(c => c.handle !== undefined).flatMap(c => [c.name, ...(c.aliases ?? [])]),
);

/**
 * Whether an extension command named `name` would be captured by ACP builtin
 * dispatch before reaching the extension handler. Beyond exact name/alias
 * collisions, `parseSlashCommand` treats `:` as a name/args separator, so a
 * colon-namespaced name whose prefix is a handled builtin (e.g. `model:foo`)
 * executes the `/model` builtin with `foo` as args. Such names must not be
 * advertised to ACP clients.
 */
export function isAcpBuiltinShadowedName(name: string): boolean {
	if (ACP_BUILTIN_RESERVED_NAMES.has(name)) return true;
	const colon = name.indexOf(":");
	return colon !== -1 && ACP_BUILTIN_RESERVED_NAMES.has(name.slice(0, colon));
}

/**
 * Commands advertised to ACP clients. Entries without a text-mode `handle`
 * (e.g. `/quit`, `/login`, dashboards) are filtered out so the client doesn't
 * see commands it cannot drive.
 */
export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
	command => command.handle !== undefined,
).map(command => {
	// Honor mode-specific copy: ACP clients receive concise text-mode
	// descriptions/hints when the spec sets `acpDescription` / `acpInputHint`,
	// otherwise fall back to the unified `description` / `inlineHint`.
	const hint = command.acpInputHint ?? command.inlineHint;
	return {
		name: command.name,
		description: command.acpDescription ?? command.description,
		input: hint ? { hint } : undefined,
	};
});

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no builtin matched (or matched a TUI-only entry); the caller
 *   should forward the input as a prompt.
 * - `{ consumed: true }` when the command handled the input entirely.
 * - `{ prompt }` when the command was handled but a residual prompt should be
 *   sent to the model.
 */
export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: SlashCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) return false;
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
