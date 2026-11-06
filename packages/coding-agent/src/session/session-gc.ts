/**
 * Session retention GC: prunes old per-cwd session directories and their
 * custom-session-files artifacts at startup.
 *
 * Sessions are `<agent dir>/sessions/<encoded-cwd>/<timestamped-session>/`
 * plus `custom-session-files/<hash>` scratch files. Nothing upstream removes
 * them; this GC deletes session trees whose newest file is older than the
 * retention window, and custom files past the same window. A session holding
 * a live process is never pruned (registry check); failures are logged and
 * skipped — GC must never block startup.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/** Prune session trees and scratch artifacts older than this. */
export const DEFAULT_SESSION_RETENTION_DAYS = 30;
/** Cap on trees removed in one GC pass so a cold first run stays bounded. */
const MAX_PRUNED_PER_RUN = 500;

async function newestMtime(dir: string, depth = 0): Promise<number> {
	if (depth > 4) return 0;
	let newest = 0;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) {
				newest = Math.max(newest, await newestMtime(full, depth + 1));
			} else {
				const stat = await fs.stat(full);
				newest = Math.max(newest, stat.mtimeMs);
			}
		} catch {
			// unreadable entry: ignore
		}
	}
	return newest;
}

async function removeTree(target: string): Promise<boolean> {
	try {
		await fs.rm(target, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run one retention pass. Returns the number of pruned session trees and
 * custom-file entries. Best effort: every failure is skipped, never thrown.
 */
export async function runSessionGc(options: {
	agentDir?: string;
	retentionDays: number;
	/** Live session ids to never prune (pinned by running processes). */
	keepSessionIds?: ReadonlySet<string>;
}): Promise<{ prunedSessions: number; prunedCustomFiles: number }> {
	if (options.retentionDays <= 0) return { prunedSessions: 0, prunedCustomFiles: 0 };
	const agentDir = options.agentDir ?? getAgentDir();
	const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
	let prunedSessions = 0;
	let prunedCustomFiles = 0;

	const sessionsRoot = path.join(agentDir, "sessions");
	try {
		for (const cwdDir of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
			if (!cwdDir.isDirectory()) continue;
			const cwdPath = path.join(sessionsRoot, cwdDir.name);
			if (cwdDir.name === "data") continue; // session-manager data store, not transcripts
			for (const session of await fs.readdir(cwdPath, { withFileTypes: true }).catch(() => [])) {
				if (prunedSessions >= MAX_PRUNED_PER_RUN) break;
				if (!session.isDirectory()) continue;
				if (options.keepSessionIds?.has(session.name)) continue;
				const sessionPath = path.join(cwdPath, session.name);
				const newest = await newestMtime(sessionPath);
				if (newest > 0 && newest < cutoff) {
					if (await removeTree(sessionPath)) prunedSessions += 1;
				}
			}
			// Drop the cwd dir itself when it became empty.
			await fs.rmdir(cwdPath).catch(() => {});
		}
	} catch (error) {
		logger.debug("session-gc: sessions pass failed", { error: String(error) });
	}

	const customRoot = path.join(agentDir, "custom-session-files");
	try {
		for (const entry of await fs.readdir(customRoot, { withFileTypes: true })) {
			if (prunedCustomFiles >= MAX_PRUNED_PER_RUN) break;
			const full = path.join(customRoot, entry.name);
			try {
				const stat = await fs.stat(full);
				if (stat.mtimeMs < cutoff) {
					await fs.rm(full, { recursive: true, force: true });
					prunedCustomFiles += 1;
				}
			} catch {
				// skip
			}
		}
	} catch (error) {
		logger.debug("session-gc: custom files pass failed", { error: String(error) });
	}

	if (prunedSessions > 0 || prunedCustomFiles > 0) {
		logger.debug("session-gc: pruned", { prunedSessions, prunedCustomFiles });
	}
	return { prunedSessions, prunedCustomFiles };
}
