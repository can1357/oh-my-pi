/**
 * AGENTS.md Provider
 *
 * Discovers standalone AGENTS.md files by walking up from cwd.
 * This handles AGENTS.md files that live in project root (not in config directories
 * like .codex/ or .gemini/, which are handled by their respective providers).
 */
import * as path from "node:path";
import { registerProvider } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import { readFile } from "../capability/fs";
import type { LoadContext, LoadResult } from "../capability/types";
import { calculateDepth, createSourceMeta } from "./helpers";

const PROVIDER_ID = "agents-md";
const DISPLAY_NAME = "AGENTS.md";

/**
 * Load standalone AGENTS.md files.
 */
async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	// Walk up from cwd looking for AGENTS.md files
	let current = ctx.cwd;

	while (true) {
		const candidate = path.join(current, "AGENTS.md");
		const content = await readFile(candidate);

		if (content !== null) {
			const parent = path.dirname(candidate);
			const baseName = parent.split(path.sep).pop() ?? "";

			if (!baseName.startsWith(".")) {
				const fileDir = path.dirname(candidate);
				const calculatedDepth = calculateDepth(ctx.cwd, fileDir);

				items.push({
					path: candidate,
					content,
					level: "project",
					depth: calculatedDepth,
					_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
				});
			}
		}

		if (current === (ctx.repoRoot ?? ctx.home)) break; // scanned repo root or home, stop

		// Move to parent directory
		const parent = path.dirname(current);
		if (parent === current) break; // Reached filesystem root
		current = parent;
	}

	return { items, warnings };
}

registerProvider(contextFileCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Standalone AGENTS.md files (Codex/Gemini style)",
	priority: 10,
	load: loadAgentsMd,
});
