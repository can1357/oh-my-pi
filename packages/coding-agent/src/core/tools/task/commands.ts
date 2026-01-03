/**
 * Workflow commands for orchestrating multi-agent workflows.
 *
 * Commands are embedded at build time via Bun's import with { type: "text" }.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Embed command markdown files at build time
import architectPlanMd from "./bundled-commands/architect-plan.md" with { type: "text" };
import implementMd from "./bundled-commands/implement.md" with { type: "text" };
import implementWithCriticMd from "./bundled-commands/implement-with-critic.md" with { type: "text" };

const EMBEDDED_COMMANDS: { name: string; content: string }[] = [
	{ name: "architect-plan.md", content: architectPlanMd },
	{ name: "implement-with-critic.md", content: implementWithCriticMd },
	{ name: "implement.md", content: implementMd },
];

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

/**
 * Load commands from a directory (for user/project commands).
 */
function loadCommandsFromDir(dir: string, source: "user" | "project"): WorkflowCommand[] {
	const commands: WorkflowCommand[] = [];

	if (!fs.existsSync(dir)) {
		return commands;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return commands;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;

		const filePath = path.join(dir, entry.name);

		try {
			if (!fs.statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		// Name is filename without extension
		const name = entry.name.replace(/\.md$/, "");

		commands.push({
			name,
			description: frontmatter.description || "",
			instructions: body,
			source,
			filePath,
		});
	}

	return commands;
}

/**
 * Check if path is a directory.
 */
function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Find nearest directory by walking up from cwd.
 */
function findNearestDir(cwd: string, relPath: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, relPath);
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
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
 * Precedence: project > user > bundled
 */
export function discoverCommands(cwd: string): WorkflowCommand[] {
	const commandMap = new Map<string, WorkflowCommand>();

	// Bundled commands (lowest priority)
	for (const cmd of loadBundledCommands()) {
		commandMap.set(cmd.name, cmd);
	}

	// User commands
	const userPiDir = path.join(os.homedir(), ".pi", "agent", "commands");
	const userClaudeDir = path.join(os.homedir(), ".claude", "commands");

	for (const cmd of loadCommandsFromDir(userClaudeDir, "user")) {
		commandMap.set(cmd.name, cmd);
	}
	for (const cmd of loadCommandsFromDir(userPiDir, "user")) {
		commandMap.set(cmd.name, cmd);
	}

	// Project commands (highest priority)
	const projectPiDir = findNearestDir(cwd, ".pi/commands");
	const projectClaudeDir = findNearestDir(cwd, ".claude/commands");

	if (projectClaudeDir) {
		for (const cmd of loadCommandsFromDir(projectClaudeDir, "project")) {
			commandMap.set(cmd.name, cmd);
		}
	}
	if (projectPiDir) {
		for (const cmd of loadCommandsFromDir(projectPiDir, "project")) {
			commandMap.set(cmd.name, cmd);
		}
	}

	return Array.from(commandMap.values());
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
