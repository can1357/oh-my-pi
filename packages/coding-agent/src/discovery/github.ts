/**
 * GitHub Copilot Provider
 *
 * Loads configuration from GitHub Copilot's config directories.
 * Priority: 30 (shared standard provider)
 *
 * Sources:
 * - Project: .github/ (repo-local Copilot config)
 * - User: ~/.copilot/ (user-global Copilot CLI config; relocatable via COPILOT_HOME)
 * - Extra: directories listed in COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 *
 * Capabilities:
 * - context-files: copilot-instructions.md in .github/ and ~/.copilot/; AGENTS.md in each COPILOT_CUSTOM_INSTRUCTIONS_DIRS
 * - rules: *.instructions.md under .github/instructions/ and <dir>/.github/instructions/ for each custom dir (applyTo frontmatter)
 * - prompts: *.prompt.md in .github/prompts/ (VS Code Copilot prompt files)
 * - skills: <name>/SKILL.md in .github/skills/ (GitHub Agent Skills layout)
 */
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled, registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import { type Instruction, instructionCapability } from "../capability/instruction";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";

import {
	buildRuleFromMarkdown,
	calculateDepth,
	createSourceMeta,
	getProjectPath,
	loadFilesFromDir,
	parseCSV,
	resolveCopilotHome,
	scanSkillsFromDir,
} from "./helpers";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

// =============================================================================
// Context Files
// =============================================================================

async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const copilotInstructionsPath = getProjectPath(ctx, "github", "copilot-instructions.md");
	if (copilotInstructionsPath) {
		const content = await readFile(copilotInstructionsPath);
		if (content) {
			const fileDir = path.dirname(copilotInstructionsPath);
			const depth = calculateDepth(ctx.cwd, fileDir, path.sep);

			items.push({
				path: copilotInstructionsPath,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, copilotInstructionsPath, "project"),
			});
		}
	}

	// User-global instructions (~/.copilot/copilot-instructions.md), applied across all repos.
	if (isUserSourceEnabled("github", ctx)) {
		const userInstructionsPath = path.join(resolveCopilotHome(ctx.home), "copilot-instructions.md");
		const userContent = await readFile(userInstructionsPath);
		if (userContent) {
			items.push({
				path: userInstructionsPath,
				content: userContent,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, userInstructionsPath, "user"),
			});
		}
	}

	// Each COPILOT_CUSTOM_INSTRUCTIONS_DIRS entry contributes an AGENTS.md (Copilot CLI
	// searches these dirs for AGENTS.md + .github/instructions/**; the latter is handled
	// by loadInstructions). copilot-instructions.md is NOT part of the custom-dir spec.
	for (const dir of copilotCustomInstructionDirs()) {
		const agentsMdPath = path.join(dir, "AGENTS.md");
		const agentsMdContent = await readFile(agentsMdPath);
		if (agentsMdContent) {
			items.push({
				path: agentsMdPath,
				content: agentsMdContent,
				level: "user",
				_source: createSourceMeta(PROVIDER_ID, agentsMdPath, "user"),
			});
		}
	}
	return { items, warnings };
}

// =============================================================================
// Instructions
// =============================================================================

