/**
 * Leases on plugin cache entries, so that `omp plugin upgrade` or `uninstall` never deletes a version
 * directory a running omp process still uses.
 *
 * A running session keeps the paths of the plugin version it loaded: skill files and the directories
 * the model was told about, slash commands, agents, hook scripts, MCP server commands and working
 * directories, LSP and DAP configs, extension modules. All of them lie inside the version's cache
 * entry (`<cacheDir>/<marketplace>___<plugin>___<version>/`).
 *
 * - Every process that reads the plugin registries leases each cache entry they name
 *   ({@link leaseCacheEntry}) before it uses the entry's files, and keeps the lease until it exits.
 *   A lease is an empty file `<cacheDir>/../plugin-leases/<entry>/<pid>-<start>`, named for the
 *   process and its start time, so the lease of a process that died without removing it is
 *   recognised (a dead pid, or a pid recycled by a process that started later) and pruned.
 * - Removal ({@link removeCacheEntryUnlessLeased}) keeps a leased entry and marks it retired; a
 *   later {@link sweepRetiredCacheEntries} removes it once no live process leases it and no
 *   registry names it again.
 * - A removal and a new lease can race. The remover renames the entry aside before it deletes it
 *   and checks the leases again after the rename: a lease taken before the rename is seen and the
 *   entry is put back. A process that leases after the remover's check finds the entry missing
 *   and reads the registries again; they stopped naming the entry before its removal began.
 */
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isPidAlive, logger, postmortem, processStartToken } from "@oh-my-pi/pi-utils";

const LEASES_DIR = "plugin-leases";
/** An empty file in a retired entry's lease directory. */
const RETIRED_MARKER = "retired";
/** `<pid>-<start-time token hash>`; the hash is `0` where the platform reports no start time. */
const LEASE_NAME_RE = /^(\d+)-([0-9a-z]+)$/;
/** An entry renamed aside for deletion by the process `<pid>`: `.<entry>.removing-<pid>-<nonce>`. */
const REMOVING_NAME_RE = /^\..+\.removing-(\d+)-[0-9a-z]+$/;

/** The directory of the leases on the cache entry `entryPath`. */
function leaseDirOf(entryPath: string): string {
	return path.join(path.dirname(path.dirname(entryPath)), LEASES_DIR, path.basename(entryPath));
}

function leaseName(pid: number, startToken: string | null): string {
	return `${pid}-${startToken === null ? "0" : Bun.hash(startToken).toString(36)}`;
}

let ownLeaseName: Promise<string> | undefined;
/** Lease files this process holds, by path, and the write that creates each. */
const ownLeases = new Map<string, Promise<boolean>>();
let releaseOnExitRegistered = false;

/**
 * Lease the cache entry `entryPath` for this process until it exits. Resolves true when this call
 * created the lease, false when the process already held it or the lease could not be written (the
 * entry is then used without one, as before leases existed).
 */
export function leaseCacheEntry(entryPath: string): Promise<boolean> {
	ownLeaseName ??= processStartToken(process.pid).then(token => leaseName(process.pid, token));
	return ownLeaseName.then(async name => {
		const leasePath = path.join(leaseDirOf(entryPath), name);
		const pending = ownLeases.get(leasePath);
		if (pending) {
			await pending;
			return false;
		}
		const write = (async () => {
			try {
				await fs.mkdir(path.dirname(leasePath), { recursive: true });
				await Bun.write(leasePath, "");
				return true;
			} catch (error) {
				ownLeases.delete(leasePath);
				logger.warn("Could not lease a plugin cache entry", { path: entryPath, error: String(error) });
				return false;
			}
		})();
		ownLeases.set(leasePath, write);
		if (!releaseOnExitRegistered) {
			releaseOnExitRegistered = true;
			// Synchronous: the exit cleanup does not wait for promises.
			postmortem.register("plugin-cache-leases", () => {
				for (const ownLease of ownLeases.keys()) nodeFs.rmSync(ownLease, { force: true });
			});
		}
		return write;
	});
}

/** Give up this process's lease on `entryPath`, taken by {@link leaseCacheEntry}. */
export async function releaseCacheEntryLease(entryPath: string): Promise<void> {
	if (!ownLeaseName) return;
	const leasePath = path.join(leaseDirOf(entryPath), await ownLeaseName);
	if (!ownLeases.delete(leasePath)) return;
	await fs.rm(leasePath, { force: true });
}

