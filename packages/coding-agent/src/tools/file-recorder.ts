import * as path from "node:path";
import { extractUriScheme } from "../internal-urls/parse";
import { InternalUrlRouter } from "../internal-urls/router";
import type { ResolveContext } from "../internal-urls/types";
import { formatPathRelativeToCwd, resolveSearchResultPath } from "./path-utils";

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
 * Display path of a native search result: URL results as-is, else native
 * virtual-root prefixes stripped and the result joined onto `basePath` (a host
 * directory or URL), relative to cwd when inside it. Paths outside cwd remain absolute.
 */
export function formatResultPath(filePath: string, isDirectory: boolean, basePath: string, cwd: string): string {
	if (InternalUrlRouter.instance().canHandle(filePath)) return filePath;
	const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
	if (isDirectory) {
		return formatPathRelativeToCwd(resolveSearchResultPath(basePath, cleanPath), cwd);
	}
	return formatPathRelativeToCwd(basePath, cwd);
}

/**
 * Host file a hashline snapshot for the displayed result `resultPath` binds to:
 * cwd-resolved host paths, and the located backing file of a mutable
 * file-backed URL (`local://`). Undefined for immutable schemes and URLs
 * without a local file, whose results must not mint edit anchors.
 */
export async function resultSnapshotPath(
	resultPath: string,
	cwd: string,
	context: ResolveContext,
): Promise<string | undefined> {
	const router = InternalUrlRouter.instance();
	if (!router.canHandle(resultPath)) return path.resolve(cwd, resultPath);
	const scheme = extractUriScheme(resultPath);
	if (scheme === undefined || router.spec(scheme)?.immutable) return undefined;
	return (await router.locate(resultPath, context)) ?? undefined;
}
