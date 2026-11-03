/**
 * "I could not find out" as a value.
 *
 * Every filesystem and version-control question on the isolation path has
 * three answers, not two: the thing is there, the thing is not there, or this
 * process could not find out. The third one has been written as the second
 * five times in this subsystem — a failed `lstat`, a failed `readdir`, an
 * unreadable owner marker, `Bun.file().exists()` on a sidecar, and a native
 * diff error that became an empty patch and cost a user's file — so it is a
 * type here rather than a convention, and `unknown` has no default: a caller
 * must say what it does with it, and the compiler will not let it be dropped.
 */

import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";

export type Lookup<T> =
	| { readonly kind: "found"; readonly value: T }
	| { readonly kind: "absent" }
	/** The question could not be answered. Never a synonym for `absent`. */
	| { readonly kind: "unknown"; readonly reason: string };

export const FOUND = <T>(value: T): Lookup<T> => ({ kind: "found", value });
export const ABSENT: Lookup<never> = { kind: "absent" };
export const UNKNOWN = (reason: string): Lookup<never> => ({ kind: "unknown", reason });

/** The message of an error, for a lookup's `reason`. */
export function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run a filesystem read, mapping `ENOENT` — and only `ENOENT` — to `absent`.
 *
 * Every other failure is `unknown`: a permission error, an I/O error and a
 * path whose parent is not a directory all mean the caller did not find out.
 */
export async function lookupFs<T>(read: () => Promise<T>): Promise<Lookup<T>> {
	try {
		return FOUND(await read());
	} catch (error) {
		if (isEnoent(error)) return ABSENT;
		return UNKNOWN(reasonOf(error));
	}
}

/** `stat`, three-valued. Follows symlinks: a dangling link is `absent` to this one. */
export async function statLookup(target: string): Promise<Lookup<Stats>> {
	return await lookupFs(async () => (await fs.stat(target)) as Stats);
}

/** `lstat`, three-valued. Answers "is there an entry here", dangling or not. */
export async function lstatLookup(target: string): Promise<Lookup<Stats>> {
	return await lookupFs(async () => (await fs.lstat(target)) as Stats);
}

/** `readdir` with entry types, three-valued. */
export async function readdirTypedLookup(dir: string): Promise<Lookup<Dirent[]>> {
	return await lookupFs(async () => await fs.readdir(dir, { withFileTypes: true }));
}

/** `realpath`, three-valued: a path that cannot be resolved has no canonical form. */
export async function realpathLookup(target: string): Promise<Lookup<string>> {
	return await lookupFs(async () => await fs.realpath(target));
}

/** A UTF-8 file's contents, three-valued. */
export async function readTextLookup(file: string): Promise<Lookup<string>> {
	return await lookupFs(async () => await fs.readFile(file, "utf8"));
}

/** `readdir`, three-valued: a listing that failed is not an empty directory. */
export async function readdirLookup(dir: string): Promise<Lookup<string[]>> {
	return await lookupFs(async () => await fs.readdir(dir));
}

/** A JSON file, three-valued. Malformed content is `unknown`, not missing. */
export async function readJsonLookup(file: string): Promise<Lookup<unknown>> {
	const exists = await lstatLookup(file);
	if (exists.kind !== "found") return exists.kind === "absent" ? ABSENT : exists;
	try {
		return FOUND((await Bun.file(file).json()) as unknown);
	} catch (error) {
		// The entry is there — `lstat` just said so — so a read or parse failure
		// is this process failing to find out, never the file being absent.
		return UNKNOWN(reasonOf(error));
	}
}

/**
 * The value, or a raised error for both other answers.
 *
 * For a caller that cannot continue without knowing — which is most callers
 * that are about to delete, rename or report "nothing to save".
 */
export function requireFound<T>(lookup: Lookup<T>, what: string): T {
	if (lookup.kind === "found") return lookup.value;
	if (lookup.kind === "absent") throw new Error(`${what} is not there.`);
	throw new Error(`${what} could not be read: ${lookup.reason}`);
}
