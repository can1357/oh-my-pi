/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from:
 *   - ~/.omp/agent/agents/*.md (user-level, primary)
 *   - ~/.pi/agent/agents/*.md (user-level, legacy)
 *   - ~/.claude/agents/*.md (user-level, legacy)
 *   - .omp/agents/*.md (project-level, primary)
 *   - .pi/agents/*.md (project-level, legacy)
 *   - .claude/agents/*.md (project-level, legacy)
 *
 * Agent files use markdown with YAML frontmatter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../../../config";
import { loadBundledAgents } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

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

		const filePath = path.resolve(dir, entry.name);

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
 * Discover agents from filesystem and merge with bundled agents.
 *
 * Precedence (highest wins): .omp > .pi > .claude (project before user), then bundled
 *
 * @param cwd - Current working directory for project agent discovery
 */
export function discoverAgents(cwd: string): DiscoveryResult {
	const resolvedCwd = path.resolve(cwd);
	const agentSources = Array.from(new Set(getConfigDirs("", { project: false }).map((entry) => entry.source)));

	// Get user directories (priority order: .omp, .pi, .claude, ...)
	const userDirs = getConfigDirs("agents", { project: false })
		.filter((entry) => agentSources.includes(entry.source))
		.map((entry) => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	// Get project directories by walking up from cwd (priority order)
	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter((entry) => agentSources.includes(entry.source))
		.map((entry) => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedSources = agentSources.filter(
		(source) =>
			userDirs.some((entry) => entry.source === source) || projectDirs.some((entry) => entry.source === source),
	);

	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
	for (const source of orderedSources) {
		const project = projectDirs.find((entry) => entry.source === source);
		if (project) orderedDirs.push({ dir: project.path, source: "project" });
		const user = userDirs.find((entry) => entry.source === source);
		if (user) orderedDirs.push({ dir: user.path, source: "user" });
	}

	const agents: AgentDefinition[] = [];
	const seen = new Set<string>();

	for (const { dir, source } of orderedDirs) {
		for (const agent of loadAgentsFromDir(dir, source)) {
			if (seen.has(agent.name)) continue;
			agents.push(agent);
			seen.add(agent.name);
		}
	}

	for (const agent of loadBundledAgents()) {
		if (seen.has(agent.name)) continue;
		agents.push(agent);
		seen.add(agent.name);
	}

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return { agents, projectAgentsDir };
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find((a) => a.name === name);
}
