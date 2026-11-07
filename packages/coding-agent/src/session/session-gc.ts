/**
 * Best-effort startup retention for session transcripts and their sibling
 * artifact trees. Custom-session-file markers are removed only if their
 * recorded transcript is gone.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCustomSessionFilesDir, getSessionsDir, isEnoent, isEnotdir, logger } from "@oh-my-pi/pi-utils";
import { AgentRegistry } from "../registry/agent-registry";
import { readSessionHeaderId } from "./session-loader";
import { tryAcquireSessionLease } from "./session-storage";

/** Prune sessions older than this. */
export const DEFAULT_SESSION_RETENTION_DAYS = 30;
/** Cap on sessions and markers removed in one GC pass. */
const MAX_PRUNED_PER_RUN = 500;

/** Include directory mtimes, and fail closed if any part of a tree cannot be read. */
async function newestMtime(target: string): Promise<number> {
	const stat = await fs.lstat(target);
	let newest = stat.mtimeMs;
	if (stat.isDirectory()) {
		for (const entry of await fs.readdir(target)) {
			newest = Math.max(newest, await newestMtime(path.join(target, entry)));
		}
	}
	return newest;
}

/** Run one best-effort retention pass, returning counts of removed sessions and markers. */
export async function runSessionGc(options: {
	agentDir?: string;
	retentionDays: number;
	/** Session ids to never prune (including the session starting this pass). */
	keepSessionIds?: ReadonlySet<string>;
}): Promise<{ prunedSessions: number; prunedCustomFiles: number }> {
	if (options.retentionDays <= 0) return { prunedSessions: 0, prunedCustomFiles: 0 };
	const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
	let prunedSessions = 0;
	let prunedCustomFiles = 0;

	const sessionsRoot = getSessionsDir(options.agentDir);
	try {
		for (const cwdDir of await fs.readdir(sessionsRoot, { withFileTypes: true })) {
			if (!cwdDir.isDirectory() || cwdDir.name === "data") continue;
			const cwdPath = path.join(sessionsRoot, cwdDir.name);
			for (const session of await fs.readdir(cwdPath, { withFileTypes: true }).catch(() => [])) {
				if (prunedSessions >= MAX_PRUNED_PER_RUN) break;
				if (!session.isFile() || !session.name.endsWith(".jsonl")) continue;
				const base = session.name.slice(0, -".jsonl".length);
				const separator = base.indexOf("_");
				if (separator < 0 || separator === base.length - 1) continue;
				const transcript = path.join(cwdPath, session.name);
				const artifacts = path.join(cwdPath, base);
				try {
					const id = (await readSessionHeaderId(transcript)) ?? base.slice(separator + 1);
					if (options.keepSessionIds?.has(id)) continue;
					const live = AgentRegistry.global()
						.list()
						.some(ref => {
							if ((ref.status !== "running" && ref.status !== "idle") || !ref.sessionFile) return false;
							const file = path.resolve(ref.sessionFile);
							const relative = path.relative(artifacts, file);
							return (
								file === path.resolve(transcript) ||
								(relative !== "" &&
									!relative.startsWith(`..${path.sep}`) &&
									relative !== ".." &&
									!path.isAbsolute(relative))
							);
						});
					if (live) continue;
					const lease = tryAcquireSessionLease(id);
					if (!lease) continue;
					try {
						let newest = (await fs.stat(transcript)).mtimeMs;
						let hasArtifacts = true;
						try {
							await fs.lstat(artifacts);
						} catch (error) {
							if (!isEnoent(error)) throw error;
							hasArtifacts = false;
						}
						if (hasArtifacts) newest = Math.max(newest, await newestMtime(artifacts));
						if (newest >= cutoff) continue;
						await fs.rm(artifacts, { recursive: true, force: true });
						await fs.rm(transcript);
						prunedSessions += 1;
					} finally {
						lease.release();
					}
				} catch {
					// Unreadable or concurrently changed sessions are left alone.
				}
			}
			await fs.rmdir(cwdPath).catch(() => {});
		}
	} catch (error) {
		logger.debug("session-gc: sessions pass failed", { error: String(error) });
	}

	try {
		const customRoot = getCustomSessionFilesDir(options.agentDir);
		for (const entry of await fs.readdir(customRoot, { withFileTypes: true })) {
			if (prunedCustomFiles >= MAX_PRUNED_PER_RUN) break;
			if (!entry.isFile()) continue;
			const marker = path.join(customRoot, entry.name);
			try {
				const target = (await Bun.file(marker).text()).trim();
				if (!target || !path.isAbsolute(target)) continue;
				try {
					await fs.stat(target);
					continue;
				} catch (error) {
					if (!isEnoent(error) && !isEnotdir(error)) continue;
				}
				await fs.rm(marker);
				prunedCustomFiles += 1;
			} catch {
				// Keep unreadable or concurrently changed markers.
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
