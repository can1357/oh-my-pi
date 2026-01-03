/**
 * Cline Provider
 *
 * Loads rules from .clinerules (can be single file or directory with *.md files).
 * Project-only (no user-level config).
 */

import { registerProvider } from "../capability/index";
import type { Rule } from "../capability/rule";
import { ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, loadFilesFromDir, parseFrontmatter } from "./helpers";

const PROVIDER_ID = "cline";
const DISPLAY_NAME = "Cline";
const PRIORITY = 40;

/**
 * Load rules from .clinerules
 */
function loadRules(ctx: LoadContext): LoadResult<Rule> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	// Project-level only (Cline uses root-level .clinerules)
	const projectPath = ctx.fs.walkUp(".clinerules");
	if (!projectPath) {
		return { items, warnings };
	}

	// Check if .clinerules is a directory or file
	if (ctx.fs.isDir(projectPath)) {
		// Directory format: load all *.md files
		const result = loadFilesFromDir(ctx, projectPath, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) => {
				const { frontmatter, body } = parseFrontmatter(content);
				const ruleName = name.replace(/\.md$/, "");

				// Parse globs (can be array or single string)
				let globs: string[] | undefined;
				if (Array.isArray(frontmatter.globs)) {
					globs = frontmatter.globs.filter((g): g is string => typeof g === "string");
				} else if (typeof frontmatter.globs === "string") {
					globs = [frontmatter.globs];
				}

				return {
					name: ruleName,
					path,
					content: body,
					globs,
					alwaysApply: typeof frontmatter.alwaysApply === "boolean" ? frontmatter.alwaysApply : undefined,
					description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
					ttsrTrigger: typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined,
					_source: source,
				};
			},
		});

		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	} else if (ctx.fs.isFile(projectPath)) {
		// Single file format
		const content = ctx.fs.readFile(projectPath);
		if (content === null) {
			warnings.push(`Failed to read .clinerules at ${projectPath}`);
			return { items, warnings };
		}

		const { frontmatter, body } = parseFrontmatter(content);
		const source = createSourceMeta(PROVIDER_ID, projectPath, "project");

		// Parse globs (can be array or single string)
		let globs: string[] | undefined;
		if (Array.isArray(frontmatter.globs)) {
			globs = frontmatter.globs.filter((g): g is string => typeof g === "string");
		} else if (typeof frontmatter.globs === "string") {
			globs = [frontmatter.globs];
		}

		items.push({
			name: "clinerules",
			path: projectPath,
			content: body,
			globs,
			alwaysApply: typeof frontmatter.alwaysApply === "boolean" ? frontmatter.alwaysApply : undefined,
			description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
			ttsrTrigger: typeof frontmatter.ttsr_trigger === "string" ? frontmatter.ttsr_trigger : undefined,
			_source: source,
		});
	}

	return { items, warnings };
}

// Register provider
registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .clinerules (single file or directory)",
	priority: PRIORITY,
	load: loadRules,
});
