/**
 * Bundled agent definitions.
 *
 * Agents are loaded from .md files in the bundled-agents directory.
 * These serve as defaults when no user/project agents are discovered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, AgentSource } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_DIR = path.join(__dirname, "bundled-agents");

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
 * Load a single agent from a markdown file.
 */
function loadAgentFromFile(filePath: string, source: AgentSource): AgentDefinition | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content);

	if (!frontmatter.name || !frontmatter.description) {
		return null;
	}

	const tools = frontmatter.tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	const recursive =
		frontmatter.recursive === undefined ? false : frontmatter.recursive === "true" || frontmatter.recursive === "1";

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		recursive,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from the bundled-agents directory.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}

	const agents: AgentDefinition[] = [];

	if (!fs.existsSync(BUNDLED_AGENTS_DIR)) {
		bundledAgentsCache = agents;
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(BUNDLED_AGENTS_DIR, { withFileTypes: true });
	} catch {
		bundledAgentsCache = agents;
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;

		const filePath = path.join(BUNDLED_AGENTS_DIR, entry.name);
		const agent = loadAgentFromFile(filePath, "bundled");
		if (agent) {
			agents.push(agent);
		}
	}

	bundledAgentsCache = agents;
	return agents;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find((a) => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
 */
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
