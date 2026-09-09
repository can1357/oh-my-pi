/**
 * Best-effort evidence that a session file has a live process behind it.
 *
 * A write timestamp cannot distinguish a conversation closed seconds ago from
 * one still being written, so it is reported for operators but never treated as
 * liveness. On Linux, `/proc` is read directly: it is authoritative,
 * dependency-free, and makes no assumptions about PATH. `lsof` is only the
 * non-Linux fallback. The repository advisory lock is probed separately because
 * its Linux implementation uses abstract Unix sockets, which `/proc/locks`
 * cannot see; `/proc/locks` still catches future direct `flock(2)`/`fcntl` use.
 */

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { $which, logger, probeFileLock } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export type LivenessSignal = "advisory-lock" | "open-handle" | "posix-lock";

export interface LivenessHolder {
	pid: number;
	command?: string;
}

export interface SessionLiveness {
	path: string;
	live: boolean;
	signals: LivenessSignal[];
	holders: LivenessHolder[];
	secondsSinceWrite: number | undefined;
	degraded: string[];
}

export interface SessionLivenessOptions {
	/** Alternate procfs root for platform-safe tests. */
	procRoot?: string;
}

const SIGNAL_ORDER: readonly LivenessSignal[] = ["advisory-lock", "open-handle", "posix-lock"];

interface MutableInspection {
	signals: Set<LivenessSignal>;
	holders: Map<number, LivenessHolder>;
	degraded: Set<string>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function degrade(state: MutableInspection, reason: string, error?: unknown): void {
	const detail = error === undefined ? reason : `${reason}: ${message(error)}`;
	state.degraded.add(detail);
	logger.debug("Session liveness check degraded", { reason: detail });
}

function procLockIdentity(dev: number, ino: number): string {
	const device = BigInt(dev);
	const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
	const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
	return `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${BigInt(ino)}`;
}

function addHolder(state: MutableInspection, pid: number, command?: string): void {
	if (pid === process.pid || !Number.isSafeInteger(pid) || pid <= 0) return;
	const existing = state.holders.get(pid);
	if (!existing || (!existing.command && command)) state.holders.set(pid, command ? { pid, command } : { pid });
}

async function readCommand(procRoot: string, pid: number): Promise<string | undefined> {
	try {
		const command = (await Bun.file(nodePath.join(procRoot, String(pid), "comm")).text()).trim();
		return command || undefined;
	} catch {
		return undefined;
	}
}

async function inspectLinuxHandles(filePath: string, procRoot: string, state: MutableInspection): Promise<void> {
	let processEntries: string[];
	try {
		processEntries = await fs.readdir(procRoot);
	} catch (error) {
		degrade(state, `open-handle check could not read ${procRoot}`, error);
		return;
	}

	const resolved = nodePath.resolve(filePath);
	for (const entry of processEntries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		const fdRoot = nodePath.join(procRoot, entry, "fd");
		let descriptors: string[];
		try {
			descriptors = await fs.readdir(fdRoot);
		} catch {
			// Processes routinely exit or deny ptrace access during the scan.
			continue;
		}
		let holdsFile = false;
		for (const descriptor of descriptors) {
			try {
				const target = await fs.readlink(nodePath.join(fdRoot, descriptor));
				if (nodePath.resolve(target) === resolved) {
					holdsFile = true;
					break;
				}
			} catch {
				// The descriptor can disappear between readdir and readlink.
			}
		}
		if (!holdsFile) continue;
		state.signals.add("open-handle");
		addHolder(state, pid, await readCommand(procRoot, pid));
	}
}

async function inspectWithLsof(filePath: string, state: MutableInspection): Promise<void> {
	const lsof = $which("lsof");
	if (!lsof) {
		degrade(state, "open-handle check unavailable: lsof was not found");
		return;
	}
	try {
		const result = await $`${lsof} -t -- ${filePath}`.quiet().nothrow();
		if (result.exitCode > 1) {
			degrade(state, `open-handle check failed: lsof exited ${result.exitCode}`, result.stderr.toString().trim());
			return;
		}
		for (const line of result.text().split(/\s+/)) {
			if (!line) continue;
			const pid = Number(line);
			if (!Number.isSafeInteger(pid) || pid <= 0) continue;
			state.signals.add("open-handle");
			addHolder(state, pid);
		}
	} catch (error) {
		degrade(state, "open-handle check could not run lsof", error);
	}
}

async function inspectPosixLocks(
	stat: { dev: number; ino: number } | undefined,
	procRoot: string,
	state: MutableInspection,
): Promise<void> {
	if (!stat) return;
	let text: string;
	try {
		text = await Bun.file(nodePath.join(procRoot, "locks")).text();
	} catch (error) {
		degrade(state, `posix-lock check could not read ${nodePath.join(procRoot, "locks")}`, error);
		return;
	}
	const identity = procLockIdentity(stat.dev, stat.ino);
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		const identityIndex = fields.indexOf(identity);
		if (identityIndex < 1) continue;
		state.signals.add("posix-lock");
		const pid = Number(fields[identityIndex - 1]);
		addHolder(state, pid, await readCommand(procRoot, pid));
	}
}

/** Inspect every available OS liveness signal without throwing. */
export async function inspectSessionLiveness(
	filePath: string,
	options: SessionLivenessOptions = {},
): Promise<SessionLiveness> {
	const state: MutableInspection = {
		signals: new Set(),
		holders: new Map(),
		degraded: new Set(),
	};
	const resolved = nodePath.resolve(filePath);
	let stat: { dev: number; ino: number; mtimeMs: number } | undefined;
	try {
		stat = await fs.stat(resolved);
	} catch (error) {
		degrade(state, `could not stat ${resolved}`, error);
	}

	const advisory = probeFileLock(resolved);
	if (advisory.held) state.signals.add("advisory-lock");
	if (advisory.error) degrade(state, "advisory-lock check failed", advisory.error);

	const procRoot = options.procRoot ?? "/proc";
	if (process.platform === "linux" || options.procRoot !== undefined) {
		await Promise.all([inspectLinuxHandles(resolved, procRoot, state), inspectPosixLocks(stat, procRoot, state)]);
	} else {
		await inspectWithLsof(resolved, state);
		degrade(state, "posix-lock check unavailable: /proc/locks is Linux-only");
	}
	const signals = SIGNAL_ORDER.filter(signal => state.signals.has(signal));
	return {
		path: resolved,
		live: signals.length > 0,
		signals,
		holders: [...state.holders.values()].sort((left, right) => left.pid - right.pid),
		secondsSinceWrite: stat ? Math.max(0, (Date.now() - stat.mtimeMs) / 1000) : undefined,
		degraded: [...state.degraded],
	};
}
