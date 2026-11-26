/**
 * The changed-file lists of the git sidebar: flat paths, or a folder tree
 * whose single-child folder chains collapse into one row (`deep/nested/`).
 */
import type { ChangedFile } from "../../../cli/git-tui/model/state";

/** A file list row: a folder (tree view) or a file. */
export type FileEntry =
	| {
			readonly kind: "dir";
			/** `<section>:<folder path>`; the fold state and selection identity. */
			readonly key: string;
			readonly name: string;
			readonly depth: number;
			readonly collapsed: boolean;
	  }
	| {
			readonly kind: "file";
			readonly key: string;
			readonly file: ChangedFile;
			/** Tree depth; absent in the flat path view. */
			readonly depth?: number;
	  };

/** Selection identity of a file row. */
export function fileKey(file: ChangedFile): string {
	return `file:${file.area}:${file.path}`;
}

interface Folder {
	name: string;
	folders: Map<string, Folder>;
	files: ChangedFile[];
}

/** Rows of `files` in the flat path view (input order). */
export function pathEntries(files: readonly ChangedFile[]): FileEntry[] {
	return files.map(file => ({ kind: "file", key: fileKey(file), file }));
}

/**
 * Rows of `files` as a folder tree: folders first (by name), then files in
 * input order; a folder holding only one folder merges with it; children of
 * folders in `collapsed` are hidden.
 */
export function treeEntries(
	files: readonly ChangedFile[],
	section: string,
	collapsed: ReadonlySet<string>,
): FileEntry[] {
	const root: Folder = { name: "", folders: new Map(), files: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		let folder = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i]!;
			let next = folder.folders.get(part);
			if (!next) {
				next = { name: part, folders: new Map(), files: [] };
				folder.folders.set(part, next);
			}
			folder = next;
		}
		folder.files.push(file);
	}
	const out: FileEntry[] = [];
	const walk = (folder: Folder, prefix: string, depth: number): void => {
		const children = [...folder.folders.values()].map(child => {
			let merged = child;
			while (merged.files.length === 0 && merged.folders.size === 1) {
				const only = merged.folders.values().next().value!;
				merged = { name: `${merged.name}/${only.name}`, folders: only.folders, files: only.files };
			}
			return merged;
		});
		children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			const path = `${prefix}${child.name}`;
			const key = `${section}:${path}`;
			const isCollapsed = collapsed.has(key);
			out.push({ kind: "dir", key, name: child.name, depth, collapsed: isCollapsed });
			if (!isCollapsed) walk(child, `${path}/`, depth + 1);
		}
		for (const file of folder.files) out.push({ kind: "file", key: fileKey(file), file, depth });
	};
	walk(root, "", 0);
	return out;
}
