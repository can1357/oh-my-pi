import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRecentSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resetSessionTitleIndexForTests } from "@oh-my-pi/pi-coding-agent/session/title-index";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

/**
 * Contracts for the history.db-backed recent-sessions path: welcome-screen
 * names must resolve from the title index without reading session file
 * contents, legacy files must fall back to a header scan that backfills the
 * index, and ordering must follow file mtime.
 */
describe("recent sessions title index", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recent-titles-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
		resetSessionTitleIndexForTests();
	});

	afterEach(() => {
		resetSessionTitleIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	async function createTitledSession(title: string): Promise<{ sessionDir: string; sessionFile: string }> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName(title, "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("session did not materialize");
		await session.close();
		return { sessionDir: path.dirname(sessionFile), sessionFile };
	}

	it("resolves a titled session from the index without reading file contents", async () => {
		const { sessionDir, sessionFile } = await createTitledSession("Indexed title");

		// Truncate the file: a content scan can no longer produce a name, so a
		// correct result proves the lookup came from the index.
		fs.truncateSync(sessionFile, 0);

		const recent = await getRecentSessions(sessionDir);
		expect(recent).toHaveLength(1);
		expect(recent[0].name).toBe("Indexed title");
		expect(recent[0].path).toBe(sessionFile);
	});

	it("falls back to a header scan for unindexed files and backfills the index", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const id = Bun.randomUUIDv7();
		const legacyFile = path.join(sessionDir, `2024-01-01T00-00-00-000Z_${id}.jsonl`);
		const header = {
			type: "session",
			version: 4,
			id,
			timestamp: "2024-01-01T00:00:00.000Z",
			cwd,
			title: "Legacy title",
		};
		fs.writeFileSync(legacyFile, `${JSON.stringify(header)}\n`);

		// First call: no index row, name comes from the 4KB header scan.
		const first = await getRecentSessions(sessionDir);
		expect(first).toHaveLength(1);
		expect(first[0].name).toBe("Legacy title");

		// The scan must have backfilled the index: after truncation the file is
		// unscannable, so the second call can only succeed via the stored row.
		fs.truncateSync(legacyFile, 0);
		const second = await getRecentSessions(sessionDir);
		expect(second).toHaveLength(1);
		expect(second[0].name).toBe("Legacy title");
	});

	it("orders by file mtime, enforces the limit, and names untitled sessions from their first prompt", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const writeSession = (name: string, title: string | undefined, firstMessage: string, mtime: Date): string => {
			const id = Bun.randomUUIDv7();
			const file = path.join(sessionDir, `${name}_${id}.jsonl`);
			const header = { type: "session", version: 4, id, timestamp: mtime.toISOString(), cwd, title };
			const message = {
				type: "message",
				id: "m1",
				parentId: null,
				message: { role: "user", content: firstMessage, timestamp: 1 },
			};
			fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
			fs.utimesSync(file, mtime, mtime);
			return file;
		};

		writeSession("2024-01-01T00-00-00-000Z", "Oldest", "old prompt", new Date("2024-01-01T00:00:00Z"));
		const middle = writeSession(
			"2024-02-01T00-00-00-000Z",
			undefined,
			"middle prompt",
			new Date("2024-02-01T00:00:00Z"),
		);
		const newest = writeSession("2024-03-01T00-00-00-000Z", "Newest", "new prompt", new Date("2024-03-01T00:00:00Z"));

		const recent = await getRecentSessions(sessionDir, 2);
		expect(recent.map(s => s.path)).toEqual([newest, middle]);
		expect(recent[0].name).toBe("Newest");
		expect(recent[1].name).toBe("middle prompt");
	});
});
