/**
 * Agents (standard) Provider
 *
 * Loads skills, rules, prompts, commands, context files, and system prompts
 * from .agent/ and .agents/ directories at both user (~/) and project levels.
 * Project-level discovery walks up from cwd to repoRoot.
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type SystemPrompt, systemPromptCapability } from "../capability/system-prompt";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildRuleFromMarkdown,
	calculateDepth,
	createSourceMeta,
	loadFilesFromDir,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "agents";
const DISPLAY_NAME = "Agents (standard)";
const PRIORITY = 70;
const AGENT_DIR_CANDIDATES = [".agent", ".agents"] as const;

/** User-level paths: ~/.agent/<segments> and ~/.agents/<segments>. */
function getUserPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
	return AGENT_DIR_CANDIDATES.map(baseDir => path.join(ctx.home, baseDir, ...segments));
}

/**
 * Project-level paths: walk up from cwd to repoRoot, returning `.agent/<segments>`
 * and `.agents/<segments>` at each ancestor.
 *
 * The user home directory is skipped: `~/.agent[s]/` is by definition
 * user-level config and is already enumerated by {@link getUserPathCandidates}.
 * Without this guard, any cwd under `$HOME` (with no closer git repoRoot) would
 * walk up to home and yield duplicate project+user entries for the same
 * directory — see https://github.com/can1357/oh-my-pi/issues/1116.
 */
export function getProjectPathCandidates(ctx: LoadContext, ...segments: string[]): string[] {
	const paths: string[] = [];
	let current = ctx.cwd;
	while (true) {
		if (current !== ctx.home) {
			for (const baseDir of AGENT_DIR_CANDIDATES) {
				paths.push(path.join(current, baseDir, ...segments));
			}
		}
		if (current === (ctx.repoRoot ?? ctx.home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return paths;
}

// Skills
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const projectScans = getProjectPathCandidates(ctx, "skills").map(dir =>
		scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "project" }),
	);
	const userScans = getUserPathCandidates(ctx, "skills").map(dir =>
		scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "user" }),
	);

	const results = await Promise.all([...projectScans, ...userScans]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .agent/skills and .agents/skills (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSkills,
});

// Rules
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<Rule>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md", "mdc"],
			transform: (name, content, filePath, source) =>
				buildRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "rules").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "rules").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .agent/rules and .agents/rules (project walk-up + user home)",
	priority: PRIORITY,
	load: loadRules,
});

// Prompts
async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<Prompt>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) => ({
				name: name.replace(/\.md$/, ""),
				path: filePath,
				content,
				_source: source,
			}),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "prompts").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "prompts").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load prompts from .agent/prompts and .agents/prompts (project walk-up + user home)",
	priority: PRIORITY,
	load: loadPrompts,
});

// Slash Commands
async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const load = (dir: string, level: "user" | "project") =>
		loadFilesFromDir<SlashCommand>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) => ({
				name: name.replace(/\.md$/, ""),
				path: filePath,
				content,
				level,
				_source: source,
			}),
		});

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "commands").map(dir => load(dir, "project")),
		...getUserPathCandidates(ctx, "commands").map(dir => load(dir, "user")),
	]);

	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load commands from .agent/commands and .agents/commands (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSlashCommands,
});

// Context Files (AGENTS.md)
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const load = async (filePath: string, level: "user" | "project"): Promise<ContextFile | null> => {
		const content = await readFile(filePath);
		if (!content) return null;
		// filePath is <ancestor>/.agent(s)/AGENTS.md — go up past the config dir to the ancestor
		const ancestorDir = path.dirname(path.dirname(filePath));
		const depth = level === "project" ? calculateDepth(ctx.cwd, ancestorDir) : undefined;
		return { path: filePath, content, level, depth, _source: createSourceMeta(PROVIDER_ID, filePath, level) };
	};

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "AGENTS.md").map(p => load(p, "project")),
		...getUserPathCandidates(ctx, "AGENTS.md").map(p => load(p, "user")),
	]);

	return { items: results.filter((r): r is ContextFile => r !== null), warnings: [] };
}

registerProvider<ContextFile>(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load AGENTS.md from .agent and .agents (project walk-up + user home)",
	priority: PRIORITY,
	load: loadContextFiles,
});

// System Prompt (SYSTEM.md)
async function loadSystemPrompt(ctx: LoadContext): Promise<LoadResult<SystemPrompt>> {
	const load = async (filePath: string, level: "user" | "project"): Promise<SystemPrompt | null> => {
		const content = await readFile(filePath);
		if (!content) return null;
		return { path: filePath, content, level, _source: createSourceMeta(PROVIDER_ID, filePath, level) };
	};

	const results = await Promise.all([
		...getProjectPathCandidates(ctx, "SYSTEM.md").map(p => load(p, "project")),
		...getUserPathCandidates(ctx, "SYSTEM.md").map(p => load(p, "user")),
	]);

	return { items: results.filter((r): r is SystemPrompt => r !== null), warnings: [] };
}

registerProvider<SystemPrompt>(systemPromptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load SYSTEM.md from .agent and .agents (project walk-up + user home)",
	priority: PRIORITY,
	load: loadSystemPrompt,
});
