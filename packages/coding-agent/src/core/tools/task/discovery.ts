/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from:
 *   - ~/.pi/agent/agents/*.md (user-level, primary)
 *   - ~/.claude/agents/*.md (user-level, fallback)
 *   - .pi/agents/*.md (project-level, primary)
 *   - .claude/agents/*.md (project-level, fallback)
 *
 * Agent files use markdown with YAML frontmatter.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadBundledAgents } from "./agents.js";
import type { AgentDefinition, AgentSource } from "./types.js";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
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
			// Strip quotes
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, body };
}

/**
 * Load agents from a directory.
 */
function loadAgentsFromDir(dir: string, source: AgentSource): AgentDefinition[] {
	const agents: AgentDefinition[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;

		const filePath = path.join(dir, entry.name);

		// Handle both regular files and symlinks
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

		// Require name and description
		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const recursive =
			frontmatter.recursive === undefined
				? undefined
				: frontmatter.recursive === "true" || frontmatter.recursive === "1";

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			recursive,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
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

/**
 * Discover agents from filesystem and merge with bundled agents.
 *
 * Precedence (highest wins): project > user > bundled
 * Within each level: .pi > .claude
 *
 * @param cwd - Current working directory for project agent discovery
 */
export function discoverAgents(cwd: string): DiscoveryResult {
	// Primary directories (.pi)
	const userPiDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectPiDir = findNearestDir(cwd, ".pi/agents");

	// Fallback directories (.claude)
	const userClaudeDir = path.join(os.homedir(), ".claude", "agents");
	const projectClaudeDir = findNearestDir(cwd, ".claude/agents");

	const agentMap = new Map<string, AgentDefinition>();

	// 1. Bundled agents (lowest priority)
	for (const agent of loadBundledAgents()) {
		agentMap.set(agent.name, agent);
	}

	// 2. User agents (.claude then .pi - .pi overrides .claude)
	for (const agent of loadAgentsFromDir(userClaudeDir, "user")) {
		agentMap.set(agent.name, agent);
	}
	for (const agent of loadAgentsFromDir(userPiDir, "user")) {
		agentMap.set(agent.name, agent);
	}

	// 3. Project agents (highest priority - .claude then .pi)
	if (projectClaudeDir) {
		for (const agent of loadAgentsFromDir(projectClaudeDir, "project")) {
			agentMap.set(agent.name, agent);
		}
	}
	if (projectPiDir) {
		for (const agent of loadAgentsFromDir(projectPiDir, "project")) {
			agentMap.set(agent.name, agent);
		}
	}

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir: projectPiDir,
	};
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find((a) => a.name === name);
}
