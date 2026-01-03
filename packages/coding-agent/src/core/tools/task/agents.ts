/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */

// Embed agent markdown files at build time
import browserMd from "./bundled-agents/browser.md" with { type: "text" };
import exploreMd from "./bundled-agents/explore.md" with { type: "text" };
import planMd from "./bundled-agents/plan.md" with { type: "text" };
import reviewerMd from "./bundled-agents/reviewer.md" with { type: "text" };
import taskMd from "./bundled-agents/task.md" with { type: "text" };
import type { AgentDefinition, AgentSource } from "./types";

const EMBEDDED_AGENTS: { name: string; content: string }[] = [
	{ name: "browser.md", content: browserMd },
	{ name: "explore.md", content: exploreMd },
	{ name: "plan.md", content: planMd },
	{ name: "reviewer.md", content: reviewerMd },
	{ name: "task.md", content: taskMd },
];

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
 * Parse an agent from embedded content.
 */
function parseAgent(fileName: string, content: string, source: AgentSource): AgentDefinition | null {
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
		filePath: `embedded:${fileName}`,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}

	const agents: AgentDefinition[] = [];

	for (const { name, content } of EMBEDDED_AGENTS) {
		const agent = parseAgent(name, content, "bundled");
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
