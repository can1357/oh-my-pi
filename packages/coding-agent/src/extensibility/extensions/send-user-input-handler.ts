/**
 * Helper for wiring the `sendUserInput` action of {@link ExtensionAPI}.
 *
 * Runs text the way the RPC mode runs a `prompt` command, so the four wiring
 * sites (interactive UI twice, ACP, and `initializeExtensions`, which print,
 * RPC and subagent sessions use) cannot drift, in this order:
 *   1. `/skill:<name>` through the RPC skill invocation (`resolveRpcSkillInvocation`
 *      and `runRpcSkillCommand`);
 *   2. built-in slash commands: those with a text-mode `handle` (the ones RPC and
 *      ACP run through `executeAcpBuiltinSlashCommand`) run it; the TUI-only
 *      rest answer `terminal-only`;
 *   3. a leading `/` that names no extension, custom or MCP prompt command,
 *      file slash command or prompt template answers `unknown` and is not sent;
 *   4. everything else goes through `session.prompt()`, which runs extension and
 *      custom commands and expands file slash commands and templates.
 *
 * Unlike typed input, the answer says what happened, so a bridge that forwards
 * a person's text can report a refusal instead of guessing.
 */
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { resolveRpcSkillInvocation, runRpcSkillCommand } from "../../modes/rpc/rpc-skill-invocation";
import type { AgentSession } from "../../session/agent-session";
import { BUILTIN_SLASH_COMMANDS_INTERNAL, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import type { SendUserInputOptions, SendUserInputResult } from "./types";

/** A built-in slash command, marked with how `sendUserInput` answers it. */
export interface UserInputBuiltinCommand {
	name: string;
	aliases: readonly string[];
	description: string;
	/** True when only the interactive terminal runs it, so `sendUserInput` answers `terminal-only`. */
	terminalOnly: boolean;
}

/**
 * Every built-in slash command, for a bridge that offers completion or explains a `terminal-only` answer.
 * A function, not a constant, so importing this module never reads the registry while modules still load.
 */
export function listUserInputBuiltinCommands(): UserInputBuiltinCommand[] {
	return BUILTIN_SLASH_COMMANDS_INTERNAL.map(command => ({
		name: command.name,
		aliases: command.aliases ?? [],
		description: command.acpDescription ?? command.description,
		terminalOnly: command.handle === undefined,
	}));
}

/** Run `text` in `session` as typed input; see {@link ExtensionAPI.sendUserInput}. */
export async function sendSessionUserInput(
	session: AgentSession,
	text: string,
	options?: SendUserInputOptions,
): Promise<SendUserInputResult> {
	const streamingBehavior = options?.deliverAs ?? "steer";
	const tag = options?.tag;

	const skill = resolveRpcSkillInvocation(session, text);
	if (skill) {
		await runRpcSkillCommand(session, skill, streamingBehavior, undefined, undefined, undefined, tag);
		return { handled: "skill" };
	}

	const parsed = parseSlashCommand(text);
	const builtin = parsed ? lookupBuiltinSlashCommand(parsed.name) : undefined;
	if (parsed && builtin) {
		// The same text-mode `handle` `executeAcpBuiltinSlashCommand` runs for RPC and ACP; that module is
		// not imported here because the action builders load this one while the registry initializes.
		if (!builtin.handle) return { handled: "terminal-only" };
		const printed: string[] = [];
		const result = await builtin.handle(parsed, {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: line => {
				printed.push(line);
			},
			// Every host re-advertises commands from `subscribeCommandMetadataChanged`,
			// which `refreshSkillsAndCommands()` fires.
			refreshCommands: () => {},
			reloadPlugins: async () => {
				const projectPath = await resolveActiveProjectRegistryPath(session.sessionManager.getCwd());
				clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
				await session.refreshSkillsAndCommands();
			},
		});
		const output = printed.length > 0 ? { output: printed.join("\n") } : undefined;
		if (result && "prompt" in result) {
			await session.prompt(result.prompt, { streamingBehavior, tag });
			return { handled: "prompt", ...output };
		}
		return { handled: "command", ...output };
	}

	if (text.startsWith("/") && !session.namesPromptCommand(text)) return { handled: "unknown" };
	const submitted = await session.prompt(text, { streamingBehavior, tag });
	// `prompt()` answers false only when an extension or custom command handled the text locally.
	return { handled: submitted ? "prompt" : "command" };
}
