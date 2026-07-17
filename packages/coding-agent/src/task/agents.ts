/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import { parseFrontmatter, prompt } from "@pk-nerdsaver-ai/pi-utils";
import { parseAgentFields } from "../discovery/helpers";
import auditMd from "../prompts/agents/audit.md" with { type: "text" };
import browserControlMd from "../prompts/agents/browser-control.md" with { type: "text" };
import browserOperationMd from "../prompts/agents/browser-operation.md" with { type: "text" };
import designerMd from "../prompts/agents/designer.md" with { type: "text" };
import exploreMd from "../prompts/agents/explore.md" with { type: "text" };
import falsifyMd from "../prompts/agents/falsify.md" with { type: "text" };
// Embed agent markdown files at build time
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import ixBrowserFastMd from "../prompts/agents/ix-browser-fast.md" with { type: "text" };
import librarianMd from "../prompts/agents/librarian.md" with { type: "text" };
import mrReducerMd from "../prompts/agents/mr-reducer.md" with { type: "text" };
import mrWorkerMd from "../prompts/agents/mr-worker.md" with { type: "text" };
import oracleMd from "../prompts/agents/oracle.md" with { type: "text" };
import planMd from "../prompts/agents/plan.md" with { type: "text" };
import reviewerMd from "../prompts/agents/reviewer.md" with { type: "text" };
import synthesizeMd from "../prompts/agents/synthesize.md" with { type: "text" };
import taskMd from "../prompts/agents/task.md" with { type: "text" };
import totReasonerMd from "../prompts/agents/tot-reasoner.md" with { type: "text" };

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = prompt.render(def.template);
	if (!def.frontmatter) return body;
	return prompt.render(agentFrontmatterTemplate, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "explore.md", template: exploreMd },
	{ fileName: "plan.md", template: planMd },
	{ fileName: "designer.md", template: designerMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{ fileName: "falsify.md", template: falsifyMd },
	{ fileName: "audit.md", template: auditMd },
	{ fileName: "synthesize.md", template: synthesizeMd },
	{ fileName: "librarian.md", template: librarianMd },
	{ fileName: "oracle.md", template: oracleMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "*",
			model: "pi/task",
		},
		template: taskMd,
	},
	{
		fileName: "quick_task.md",
		frontmatter: {
			name: "quick_task",
			description: "Low-reasoning agent for strictly mechanical updates or data collection only",
			model: "pi/smol",
			thinkingLevel: Effort.Medium,
		},
		template: taskMd,
	},
	// browser-control: spawnable browser-control subagent type; primary surface is IX Bridge
	// (model role pi/browser-control)
	{
		fileName: "browser-control.md",
		template: browserControlMd,
	},
	// browser-operation: compatibility browser-test subagent type; primary surface is IX Bridge
	// (model role pi/browser-control)
	{
		fileName: "browser-operation.md",
		template: browserOperationMd,
	},
	// ix-browser-fast: short-loop IX Bridge specialist (shares pi/browser-control)
	{
		fileName: "ix-browser-fast.md",
		template: ixBrowserFastMd,
	},
	{ fileName: "mr-reducer.md", template: mrReducerMd },
	{ fileName: "mr-worker.md", template: mrWorkerMd },
	{ fileName: "tot-reasoner.md", template: totReasonerMd },
];

// Computed lazily on first loadBundledAgents() call to avoid eager prompt.render at module load.

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/**
 * Parse an agent from embedded content.
 */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
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
	bundledAgentsCache = EMBEDDED_AGENT_DEFS.map(def =>
		parseAgent(`embedded:${def.fileName}`, buildAgentContent(def), "bundled"),
	);
	return bundledAgentsCache;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find(a => a.name === name);
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
