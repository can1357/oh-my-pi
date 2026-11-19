/**
 * Cline Provider
 *
 * Loads rules from .clinerules (can be single file or directory with *.md files).
 * Project-only (no user-level config).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { readDirEntries, readFile } from "../capability/fs";
import type { Rule } from "../capability/rule";
import { ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { createSourceMeta, discoverRuleFromMarkdown, loadFilesFromDir } from "./helpers";

const PROVIDER_ID = "cline";
const DISPLAY_NAME = "Cline";
const PRIORITY = 40;

async function findClinerules(startDir: string): Promise<{ path: string; isDir: boolean } | null> {
	let current = path.resolve(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === ".clinerules");
		if (entry) {
			return {
				path: path.resolve(current, ".clinerules"),
				isDir: entry.isDirectory(),
			};
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Load rules from .clinerules
 */
async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const items: Rule[] = [];
	const warnings: string[] = [];

	// Project-level only (Cline uses root-level .clinerules)
	const found = await findClinerules(ctx.cwd);
	if (!found) {
		return { items, warnings };
	}

	// Check if .clinerules is a directory or file
	if (found.isDir) {
		// Directory format: load all *.md files
		const result = await loadFilesFromDir(ctx, found.path, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: (name, content, path, source) =>
				discoverRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.md$/ }),
		});

		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	} else {
		// Single file format
		const content = await readFile(found.path);
		if (content === null) {
			warnings.push(`Failed to read .clinerules at ${found.path}`);
			return { items, warnings };
		}

		const source = createSourceMeta(PROVIDER_ID, found.path, "project");
		const rule = discoverRuleFromMarkdown("clinerules.md", content, found.path, source, { ruleName: "clinerules" });
		if (rule) items.push(rule);
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
