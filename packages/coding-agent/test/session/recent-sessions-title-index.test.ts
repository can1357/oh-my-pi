import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getRecentSessions, listSessionsForPicker } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	closeSessionIndex,
	lookupSessionTitle,
	recordSessionTitle,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
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
		closeSessionIndex();
	});

	afterEach(() => {
		closeSessionIndex();
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

	it("keeps the index while a journal cannot be read for its title, and reads the title once it can", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const timestamp = "2024-01-01T00:00:00.000Z";
		const writeRenamed = (id: string): string => {
			const file = path.join(sessionDir, `2024-01-01T00-00-00-000Z_${id}.jsonl`);
			const records = [
				{ type: "session", version: 3, id, timestamp, cwd, title: "Header title" },
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp,
					message: { role: "user", content: "hello", timestamp: 1 },
				},
				{
					type: "title_change",
					id: "renamed",
					parentId: "root",
					timestamp,
					title: "Journal title",
					source: "user",
				},
			];
			fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
			return file;
		};
		const indexedId = Bun.randomUUIDv7();
		const unindexedId = Bun.randomUUIDv7();
		const unreadable = new Set([writeRenamed(indexedId), writeRenamed(unindexedId)]);
		recordSessionTitle(indexedId, "Journal title");
		const scanTitles = async () =>
			Object.fromEntries(
				(await (await listSessionsForPicker(sessionDir, new FileSessionStorage(), new Set())).complete).map(
					session => [session.id, session.title],
				),
			);

		const realFile = Bun.file.bind(Bun);
		const fileSpy = spyOn(Bun, "file").mockImplementation((source, options) => {
			const file = realFile(source as string, options);
			if (unreadable.has(source as string)) {
				file.stream = () =>
					new ReadableStream<Uint8Array<ArrayBuffer>>({
						pull(controller) {
							controller.error(new Error("title read failed"));
						},
					});
			}
			return file;
		});
		try {
			// Listed under the indexed title, else the header's; neither is written to the index.
			expect(await scanTitles()).toEqual({ [indexedId]: "Journal title", [unindexedId]: "Header title" });
			expect((await getRecentSessions(sessionDir)).map(recent => recent.name).sort()).toEqual([
				"Header title",
				"Journal title",
			]);
			expect(lookupSessionTitle(indexedId)).toBe("Journal title");
			expect(lookupSessionTitle(unindexedId)).toBeUndefined();
		} finally {
			fileSpy.mockRestore();
		}

		// The files' stat identity is unchanged: only an uncached scan finds the journal title.
		expect(await scanTitles()).toEqual({ [indexedId]: "Journal title", [unindexedId]: "Journal title" });
		expect(lookupSessionTitle(unindexedId)).toBe("Journal title");
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