async function loadInstructions(ctx: LoadContext): Promise<LoadResult<Instruction>> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	const instructionsDir = getProjectPath(ctx, "github", "instructions");
	if (instructionsDir) {
		// Path-specific instructions live "within or below" .github/instructions/ → recurse.
		const result = await loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformInstruction,
			recursive: true,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	// Each COPILOT_CUSTOM_INSTRUCTIONS_DIRS entry contributes <dir>/.github/instructions/**/*.instructions.md.
	for (const dir of copilotCustomInstructionDirs()) {
		const customInstructionsDir = path.join(dir, ".github", "instructions");
		const result = await loadFilesFromDir<Instruction>(ctx, customInstructionsDir, PROVIDER_ID, "user", {
			extensions: ["md"],
			transform: transformInstruction,
			recursive: true,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformInstruction(name: string, content: string, filePath: string, source: SourceMeta): Instruction | null {
	// Only process .instructions.md files
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });

	// Extract applyTo glob pattern from frontmatter
	const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : undefined;

	// Derive name from filename (strip .instructions.md suffix)
	const instructionName = path.basename(name, ".instructions.md");

	return {
		name: instructionName,
		path: filePath,
		content: body,
		applyTo,
		_source: source,
	};
}

// =============================================================================
// Rules
// =============================================================================

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	const load = async (dir: string, level: "user" | "project") => {
		const applyToWarnings: string[] = [];
		const result = await loadFilesFromDir<Rule>(ctx, dir, PROVIDER_ID, level, {
			extensions: ["md"],
			transform: (name, content, filePath, source) =>
				transformInstructionRule(name, content, filePath, source, applyToWarnings),
			recursive: true,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
		warnings.push(...applyToWarnings);
	};

	const instructionsDir = getProjectPath(ctx, "github", "instructions");
	if (instructionsDir) {
		await load(instructionsDir, "project");
	}

	for (const dir of copilotCustomInstructionDirs()) {
		await load(path.join(dir, ".github", "instructions"), "user");
	}

	return { items, warnings };
}

function transformInstructionRule(
	name: string,
	content: string,
	filePath: string,
	source: SourceMeta,
	warnings: string[],
): Rule | null {
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter } = parseFrontmatter(content, { source: filePath });
	const applyToGlobs = normalizeApplyToGlobs(frontmatter.applyTo);
	if (!applyToGlobs) {
		warnings.push(`Missing applyTo in ${filePath}; loaded without GitHub glob scoping.`);
	}

	const rule = buildRuleFromMarkdown(name, content, filePath, source, {
		stripNamePattern: /\.instructions\.md$/,
	});
	if (applyToGlobs?.some(isAlwaysApplyGlob)) {
		return { ...rule, alwaysApply: true, globs: undefined };
	}

	const description = rule.description ?? describeInstructionRule(applyToGlobs);
	return { ...rule, alwaysApply: false, globs: applyToGlobs, description };
}

function normalizeApplyToGlobs(value: unknown): string[] | undefined {
	// GitHub documents applyTo as a single comma-separated string (e.g.
	// "**/*.ts,**/*.tsx"); also tolerate a YAML array of such strings.
	const raw = Array.isArray(value) ? value : [value];
	const globs = raw.flatMap(item => (typeof item === "string" ? parseCSV(item) : []));
	return globs.length > 0 ? globs : undefined;
}

function isAlwaysApplyGlob(glob: string): boolean {
	// GitHub treats "*", "**", and "**/*" as matching every file.
	return glob === "*" || glob === "**" || glob === "**/*";
}

function describeInstructionRule(globs: string[] | undefined): string {
	if (!globs) return "GitHub Copilot instructions without applyTo metadata";
	return `GitHub Copilot instructions for ${globs.join(", ")}`;
}

// =============================================================================
// Prompts
// =============================================================================

async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	// `.github/prompts/*.prompt.md` is the VS Code Copilot prompt-file convention (the
	// Copilot CLI has no prompt-file feature of its own); surface them as slash commands.
	const promptsDir = getProjectPath(ctx, "github", "prompts");
	if (!promptsDir) return { items: [], warnings: [] };

	return loadFilesFromDir<Prompt>(ctx, promptsDir, PROVIDER_ID, "project", {
		extensions: ["md"],
		transform: transformPrompt,
	});
}

function transformPrompt(name: string, content: string, filePath: string, source: SourceMeta): Prompt | null {
	// Prompt files are `*.prompt.md`; ignore other markdown that may share the dir.
	if (!name.endsWith(".prompt.md")) return null;

	const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
	const promptName =
		typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : path.basename(name, ".prompt.md");

	return { name: promptName, path: filePath, content: body, _source: source };
}

/** Directories listed in the COPILOT_CUSTOM_INSTRUCTIONS_DIRS env var (comma-separated). */
function copilotCustomInstructionDirs(): string[] {
	const raw = process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
	return raw ? parseCSV(raw) : [];
}

// =============================================================================
// Skills
// =============================================================================

/**
 * Load skills from `.github/skills/<name>/SKILL.md`.
 *
 * GitHub documents this layout for Copilot Agent Skills and matches the
 * non-recursive shape `scanSkillsFromDir` already expects. `requireDescription`
 * is on to match the Agent Skills spec (name + description are mandatory) and
 * the sibling `native`/`omp-plugins` providers.
 *
 * @see https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
 */
async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const skillsDir = getProjectPath(ctx, "github", "skills");
	if (!skillsDir) return { items: [], warnings: [] };

	return scanSkillsFromDir(ctx, {
		dir: skillsDir,
		providerId: PROVIDER_ID,
		level: "project",
		requireDescription: true,
	});
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description:
		"Load copilot-instructions.md from .github/ and ~/.copilot/; AGENTS.md from COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ and COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
	priority: PRIORITY,
	load: loadInstructions,
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ as Copilot-scoped rules",
	priority: PRIORITY,
	load: loadRules,
});
registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from .github/skills/*/SKILL.md",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.prompt.md from .github/prompts/ (VS Code Copilot prompt files)",
	priority: PRIORITY,
	load: loadPrompts,
});
