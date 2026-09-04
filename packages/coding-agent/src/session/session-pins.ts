import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import type { SessionInfo } from "./session-listing";

const PINS_FILENAME = "session-pins.json";

function pinsPath(agentDir: string): string {
	return path.join(agentDir, PINS_FILENAME);
}

/**
 * Read the global set of pinned session ids (`~/.omp/session-pins.json`). Pins
 * are keyed by session id, not file path, so they survive `/move` renames.
 * A missing file yields an empty set; a corrupt one degrades to empty with a
 * warning rather than breaking the resume picker.
 */
export async function loadPinnedSessionIds(agentDir: string = getAgentDir()): Promise<Set<string>> {
	try {
		const pins: unknown = JSON.parse(await fs.readFile(pinsPath(agentDir), "utf-8"));
		if (!Array.isArray(pins)) return new Set();
		return new Set(pins.filter((id): id is string => typeof id === "string"));
	} catch (err) {
		if (isEnoent(err)) return new Set();
		logger.warn("Failed to read session pins", { error: err });
		return new Set();
	}
}

/**
 * Toggle one session's pin and persist the set; returns the new pinned state.
 *
 * The read-modify-write runs under the shared cross-process file lock and
 * commits via write-temp-then-rename, mirroring the MCP config writer: two omp
 * instances toggling pins concurrently can no longer lose each other's update
 * (load-load-write-write), and a crash mid-write leaves the previous pins file
 * intact instead of a truncated one that degrades to an empty set.
 */
export async function toggleSessionPin(sessionId: string, agentDir: string = getAgentDir()): Promise<boolean> {
	const filePath = pinsPath(agentDir);
	await fs.mkdir(agentDir, { recursive: true });
	return withFileLock(filePath, async () => {
		const pinned = await loadPinnedSessionIds(agentDir);
		if (!pinned.delete(sessionId)) pinned.add(sessionId);
		const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(tmpPath, JSON.stringify([...pinned], null, "\t"), { encoding: "utf-8", mode: 0o600 });
			await fs.rename(tmpPath, filePath);
		} catch (error) {
			await fs.rm(tmpPath, { force: true }).catch(() => {});
			throw error;
		}
		return pinned.has(sessionId);
	});
}

/**
 * Stable partition putting pinned sessions on top: within each group the
 * caller's order (recency) is preserved. Unknown ids are a no-op so stale
 * pins for deleted sessions never disturb the listing.
 */
export function sortPinnedFirst(sessions: SessionInfo[], pinnedIds: ReadonlySet<string>): SessionInfo[] {
	if (pinnedIds.size === 0) return sessions;
	const top: SessionInfo[] = [];
	const rest: SessionInfo[] = [];
	for (const session of sessions) (pinnedIds.has(session.id) ? top : rest).push(session);
	return top.length > 0 ? [...top, ...rest] : sessions;
}
