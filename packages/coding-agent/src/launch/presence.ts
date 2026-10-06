import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import {
	canonicalProjectDir,
	daemonBrokerEndpoint,
	daemonRuntimeDir,
	probeBrokerEndpoint,
	readDaemonScopeMeta,
} from "./paths";

const CLIENTS_DIR = "clients";
const BROKER_PID_FILE = "broker.pid";
/**
 * Basename of the container holding per-project daemon scopes
 * (`<state>/run/daemons`). {@link pruneDeadDaemonRuntimeDirs} refuses to sweep
 * any other root so a runtime dir passed from outside the state tree cannot
 * turn the reclaim into an rm -rf of unrelated neighbours (issue #8721).
 */
const DAEMONS_DIR = "daemons";
/**
 * Name shape of a project daemon scope: the 16-hex wyhash of the project dir
 * produced by `getDaemonRuntimeDir`. Only entries matching this are pruned,
 * which excludes the machine-global `global` container and any foreign dir.
 */
const DAEMON_SCOPE_KEY = /^[0-9a-f]{16}$/;
/**
 * Grace before a dead daemon runtime dir becomes prune-eligible. Guards against
 * deleting a scope whose owning omp process is mid-startup (token written, broker
 * not yet spawned, presence not yet registered). The leak this reclaims is a
 * weeks-scale accumulation, so a few minutes of slack costs nothing.
 */
const DAEMON_RUNTIME_STALE_GRACE_MS = 5 * 60_000;

/** A pid recorded in a daemon scope: a broker lease or a client presence entry. */
interface PidRecord {
	pid: number;
	/** {@link daemonProcessDomain} of the writer; absent in records from older builds. */
	domain?: unknown;
}

let processDomain: Promise<string> | undefined;

/**
 * Identity of the boot and PID namespace this process's pid belongs to (the
 * inputs of the X11 pointer registry's owner domain in `mpx.rs`). A recorded
 * pid means something only inside the domain that wrote it: containers and
 * hosts sharing one state directory each see the others' pids as dead or as
 * unrelated processes. Off Linux, or where procfs cannot say, the platform
 * name: processes on one such platform compare equal and keep the pid test,
 * while every other platform reads their records as foreign.
 */
export function daemonProcessDomain(): Promise<string> {
	processDomain ??= readProcessDomain();
	return processDomain;
}

async function readProcessDomain(): Promise<string> {
	if (process.platform === "linux") {
		try {
			// node:fs, not Bun.file(): the broker records this before it listens, and
			// a Bun.file read holds no event-loop ref there.
			const [boot, namespace] = await Promise.all([
				fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
				fs.readlink("/proc/self/ns/pid"),
			]);
			return `${boot.trim()}/${namespace}`;
		} catch {
			// procfs cannot place this process; fall back to the platform.
		}
	}
	return process.platform;
}

function isPidRecord(value: unknown): value is PidRecord {
	return typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number";
}

/**
 * `foreign` when the record comes from another domain: its pid names nothing
 * here, so its process can be proven neither alive nor dead. Records without
 * a domain fall back to the pid test. EPERM means the process exists under
 * another uid, so it reads as live.
 */
async function recordedProcessState(record: PidRecord): Promise<"live" | "dead" | "foreign"> {
	if (record.domain !== undefined && record.domain !== (await daemonProcessDomain())) return "foreign";
	try {
		process.kill(record.pid, 0);
		return "live";
	} catch (error) {
		return hasFsCode(error, "EPERM") ? "live" : "dead";
	}
}

/** Handle keeping one omp process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	close(): Promise<void>;
}

/** Register this omp process so project daemons survive while it remains alive. */
export async function registerDaemonProjectPresence(
	projectDir: string,
	runtimeOverride?: string,
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = runtimeOverride ?? daemonRuntimeDir(canonical);
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = path.join(clientsDir, `${id}.json`);
	await Bun.write(
		presencePath,
		JSON.stringify({ pid: process.pid, id, projectDir: canonical, domain: await daemonProcessDomain() }),
	);
	// POSIX modes are meaningless on Windows; chmod there only costs another syscall.
	if (process.platform !== "win32") await fs.chmod(presencePath, 0o600);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await fs.rm(presencePath, { force: true });
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { close };
}

/**
 * Return whether a registered omp process in this runtime directory is still
 * alive, removing unreadable or malformed entries and entries whose process is
 * provably gone. Entries from another domain are kept but not counted: their
 * process can be proven neither alive nor dead, and counting them would keep
 * the broker up for good once their domain is gone (a reboot, a removed
 * container).
 */
