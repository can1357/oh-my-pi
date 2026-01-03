/**
 * Workflow commands for orchestrating multi-agent workflows.
 *
 * Commands are embedded at build time via Bun's import with { type: "text" }.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../../../config";

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

		const filePath = path.resolve(dir, entry.name);

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
	const commandSources = Array.from(new Set(getConfigDirs("", { project: false }).map((entry) => entry.source)));

	const userDirs = getConfigDirs("commands", { project: false })
		.filter((entry) => commandSources.includes(entry.source))
		.map((entry) => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("commands", resolvedCwd)
		.filter((entry) => commandSources.includes(entry.source))
		.map((entry) => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedSources = commandSources.filter(
		(source) =>
			userDirs.some((entry) => entry.source === source) || projectDirs.some((entry) => entry.source === source),
	);

	const orderedDirs: Array<{ dir: string; source: "user" | "project" }> = [];
	for (const source of orderedSources) {
		const project = projectDirs.find((entry) => entry.source === source);
		if (project) orderedDirs.push({ dir: project.path, source: "project" });
		const user = userDirs.find((entry) => entry.source === source);
		if (user) orderedDirs.push({ dir: user.path, source: "user" });
	}

	const commands: WorkflowCommand[] = [];
	const seen = new Set<string>();

	for (const { dir, source } of orderedDirs) {
		for (const cmd of loadCommandsFromDir(dir, source)) {
			if (seen.has(cmd.name)) continue;
			commands.push(cmd);
			seen.add(cmd.name);
		}
	}

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
