import * as path from "node:path";
import { FileType, type GlobMatch, listWorkspace } from "@oh-my-pi/pi-natives";
import { formatAge, formatBytes } from "@oh-my-pi/pi-utils";

/** Defaults for the workspace tree shown in the system prompt. */
const WORKSPACE_DEFAULTS = {
	maxDepth: 3,
	perDirLimit: 12,
	lineCap: 120,
} as const;

/**
 * Hard cap on AGENTS.md files surfaced by `buildWorkspaceTree`. Mirrors the
 * native cap so the system-prompt builder does not need a second pass.
 */
export const AGENTS_MD_LIMIT = 200;

export interface DirectoryTree {
	rootPath: string;
	rendered: string;
	truncated: boolean;
	totalLines: number;
}

export interface WorkspaceTree extends DirectoryTree {
	/** AGENTS.md files beneath the root whose rules may apply to subdirectories. */
	agentsMdFiles: string[];
}

export interface BuildDirectoryTreeOptions {
	/** Directory depth below the root to include. Root itself is depth 0. Default: 1. */
	maxDepth?: number;
	/** Per-directory child cap. `null` disables the cap. Default: `null`. */
	perDirLimit?: number | null;
	/** Optional override for the root level. Defaults to `perDirLimit`. */
	rootLimit?: number | null;
	/** Hard rendered line cap. `null` disables. Default: `null`. */
	lineCap?: number | null;
}

export interface BuildWorkspaceTreeOptions {
	/** Abort the native workspace scan after this many milliseconds. */
	timeoutMs?: number;
}

/**
 * Build a generic directory tree using a single native scan. Hidden files are
 * shown, .gitignore is not consulted, and the standard non-source directories
 * (`node_modules`, `.git`, build outputs, caches…) are pruned by the native
 * walker. Used by the read tool's directory-listing path.
 */
export async function buildDirectoryTree(cwd: string, options: BuildDirectoryTreeOptions = {}): Promise<DirectoryTree> {
	const rootPath = path.resolve(cwd);
	const maxDepth = options.maxDepth ?? 1;
	const perDirLimit = options.perDirLimit === undefined ? null : options.perDirLimit;
	const rootLimit = options.rootLimit === undefined ? perDirLimit : options.rootLimit;

	let entries: readonly GlobMatch[];
	let nativeTruncated: boolean;
	try {
		const result = await listWorkspace({
			path: rootPath,
			maxDepth,
			hidden: true,
			gitignore: false,
		});
		entries = result.entries;
		nativeTruncated = result.truncated;
	} catch {
		return emptyTree(rootPath);
	}

	return assembleTree(rootPath, entries, {
		perDirLimit,
		rootLimit,
		lineCap: options.lineCap === undefined ? null : options.lineCap,
		nativeTruncated,
		// Tool output (read tool directory listing), not a cached prefix —
		// the human-friendly relative "ago" is appropriate here.
		ageMode: "relative",
	});
}

/**
 * Build the workspace tree shown in the system prompt. Returns the rendered
 * tree plus the AGENTS.md files surfaced by the same native walk so callers
 * never need to do a second filesystem scan.
 */
export async function buildWorkspaceTree(cwd: string, options: BuildWorkspaceTreeOptions = {}): Promise<WorkspaceTree> {
	const rootPath = path.resolve(cwd);
	try {
		const result = await listWorkspace({
			path: rootPath,
			maxDepth: WORKSPACE_DEFAULTS.maxDepth,
			hidden: false,
			gitignore: true,
			collectAgentsMd: true,
			timeoutMs: options.timeoutMs,
		});
		const tree = assembleTree(rootPath, result.entries, {
			perDirLimit: WORKSPACE_DEFAULTS.perDirLimit,
			rootLimit: WORKSPACE_DEFAULTS.perDirLimit,
			lineCap: WORKSPACE_DEFAULTS.lineCap,
			nativeTruncated: result.truncated,
			// This tree is embedded in the cached system prompt. Render absolute
			// mtimes so the block is byte-identical across sessions and does not
			// bust the prompt cache (a relative "Nm ago" drifts every build).
			ageMode: "absolute",
		});
		return { ...tree, agentsMdFiles: result.agentsMdFiles };
	} catch {
		return { ...emptyTree(rootPath), agentsMdFiles: [] };
	}
}

