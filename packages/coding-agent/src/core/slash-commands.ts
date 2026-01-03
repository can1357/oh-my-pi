import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getCommandsDir, getConfigDirPaths } from "../config";
import { logger } from "./logger";

/**
 * Represents a custom slash command loaded from a file
 */
export interface FileSlashCommand {
	name: string;
	description: string;
	content: string;
	source: string; // e.g., "(user)", "(project)", "(project:frontend)"
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter, content } where content has frontmatter stripped
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; content: string } {
	const frontmatter: Record<string, string> = {};

	if (!content.startsWith("---")) {
		return { frontmatter, content };
	}

	const endIndex = content.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, content };
	}

	const frontmatterBlock = content.slice(4, endIndex);
	const remainingContent = content.slice(endIndex + 4).trim();

	// Simple YAML parsing - just key: value pairs
	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^(\w+):\s*(.*)$/);
		if (match) {
			frontmatter[match[1]] = match[2].trim();
		}
	}

	return { frontmatter, content: remainingContent };
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * Substitute argument placeholders in command content
 * Supports $1, $2, ... for positional args and $@ for all args
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;

	// Replace $@ with all args joined
	result = result.replace(/\$@/g, args.join(" "));

	// Replace $1, $2, etc. with positional args
	result = result.replace(/\$(\d+)/g, (_, num) => {
		const index = parseInt(num, 10) - 1;
		return args[index] ?? "";
	});

	return result;
}

type CommandSource = "builtin" | "claude-user" | "claude-project" | "user" | "project";

/**
 * Recursively scan a directory for .md files (and symlinks to .md files) and load them as slash commands
 */
function loadCommandsFromDir(dir: string, source: CommandSource, subdir: string = ""): FileSlashCommand[] {
	const commands: FileSlashCommand[] = [];

	if (!existsSync(dir)) {
		return commands;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				// Recurse into subdirectory
				const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
				commands.push(...loadCommandsFromDir(fullPath, source, newSubdir));
			} else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) {
				try {
					const rawContent = readFileSync(fullPath, "utf-8");
					const { frontmatter, content } = parseFrontmatter(rawContent);

					const name = entry.name.slice(0, -3); // Remove .md extension

					// Build source string based on source type
					const sourceLabel =
						source === "builtin"
							? "builtin"
							: source === "claude-user"
								? "claude-user"
								: source === "claude-project"
									? "claude-project"
									: source === "user"
										? "user"
										: "project";
					const sourceStr = subdir ? `(${sourceLabel}:${subdir})` : `(${sourceLabel})`;

					// Get description from frontmatter or first non-empty line
					let description = frontmatter.description || "";
					if (!description) {
						const firstLine = content.split("\n").find((line) => line.trim());
						if (firstLine) {
							// Truncate if too long
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) description += "...";
						}
					}

					// Append source to description
					description = description ? `${description} ${sourceStr}` : sourceStr;

					commands.push({
						name,
						description,
						content,
						source: sourceStr,
					});
				} catch (err) {
					logger.debug("Failed to read slash command file", { error: String(err) });
				}
			}
		}
	} catch (err) {
		logger.debug("Failed to read slash command directory", { error: String(err) });
	}

	return commands;
}

export interface LoadSlashCommandsOptions {
	/** Working directory for project-local commands. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global commands. Default: from getCommandsDir() */
	agentDir?: string;
	/** Enable loading from ~/.claude/commands/. Default: true */
	enableClaudeUser?: boolean;
	/** Enable loading from .claude/commands/. Default: true */
	enableClaudeProject?: boolean;
}

/**
 * Load all custom slash commands from:
 * 1. Builtin: package commands/
 * 2. Claude user: ~/.claude/commands/
 * 3. Claude project: .claude/commands/
 * 4. OMP user: agentDir/commands/
 * 5. OMP project: cwd/.omp/commands/ (and legacy .pi/commands/)
 *
 * First occurrence wins (earlier sources have priority).
 */
export function loadSlashCommands(options: LoadSlashCommandsOptions = {}): FileSlashCommand[] {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getCommandsDir();
	const enableClaudeUser = options.enableClaudeUser ?? true;
	const enableClaudeProject = options.enableClaudeProject ?? true;

	const commands: FileSlashCommand[] = [];
	const seenNames = new Set<string>();

	const addCommands = (newCommands: FileSlashCommand[]) => {
		for (const cmd of newCommands) {
			if (!seenNames.has(cmd.name)) {
				commands.push(cmd);
				seenNames.add(cmd.name);
			}
		}
	};

	// 1. Builtin commands (from package)
	const builtinDir = join(import.meta.dir, "../commands");
	if (existsSync(builtinDir)) {
		addCommands(loadCommandsFromDir(builtinDir, "builtin"));
	}

	// 2. Claude user commands (~/.claude/commands/)
	if (enableClaudeUser) {
		const claudeUserDir = join(homedir(), ".claude", "commands");
		addCommands(loadCommandsFromDir(claudeUserDir, "claude-user"));
	}

	// 3. Claude project commands (.claude/commands/)
	if (enableClaudeProject) {
		const claudeProjectDir = resolve(resolvedCwd, ".claude", "commands");
		addCommands(loadCommandsFromDir(claudeProjectDir, "claude-project"));
	}

	// 4. OMP user commands (agentDir/commands/)
	const globalCommandsDir = options.agentDir ? join(options.agentDir, "commands") : resolvedAgentDir;
	addCommands(loadCommandsFromDir(globalCommandsDir, "user"));

	// 5. OMP project commands (cwd/.omp/commands/ and legacy .pi/commands/)
	for (const dir of getConfigDirPaths("commands", { user: false, cwd: resolvedCwd })) {
		addCommands(loadCommandsFromDir(dir, "project"));
	}

	return commands;
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

	const fileCommand = fileCommands.find((cmd) => cmd.name === commandName);
	if (fileCommand) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(fileCommand.content, args);
	}

	return text;
}
