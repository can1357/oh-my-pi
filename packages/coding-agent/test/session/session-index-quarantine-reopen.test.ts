import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeSessionIndex, recordSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getHistoryDbPath, openSqliteDatabaseSync, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Quarantining a corrupt history.db unlinks the file and its sidecars, then
 * recreates a store at the very same path. In-process, HistoryStorage closes
 * the session index before it quarantines; a peer process cannot, so this
 * process's index connection stays cached on the path. Cached on the path
 * alone it stays attached to the unlinked inode, and a title written after
 * the peer's recovery lands nowhere a later reader can see.
 */
describe.skipIf(process.platform === "win32")("session index across a peer's store quarantine", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-index-quarantine-"));
		setAgentDir(testAgentDir);
		closeSessionIndex();
	});

	afterEach(() => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("writes a title visible to a fresh reader after another process quarantined and recreated history.db", () => {
		const dbPath = getHistoryDbPath();
		recordSessionTitle("session-a", "before quarantine");
		expect(fs.existsSync(dbPath)).toBe(true);

		// Corrupt the store underneath this process's still-open index connection,
		// then recover it the way a peer process's opener does, without touching
		// that connection.
		fs.writeFileSync(dbPath, "definitely not a sqlite database");
		for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
		openSqliteDatabaseSync(
			dbPath,
			db => {
				db.run("PRAGMA journal_mode=WAL");
				return db;
			},
			{ recoverCorruption: true },
		).close();
		expect(fs.readdirSync(path.dirname(dbPath)).some(name => name.startsWith("history.db.corrupt-"))).toBe(true);

		// This write is the one that used to disappear into the unlinked inode.
		recordSessionTitle("session-b", "after quarantine");

		// A plain connection, like any other process opening the store: the
		// cached index handle cannot vouch for itself here.
		const reader = new Database(dbPath);
		try {
			const row = reader
				.query<{ title: string }, [string]>("SELECT title FROM session_titles WHERE session_id = ?")
				.get("session-b");
			expect(row?.title).toBe("after quarantine");
		} finally {
			reader.close();
		}
	});
});
