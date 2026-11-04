/**
 * Which reads the agent is likely to edit, for the edit gate (`spotlight.experiment.editGate`): a read of a code file
 * by a main session, or of a file the session had already read or edited.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { resolveToCwd } from "../tools/path-utils";

/** Extensions of the files the gate counts as code (lowercase, with the dot). */
export const CODE_EXTENSIONS: Readonly<Record<string, true>> = {
	".py": true,
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".rs": true,
	".go": true,
	".c": true,
	".cc": true,
	".cpp": true,
	".h": true,
	".hpp": true,
	".cu": true,
	".cuh": true,
	".java": true,
	".kt": true,
	".swift": true,
	".rb": true,
	".zig": true,
	".lua": true,
	".sh": true,
	".css": true,
	".scss": true,
	".html": true,
	".sql": true,
};

/** Tools whose calls edit the files their arguments name. */
export const EDIT_TOOLS: Readonly<Record<string, true>> = { edit: true, write: true, ast_edit: true };

/**
 * The key a read or edit target is tracked by: the path without its read selector (`:10-20`, `:raw`), resolved
 * against the session cwd (`~` expanded); a URL (`artifact://3`) stays as written.
 */
export function targetKey(target: string, cwd: string): string {
	const bare = splitPathAndSel(target.trim()).path;
	try {
		return resolveToCwd(bare, cwd);
	} catch {
		// An internal URL is no file path: it is its own key.
		return bare;
	}
}

/** Whether a tracked target is a code file ({@link CODE_EXTENSIONS}). */
export function isCodeTarget(key: string): boolean {
	return Object.hasOwn(CODE_EXTENSIONS, path.extname(key).toLowerCase());
}

/**
 * The paths an edit-tool call names: the tool's own reading of its arguments when it has one (`edit`'s patch
 * headers), else its `path` or `paths` argument (`write`, `ast_edit`).
 */
export function editTargets(args: unknown, toolPaths: readonly string[] | undefined): string[] {
	if (toolPaths && toolPaths.length > 0) return [...toolPaths];
	if (!isRecord(args)) return [];
	const out: string[] = [];
	if (typeof args.path === "string") out.push(args.path);
	if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string") out.push(p);
	return out;
}
