/**
 * Scratch space a benchmarked model cannot explore.
 *
 * Task working directories and the extracted fixtures (whose `expected/` trees
 * are the answers) live under one root in the OS temp dir. The root denies
 * listing and every entry has a random name, so a model that walks up from its
 * working directory finds neither sibling runs nor fixtures, and the path gives
 * it no task id to search the disk for. Run logs, which record every run's edit
 * payloads, are written outside this tree (see `LOG_DIR` in `runner.ts`).
 *
 * This is not a sandbox: a model with a shell can still search the rest of the
 * machine by file content.
 */
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";

let root: Promise<TempDir> | undefined;

async function createRoot(): Promise<TempDir> {
	const dir = await TempDir.create("@metaharness-edit-");
	// Write + search without read: entries open by name but cannot be listed.
	await fs.chmod(dir.path(), 0o300);
	return dir;
}

/** A scratch directory owned by its creator. */
export interface Scratch {
	/** `<root>/<random>`. */
	dir: string;
	remove(): Promise<void>;
}

/** Create an empty scratch directory. */
export async function createScratch(): Promise<Scratch> {
	root ??= createRoot();
	const dir = (await root).join(crypto.randomUUID());
	await fs.mkdir(dir);
	return { dir, remove: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Remove the scratch root and every directory still under it. */
export async function removeScratch(): Promise<void> {
	const created = root;
	if (!created) return;
	root = undefined;
	const dir = await created;
	// Removal has to list the root.
	await fs.chmod(dir.path(), 0o700);
	await dir.remove();
}
