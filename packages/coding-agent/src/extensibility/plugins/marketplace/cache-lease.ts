/**
 * Leases on plugin cache entries, so that `omp plugin upgrade`, a reinstall or `uninstall` never
 * deletes a version directory a running omp process still uses.
 *
 * A running session keeps the paths of the plugin copy it loaded: skill files and the directories
 * the model was told about, slash commands, agents, hook scripts, MCP server commands and working
 * directories, LSP and DAP configs, extension modules. All of them lie inside the copy's cache
 * entry (`<cacheDir>/<marketplace>___<plugin>___<version>[___<n>]/`).
 *
 * - Every process that reads the plugin registries leases each cache entry they name
 *   ({@link leaseCacheEntry}) before it uses the entry's files, and keeps the lease until it exits.
 *   An installer leases the entry it is about to create. A lease is an empty file
 *   `<cacheDir>/../plugin-leases/<entry>/<pid>-<start>`, named for the process and its start time,
 *   so the lease of a process that died without removing it is recognised (a dead pid, or a pid a
 *   later process reuses) and pruned.
 * - Removal ({@link removeCacheEntryUnlessLeased}) keeps a leased entry and marks it retired; a
 *   later {@link sweepRetiredCacheEntries} removes it once no live process leases it and no
 *   registry names it again.
 * - Taking a lease (write it, then check that the entry exists) and deciding a removal (mark the
 *   entry retired, check the leases, move the entry aside) each run under one OS lock per entry,
 *   which the OS releases when its holder dies. So a removal either sees a lease and keeps the
 *   entry, or moves the entry aside before the lease is written; the process that leases then
 *   finds the entry missing and reads the registries again, which stopped naming it before its
 *   removal began. The moved-aside copy is deleted after the lock is released.
 * - Removal fails closed: it writes the retired mark before it checks the leases, and keeps the
 *   entry when it cannot. A process whose lease could not be written (the same directory, the same
 *   user) leaves the remover unable to write there too; it tries again on its next registry read.
 */
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isPidAlive, logger, postmortem, processStartToken, withFileLock } from "@oh-my-pi/pi-utils";

const LEASES_DIR = "plugin-leases";
/** An empty file in a retired entry's lease directory. */
const RETIRED_MARKER = "retired";
/** `<pid>-<start-time token hash>`; the hash is `0` where the platform reports no start time. */
const LEASE_NAME_RE = /^(\d+)-([0-9a-z]+)$/;
/** An entry moved aside for deletion by the process `<pid>`: `.<entry>.removing-<pid>-<nonce>`. */
const REMOVING_NAME_RE = /^\..+\.removing-(\d+)-[0-9a-z]+$/;

/** The directory of the leases on the cache entry `entryPath`. */
function leaseDirOf(entryPath: string): string {
	return path.join(path.dirname(path.dirname(entryPath)), LEASES_DIR, path.basename(entryPath));
}

/** Run `fn` under the OS lock of the cache entry whose lease directory is `leaseDir`, which exists while it runs. */
async function withEntryLock<T>(leaseDir: string, fn: () => Promise<T>): Promise<T> {
	await fs.mkdir(path.dirname(leaseDir), { recursive: true });
	return withFileLock(leaseDir, async () => {
		// A removal that held the lock before may have removed it.
		await fs.mkdir(leaseDir, { recursive: true });
		return fn();
	});
}

function leaseName(pid: number, startToken: string | null): string {
	return `${pid}-${startToken === null ? "0" : Bun.hash(startToken).toString(36)}`;
}

let ownLeaseName: Promise<string> | undefined;
/** Lease files this process wrote and holds: true for a lease kept until exit, false for an install's. */
const ownLeases = new Map<string, boolean>();
let releaseOnExitRegistered = false;

async function exists(target: string): Promise<boolean> {
	return fs.stat(target).then(
		() => true,
		error => !isEnoent(error),
	);
}

/**
 * Lease the cache entry `entryPath` for this process and resolve whether the entry exists. A lease
 * on an existing entry is kept until the process exits. With `forInstall` (the caller is about to
 * create the entry) the lease is kept even though the entry is missing, until
 * {@link releaseInstallLease}. Otherwise a lease on a missing entry is not kept. When the lease
 * cannot be written the entry is used without one; the next call tries again.
 */
