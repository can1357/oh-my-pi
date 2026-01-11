/**
 * Workflow commands for orchestrating multi-agent workflows.
 *
 * Commands are embedded at build time via Bun's import with { type: "text" }.
 */

import * as path from "node:path";
import { type SlashCommand, slashCommandCapability } from "../../../capability/slash-command";
import { loadSync } from "../../../discovery";

// Embed command markdown files at build time
import initMd from "../../../prompts/agents/init.md" with { type: "text" };
import { renderPromptTemplate } from "../../prompt-templates";

const EMBEDDED_COMMANDS: { name: string; content: string }[] = [
	{ name: "init.md", content: renderPromptTemplate(initMd) },
];

export const EMBEDDED_COMMAND_TEMPLATES: ReadonlyArray<{ name: string; content: string }> = EMBEDDED_COMMANDS;

/** Workflow command definition */
export interface WorkflowCommand {
	name: string;
	description: string;
	instructions: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, body };
}

/** Cache for bundled commands */
let bundledCommandsCache: WorkflowCommand[] | null = null;

/**
 * Load all bundled commands from embedded content.
 */
export function loadBundledCommands(): WorkflowCommand[] {
	if (bundledCommandsCache !== null) {
		return bundledCommandsCache;
	}

	const commands: WorkflowCommand[] = [];

	for (const { name, content } of EMBEDDED_COMMANDS) {
		const { frontmatter, body } = parseFrontmatter(content);
		const cmdName = name.replace(/\.md$/, "");

		commands.push({
			name: cmdName,
			description: frontmatter.description || "",
			instructions: body,
			source: "bundled",
			filePath: `embedded:${name}`,
		});
	}

	bundledCommandsCache = commands;
	return commands;
}

/**
 * Discover all available commands.
 *
 * Precedence (highest wins): .omp > .pi > .claude (project before user), then bundled
 */
export function discoverCommands(cwd: string): WorkflowCommand[] {
	const resolvedCwd = path.resolve(cwd);

	// Load slash commands from capability API
	const result = loadSync<SlashCommand>(slashCommandCapability.id, { cwd: resolvedCwd });

	const commands: WorkflowCommand[] = [];
	const seen = new Set<string>();

	// Convert SlashCommand to WorkflowCommand format
	for (const cmd of result.items) {
		if (seen.has(cmd.name)) continue;

		const { frontmatter, body } = parseFrontmatter(cmd.content);

		// Map capability levels to WorkflowCommand source
		const source: "bundled" | "user" | "project" = cmd.level === "native" ? "bundled" : cmd.level;

		commands.push({
			name: cmd.name,
			description: frontmatter.description || "",
			instructions: body,
			source,
			filePath: cmd.path,
		});
		seen.add(cmd.name);
	}

	// Add bundled commands if not already present
	for (const cmd of loadBundledCommands()) {
		if (seen.has(cmd.name)) continue;
		commands.push(cmd);
		seen.add(cmd.name);
	}

	return commands;
}

/**
 * Get a command by name.
 */
export function getCommand(commands: WorkflowCommand[], name: string): WorkflowCommand | undefined {
	return commands.find((c) => c.name === name);
}

/**
 * Expand command instructions with task input.
 * Replaces $@ with the provided input.
 */
export function expandCommand(command: WorkflowCommand, input: string): string {
	return command.instructions.replace(/\$@/g, input);
}

/**
 * Clear the bundled commands cache (for testing).
 */
export function clearBundledCommandsCache(): void {
	bundledCommandsCache = null;
}