// ─── internals ──────────────────────────────────────────────────────────────

interface Node {
	name: string;
	isDir: boolean;
	mtimeMs: number;
	size: number;
	depth: number;
	children: Node[];
	/** When > 0, `children` is laid out as `[recent…, oldest]`. */
	droppedCount: number;
}

interface RenderedLine {
	label: string;
	depth: number;
	isRoot: boolean;
	size?: string;
	age?: string;
}

interface AssembleOptions {
	perDirLimit: number | null;
	rootLimit: number | null;
	lineCap: number | null;
	nativeTruncated: boolean;
	/**
	 * How per-entry modification times are rendered.
	 * - "relative": render-time "Nm ago" (fine for tool output).
	 * - "absolute": deterministic UTC timestamp (prompt-cache-stable; used for
	 *   the system-prompt workspace tree). See {@link makeAgeFormatter}.
	 */
	ageMode: "relative" | "absolute";
}

function assembleTree(rootPath: string, entries: readonly GlobMatch[], opts: AssembleOptions): DirectoryTree {
	// Bucket entries by parent path. The native walker may yield siblings in
	// any order across worker threads, so we group by string key and sort once
	// per directory below.
	const byParent = new Map<string, Node[]>();
	for (const entry of entries) {
		const slash = entry.path.lastIndexOf("/");
		const name = slash === -1 ? entry.path : entry.path.slice(slash + 1);
		const parentPath = slash === -1 ? "" : entry.path.slice(0, slash);
		const node: Node = {
			name,
			isDir: entry.fileType === FileType.Dir,
			mtimeMs: entry.mtime ?? 0,
			size: entry.size ?? 0,
			depth: parentPath ? parentPath.split("/").length + 1 : 1,
			children: [],
			droppedCount: 0,
		};
		const bucket = byParent.get(parentPath);
		if (bucket) bucket.push(node);
		else byParent.set(parentPath, [node]);
	}

	const root: Node = {
		name: ".",
		isDir: true,
		mtimeMs: 0,
		size: 0,
		depth: 0,
		children: [],
		droppedCount: 0,
	};

	let truncated = opts.nativeTruncated;
	const stack: Array<{ node: Node; relPath: string }> = [{ node: root, relPath: "" }];
	while (stack.length > 0) {
		const { node, relPath } = stack.pop()!;
		const all = (byParent.get(relPath) ?? []).slice().sort(byRecency);
		const limit = node.depth === 0 ? opts.rootLimit : opts.perDirLimit;
		if (limit !== null && all.length > limit) {
			node.children = limit <= 1 ? all.slice(0, Math.max(0, limit)) : [...all.slice(0, limit - 1), all.at(-1)!];
			node.droppedCount = all.length - limit;
			truncated = true;
		} else {
			node.children = all;
		}
		for (const child of node.children) {
			if (!child.isDir) continue;
			stack.push({ node: child, relPath: relPath ? `${relPath}/${child.name}` : child.name });
		}
	}

	const rawLines: RenderedLine[] = [];
	renderNode(root, makeAgeFormatter(opts.ageMode), rawLines);
	const { lines, elidedCount } = applyLineCap(rawLines, opts.lineCap);

	return {
		rootPath,
		rendered: formatLines(lines),
		truncated: truncated || elidedCount > 0,
		totalLines: lines.length,
	};
}

function byRecency(a: Node, b: Node): number {
	return b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name);
}