/** Whether the process that wrote a lease named `<pid>-<hash>` is alive; a recycled pid is not. */
async function isLiveLease(pid: number, startHash: string): Promise<boolean> {
	if (!isPidAlive(pid)) return false;
	if (startHash === "0") return true;
	const startToken = await processStartToken(pid);
	// A live pid whose start time cannot be read (EPERM on another user's process) counts as alive.
	return startToken === null || leaseName(pid, startToken) === `${pid}-${startHash}`;
}

/** Whether a live process leases the cache entry `entryPath`. Leases of dead processes are removed. */
async function hasLiveLease(entryPath: string): Promise<boolean> {
	const leaseDir = leaseDirOf(entryPath);
	let names: string[];
	try {
		names = await fs.readdir(leaseDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const name of names) {
		const match = LEASE_NAME_RE.exec(name);
		if (!match) continue;
		if (await isLiveLease(Number(match[1]), match[2])) live = true;
		else await fs.rm(path.join(leaseDir, name), { force: true });
	}
	return live;
}

async function markRetired(entryPath: string): Promise<void> {
	const leaseDir = leaseDirOf(entryPath);
	await fs.mkdir(leaseDir, { recursive: true });
	await Bun.write(path.join(leaseDir, RETIRED_MARKER), "");
}

/**
 * Delete the cache entry `entryPath` unless a live process leases it. A leased entry is kept and
 * marked retired, for {@link sweepRetiredCacheEntries} to remove once its last holder exits.
 * Resolves true when the entry is gone.
 */
export async function removeCacheEntryUnlessLeased(entryPath: string): Promise<boolean> {
	if (await hasLiveLease(entryPath)) {
		await markRetired(entryPath);
		return false;
	}
	const aside = path.join(
		path.dirname(entryPath),
		`.${path.basename(entryPath)}.removing-${process.pid}-${Bun.hash(crypto.randomUUID()).toString(36)}`,
	);
	try {
		await fs.rename(entryPath, aside);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		await fs.rm(leaseDirOf(entryPath), { recursive: true, force: true });
		return true;
	}
	if (await hasLiveLease(entryPath)) {
		// Leased between the first check and the rename: put it back.
		try {
			await fs.rename(aside, entryPath);
		} catch (error) {
			// A same-version reinstall already put a new copy in place; the holder reads that one.
			logger.warn("Could not restore a leased plugin cache entry", { path: entryPath, error: String(error) });
			await fs.rm(aside, { recursive: true, force: true });
		}
		await markRetired(entryPath);
		return false;
	}
	await fs.rm(aside, { recursive: true, force: true });
	await fs.rm(leaseDirOf(entryPath), { recursive: true, force: true });
	return true;
}

/**
 * Remove each retired entry of the cache `cacheDir` that no live process leases and that
 * `isReferenced` (the plugin registries) no longer names; a retired entry the registries name
 * again (a reinstall of that version) is no longer retired. Also removes what a removal that died
 * midway renamed aside. Failures are logged, not thrown: a kept entry only costs disk space.
 */
export async function sweepRetiredCacheEntries(
	cacheDir: string,
	isReferenced: (entryPath: string) => boolean,
): Promise<void> {
	const leasesRoot = path.join(path.dirname(cacheDir), LEASES_DIR);
	for (const name of await readdirIfExists(leasesRoot)) {
		const marker = path.join(leasesRoot, name, RETIRED_MARKER);
		try {
			if (!(await Bun.file(marker).exists())) continue;
			const entryPath = path.join(cacheDir, name);
			if (isReferenced(entryPath)) await fs.rm(marker, { force: true });
			else await removeCacheEntryUnlessLeased(entryPath);
		} catch (error) {
			logger.warn("Could not sweep a retired plugin cache entry", { marker, error: String(error) });
		}
	}
	for (const name of await readdirIfExists(cacheDir)) {
		const match = REMOVING_NAME_RE.exec(name);
		if (!match || isPidAlive(Number(match[1]))) continue;
		await fs.rm(path.join(cacheDir, name), { recursive: true, force: true }).catch(error => {
			logger.warn("Could not remove an abandoned plugin cache removal", { name, error: String(error) });
		});
	}
}

/** The names in `dir`; none when it is missing or cannot be read (logged). */
async function readdirIfExists(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Could not list a plugin cache directory", { dir, error: String(error) });
		return [];
	}
}
