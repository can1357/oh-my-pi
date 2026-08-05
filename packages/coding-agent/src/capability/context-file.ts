/**
 * Context Files Capability
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 */
import * as path from "node:path";
import { defineCapability } from ".";
import type { LoadContext, SourceMeta } from "./types";

/**
 * A context file that provides persistent instructions to the agent.
 */
export interface ContextFile {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/** Which level this came from */
	level: "user" | "project";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	depth?: number;
	/** Source metadata */
	_source: SourceMeta;
}

function relativeTo(root: string, filePath: string): string | undefined {
	const rel = path.relative(root, filePath);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
	return rel.split(path.sep).join("/");
}

/**
 * Scope-stable identity for a context file: `./`-prefixed repo-relative inside a
 * repository, `~/`-relative under home, absolute otherwise. Keeps ids portable
 * across checkouts while still distinguishing same-named files, and always
 * yields a path-shaped scope so it can never collide with a legacy basename id.
 */
function extensionScope(file: ContextFile, ctx: LoadContext): string {
	const fromRepo = ctx.repoRoot ? relativeTo(ctx.repoRoot, file.path) : undefined;
	if (fromRepo) return `./${fromRepo}`;
	const fromHome = relativeTo(ctx.home, file.path);
	if (fromHome) return `~/${fromHome}`;
	return file.path.split(path.sep).join("/");
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	// Deduplicate by scope: one user-level file, and one project-level file per directory depth.
	// Within each depth level, higher-priority providers shadow lower-priority ones.
	// This supports monorepo hierarchies where AGENTS.md exists at multiple ancestor levels.
	// Clamp depth >= 0: files inside config subdirectories of an ancestor (e.g. .claude/, .github/)
	// are same-scope as the ancestor itself.
	key: file => (file.level === "user" ? "user" : `project:${Math.max(0, file.depth ?? 0)}`),
	// Path-qualified: keying by basename alone made one disabled id suppress
	// EVERY same-named file at that level (disabling one project's AGENTS.md
	// silently disabled all of them).
	toExtensionId: (file, ctx) => `context-file:${file.level}:${extensionScope(file, ctx)}`,
	// Entries persisted before the path-qualified format used the basename form.
	// Keep honouring them — dropping the legacy key would silently re-enable
	// files users deliberately disabled. Legacy entries retain the old collision
	// behaviour (they match by basename); only new disables are precise.
	toLegacyExtensionIds: file => [`context-file:${file.level}:${path.basename(file.path)}`],
	validate: file => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project") return "Invalid level: must be 'user' or 'project'";
		return undefined;
	},
});
