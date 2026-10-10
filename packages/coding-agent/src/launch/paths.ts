import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, hasFsCode, isEacces, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** File in a broker runtime dir recording which project (or global service dir) owns the scope. */
const SCOPE_FILE = "scope.json";
/**
 * Small mutable lifecycle state (snapshot, completion bookkeeping) in
 * `<runtimeDir>/daemons/<name>/`. Rewritten on transitions, and only when its
 * serialized form changes.
 */
export const DAEMON_META_FILE = "meta.json";
/**
 * The launch spec, including its environment (often the whole parent env,
 * tens of KB). Written when the record is created or its mode changes, never
 * on lifecycle transitions. Older brokers embedded it in `meta.json`; readers
 * still accept that layout and broker recovery migrates it.
 */
export const DAEMON_SPEC_FILE = "spec.json";

/**
 * Target of a relocation symlink for `original`, or undefined when the link
 * does not mirror that path under an `omp` dir. This excludes foreign links
 * from profile cleanup.
 */
async function relocatedTarget(link: string, original: string = link): Promise<string | undefined> {
	let target: string;
	try {
		target = await fs.readlink(link);
	} catch {
		return undefined; // Missing or not a symlink.
	}
	return path.isAbsolute(target) && target.endsWith(path.join(`${path.sep}omp`, original)) ? target : undefined;
}

/** Retain a previous Snap profile until dead-scope pruning proves no daemon still uses it. */
async function retainRelocatedTarget(original: string, target: string): Promise<void> {
	for (let index = 1; ; index++) {
		const marker = `${original}.relocated.${index}`;
		try {
			await fs.symlink(target, marker);
			return;
		} catch (error) {
			if (!hasFsCode(error, "EEXIST")) throw error;
			if ((await fs.readlink(marker).catch(() => undefined)) === target) return;
		}
	}
}

/**
 * Make runtime-dir path `original` name the data actually stored at `actual`.
 *
 * A launcher that cannot write the runtime dir stores the data elsewhere (a
 * Snap-confined Chromium mirrors its profile under
 * `$SNAP_USER_COMMON/omp/<original path>`). That replaces whatever sits at
 * `original` with a symlink to `actual`, so the scope still owns the data and
 * pruning reclaims it ({@link removeRelocatedRuntimeData}). Retargeting or
 * returning to `original` keeps the previous Snap target recorded by a
 * separate link until dead-scope pruning confirms no broker still uses it.
 */
export async function placeRuntimeData(original: string, actual: string): Promise<void> {
	const previous = await relocatedTarget(original);
	if (actual === original) {
		if (previous === undefined) return;
		await retainRelocatedTarget(original, previous);
		await fs.rm(original, { force: true });
		return;
	}
	if ((await fs.readlink(original).catch(() => undefined)) === actual) return;
	if (previous !== undefined) await retainRelocatedTarget(original, previous);
	await fs.rm(original, { recursive: true, force: true });
	try {
		await fs.symlink(actual, original);
	} catch (error) {
		if (hasFsCode(error, "EEXIST") && (await fs.readlink(original).catch(() => undefined)) === actual) return;
		throw error;
	}
}

/** Remove relocated profiles once the broker and all clients have left the scope; see {@link placeRuntimeData}. */
export async function removeRelocatedRuntimeData(runtimeDir: string): Promise<void> {
	for (const name of await fs.readdir(runtimeDir)) {
		const marker = name.match(/^(.*)\.relocated\.[1-9]\d*$/);
		const link = path.join(runtimeDir, name);
		const original = path.join(runtimeDir, marker?.[1] ?? name);
		const target = await relocatedTarget(link, original);
		if (target !== undefined) await fs.rm(target, { recursive: true, force: true });
	}
}

/**
 * Canonicalize a project directory the same way every broker client does, so
 * hash-keyed runtime dirs and Windows pipe names agree across processes.
 * Missing paths and permission-denied lookups (EPERM/EACCES on protected
 * parent directories) resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error) || isEacces(error) || hasFsCode(error, "EPERM")) return resolved;
		throw error;
	}
}

/**
 * Record the scope's canonical project directory inside its runtime dir.
 * Written by the broker at startup so out-of-process inspectors (`omp ps`)
 * can map a hash-keyed runtime dir back to its project.
 */
export async function writeDaemonScopeMeta(runtimeDir: string, projectDir: string): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify({ projectDir }));
}

/** Read the project directory recorded for a runtime dir; undefined when absent or malformed. */
export async function readDaemonScopeMeta(runtimeDir: string): Promise<string | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			return raw.projectDir;
		}
	} catch {
		// Missing or malformed scope metadata reads as unknown.
	}
	return undefined;
}

/** One daemon record dir as stored on disk, before parsing. */
export interface StoredDaemonRecord {
	/** Decoded `meta.json`. */
	meta: object & { daemon: unknown };
	/** Decoded launch spec, from `meta.json` (legacy layout) or `spec.json`. */
	spec: unknown;
	/** The spec was embedded in `meta.json` by an older broker. */
	legacyLayout: boolean;
}

/**
 * Read a daemon record dir in either layout. Undefined when `meta.json` has no
 * daemon snapshot; throws when a file is missing or malformed.
 */
export async function readStoredDaemonRecord(dir: string): Promise<StoredDaemonRecord | undefined> {
	const meta: unknown = await Bun.file(path.join(dir, DAEMON_META_FILE)).json();
	if (typeof meta !== "object" || meta === null || !("daemon" in meta)) return undefined;
	if ("spec" in meta) return { meta, spec: meta.spec, legacyLayout: true };
	const spec: unknown = await Bun.file(path.join(dir, DAEMON_SPEC_FILE)).json();
	return { meta, spec, legacyLayout: false };
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\omp-daemon-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}