/**
 * Build the per-node age formatter for a single render pass.
 *
 * - "relative": a render-time "Nm ago" string (computed once from `Date.now()`).
 *   Used for tool output that is not part of any cached prefix.
 * - "absolute": a deterministic UTC `YYYY-MM-DD HH:MM` derived purely from the
 *   file's mtime. Used for the system-prompt workspace tree so the rendered
 *   block stays byte-identical across sessions. A relative age is recomputed on
 *   every build, so two sessions seconds apart differ ("9m ago" → "10m ago");
 *   because KV cache is contextual, that early change invalidates the cache for
 *   everything after the tree — including the multi-thousand-token tool block —
 *   forcing a full prompt re-prefill on every new session. An absolute mtime
 *   only changes when the file itself changes, which is the correct trigger.
 */
function makeAgeFormatter(mode: "relative" | "absolute"): (mtimeMs: number) => string {
	if (mode === "absolute") return formatMtimeStable;
	const nowMs = Date.now();
	return (mtimeMs: number) => formatAge(Math.max(0, Math.floor((nowMs - mtimeMs) / 1000)));
}

/** Deterministic, render-time-independent timestamp: UTC `YYYY-MM-DD HH:MM`. */
function formatMtimeStable(mtimeMs: number): string {
	if (!mtimeMs) return "";
	return new Date(mtimeMs).toISOString().slice(0, 16).replace("T", " ");
}

function renderNode(node: Node, formatNodeAge: (mtimeMs: number) => string, out: RenderedLine[]): void {
	if (node.depth === 0) {
		out.push({ label: node.name, depth: 0, isRoot: true });
	} else {
		const indent = "  ".repeat(node.depth);
		const suffix = node.isDir ? "/" : "";
		out.push({
			label: `${indent}- ${node.name}${suffix}`,
			depth: node.depth,
			isRoot: false,
			size: node.isDir ? undefined : formatBytes(node.size),
			age: formatNodeAge(node.mtimeMs),
		});
	}

	if (node.droppedCount === 0) {
		for (const child of node.children) renderNode(child, formatNodeAge, out);
		return;
	}

	// Layout: recent children, then "… N more" marker, then the oldest child.
	const recent = node.children.slice(0, -1);
	const oldest = node.children.at(-1);
	for (const child of recent) renderNode(child, formatNodeAge, out);
	const childDepth = node.depth + 1;
	out.push({
		label: `${"  ".repeat(childDepth)}- … ${node.droppedCount} more`,
		depth: childDepth,
		isRoot: false,
	});
	if (oldest) renderNode(oldest, formatNodeAge, out);
}

/**
 * Cap the rendered tree at `lineCap` lines by removing the deepest trailing
 * entries first. Root and root children (depth ≤ 1) are always preserved so
 * the structural overview stays intact.
 */
function applyLineCap(
	lines: readonly RenderedLine[],
	lineCap: number | null,
): { lines: RenderedLine[]; elidedCount: number } {
	if (lineCap === null || lines.length <= lineCap) return { lines: [...lines], elidedCount: 0 };

	const PROTECTED_DEPTH = 1;
	const target = Math.max(1, lineCap - 1);
	const removable = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => !line.isRoot && line.depth > PROTECTED_DEPTH)
		.sort((a, b) => b.line.depth - a.line.depth || b.index - a.index)
		.slice(0, lines.length - target);
	if (removable.length === 0) return { lines: [...lines], elidedCount: 0 };

	const removed = new Set(removable.map(item => item.index));
	const kept = lines.filter((_, index) => !removed.has(index));
	kept.push({
		label: `[…${removable.length}ln elided…]`,
		depth: 0,
		isRoot: false,
	});
	return { lines: kept, elidedCount: removable.length };
}

function formatLines(lines: readonly RenderedLine[]): string {
	const maxLabelLength = lines.reduce((max, line) => Math.max(max, line.label.length), 0);
	return lines
		.map(line => {
			if (!line.age) return line.label;
			const sizeColumn = (line.size ?? "").padEnd(8);
			return `${line.label.padEnd(maxLabelLength + 2)}${sizeColumn}  ${line.age.padEnd(4)}`.trimEnd();
		})
		.join("\n");
}

function emptyTree(rootPath: string): DirectoryTree {
	return {
		rootPath,
		rendered: "",
		truncated: false,
		totalLines: 0,
	};
}