export async function hasLiveDaemonProjectPresence(runtimeDir: string): Promise<boolean> {
	return (await scanDaemonProjectPresence(runtimeDir, true)).live;
}

/**
 * Classify a scope's presence entries: `live` when one names a live process,
 * `unknown` when one names a process that can be proven neither alive nor
 * dead. With `clean` (the broker's own idle check), unreadable or malformed
 * entries and entries whose process is dead are removed. A sweep of sibling
 * scopes passes false: it must never rewrite a scope it might not own, and an
 * entry it cannot read is `unknown` to it.
 */
async function scanDaemonProjectPresence(
	runtimeDir: string,
	clean: boolean,
): Promise<{ live: boolean; unknown: boolean }> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return { live: false, unknown: false };
		throw error;
	}
	let live = false;
	let unknown = false;
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		let state: "live" | "dead" | "foreign" | "unreadable";
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			state = isPidRecord(decoded) ? await recordedProcessState(decoded) : "unreadable";
		} catch (error) {
			if (isEnoent(error)) continue; // Removed since the listing.
			state = "unreadable";
		}
		if (state === "live") live = true;
		else if (state === "foreign") unknown = true;
		else if (clean) await fs.rm(presencePath, { force: true });
		else if (state === "unreadable") unknown = true;
	}
	return { live, unknown };
}

/**
 * The scope's `broker.pid`: `absent` when there is none, `unreadable` when it
 * exists but cannot be read or decoded (a torn write, a mode this process may
 * not read), otherwise its record.
 */
async function readBrokerPidRecord(runtimeDir: string): Promise<PidRecord | "absent" | "unreadable"> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, BROKER_PID_FILE)).json();
		return isPidRecord(raw) ? raw : "unreadable";
	} catch (error) {
		return isEnoent(error) ? "absent" : "unreadable";
	}
}

/** PID recorded in the runtime dir's broker lease when that broker process is still alive; undefined otherwise. */
export async function readLiveDaemonBrokerPid(runtimeDir: string): Promise<number | undefined> {
	const record = await readBrokerPidRecord(runtimeDir);
	if (typeof record === "string") return undefined; // Missing or malformed broker.pid => no owning broker.
	try {
		process.kill(record.pid, 0);
		return record.pid;
	} catch {
		return undefined;
	}
}

/**
 * Remove sibling project daemon runtime directories whose broker is dead and
 * whose client-presence set is empty, reclaiming the disk that short-lived
 * project directories leave behind (issue #8674).
 *
 * Best-effort and non-throwing: a scope is deleted only when its `broker.pid`
 * is absent/dead, no live client presence remains, its endpoint reports that
 * nothing listens there, and it has been untouched for
 * {@link DAEMON_RUNTIME_STALE_GRACE_MS}. A record written in another domain
 * (see {@link daemonProcessDomain}) or one this process cannot read keeps the
 * scope, and the sweep never removes presence entries. The caller's own
 * `currentRuntimeDir` is always skipped, and the sweep runs only inside the
 * {@link DAEMONS_DIR} container over entries named like a {@link DAEMON_SCOPE_KEY}
 * — so a runtime dir relocated elsewhere (e.g. the smoke test under
 * `os.tmpdir()`) never reclaims unrelated neighbours (issue #8721).
 */
export async function pruneDeadDaemonRuntimeDirs(currentRuntimeDir: string): Promise<void> {
	const root = path.dirname(currentRuntimeDir);
	if (path.basename(root) !== DAEMONS_DIR) return;
	const current = path.resolve(currentRuntimeDir);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to scan daemon runtime root for pruning", {
				root,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !DAEMON_SCOPE_KEY.test(entry.name)) continue;
		const dir = path.join(root, entry.name);
		if (path.resolve(dir) === current) continue;
		try {
			const stat = await fs.stat(dir);
			if (now - stat.mtimeMs < DAEMON_RUNTIME_STALE_GRACE_MS) continue;
			const broker = await readBrokerPidRecord(dir);
			if (broker === "unreadable") continue;
			if (broker !== "absent" && (await recordedProcessState(broker)) !== "dead") continue;
			const presence = await scanDaemonProjectPresence(dir, false);
			if (presence.live || presence.unknown) continue;
			// The project dir only names a Windows pipe; a scope without scope.json
			// there cannot be probed, and the checks above decide alone.
			const endpoint = daemonBrokerEndpoint((await readDaemonScopeMeta(dir)) ?? dir, dir);
			if ((await probeBrokerEndpoint(endpoint)) !== "dead") continue;
			await fs.rm(dir, { recursive: true, force: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			logger.warn("Failed to prune dead daemon runtime dir", {
				dir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
