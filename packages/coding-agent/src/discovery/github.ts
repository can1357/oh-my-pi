/**
 * GitHub Copilot Provider
 *
 * Loads configuration from GitHub Copilot's config directories.
 * Priority: 30 (shared standard provider)
 *
 * Sources:
 * - Project: .github/ (project-only, no user-level discovery)
 *
 * Capabilities:
 * - context-files: copilot-instructions.md in .github/
 * - instructions: *.instructions.md in .github/instructions/ with applyTo frontmatter
 */

import { basename, dirname, sep } from "node:path";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { registerProvider } from "../capability/index";
import { type Instruction, instructionCapability } from "../capability/instruction";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { calculateDepth, createSourceMeta, getProjectPath, loadFilesFromDir, parseFrontmatter } from "./helpers";

const PROVIDER_ID = "github";
const DISPLAY_NAME = "GitHub Copilot";
const PRIORITY = 30;

// =============================================================================
// Context Files
// =============================================================================

function loadContextFiles(ctx: LoadContext): LoadResult<ContextFile> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// Project-level: .github/copilot-instructions.md
	const copilotInstructionsPath = getProjectPath(ctx, "github", "copilot-instructions.md");
	if (copilotInstructionsPath && ctx.fs.isFile(copilotInstructionsPath)) {
		const content = ctx.fs.readFile(copilotInstructionsPath);
		if (content) {
			const fileDir = dirname(copilotInstructionsPath);
			const depth = calculateDepth(ctx.cwd, fileDir, sep);

			items.push({
				path: copilotInstructionsPath,
				content,
				level: "project",
				depth,
				_source: createSourceMeta(PROVIDER_ID, copilotInstructionsPath, "project"),
			});
		} else {
			warnings.push(`Failed to read ${copilotInstructionsPath}`);
		}
	}

	return { items, warnings };
}

// =============================================================================
// Instructions
// =============================================================================

function loadInstructions(ctx: LoadContext): LoadResult<Instruction> {
	const items: Instruction[] = [];
	const warnings: string[] = [];

	// Project-level: .github/instructions/*.instructions.md
	const instructionsDir = getProjectPath(ctx, "github", "instructions");
	if (instructionsDir && ctx.fs.isDir(instructionsDir)) {
		const result = loadFilesFromDir<Instruction>(ctx, instructionsDir, PROVIDER_ID, "project", {
			extensions: ["md"],
			transform: transformInstruction,
		});
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}

	return { items, warnings };
}

function transformInstruction(name: string, content: string, path: string, source: SourceMeta): Instruction | null {
	// Only process .instructions.md files
	if (!name.endsWith(".instructions.md")) {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(content);

	// Extract applyTo glob pattern from frontmatter
	const applyTo = typeof frontmatter.applyTo === "string" ? frontmatter.applyTo : undefined;

	// Derive name from filename (strip .instructions.md suffix)
	const instructionName = basename(name, ".instructions.md");

	return {
		name: instructionName,
		path,
		content: body,
		applyTo,
		_source: source,
	};
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load copilot-instructions.md from .github/",
	priority: PRIORITY,
	load: loadContextFiles,
});

registerProvider(instructionCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load *.instructions.md from .github/instructions/ with applyTo frontmatter",
	priority: PRIORITY,
	load: loadInstructions,
});
