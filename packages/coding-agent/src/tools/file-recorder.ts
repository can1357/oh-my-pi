import * as path from "node:path";
import { formatPathRelativeToCwd } from "./path-utils";

/**
 * Creates a deduplicating recorder for relative file paths.
 * Preserves insertion order in `list`; subsequent duplicates are ignored.
 */
export function createFileRecorder(): {
	record: (relativePath: string) => void;
	list: string[];
} {
	const seen = new Set<string>();
	const list: string[] = [];
	return {
		record(relativePath: string) {
			if (!seen.has(relativePath)) {
				seen.add(relativePath);
				list.push(relativePath);
			}
		},
		list,
	};
}

/**
 * Strip native virtual-root prefixes and format file paths relative to cwd when
 * they are inside cwd. Paths outside cwd remain absolute.
 */
export function formatResultPath(filePath: string, isDirectory: boolean, basePath: string, cwd: string): string {
	const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
	if (isDirectory) {
		return formatPathRelativeToCwd(path.resolve(basePath, cleanPath), cwd);
	}
	return formatPathRelativeToCwd(basePath, cwd);
}
