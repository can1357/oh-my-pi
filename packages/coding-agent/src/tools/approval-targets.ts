/**
 * Cache-key derivation for `tools.approvalMode: always-ask-cached` grants.
 *
 * Shared by every path-based tool (`read`, `write`, `edit`) so one approved
 * target maps to one key: a filesystem path resolved against the session cwd
 * (case-folded on case-insensitive platforms via {@link approvalCacheKeyForPath}),
 * a registered internal URL (`xd://`, `local://`, …) kept in its normalized
 * form, or a readable web URL kept as written.
 */
import { isReadableUrlPath } from "@oh-my-pi/pi-tui/tools/read";
import * as fs from "node:fs";
import * as path from "node:path";
import { InternalUrlRouter } from "../internal-urls/router";
import { approvalCacheKeyForPath } from "./approval-cache";
import { resolveToCwd } from "./path-utils";

/** Key prefix for a recursive search of a tree: opaque, so no folder or file grant matches it. */
const APPROVAL_TREE_SEARCH_PREFIX = "tree\0";

/**
 * Cache key for a recursive search rooted at `directoryKey`. Such a search reads below subfolders,
 * which a folder grant does not cover, so it carries an opaque key of its own: only a grant the user
 * recorded for that same tree silences it, and a grant on the folder never does by accident.
 */
export function approvalTreeSearchKey(directoryKey: string): string {
	return `${APPROVAL_TREE_SEARCH_PREFIX}${directoryKey}`;
}

/** The folder key a tree key was minted from, or `undefined` when the key is not a tree key. */
export function approvalTreeSearchFolderKey(key: string): string | undefined {
	return key.startsWith(APPROVAL_TREE_SEARCH_PREFIX) ? key.slice(APPROVAL_TREE_SEARCH_PREFIX.length) : undefined;
}

/** Whether a readable URL's host is public, so Ask and remember can leave it ungated. */
export function isApprovalPublicUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		// A readable URL may be written without a scheme (`www.example.com/docs`).
		try {
			host = new URL(`https://${url}`).hostname.toLowerCase();
		} catch {
			return false;
		}
	}
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host.length === 0) return false;
	// Intranet names: a single label, or a reserved local suffix.
	if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")) {
		return false;
	}
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
		if (a === 192 && b === 168) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 169 && b === 254) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		return true;
	}
	// IPv6 literals: loopback, link-local, unique-local and v4-mapped ranges are private.
	if (host.includes(":")) {
		return !(
			host === "::1" ||
			host.startsWith("fe80:") ||
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("::ffff:")
		);
	}
	return true;
}

/**
 * Whether an exact grant target names a file rather than a directory or a
 * non-filesystem target (an internal or web URL) — the file-flavoured answer is
 * only named for a file. A path nothing occupies yet still counts as a file:
 * approving a write is how its file comes to exist.
 */
export function approvalTargetNamesFile(target: string): boolean {
	// A recursive search's tree key is opaque: nothing on disk names it, and it is never a file.
	if (target.startsWith(APPROVAL_TREE_SEARCH_PREFIX)) return false;
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(target);
	if (router.canHandle(normalized) || isReadableUrlPath(target)) return false;
	try {
		return !fs.statSync(target).isDirectory();
	} catch {
		return true;
	}
}

/**
 * The directory an exact target covers for a folder answer: a directory target is
 * the folder itself (a directory read must offer its own directory, never the
 * parent that would grant every sibling), a file target's parent is, and a path
 * nothing occupies yet counts as a file so its parent is offered. `undefined`
 * when the target names no filesystem path.
 */
export function approvalTargetDirectory(target: string): string | undefined {
	const trimmed = target.replace(/[\\/]+$/, "");
	if (trimmed.length === 0) return undefined;
	const router = InternalUrlRouter.instance();
	if (router.canHandle(router.normalize(trimmed)) || isReadableUrlPath(trimmed)) return undefined;
	// A filesystem root is its own directory: stripping its separator leaves POSIX "" and Windows
	// "C:", which names the drive's current directory rather than the root.
	if (path.parse(target).root === target) return target;
	try {
		return fs.statSync(trimmed).isDirectory() ? trimmed : path.dirname(trimmed);
	} catch {
		return path.dirname(trimmed);
	}
}

/**
 * Normalize one tool argument into an approval-cache key, or `undefined` when
 * the argument is empty. Unresolvable-but-non-empty targets fall back to their
 * trimmed text so a grant still sticks to the exact target that was approved.
 */
export function approvalTargetKey(cwd: string, target: string): string | undefined {
	// Trimming is only a test for a blank input: leading and trailing spaces are real filename bytes,
	// so `" secret "` and `"secret"` must not share one grant.
	const trimmed = target.trim();
	if (trimmed.length === 0) return undefined;
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(trimmed);
	if (router.canHandle(normalized)) return normalized;
	if (isReadableUrlPath(trimmed)) return trimmed;
	try {
		return approvalCacheKeyForPath(resolveToCwd(target, cwd));
	} catch {
		// resolveToCwd rejects registered internal URLs; those returned above.
		return target;
	}
}

/** Entries a listing scans before it stops: the counts become lower bounds, and huge folders cannot stall a prompt. */
const APPROVAL_FOLDER_SCAN_LIMIT = 200;

/** What a folder grant on a directory reaches: its own entries, `limit` of them named. */
export interface ApprovalFolderListing {
	/** Entry names in sort order, a trailing slash marking a folder, `limit` of them at most. */
	readonly entries: readonly string[];
	/** Entries past `limit`, counted but not named. */
	readonly rest: number;
	readonly folders: number;
	readonly files: number;
	readonly total: number;
	/** True when the scan stopped at its bound, so the counts are lower bounds. */
	readonly truncated: boolean;
}

/**
 * The entries directly inside `directory`, as a folder grant covers them — one
 * level deep, since that is as far as a folder grant reaches — for the approval
 * prompt to show what it is about to allow. Directories are marked with a
 * trailing slash (they need their own approval). Reads asynchronously and stops
 * after {@link APPROVAL_FOLDER_SCAN_LIMIT} entries, so a big or slow folder
 * cannot block the event loop while the prompt is prepared. `undefined` when
 * `directory` is not a readable directory.
 */
export async function approvalFolderListing(
	directory: string,
	limit: number,
): Promise<ApprovalFolderListing | undefined> {
	let handle: fs.Dir;
	try {
		handle = await fs.promises.opendir(directory);
	} catch {
		return undefined;
	}
	const scanned: string[] = [];
	let folders = 0;
	let total = 0;
	let truncated = false;
	try {
		for await (const entry of handle) {
			if (scanned.length >= APPROVAL_FOLDER_SCAN_LIMIT) {
				truncated = true;
				break;
			}
			const isFolder = entry.isDirectory();
			if (isFolder) folders++;
			total++;
			scanned.push(isFolder ? `${entry.name}/` : entry.name);
		}
	} catch {
		// A folder that stops reading midway still shows whatever it managed to list.
	} finally {
		await handle.close().catch(() => {});
	}
	scanned.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const entries = scanned.slice(0, limit);
	return { entries, rest: total - entries.length, folders, files: total - folders, total, truncated };
}
