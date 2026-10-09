/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { Effort } from "@oh-my-pi/pi-ai";
import { logger, parseFrontmatter, prompt } from "@oh-my-pi/pi-utils";
import { parseAgentFields } from "../discovery/helpers";
import type { Skill } from "../extensibility/skills";
// Embed agent markdown files at build time
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import reviewerMd from "../prompts/agents/reviewer.md" with { type: "text" };
import scoutMd from "../prompts/agents/scout.md" with { type: "text" };
import securityReviewerMd from "../prompts/agents/security-reviewer.md" with { type: "text" };
import taskMd from "../prompts/agents/task.md" with { type: "text" };
import { AUTO_THINKING } from "@oh-my-pi/pi-tui/thinking";

import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import type { AgentDefinition } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
	prewalk?: boolean | string;
	advisor?: boolean | string;
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
	{ fileName: "scout.md", template: scoutMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{ fileName: "security-reviewer.md", template: securityReviewerMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "*",
			model: "@task",
			thinkingLevel: AUTO_THINKING,
			// No `prewalk` frontmatter: the generic task hand-off (strong model
			// plans, then hands off to the smol role) is armed by the
			// `task.prewalk` setting (default off) or per agent via /agents
			// (task.agentPrewalk).
		},
		template: taskMd,
	},
	{
		fileName: "sonic.md",
		frontmatter: {
			name: "sonic",
			description: "Low-reasoning agent for strictly mechanical updates or data collection only",
			model: "@smol",
			thinkingLevel: Effort.Medium,
		},
		template: taskMd,
	},
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

	override toString(): string {
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

/**
 * Resolve the skill list handed to a subagent session, applying the agent's
 * per-role visibility frontmatter (`skills` allowlist, `hideSkills` denylist,
 * `unhideSkills` source-hide override).
 *
 * Visibility controls the rendered `<skills>` block only — skills are never
 * dropped, so `skill://<name>` stays reachable (plus `/skill:<name>` where the
 * session has a slash dispatcher, i.e. the main session). Since the
 * child prompt renderer re-filters `hide !== true`, listing-hidden skills are
 * marked `hide: true` on the copies and `unhideSkills` clears the flag.
 * This is presentation filtering, not access control: a
 * `disableModelInvocation: true` opt-out is never listable via `unhideSkills`,
 * but `skill://` resolution itself does not enforce `hide`.
 *
 * Globs follow `Bun.Glob` semantics: `*` does not cross `/`, so a namespaced
 * collision alias (`ns/name`) needs an explicit `ns/*` or `**` pattern.
 *
 * Precedence per skill (deny wins):
 *  1. `hideSkills` glob match → hidden (beats allowlist and `unhideSkills`);
 *  2. `skills` allowlist present and no match → hidden;
 *  3. source `hide: true` and no `unhideSkills` match → hidden;
 *  4. otherwise → listed.
 */
export function resolveAgentSkills(
	sessionSkills: readonly Skill[],
	agent: Pick<AgentDefinition, "skills" | "hideSkills" | "unhideSkills">,
): Skill[] {
	const allowlist = agent.skills;
	const deny = agent.hideSkills;
	const unhide = agent.unhideSkills;
	const compile = (patterns: string[] | undefined): Array<{ glob: Bun.Glob; pattern: string }> | undefined => {
		if (!patterns?.length) return undefined;
		const warned = new Set<string>();
		const compiled: Array<{ glob: Bun.Glob; pattern: string }> = [];
		for (const pattern of patterns) {
			try {
				compiled.push({ glob: new Bun.Glob(pattern), pattern });
			} catch {
				if (!warned.has(pattern)) {
					warned.add(pattern);
					logger.warn("Invalid skill glob in agent frontmatter", { pattern });
				}
			}
		}
		return compiled;
	};
	const denyGlobs = compile(deny);
	const unhideGlobs = compile(unhide);
	// `skills: []` ("none") is a present-but-empty allowlist: everything is
	// filtered out. An absent `skills` field is unrestricted. `compile`
	// collapses empty arrays to `undefined`, so track presence separately.
	const allowGlobs = compile(allowlist);
	const allowlistPresent = allowlist !== undefined;
	const matches = (globs: Array<{ glob: Bun.Glob; pattern: string }> | undefined, name: string): boolean =>
		globs?.some(({ glob }) => glob.match(name)) ?? false;
	return sessionSkills.map(skill => {
		// `unhideSkills` overrides presentation hides (`SKILL.md` `hide: true`)
		// only. A `disableModelInvocation: true` opt-out is never listable via
		// `unhideSkills`, regardless of the skill's current `hide` value — the
		// flag is checked independently so a malformed Skill record (flag set,
		// `hide` falsy) cannot bypass the protection.
		const invocationRevoked = skill.modelInvocationDisabled === true;
		const unhideable = skill.hide === true && !invocationRevoked;
		const listed =
			!matches(denyGlobs, skill.name) &&
			(!allowlistPresent || matches(allowGlobs, skill.name)) &&
			(skill.hide !== true || (unhideable && matches(unhideGlobs, skill.name))) &&
			!invocationRevoked;
		// Always spread-copy: the parent session and the child must not share
		// Skill identities (a child-side in-place mutation would leak back).
		if (listed) {
			return skill.hide === true ? { ...skill, hide: false } : { ...skill };
		}
		return skill.hide === true ? { ...skill } : { ...skill, hide: true };
	});
}

/**
 * Resolve the agent's `autoloadSkills` names against the full unfiltered skill
 * list. A skill hidden from the `<skills>` listing can still be preloaded —
 * except a `disableModelInvocation: true` opt-out, which is never injectable
 * (mirroring the `unhideSkills` rule in {@link resolveAgentSkills}). Unknown
 * names are ignored. Returns copies, never parent session identities.
 */
export function resolveAgentAutoloadSkills(
	sessionSkills: readonly Skill[],
	autoloadSkills: string[] | undefined,
): Skill[] {
	if (!autoloadSkills?.length) return [];
	return autoloadSkills
		.map(name => sessionSkills.find(skill => skill.name === name))
		.filter(skill => skill !== undefined && skill.modelInvocationDisabled !== true)
		.map(skill => ({ ...skill }));
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
