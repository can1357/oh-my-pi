/**
 * Multi-level path tree shared by grouped file listings (find / grep / ast tools)
 * and compaction file-operation lists.
 *
 * Flat path lists used to group by the *immediate* parent directory and print the
 * full directory path in every header. For results spread across a deep tree — or
 * rooted outside cwd, where paths stay absolute — that repeated the shared prefix
 * on every line. The tree below folds single-child directory chains (so the common
 * prefix collapses into one header) and nests the rest, charging the model one
 * token per path segment instead of one per file.
 */

const URL_LIKE_PATH_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** True for `scheme://…` entries that have no meaningful directory structure. */
export function isUrlLikePath(filePath: string): boolean {
	return URL_LIKE_PATH_RE.test(filePath);
}

export interface PathTreeNode {
	/** Direct file leaves, in first-seen order. */
	files: Array<{ name: string; key: string }>;
	/** Dedup set for `files` (a glob can surface the same path twice on retry). */
	fileNames: Set<string>;
	/** Child directories, in first-seen order. */
	subdirs: Array<{ name: string; node: PathTreeNode }>;
	/** Dedup index for `subdirs`. */
	dirIndex: Map<string, PathTreeNode>;
}

export interface PathTreeInput {
	/** Path string; absolute, cwd-relative, or url-like. Backslashes are normalized. */
	path: string;
	/** Whether the leaf itself is a directory (trailing-slash match from find). */
	isDir: boolean;
	/** Opaque key carried onto file events for section lookup. Defaults to `path`. */
	key?: string;
}

/** One node emitted while walking the tree: a folded directory or a file leaf. */
export interface GroupedTreeEvent {
	kind: "dir" | "file";
	/** 0-based nesting depth (root children are depth 0). */
	depth: number;
	/** Folded chain for dirs (e.g. `a/b/c`, no trailing slash); basename for files. */
	name: string;
	/** File key for `kind === "file"`; empty string for directories. */
	key: string;
}

function createNode(): PathTreeNode {
	return { files: [], fileNames: new Set(), subdirs: [], dirIndex: new Map() };
}

function addFile(node: PathTreeNode, name: string, key: string): void {
	if (node.fileNames.has(name)) return;
	node.fileNames.add(name);
	node.files.push({ name, key });
}

/**
 * Build a directory tree from a flat list of paths. URL-like entries are kept
 * whole as root-level file leaves (they have no meaningful directory structure).
 * Absolute paths carry a leading empty segment so they share a common `/` root
 * and fold like any other prefix.
 */
export function buildPathTree(entries: Iterable<PathTreeInput>): PathTreeNode {
	const root = createNode();
	for (const { path: rawPath, isDir, key } of entries) {
		const normalized = rawPath.replace(/\\/g, "/");
		const fileKey = key ?? rawPath;
		if (isUrlLikePath(normalized)) {
			addFile(root, normalized, fileKey);
			continue;
		}
		const trimmed = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
		if (trimmed.length === 0) continue;
		const segments = trimmed.split("/");
		const dirCount = isDir ? segments.length : segments.length - 1;
		let node = root;
		for (let i = 0; i < dirCount; i++) {
			const segment = segments[i]!;
			let child = node.dirIndex.get(segment);
			if (!child) {
				child = createNode();
				node.dirIndex.set(segment, child);
				node.subdirs.push({ name: segment, node: child });
			}
			node = child;
		}
		if (!isDir) {
			addFile(node, segments[segments.length - 1]!, fileKey);
		}
	}
	return root;
}

/**
 * Depth-first walk yielding directory and file events. Directories collapse their
 * single-child chains (`a` → `a/b` → `a/b/c`) so a shared prefix becomes one
 * header. Each node's direct files are emitted before its subdirectories, keeping
 * a file unambiguously attached to the header above it.
 */
export function* walkPathTree(node: PathTreeNode, depth = 0): Generator<GroupedTreeEvent> {
	for (const file of node.files) {
		yield { kind: "file", depth, name: file.name, key: file.key };
	}
	for (const subdir of node.subdirs) {
		let dirNode = subdir.node;
		const parts = [subdir.name];
		while (dirNode.files.length === 0 && dirNode.subdirs.length === 1) {
			const only = dirNode.subdirs[0]!;
			parts.push(only.name);
			dirNode = only.node;
		}
		yield { kind: "dir", depth, name: parts.join("/"), key: "" };
		yield* walkPathTree(dirNode, depth + 1);
	}
}

/**
 * Render a flat path list as a grouped, prefix-folded directory tree without
 * per-file bodies (find-tool output shape, also used by compaction `<files>`
 * lists). Single-child directory chains fold into one header (`# a/b/c/`),
 * each level adds one `#`, and files are listed bare under the deepest
 * directory header that owns them. Trailing-slash entries are directory
 * leaves and keep their slash in the header.
 *
 * `annotate` receives each file's full original path and its return value is
 * appended verbatim to the file line (e.g. ` (RW)`).
 *
 * Order follows the input: a directory appears when its first member is
 * emitted, and a node's own files precede its subdirectories.
 */
export function formatGroupedPaths(paths: readonly string[], annotate?: (path: string) => string): string {
	if (paths.length === 0) return "";
	const tree = buildPathTree(paths.map(entry => ({ path: entry, isDir: entry.endsWith("/") })));
	const lines: string[] = [];
	for (const event of walkPathTree(tree)) {
		if (event.kind === "dir") {
			lines.push(`${"#".repeat(event.depth + 1)} ${event.name}/`);
		} else {
			lines.push(annotate ? `${event.name}${annotate(event.key)}` : event.name);
		}
	}
	return lines.join("\n");
}
