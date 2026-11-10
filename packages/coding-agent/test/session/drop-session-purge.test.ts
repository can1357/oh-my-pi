import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import {
	closeSessionIndex,
	recordSessionRecap,
	recordSessionTitle,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getHistoryDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
const originalConfigDir = process.env.PI_CONFIG_DIR;
let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-drop-session-purge-");
	HistoryStorage.close();
	closeSessionIndex();
	// Both stores resolve under the isolated config root: history.db via the agent dir, stats.db via the root.
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	HistoryStorage.close();
	closeSessionIndex();
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	setAgentDir(originalAgentDir);
	tempDir.removeSync();
});

async function createSession(prompt: string): Promise<SessionManager> {
	const session = SessionManager.create(tempDir.join("project"));
	session.appendMessage({ role: "user", content: prompt, timestamp: 1 });
	await session.flush();
	const id = session.getSessionId();
	await HistoryStorage.open().add(prompt, tempDir.join("project"), id);
	recordSessionTitle(id, `${prompt} title`);
	recordSessionRecap(id, tempDir.join("project"), `${prompt} recap`);
	return session;
}

describe("SessionManager.dropSession", () => {
	it("purges the dropped session's prompts, search index, title, and recaps but keeps other sessions'", async () => {
		const kept = await createSession("kept-marker");
		const dropped = await createSession("dropped-marker");
		const droppedFile = dropped.getSessionFile();
		if (!droppedFile) throw new Error("Expected session file");

		await dropped.dropSession(droppedFile);

		const history = HistoryStorage.open();
		expect(history.search("marker", 10).map(entry => entry.prompt)).toEqual(["kept-marker"]);
		const db = new Database(getHistoryDbPath(), { readonly: true });
		try {
			const ftsHits = db.query("SELECT rowid FROM history_fts WHERE history_fts MATCH 'dropped'").all();
			expect(ftsHits).toEqual([]);
			const sessionsWith = (table: string) =>
				db
					.query<{ session_id: string }, []>(`SELECT DISTINCT session_id FROM ${table} ORDER BY session_id`)
					.all()
					.map(row => row.session_id);
			expect(sessionsWith("session_titles")).toEqual([kept.getSessionId()]);
			expect(sessionsWith("session_recaps")).toEqual([kept.getSessionId()]);
		} finally {
			db.close();
		}
	});
});