export async function leaseCacheEntry(entryPath: string, options: { forInstall?: boolean } = {}): Promise<boolean> {
	ownLeaseName ??= processStartToken(process.pid).then(token => leaseName(process.pid, token));
	const leaseDir = leaseDirOf(entryPath);
	const leasePath = path.join(leaseDir, await ownLeaseName);
	const forLife = !options.forInstall;
	if (ownLeases.has(leasePath)) {
		if (forLife) ownLeases.set(leasePath, true);
		return exists(entryPath);
	}
	try {
		return await withEntryLock(leaseDir, async () => {
			await Bun.write(leasePath, "");
			const present = await exists(entryPath);
			if (present || !forLife) {
				ownLeases.set(leasePath, forLife);
				registerReleaseOnExit();
			} else {
				await fs.rm(leasePath, { force: true });
				await fs.rmdir(leaseDir).catch(() => {});
			}
			return present;
		});
	} catch (error) {
		logger.warn("Could not lease a plugin cache entry", { path: entryPath, error: String(error) });
		return exists(entryPath);
	}
}

/**
 * Give up an install's lease on `entryPath` once the registry names the entry. A lease this process
 * also took to use the entry stays until exit.
 */
export async function releaseInstallLease(entryPath: string): Promise<void> {
	if (!ownLeaseName) return;
	const leasePath = path.join(leaseDirOf(entryPath), await ownLeaseName);
	if (ownLeases.get(leasePath) !== false) return;
	ownLeases.delete(leasePath);
	await fs.rm(leasePath, { force: true });
}

function registerReleaseOnExit(): void {
	if (releaseOnExitRegistered) return;
	releaseOnExitRegistered = true;
	// Synchronous: the exit cleanup does not wait for promises.
	postmortem.register("plugin-cache-leases", () => {
		for (const ownLease of ownLeases.keys()) nodeFs.rmSync(ownLease, { force: true });
	});
}

/** Whether the process that wrote a lease named `<pid>-<hash>` is alive; a reused pid is not. */
async function isLiveLease(pid: number, startHash: string): Promise<boolean> {
	if (!isPidAlive(pid)) return false;
	if (startHash === "0") return true;
	const startToken = await processStartToken(pid);
	// A live pid whose start time cannot be read counts as alive.
	return startToken === null || leaseName(pid, startToken) === `${pid}-${startHash}`;
}

/** Whether a live process leases the entry whose lease directory is `leaseDir`. Dead leases are removed. */
async function hasLiveLease(leaseDir: string): Promise<boolean> {
	let live = false;
	for (const name of await fs.readdir(leaseDir)) {
		const match = LEASE_NAME_RE.exec(name);
		if (!match) continue;
		if (await isLiveLease(Number(match[1]), match[2])) live = true;
		else await fs.rm(path.join(leaseDir, name), { force: true });
	}
	return live;
}

/**
 * Delete the cache entry `entryPath` unless a live process leases it. A leased entry, or one whose
 * leases cannot be checked, is kept and marked retired, for {@link sweepRetiredCacheEntries} to
 * remove once its last holder exits. Resolves true when the entry is gone.
 */
export async function removeCacheEntryUnlessLeased(entryPath: string): Promise<boolean> {
	const leaseDir = leaseDirOf(entryPath);
	const aside = path.join(
		path.dirname(entryPath),
		`.${path.basename(entryPath)}.removing-${process.pid}-${Bun.hash(crypto.randomUUID()).toString(36)}`,
	);
	let movedAside = false;
	try {
		const removed = await withEntryLock(leaseDir, async () => {
			// Marked first: a removal that cannot write here keeps the entry.
			await Bun.write(path.join(leaseDir, RETIRED_MARKER), "");
			if (await hasLiveLease(leaseDir)) return false;
			try {
				await fs.rename(entryPath, aside);
				movedAside = true;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			await fs.rm(path.join(leaseDir, RETIRED_MARKER), { force: true });
			await fs.rmdir(leaseDir).catch(() => {});
			return true;
		});
		if (!removed) return false;
	} catch (error) {
		logger.warn("Keeping a plugin cache entry whose leases could not be checked", {
			path: entryPath,
			error: String(error),
		});
		return false;
	}
	if (movedAside) await fs.rm(aside, { recursive: true, force: true });
	return true;
}

/**
 * Remove each retired entry of the cache `cacheDir` that no live process leases and that
 * `isReferenced` (the plugin registries) no longer names; a retired entry the registries name
 * again is no longer retired. Also removes what a removal that died midway moved aside. Failures
 * are logged, not thrown: a kept entry only costs disk space.
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
