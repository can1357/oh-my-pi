import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const timestamp = "2026-01-01T00:00:00.000Z";
const assistant = {
	role: "assistant",
	provider: "anthropic",
	model: "claude-3-7-sonnet",
	api: "anthropic-messages",
	content: [{ type: "text", text: "A useful reply" }],
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
} as const;

for (const backend of ["File", "Memory", "SQLite"] as const) {
	describe(`session listing empty-title normalization (${backend})`, () => {
		let root: string;
		let storage: SessionStorage;
		let client: InstanceType<typeof SQL> | undefined;
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

		beforeEach(async () => {
			root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-listing-empty-title-"));
			setAgentDir(path.join(root, "agent"));
			if (backend === "SQLite") {
				client = new SQL("sqlite::memory:");
				storage = await SqlSessionStorage.create({ client });
			} else {
				storage = backend === "File" ? new FileSessionStorage() : new MemorySessionStorage();
			}
		});

		afterEach(async () => {
			await client?.end();
			client = undefined;
			setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			fs.rmSync(root, { recursive: true, force: true });
		});

		it("returns undefined, not an empty title, for a newly materialized untitled session", async () => {
			const sessionDir = path.join(root, "sessions");
			const manager = SessionManager.create(root, sessionDir, storage);
			await manager.ensureOnDisk();
			await manager.close();

			const listed = await SessionManager.list(root, sessionDir, storage);
			expect(listed).toHaveLength(1);
			expect(listed[0].path).toBe(manager.getSessionFile()!);
			expect(listed[0].title).toBeUndefined();
		});

		it("uses the compaction short summary when the manager's physical title slot is empty", async () => {
			const sessionDir = path.join(root, "sessions");
			const manager = SessionManager.create(root, sessionDir, storage);
			manager.appendMessage({ role: "user", content: "Summarize this task", timestamp: 1 });
			const keptEntry = manager.appendMessage({ ...assistant, content: [...assistant.content] });
			await manager.flush();
			manager.appendCompaction("A longer archived summary", "Compacted task", keptEntry, 100);
			await manager.close();

			const readText = spyOn(storage, "readText");
			const query = client ? spyOn(client, "unsafe") : undefined;
			try {
				const listed = await SessionManager.list(root, sessionDir, storage);
				expect(listed).toHaveLength(1);
				expect(listed[0].title).toBe("Compacted task");
				if (backend !== "Memory") expect(readText).not.toHaveBeenCalled();
				expect(query?.mock.calls.filter(([sql]) => /^SELECT content AS content\b/i.test(sql)) ?? []).toEqual([]);
			} finally {
				readText.mockRestore();
				query?.mockRestore();
			}
		});

		it("keeps journal clears authoritative over a stale header while retaining summary fallback", async () => {
			const sessionDir = path.join(root, "sessions");
			const cases = [
				{ id: "empty", title: "", summary: undefined, expected: undefined },
				{
					id: "missing",
					title: undefined,
					summary: "Summary after missing clear",
					expected: "Summary after missing clear",
				},
				{ id: "whitespace", title: " \t\r\n ", summary: undefined, expected: undefined },
				{
					id: "empty-summary",
					title: "",
					summary: "Summary after empty clear",
					expected: "Summary after empty clear",
				},
				{
					id: "whitespace-summary",
					title: " \t ",
					summary: "Summary after whitespace clear",
					expected: "Summary after whitespace clear",
				},
				{
					id: "whitespace-slot",
					title: " \t ",
					summary: "Summary after empty slot",
					expected: "Summary after empty slot",
					slotOnly: true,
				},
			];
			for (const testCase of cases) {
				const records: unknown[] = [
					{ type: "session", version: 3, id: testCase.id, cwd: root, timestamp, title: "Stale header title" },
					{ type: "message", id: "assistant", parentId: null, timestamp, message: assistant },
				];
				if (testCase.summary) records.push({ type: "compaction", shortSummary: testCase.summary });
				if (!testCase.slotOnly) {
					records.push({
						type: "title_change",
						id: "clear",
						parentId: "assistant",
						timestamp,
						title: testCase.title,
						source: "user",
					});
				}
				const slot = serializeTitleSlot({
					title: testCase.slotOnly ? testCase.title! : "Stale slot title",
					updatedAt: timestamp,
				});
				await storage.writeText(
					path.join(sessionDir, `${testCase.id}.jsonl`),
					slot + `${records.map(record => JSON.stringify(record)).join("\n")}\n`,
				);
			}

			const readText = spyOn(storage, "readText");
			const query = client ? spyOn(client, "unsafe") : undefined;
			try {
				const listed = await SessionManager.list(root, sessionDir, storage);
				expect(Object.fromEntries(listed.map(info => [info.id, info.title]))).toEqual(
					Object.fromEntries(cases.map(testCase => [testCase.id, testCase.expected])),
				);
				if (backend === "SQLite") expect(readText).not.toHaveBeenCalled();
				expect(query?.mock.calls.filter(([sql]) => /^SELECT content AS content\b/i.test(sql)) ?? []).toEqual([]);
			} finally {
				readText.mockRestore();
				query?.mockRestore();
			}
		});
	});
}
