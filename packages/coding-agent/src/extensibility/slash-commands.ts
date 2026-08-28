import { parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { slashCommandCapability } from "../capability/slash-command";
import type { EffectiveExtensionRoots } from "../capability/types";
import { appendInlineArgsFallback, templateUsesInlineArgPlaceholders } from "../config/prompt-templates";
import type { SlashCommand } from "../discovery";
import { loadCapability } from "../discovery";
import { EMBEDDED_COMMAND_TEMPLATES } from "../task/commands";
import { parseCommandArgs, substituteArgs } from "../utils/command-args";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export type SlashCommandLocation = "user" | "project" | "path";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	location?: SlashCommandLocation;
	path?: string;
}

export type { BuiltinSlashCommand, SubcommandDef } from "../slash-commands/types";

/**
 * Represents a custom slash command loaded from a file
 */
export interface FileSlashCommand {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "via Claude Code (User)"
	/** Source metadata for display */
	_source?: { providerName: string; level: "user" | "project" | "native" };
}

const EMBEDDED_SLASH_COMMANDS = EMBEDDED_COMMAND_TEMPLATES;

function parseCommandTemplate(
	content: string,
	options: { source: string; level?: "off" | "warn" | "fatal" },
): { description: string; body: string } {
	const { frontmatter, body } = parseFrontmatter(content, options);
	const frontmatterDesc = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

	// Get description from frontmatter or first non-empty line
	let description = frontmatterDesc;
	if (!description) {
		const firstLine = body.split("\n").find(line => line.trim());
		if (firstLine) {
			description = firstLine.slice(0, 60);
			if (firstLine.length > 60) description += "...";
		}
	}

	return { description, body };
}

export interface LoadSlashCommandsOptions {
	/** Working directory for project-local commands. Default: getProjectDir() */
	cwd?: string;
	/** Session-local extension roots for post-startup reloads (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
}

/**
 * Load all custom slash commands using the capability API.
 * Loads from all registered providers (builtin, user, project).
 */
export async function loadSlashCommands(options: LoadSlashCommandsOptions = {}): Promise<FileSlashCommand[]> {
	const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
		cwd: options.cwd,
		extensionRoots: options.extensionRoots,
	});

	const fileCommands: FileSlashCommand[] = result.items.map(cmd => {
		const { description, body } = parseCommandTemplate(cmd.content, {
			source: cmd.path ?? `slash-command:${cmd.name}`,
			level: cmd.level === "native" ? "fatal" : "warn",
		});

		// Format source label: "via ProviderName Level"
		const capitalizedLevel = cmd.level.charAt(0).toUpperCase() + cmd.level.slice(1);
		const sourceStr = `via ${cmd._source.providerName} ${capitalizedLevel}`;

		return {
			name: cmd.name,
			description,
			content: body,
			source: sourceStr,
			_source: { providerName: cmd._source.providerName, level: cmd.level },
		};
	});

	const seenNames = new Set(fileCommands.map(cmd => cmd.name));
	for (const cmd of EMBEDDED_SLASH_COMMANDS) {
		const name = cmd.name.replace(/\.md$/, "");
		if (seenNames.has(name)) continue;

		const { description, body } = parseCommandTemplate(cmd.content, {
			source: `embedded:${cmd.name}`,
			level: "fatal",
		});
		fileCommands.push({
			name,
			description,
			content: body,
			source: "bundled",
		});
		seenNames.add(name);
	}

	return fileCommands;
}

/**
 * Expand a slash command if it matches a file-based command.
 * Returns the expanded content or the original text if not a slash command.
 */
export function expandSlashCommand(text: string, fileCommands: FileSlashCommand[]): string {
	if (!text.startsWith("/")) return text;

	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

	const fileCommand = fileCommands.find(cmd => cmd.name === commandName);
	if (fileCommand) {
		const args = parseCommandArgs(argsString);
		const argsText = args.join(" ");
		const usesInlineArgPlaceholders = templateUsesInlineArgPlaceholders(fileCommand.content);
		const substituted = substituteArgs(fileCommand.content, args);
		const rendered = prompt.render(substituted, { args, ARGUMENTS: argsText, arguments: argsText });
		return appendInlineArgsFallback(rendered, argsText, usesInlineArgPlaceholders);
	}

	return text;
}
