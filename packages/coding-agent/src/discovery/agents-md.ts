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
 * Compare paths while tolerating Windows drive casing.
 */
function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

/**
 * Return whether `child` is at or below `parent`.
 */
function isWithin(parent: string, child: string): boolean {
	const normalizedParent = path.resolve(parent);
	const normalizedChild = path.resolve(child);
	const relative = path.relative(
		process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent,
		process.platform === "win32" ? normalizedChild.toLowerCase() : normalizedChild,
	);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Load standalone AGENTS.md files.
 *
 * When a repository is nested below the user's home directory, continue past
 * the Git root to discover workspace-level AGENTS.md files, but stop before
 * loading the home directory's own AGENTS.md as project context.
 */
export async function loadAgentsMd(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];
	const home = path.resolve(ctx.home);
	const cwd = path.resolve(ctx.cwd);
	const repoRoot = ctx.repoRoot ? path.resolve(ctx.repoRoot) : null;
	const filesystemRoot = path.parse(cwd).root;
	const cwdIsUnderHome = isWithin(home, cwd);
	const repoIsUnderHome = repoRoot !== null && isWithin(home, repoRoot);
	const scanToHome = repoRoot !== null && cwdIsUnderHome && repoIsUnderHome;
	const boundary = scanToHome ? home : (repoRoot ?? (cwdIsUnderHome ? home : filesystemRoot));
	const includeBoundary = repoRoot === null ? cwdIsUnderHome : !samePath(boundary, home);
	const excludeHome = scanToHome;

	let current = cwd;
	while (true) {
		const atBoundary = samePath(current, boundary);
		const atHome = excludeHome && samePath(current, home);
		if (!(atHome || (atBoundary && !includeBoundary))) {
			const candidate = path.join(current, "AGENTS.md");
			const content = await readFile(candidate);

			if (content !== null) {
				const parent = path.dirname(candidate);
				const baseName = parent.split(path.sep).pop() ?? "";

				if (!baseName.startsWith(".")) {
					const fileDir = path.dirname(candidate);
					const calculatedDepth = calculateDepth(cwd, fileDir, path.sep);

					items.push({
						path: candidate,
						content,
						level: "project",
						depth: calculatedDepth,
						_source: createSourceMeta(PROVIDER_ID, candidate, "project"),
					});
				}
			}
		}
		if (atBoundary) break;

		const parent = path.dirname(current);
		if (parent === current) break;
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
