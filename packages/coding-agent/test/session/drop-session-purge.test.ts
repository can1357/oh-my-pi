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

const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const originalAgentDir = getAgentDir();
const originalEnv: Record<string, string | undefined> = {};
let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-drop-session-purge-");
	HistoryStorage.close();
	closeSessionIndex();
	// An XDG override would route both stores to a shared data dir, so clear it; then
	// history.db resolves under the temp agent dir and stats.db under the temp config root.
	for (const key of ["PI_CONFIG_DIR", ...XDG_KEYS]) {
		originalEnv[key] = process.env[key];
		delete process.env[key];
	}
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	HistoryStorage.close();
	closeSessionIndex();
	for (const key in originalEnv) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
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
			const ids = [kept.getSessionId(), dropped.getSessionId()];
			const sessionsWith = (table: string) =>
				db
					.query<{ session_id: string }, [string, string]>(
						`SELECT DISTINCT session_id FROM ${table} WHERE session_id IN (?, ?)`,
					)
					.all(ids[0], ids[1])
					.map(row => row.session_id);
			expect(sessionsWith("session_titles")).toEqual([kept.getSessionId()]);
			expect(sessionsWith("session_recaps")).toEqual([kept.getSessionId()]);
		} finally {
			db.close();
		}
	});
});
