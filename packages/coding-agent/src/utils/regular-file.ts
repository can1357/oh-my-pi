import * as fs from "node:fs/promises";
import { isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";

/** Whether `filePath` exists on disk as a regular file; returns `false` on any stat failure. */
export async function isRegularFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether `filePath` is verifiably absent as a regular file (`ENOENT`, `ENOTDIR`,
 * or a non-file entry). Unreadable paths (`EACCES`, `EPERM`, `EIO`) return
 * `false` so permission-blocked subtrees are conservatively treated as present.
 */
export async function isRegularFileMissing(filePath: string): Promise<boolean> {
	try {
		return !(await fs.stat(filePath)).isFile();
	} catch (error) {
		return isEnoent(error) || isEnotdir(error);
	}
}
