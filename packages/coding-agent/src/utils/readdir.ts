/**
 * Directory listing that distinguishes "absent" from "unreadable".
 *
 * `fs.readdir(dir).catch(() => [])` maps every failure onto the same empty
 * array a genuinely empty directory produces, so `EACCES`, `EPERM`, `ENOTDIR`
 * and `EMFILE` all report "nothing here" to the user. Every caller of
 * {@link readDirOutcome} gets the real error instead and decides how to surface
 * it, which keeps a failed scan from being mistaken for an empty one.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";

/** Outcome of one directory listing, separating absence from a failed read. */
export type ReadDirOutcome =
	| { status: "ok"; entries: Dirent[] }
	/** The directory does not exist. An absent directory is an ordinary empty result. */
	| { status: "missing" }
	/** The directory exists but could not be read. Never treat this as empty. */
	| { status: "error"; error: NodeJS.ErrnoException };

/**
 * List a directory, classifying the failure rather than swallowing it.
 *
 * `ENOENT` (and `ENOTDIR`, where a path component is a file, which cannot hold
 * children either) report `missing`. Every other code reports `error` so the
 * caller can surface it and can refuse to act on the missing entries.
 */
export async function readDirOutcome(dir: string): Promise<ReadDirOutcome> {
	try {
		return { status: "ok", entries: await fs.readdir(dir, { withFileTypes: true }) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
		return { status: "error", error: error as NodeJS.ErrnoException };
	}
}

/** One-line description of an unreadable directory for a user-facing notice. */
export function describeReadDirFailure(dir: string, error: NodeJS.ErrnoException): string {
	return `Could not read directory ${dir}: ${error.code ?? String(error)}`;
}
