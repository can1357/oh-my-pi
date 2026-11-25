/**
 * Type-safe filesystem error handling utilities.
 *
 * Use these to check error codes without string matching on messages:
 *
 * @example
 * ```ts
 * import { isEnoent, isFsError } from "@oh-my-pi/pi-utils";
 *
 * try {
 *     return await Bun.file(path).text();
 * } catch (err) {
 *     if (isEnoent(err)) return null;
 *     throw err;
 * }
 * ```
 */

import * as fs from "node:fs/promises";

export interface FsError extends Error {
	code: string;
	errno?: number;
	syscall?: string;
	path?: string;
}

export function isFsError(err: unknown): err is FsError {
	return err instanceof Error && "code" in err && typeof (err as FsError).code === "string";
}

export function isEnoent(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOENT";
}

/** Whether `target` exists. Only ENOENT means "no"; permission and I/O failures propagate. */
export async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

export function isEacces(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EACCES";
}

export function isEisdir(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EISDIR";
}

export function isEnotdir(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTDIR";
}

export function isEexist(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EEXIST";
}

export function isEnotempty(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTEMPTY";
}

export function hasFsCode(err: unknown, code: string): err is FsError {
	return isFsError(err) && err.code === code;
}
