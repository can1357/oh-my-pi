import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import {
	mergeSessionRanking,
	rankSessionSearchMatches,
} from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { listSessions, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getHistoryDbPath, getSessionsDir, TempDir } from "@oh-my-pi/pi-utils";

function makeSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `${id}.jsonl`,
		id,
		cwd: "/repo",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		size: 100,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	};
}

const ids = (sessions: SessionInfo[]): string[] => sessions.map(s => s.id);

describe("slotted session headers", () => {
	it("lists and ranks sessions whose mutable title slot is the first JSONL entry", async () => {
		const storage = new MemorySessionStorage();
		const sessionDir = "/sessions/project";
		const file = `${sessionDir}/slotted.jsonl`;
		storage.writeTextSync(
			file,
			[
				JSON.stringify({ type: "title", v: 1, title: "Slot Title", updatedAt: "2026-06-27T00:00:00.000Z" }),
				JSON.stringify({
					type: "session",
					id: "header-id",
					cwd: "/repo",
					title: "Stale Header Title",
					timestamp: "2026-06-27T00:00:00.000Z",
				}),
				JSON.stringify({ type: "message", message: { role: "user", content: "first prompt" } }),
				"",
			].join("\n"),
		);

		const sessions = await listSessions(sessionDir, storage);

		expect(sessions.map(session => ({ id: session.id, cwd: session.cwd, title: session.title }))).toEqual([
			{ id: "header-id", cwd: "/repo", title: "Slot Title" },
		]);
		expect(ids(rankSessionSearchMatches(sessions, "slot"))).toEqual(["header-id"]);
	});

	it("cleans history rows for archived slotted sessions by reading the header after the title slot", async () => {
		const tempDir = TempDir.createSync("@test-slotted-archive-");
		try {
			const root = tempDir.path();
			const archiveDir = path.join(root, "archive", "sessions", "project");
			const archived = path.join(archiveDir, "legacy-name.jsonl.gz");
			await Bun.write(
				archived,
				gzipSync(
					[
						JSON.stringify({
							type: "title",
							v: 1,
							title: "Archived Slot Title",
							updatedAt: "2026-06-27T00:00:00.000Z",
						}),
						JSON.stringify({
							type: "session",
							version: 3,
							id: "archive-header-id",
							timestamp: "2026-06-27T00:00:00.000Z",
							cwd: "/repo",
						}),
						"",
					].join("\n"),
				),
			);
			const dbPath = getHistoryDbPath(root);
			const db = new Database(dbPath);
			db.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
			db.run("INSERT INTO history (prompt, session_id) VALUES ('old prompt', 'archive-header-id')");
			db.close();

			const result = await runGcCommand({
				flags: {
					agentDir: root,
					archive: true,
					coldArchiveAfterDays: 30,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
					apply: true,
				},
			});

			const check = new Database(dbPath);
			const rows = check.prepare("SELECT session_id FROM history").all() as Array<{ session_id: string }>;
			check.close();
			expect(result.archive?.historyRowsDeleted).toBe(1);
			expect(rows).toEqual([]);
			expect(await Bun.file(path.join(getSessionsDir(root), "project", "legacy-name.jsonl")).exists()).toBe(false);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});
});

describe("rankSessionSearchMatches", () => {
	it("keeps literal query matches recency-first instead of overvaluing earlier word position", () => {
		const oldPrefix = makeSession("old-prefix", {
			title: "Resize Buffer Issue",
			firstMessage: "why doesnt resize properly clean the scrollback buffer",
			modified: new Date("2024-01-01T00:00:00Z"),
		});
		const oldControls = makeSession("old-controls", {
			title: "Resize Controls",
			firstMessage: "can you make width height resize always clean reset",
			modified: new Date("2024-01-01T01:00:00Z"),
		});
		const recentWindow = makeSession("recent-window", {
			title: "Window Resize Issues",
			firstMessage: "when i resize the window rapidly i end up with this",
			modified: new Date("2024-01-03T00:00:00Z"),
		});

		expect(ids(rankSessionSearchMatches([oldPrefix, oldControls, recentWindow], "resize"))).toEqual([
			"recent-window",
			"old-controls",
			"old-prefix",
		]);
	});

	it("keeps literal substring matches ahead of pure fuzzy matches", () => {
		const fuzzyRecent = makeSession("fuzzy-recent", {
			title: "Render Buffer",
			modified: new Date("2024-01-03T00:00:00Z"),
		});
		const literalOld = makeSession("literal-old", {
			title: "RB Notes",
			modified: new Date("2024-01-01T00:00:00Z"),
		});

		expect(ids(rankSessionSearchMatches([fuzzyRecent, literalOld], "rb"))).toEqual(["literal-old", "fuzzy-recent"]);
	});

	it("filters low-quality pure fuzzy matches while keeping exact matches", () => {
		const exact = makeSession("exact", {
			title: "MN Discussion",
		});
		const lowQuality = makeSession("low-quality", {
			title: "Random Notes",
		});

		expect(ids(rankSessionSearchMatches([exact, lowQuality], "mn"))).toEqual(["exact"]);
	});

	it("returns all sessions unchanged for an empty query", () => {
		const sessions = [makeSession("a"), makeSession("b")];

		expect(rankSessionSearchMatches(sessions, "   ")).toBe(sessions);
	});
});

describe("mergeSessionRanking", () => {
	it("orders prompt-history matches first by history rank, then metadata-only matches", () => {
		const all = ["a", "b", "c", "d", "e"].map(id => makeSession(id));
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = ["a", "b", "c"].map(id => byId.get(id)!); // metadata matches, already ranked
		const historyIds = ["c", "a", "e"]; // prompt matches, best→worst

		// c,a,e matched prompt history → lead in history order; b is metadata-only.
		expect(ids(mergeSessionRanking(all, fuzzy, historyIds))).toEqual(["c", "a", "e", "b"]);
	});

	it("never drops a metadata match and appends it after prompt-history matches", () => {
		const all = ["a", "b"].map(id => makeSession(id));
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = [byId.get("a")!];

		expect(ids(mergeSessionRanking(all, fuzzy, ["b"]))).toEqual(["b", "a"]);
	});

	it("surfaces purely history-matched sessions ordered by prompt-history rank", () => {
		const all = ["a", "b", "c"].map(id => makeSession(id));

		// No fuzzy match at all; c is the best prompt-history match, then a. b is excluded.
		expect(ids(mergeSessionRanking(all, [], ["c", "a"]))).toEqual(["c", "a"]);
	});

	it("ignores history matches for sessions absent from the list", () => {
		const all = [makeSession("a")];
		const byId = new Map(all.map(s => [s.id, s]));

		// "z" is matched in history but not resumable from this list → dropped.
		expect(ids(mergeSessionRanking(all, [byId.get("a")!], ["a", "z"]))).toEqual(["a"]);
	});

	it("returns the fuzzy result unchanged when there are no history matches", () => {
		const all = ["a", "b"].map(id => makeSession(id));
		const byId = new Map(all.map(s => [s.id, s]));
		const fuzzy = ["b", "a"].map(id => byId.get(id)!);

		expect(ids(mergeSessionRanking(all, fuzzy, []))).toEqual(["b", "a"]);
	});
});
