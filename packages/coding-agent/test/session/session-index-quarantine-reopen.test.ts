import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { recordSessionTitle, resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getHistoryDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Quarantining a corrupt history.db unlinks the file and its sidecars, then
 * recreates a store at the very same path. A session-index connection that is
 * cached on the path alone stays attached to the unlinked inode, so a title
 * written after the recovery lands nowhere a later reader can see.
 */
describe.skipIf(process.platform === "win32")("session index across a store quarantine", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-index-quarantine-"));
		setAgentDir(testAgentDir);
		resetSessionIndexForTests();
	});

	afterEach(() => {
		HistoryStorage.close();
		resetSessionIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("writes a title visible to a fresh reader after history.db is quarantined and recreated", () => {
		const dbPath = getHistoryDbPath();
		recordSessionTitle("session-a", "before quarantine");
		expect(fs.existsSync(dbPath)).toBe(true);

		// Corrupt the store underneath the still-open index connection, then let
		// the recovering opener preserve and replace it at the same path.
		fs.writeFileSync(dbPath, "definitely not a sqlite database");
		for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
		HistoryStorage.open(dbPath);
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
