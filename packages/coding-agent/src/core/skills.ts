import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { minimatch } from "minimatch";
import { skillCapability } from "../capability/skill";
import type { SourceMeta } from "../capability/types";
import type { Skill as CapabilitySkill, SkillFrontmatter as ImportedSkillFrontmatter } from "../discovery";
import { loadSync } from "../discovery";
import { parseFrontmatter } from "../discovery/helpers";
import type { SkillsSettings } from "./settings-manager";

// Re-export SkillFrontmatter for backward compatibility
export type { ImportedSkillFrontmatter as SkillFrontmatter };

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	/** Source metadata for display */
	_source?: SourceMeta;
}

export interface SkillWarning {
	skillPath: string;
	message: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	warnings: SkillWarning[];
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

/**
 * Load skills from a directory recursively.
 * Skills are directories containing a SKILL.md file with frontmatter including a description.
 * @deprecated Use loadSync("skills") from discovery API instead
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const skills: Skill[] = [];
	const warnings: SkillWarning[] = [];
	const seenPaths = new Set<string>();

	function addSkill(skillFile: string, skillDir: string, dirName: string) {
		if (seenPaths.has(skillFile)) return;
		try {
			const content = readFileSync(skillFile, "utf-8");
			const { frontmatter } = parseFrontmatter(content);
			const name = (frontmatter.name as string) || dirName;
			const description = frontmatter.description as string;

			if (description) {
				seenPaths.add(skillFile);
				skills.push({
					name,
					description,
					filePath: skillFile,
					baseDir: skillDir,
					source: options.source,
				});
			}
		} catch {
			// Skip invalid skills
		}
	}

	function scanDir(dir: string) {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) {
					const skillFile = join(fullPath, "SKILL.md");
					try {
						const stat = statSync(skillFile);
						if (stat.isFile()) {
							addSkill(skillFile, fullPath, entry.name);
						}
					} catch {
						// No SKILL.md in this directory
					}
					scanDir(fullPath);
				} else if (entry.isFile() && entry.name === "SKILL.md") {
					addSkill(fullPath, dir, basename(dir));
				}
			}
		} catch (err) {
			warnings.push({ skillPath: dir, message: `Failed to read directory: ${err}` });
		}
	}

	scanDir(options.dir);

	return { skills, warnings };
}

/**
 * Scan a directory for SKILL.md files recursively.
 * Used internally by loadSkills for custom directories.
 */
function scanDirectoryForSkills(dir: string): LoadSkillsResult {
	const skills: Skill[] = [];
	const warnings: SkillWarning[] = [];
	const seenPaths = new Set<string>();

	function addSkill(skillFile: string, skillDir: string, dirName: string) {
		if (seenPaths.has(skillFile)) return;
		try {
			const content = readFileSync(skillFile, "utf-8");
			const { frontmatter } = parseFrontmatter(content);
			const name = (frontmatter.name as string) || dirName;
			const description = frontmatter.description as string;

			if (description) {
				seenPaths.add(skillFile);
				skills.push({
					name,
					description,
					filePath: skillFile,
					baseDir: skillDir,
					source: "custom",
				});
			}
		} catch {
			// Skip invalid skills
		}
	}

	function scanDir(currentDir: string) {
		try {
			const entries = readdirSync(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

				const fullPath = join(currentDir, entry.name);
				if (entry.isDirectory()) {
					const skillFile = join(fullPath, "SKILL.md");
					try {
						const stat = statSync(skillFile);
						if (stat.isFile()) {
							addSkill(skillFile, fullPath, entry.name);
						}
					} catch {
						// No SKILL.md in this directory
					}
					scanDir(fullPath);
				} else if (entry.isFile() && entry.name === "SKILL.md") {
					addSkill(fullPath, currentDir, basename(currentDir));
				}
			}
		} catch (err) {
			warnings.push({ skillPath: currentDir, message: `Failed to read directory: ${err}` });
		}
	}

	scanDir(dir);

	return { skills, warnings };
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	if (skills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
	];

	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions extends SkillsSettings {
	/** Working directory for project-local skills. Default: process.cwd() */
	cwd?: string;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation warnings.
 */
export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
	const {
		cwd = process.cwd(),
		enabled = true,
		enableCodexUser = true,
		enableClaudeUser = true,
		enableClaudeProject = true,
		enablePiUser = true,
		enablePiProject = true,
		customDirectories = [],
		ignoredSkills = [],
		includeSkills = [],
	} = options;

	// Early return if skills are disabled
	if (!enabled) {
		return { skills: [], warnings: [] };
	}

	// Helper to check if a source is enabled
	function isSourceEnabled(source: SourceMeta): boolean {
		const { provider, level } = source;
		if (provider === "codex" && level === "user") return enableCodexUser;
		if (provider === "claude" && level === "user") return enableClaudeUser;
		if (provider === "claude" && level === "project") return enableClaudeProject;
		if (provider === "native" && level === "user") return enablePiUser;
		if (provider === "native" && level === "project") return enablePiProject;
		// For other providers (gemini, cursor, etc.) or custom, default to enabled
		return true;
	}

	// Use capability API to load all skills
	const result = loadSync<CapabilitySkill>(skillCapability.id, { cwd });

	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const collisionWarnings: SkillWarning[] = [];

	// Check if skill name matches any of the include patterns
	function matchesIncludePatterns(name: string): boolean {
		if (includeSkills.length === 0) return true;
		return includeSkills.some((pattern) => minimatch(name, pattern));
	}

	// Check if skill name matches any of the ignore patterns
	function matchesIgnorePatterns(name: string): boolean {
		if (ignoredSkills.length === 0) return false;
		return ignoredSkills.some((pattern) => minimatch(name, pattern));
	}

	// Helper to add a skill to the map
	function addSkill(capSkill: CapabilitySkill, sourceProvider: string) {
		// Apply ignore filter (glob patterns) - takes precedence over include
		if (matchesIgnorePatterns(capSkill.name)) {
			return;
		}
		// Apply include filter (glob patterns)
		if (!matchesIncludePatterns(capSkill.name)) {
			return;
		}

		// Resolve symlinks to detect duplicate files
		let realPath: string;
		try {
			realPath = realpathSync(capSkill.path);
		} catch {
			realPath = capSkill.path;
		}

		// Skip silently if we've already loaded this exact file (via symlink)
		if (realPathSet.has(realPath)) {
			return;
		}

		const existing = skillMap.get(capSkill.name);
		if (existing) {
			collisionWarnings.push({
				skillPath: capSkill.path,
				message: `name collision: "${capSkill.name}" already loaded from ${existing.filePath}, skipping this one`,
			});
		} else {
			// Transform capability skill to legacy format
			const skill: Skill = {
				name: capSkill.name,
				description: capSkill.frontmatter?.description || "",
				filePath: capSkill.path,
				baseDir: capSkill.path.replace(/\/SKILL\.md$/, ""),
				source: `${sourceProvider}:${capSkill.level}`,
				_source: capSkill._source,
			};
			skillMap.set(capSkill.name, skill);
			realPathSet.add(realPath);
		}
	}

	// Process skills from capability API
	for (const capSkill of result.items) {
		// Check if this source is enabled
		if (!isSourceEnabled(capSkill._source)) {
			continue;
		}

		addSkill(capSkill, capSkill._source.provider);
	}

	// Process custom directories - scan directly without using full provider system
	for (const dir of customDirectories) {
		const customSkills = scanDirectoryForSkills(dir);
		for (const s of customSkills.skills) {
			// Convert to capability format for addSkill processing
			const capSkill: CapabilitySkill = {
				name: s.name,
				path: s.filePath,
				content: "",
				frontmatter: { description: s.description },
				level: "user",
				_source: {
					provider: "custom",
					providerName: "Custom",
					path: s.filePath,
					level: "user",
				},
			};
			addSkill(capSkill, "custom");
		}
		for (const warning of customSkills.warnings) {
			collisionWarnings.push(warning);
		}
	}

	return {
		skills: Array.from(skillMap.values()),
		warnings: [...result.warnings.map((w) => ({ skillPath: "", message: w })), ...collisionWarnings],
	};
}
