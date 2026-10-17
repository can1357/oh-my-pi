/**
 * Cache-target keys for the read-tier search tools (`grep`, `glob`) under
 * `tools.approvalMode: always-ask-cached`.
 *
 * Neither tool names one file the way `read`/`write`/`edit` do: a call is
 * scoped to one or more search roots — a folder, a file, or a glob whose
 * non-glob base is the folder actually walked. With no targets reported, the
 * cached mode auto-allowed both tools, so the file contents a `read` would
 * prompt for leaked through a search of the same path. One key per root closes
 * that: a file root reports the file key a `read` of it mints, a one-level
 * search reports the folder key a folder grant covers, and a recursive search
 * reports the tree key of that folder — which no plain folder grant matches,
 * because recursing below subfolders is more than one level of the folder.
 */
import { isReadableUrlPath } from "@oh-my-pi/pi-tui/tools/read";
import * as fs from "node:fs";
import { InternalUrlRouter } from "../internal-urls/router";
import { approvalDirectoryKey } from "./approval-cache";
import { approvalTargetKey, approvalTreeSearchKey, isApprovalPublicUrl } from "./approval-targets";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

/** List delimiters the execution-side path parser splits a root on. */
const ROOT_DELIMITERS = /[;,\s]+/;

/**
 * Roots to key for one raw entry: the entry itself plus its list parts. Execution fans `a;b`, `a,b`
 * and whitespace lists out, so a key minted only from the unsplit string would miss every path the
 * search really walks — and a search that reports no keys is auto-allowed. Parts that do not resolve
 * are dropped below, so naming them here can only add keys that really exist.
 */
function approvalRootCandidates(rawRoot: string): string[] {
	const parts = rawRoot.split(ROOT_DELIMITERS).filter(part => part.length > 0);
	return parts.length <= 1 ? [rawRoot] : [rawRoot, ...parts];
}

/**
 * Approval-cache keys for one search call, or `undefined` when no root resolves
 * to anything rememberable.
 *
 * `splitBase` is the calling tool's own root parser ({@link parseSearchPath} for
 * `grep`, {@link parseFindPattern} for `glob`), so a glob root reports the
 * folder the tool actually walks instead of the pattern. `isRecursive` says
 * whether that root is walked below its subfolders (`grep` always is; a `glob`
 * pattern only with `**`); such a root reports a tree key instead of the folder
 * key. Nothing here expands a glob, materializes an archive member, or walks a
 * directory: each root costs at most one `statSync`. An omitted `path` makes the
 * tool search the session cwd, so that folder is reported too; a supplied root
 * that resolves to nothing — a public web URL (whose contents are public
 * already, the contract `read` follows), an unreadable target, or a missing path
 * — contributes no key.
 */
export function searchApprovalCacheTargets(
	roots: readonly string[],
	cwd: string,
	splitBase: (root: string) => string,
	isRecursive: (root: string) => boolean = () => true,
): readonly string[] | undefined {
	const keys = new Set<string>();
	// Both tools search `.` when no path argument was supplied, so the fallback
	// root below is the folder the call really runs in.
	for (const rawRoot of roots.length > 0 ? roots : ["."]) {
		const root = normalizePathLikeInput(rawRoot);
		if (root.length === 0) continue;
		for (const candidate of approvalRootCandidates(root)) {
			const base = normalizePathLikeInput(splitBase(candidate));
			const key = searchRootApprovalKey(base, cwd, isRecursive(candidate));
			if (key !== undefined) keys.add(key);
		}
	}
	return keys.size > 0 ? [...keys] : undefined;
}

/**
 * One cache key for a resolution-ready search root: a file reports the file key
 * a `read` of it would mint, a folder reports the folder key a folder grant
 * covers, a folder walked recursively reports its tree key, and a registered
 * internal URL keeps its normalized form. `undefined` for anything else — a
 * public web URL, or a root that does not resolve or does not exist.
 */
function searchRootApprovalKey(root: string, cwd: string, recursive: boolean): string | undefined {
	if (root.length === 0) return undefined;
	if (isReadableUrlPath(root)) {
		// A public page is ungated like a public read; a private host is gated like a file.
		return isApprovalPublicUrl(root) ? undefined : approvalTargetKey(cwd, root);
	}
	const router = InternalUrlRouter.instance();
	if (router.canHandle(router.normalize(root))) return approvalTargetKey(cwd, root);
	let absolute: string;
	try {
		absolute = resolveToCwd(root, cwd);
	} catch {
		// resolveToCwd rejects unknown URL schemes; there is no filesystem target to key.
		return undefined;
	}
	try {
		if (!fs.statSync(absolute).isDirectory()) return approvalTargetKey(cwd, root);
		const directoryKey = approvalDirectoryKey(absolute);
		return recursive ? approvalTreeSearchKey(directoryKey) : directoryKey;
	} catch {
		// The search of a path that does not exist finds nothing and errors out;
		// nothing about it is worth remembering.
		return undefined;
	}
}
