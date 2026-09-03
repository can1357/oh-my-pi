/**
 * Sharpshooter delta queue.
 *
 * Producers (per-prompt extraction) write one JSON file per delta under
 * `queue/<sessionId>/`; the consolidator lists, applies, and unlinks exactly the
 * files it read. File-per-delta makes producers lock-free: there is no shared
 * append fd to race against a consuming rename, and a crash between apply and
 * unlink only re-delivers deltas (consolidation is idempotent by construction —
 * newest-wins over full-file rewrites).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { sharpshooterQueueDir } from "./paths";
import type { SharpshooterDelta } from "./types";

/** One queued delta plus the file backing it (consume token). */
export interface QueuedSharpshooterDelta {
	delta: SharpshooterDelta;
	file: string;
}

/** All queued deltas of one session, ordered oldest-first. */
export interface SharpshooterSessionDeltas {
	sessionId: string;
	deltas: QueuedSharpshooterDelta[];
}

const SESSION_DIR_RE = /^[A-Za-z0-9_-]+$/;

function queueFileName(ts: number): string {
	// ts36 zero-padded so lexical order == chronological order; nonce breaks
	// same-millisecond collisions from concurrent extractions.
	const nonce = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `${ts.toString(36).padStart(10, "0")}-${nonce}.json`;
}

/** Persist one delta into the session's queue directory. */
export async function appendSharpshooterDelta(agentDir: string, cwd: string, delta: SharpshooterDelta): Promise<void> {
	const dir = path.join(sharpshooterQueueDir(agentDir, cwd), sanitizeSessionId(delta.sessionId));
	await Bun.write(path.join(dir, queueFileName(delta.ts)), JSON.stringify(delta));
}

/**
 * Session ids become directory names; strip anything path-hostile. Ids are
 * UUID-shaped in practice, so this is defense, not normalization.
 */
export function sanitizeSessionId(sessionId: string): string {
	const cleaned = sessionId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "session";
}

/**
 * List every queued delta grouped per session, sessions ordered by their oldest
 * queued delta and deltas ordered oldest-first within each session. Unreadable
 * or corrupt entries are skipped (never consumed), so a torn write cannot wedge
 * the queue.
 */
export async function listSharpshooterDeltas(agentDir: string, cwd: string): Promise<SharpshooterSessionDeltas[]> {
	const queueRoot = sharpshooterQueueDir(agentDir, cwd);
	let sessionDirs: string[];
	try {
		sessionDirs = (await fs.readdir(queueRoot, { withFileTypes: true }))
			.filter(entry => entry.isDirectory() && SESSION_DIR_RE.test(entry.name))
			.map(entry => entry.name);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}

	const groups: SharpshooterSessionDeltas[] = [];
	for (const sessionId of sessionDirs) {
		const dir = path.join(queueRoot, sessionId);
		const names = (await fs.readdir(dir).catch(() => [] as string[]))
			.filter(name => name.endsWith(".json"))
			.sort((a, b) => a.localeCompare(b));
		const deltas: QueuedSharpshooterDelta[] = [];
		for (const name of names) {
			const file = path.join(dir, name);
			try {
				const parsed = (await Bun.file(file).json()) as SharpshooterDelta;
				if (parsed && typeof parsed === "object" && parsed.v === 1 && typeof parsed.statement === "string") {
					deltas.push({ delta: parsed, file });
				}
			} catch {
				// Torn or foreign file: leave it for manual inspection, never consume.
			}
		}
		if (deltas.length > 0) groups.push({ sessionId, deltas });
	}

	groups.sort((a, b) => (a.deltas[0]?.delta.ts ?? 0) - (b.deltas[0]?.delta.ts ?? 0));
	return groups;
}

/**
 * Remove consumed delta files and prune emptied session directories. Missing
 * files are ignored — a concurrent consumer or manual cleanup already won.
 */
export async function consumeSharpshooterDeltas(files: readonly string[]): Promise<void> {
	const dirs = new Set<string>();
	for (const file of files) {
		try {
			await fs.rm(file, { force: true });
		} catch {
			// Best-effort: an unremovable file only causes re-delivery.
		}
		dirs.add(path.dirname(file));
	}
	for (const dir of dirs) {
		const remaining = await fs.readdir(dir).catch(() => null);
		if (remaining !== null && remaining.length === 0) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/** Total queued delta count across sessions (for status displays). */
export async function sharpshooterQueueDepth(agentDir: string, cwd: string): Promise<number> {
	const groups = await listSharpshooterDeltas(agentDir, cwd);
	return groups.reduce((sum, group) => sum + group.deltas.length, 0);
}
