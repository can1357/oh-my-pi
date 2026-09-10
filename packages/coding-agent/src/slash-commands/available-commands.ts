import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import { getSkillSlashCommandName, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { ACP_BUILTIN_RESERVED_NAMES, isAcpBuiltinShadowedName } from "./acp-builtins";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "./builtin-registry";

export type AvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export interface InternalAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
	/** Remote TUI dispatch owner; omitted for non-builtin dynamic commands. */
	owner?: "client" | "daemon";
}

export interface AvailableCommandsSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly mcpPromptCommands?: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
	readonly effectiveExtensionRoots?: EffectiveExtensionRoots;
	setSlashCommands(slashCommands: FileSlashCommand[]): void;
	sessionManager: { getCwd(): string };
}
export interface BuildAvailableSlashCommandsOptions {
	/**
	 * Include builtins that only have a TUI handler. ACP/RPC callers leave this
	 * disabled because those commands require client-owned UI state.
	 */
	includeClientOwnedBuiltins?: boolean;
}

/** Return client-owned builtin metadata for merging into a daemon palette. */
export function getClientOwnedBuiltinSlashCommands(): InternalAvailableSlashCommand[] {
	return BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
		command => (command.owner ?? (command.handle ? "daemon" : "client")) === "client",
	).map(command => ({
		name: command.name,
		aliases: command.aliases,
		description: command.description,
		input: command.inlineHint ? { hint: command.inlineHint } : undefined,
		subcommands: command.subcommands,
		source: "builtin",
		owner: "client",
	}));
}

/** Build the complete local palette for a remote TUI (daemon + client-owned builtins). */
export async function buildRemoteAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd =>
		loadSlashCommands({ cwd, extensionRoots: session.effectiveExtensionRoots }),
): Promise<InternalAvailableSlashCommand[]> {
	return buildAvailableSlashCommands(session, loadFileCommands, { includeClientOwnedBuiltins: true });
}

export async function buildAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd =>
		loadSlashCommands({ cwd, extensionRoots: session.effectiveExtensionRoots }),
	options: BuildAvailableSlashCommandsOptions = {},
): Promise<InternalAvailableSlashCommand[]> {
	const commands: InternalAvailableSlashCommand[] = [];
	const seenNames = new Set<string>();
	const appendCommand = (command: InternalAvailableSlashCommand): void => {
		if (seenNames.has(command.name)) return;
		seenNames.add(command.name);
		commands.push(command);
	};

	for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
		if (!command.handle && !options.includeClientOwnedBuiltins) continue;
		const hint = command.acpInputHint ?? command.inlineHint;
		appendCommand({
			name: command.name,
			aliases: command.aliases,
			description: command.acpDescription ?? command.description,
			input: hint ? { hint } : undefined,
			subcommands: command.subcommands,
			source: "builtin",
			owner: command.owner ?? (command.handle ? "daemon" : "client"),
		});
	}

	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			appendCommand({
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				input: { hint: "arguments" },
				source: "skill",
				owner: "daemon",
			});
		}
	}

	const runner = session.extensionRunner;
	if (runner) {
		for (const command of runner.getRegisteredCommands(ACP_BUILTIN_RESERVED_NAMES)) {
			if (isAcpBuiltinShadowedName(command.name)) continue;
			appendCommand({
				name: command.name,
				description: command.description ?? "(extension command)",
				owner: "daemon",
				input: { hint: "arguments" },
				source: "extension",
			});
		}
	}

	for (const command of session.customCommands) {
		const source: AvailableSlashCommandSource = command.path?.startsWith("mcp:") ? "mcp_prompt" : "custom";
		appendCommand({
			name: command.command.name,
			description: command.command.description,
			input: { hint: "arguments" },
			source,
			owner: "daemon",
		});
	}

	const fileCommands = await loadFileCommands(session.sessionManager.getCwd());
	session.setSlashCommands(fileCommands);
	for (const command of fileCommands) {
		appendCommand({ name: command.name, description: command.description, source: "file", owner: "daemon" });
	}

	return commands;
}

export function toAcpAvailableCommands(commands: readonly InternalAvailableSlashCommand[]): AvailableCommand[] {
	return commands.map(command => ({
		name: command.name,
		description: command.description ?? "",
		input: command.input,
	}));
}
