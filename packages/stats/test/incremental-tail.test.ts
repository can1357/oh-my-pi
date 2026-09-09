import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, getFileOffset, getOverallStats, getRecentRequests, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-tail-");

beforeEach(() => {
	const temp = isolation.current();
	if (
		!temp ||
		path.resolve(os.homedir(), process.env.PI_CONFIG_DIR ?? "") !== temp.join("config") ||
		!getStatsDbPath().startsWith(`${temp.path()}${path.sep}`)
	) {
		throw new Error("Stats tests require an isolated temporary configuration and database");
	}
});

function assistant(id: string): string {
	return `${JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-09-07T12:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	})}\n`;
}

function tier(value: string | null): string {
	return `${JSON.stringify({ type: "service_tier_change", serviceTier: value })}\n`;
}

async function session(content: string): Promise<string> {
	const file = path.join(getSessionsDir(), "--tmp--tail", "session.jsonl");
	await Bun.write(file, content);
	return file;
}

describe("incremental stats ingestion", () => {
	for (const kind of ["message", "user", "tool", "tool-entry"] as const) {
		const title =
			kind === "tool-entry"
				? "preserves forked tool calls when a replacement reuses the call ID in a different entry"
				: `preserves forked ${kind} records when a replacement reuses an ID at a new timestamp`;
		it(title, async () => {
			const oldTime = Date.parse("2026-09-07T12:00:00Z");
			const newTime = kind === "tool-entry" ? oldTime : Date.parse("2026-09-07T13:00:00Z");
			const entry = (timestamp: number, id = "shared"): string =>
				`${JSON.stringify({
					type: "message",
					id,
					timestamp: new Date(timestamp).toISOString(),
					message: {
						role: kind === "user" ? "user" : "assistant",
						timestamp,
						content:
							kind === "tool" || kind === "tool-entry"
								? [{ type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } }]
								: [{ type: "text", text: "hello" }],
						model: "gpt-5.4",
						provider: "openai",
						api: "openai-responses",
						stopReason: "stop",
						usage:
							kind === "message"
								? {
										input: 10,
										output: 5,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 15,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									}
								: undefined,
					},
				})}\n`;
			const fork = path.join(getSessionsDir(), "--tmp--tail", "fork.jsonl");
			await Bun.write(fork, "");
			const owner = await session(entry(oldTime));
			await syncAllSessions({ workers: 1 });
			await Bun.write(fork, entry(oldTime));
			await syncAllSessions({ workers: 1 });
			const db = await initDb();
			db.prepare("DELETE FROM meta WHERE key = 'messages_cost_reingest_v1'").run();
			closeDb();
			await Bun.write(`${owner}.replacement`, entry(newTime, kind === "tool-entry" ? "new-entry" : "shared"));
			await fs.rename(`${owner}.replacement`, owner);
			const visited: string[] = [];
			await syncAllSessions({
				workers: 1,
				onProgress(progress) {
					visited.push(progress.sessionFile);
				},
			});
			expect(visited[0]).toBe(fork);
			await syncAllSessions({ workers: 1 });
			const table = kind === "message" ? "messages" : kind === "user" ? "user_messages" : "tool_calls";
			const rows = (await initDb()).prepare(`SELECT timestamp FROM ${table} ORDER BY timestamp`).all() as {
				timestamp: number;
			}[];
			expect(rows.map(row => row.timestamp)).toEqual([oldTime, newTime]);
		});
	}

	it("rebuilds a replaced transcript when a database backfill invalidates its cursor", async () => {
		const file = await session(assistant("old"));
		await syncAllSessions({ workers: 1 });
		const db = await initDb();
		db.prepare("DELETE FROM meta WHERE key = 'messages_cost_reingest_v1'").run();
		closeDb();
		await Bun.write(`${file}.replacement`, assistant("new"));
		await fs.rename(`${file}.replacement`, file);
		await syncAllSessions({ workers: 1 });
		expect(getRecentRequests().map(row => row.entryId)).toEqual(["new"]);
	});

	it("detects a second replacement after interruption without forgetting its previous file identity", async () => {
		const fileA = await session(assistant("oldA"));
		const fileB = path.join(path.dirname(fileA), "second.jsonl");
		await Bun.write(fileB, assistant("oldB"));
		await syncAllSessions({ workers: 1 });
		await fs.writeFile(fileA, assistant("newA"));
		await expect(
			syncAllSessions({
				workers: 1,
				onProgress(progress) {
					if (progress.sessionFile === fileA) throw new Error("interrupted after A");
				},
			}),
		).rejects.toThrow("interrupted after A");
		closeDb();
		await fs.writeFile(
			fileB,
			assistant("newB") + JSON.stringify({ type: "custom", padding: "x".repeat(8192) }) + "\n",
		);
		await syncAllSessions({ workers: 2 });
		expect(
			getRecentRequests()
				.map(row => row.entryId)
				.sort(),
		).toEqual(["newA", "newB"]);
	}, 15_000);

	for (const state of [null, "invalid JSON"] as const) {
		it(`rebuilds a larger replacement when persisted parser state is ${state === null ? "missing" : "invalid"}`, async () => {
			const file = await session(assistant("old"));
			await syncAllSessions({ workers: 1 });
			const db = await initDb();
			db.prepare("UPDATE file_offsets SET parser_state = ? WHERE session_file = ?").run(state, file);
			closeDb();
			await fs.writeFile(
				file,
				assistant("new") + JSON.stringify({ type: "custom", padding: "x".repeat(8192) }) + "\n",
			);
			await syncAllSessions({ workers: 1 });
			expect(getRecentRequests().map(row => row.entryId)).toEqual(["new"]);
		});
	}

	it("reads only appended bytes after reopening the database and retains priority accounting", async () => {
		const file = await session(
			tier("priority") +
				JSON.stringify({ type: "custom", padding: "x".repeat(2_000_000) }) +
				"\n" +
				assistant("first"),
		);
		await syncAllSessions({ workers: 1 });
		closeDb();
		const tail = assistant("second");
		await fs.appendFile(file, tail);
		const prototype = Object.getPrototypeOf(Bun.file(file)) as Bun.BunFile;
		const original = prototype.bytes;
		let readBytes = 0;
		const observer = spyOn(prototype, "bytes").mockImplementation(async function (this: Bun.BunFile) {
			const bytes = await original.call(this);
			readBytes += bytes.length;
			return bytes;
		});
		try {
			await syncAllSessions({ workers: 1 });
		} finally {
			observer.mockRestore();
		}
		expect(getOverallStats().totalRequests).toBe(2);
		expect(getOverallStats().totalPremiumRequests).toBe(2);
		expect(readBytes).toBeLessThan(Buffer.byteLength(tail) + 4096);
	});

	for (const operation of ["replace", "truncate"] as const) {
		it(`rebuilds derived totals after ${operation} instead of reusing the old offset and tier`, async () => {
			const file = await session(
				tier("priority") + assistant("old") + JSON.stringify({ type: "custom", padding: "x".repeat(8192) }) + "\n",
			);
			await syncAllSessions({ workers: 1 });
			const replacement = assistant("new");
			if (operation === "replace") {
				await Bun.write(`${file}.new`, replacement);
				await fs.rename(`${file}.new`, file);
			} else {
				await fs.writeFile(file, replacement);
			}
			await syncAllSessions({ workers: 1 });
			expect(getRecentRequests().map(row => row.entryId)).toEqual(["new"]);
			expect(getOverallStats().totalPremiumRequests).toBe(0);
		});
	}

	it("upgrades offset-only databases without losing the active tier", async () => {
		const file = await session(tier("priority") + assistant("first"));
		await syncAllSessions({ workers: 1 });
		closeDb();
		const raw = new Database(getStatsDbPath());
		raw.exec(
			"ALTER TABLE file_offsets RENAME TO old_offsets; CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL); INSERT INTO file_offsets SELECT session_file, offset, last_modified FROM old_offsets; DROP TABLE old_offsets;",
		);
		raw.close();
		await syncAllSessions({ workers: 1 });
		await fs.appendFile(file, assistant("second"));
		await syncAllSessions({ workers: 1 });
		expect(getOverallStats().totalRequests).toBe(2);
		expect(getOverallStats().totalPremiumRequests).toBe(2);
	});

	it("carries service-tier resets through the worker protocol and database restarts", async () => {
		const file = await session(tier("priority") + assistant("first"));
		await syncAllSessions({ workers: 2 });
		closeDb();
		await fs.appendFile(file, assistant("second") + tier(null));
		await syncAllSessions({ workers: 2 });
		closeDb();
		await fs.appendFile(file, assistant("third"));
		await syncAllSessions({ workers: 2 });
		expect(getOverallStats().totalRequests).toBe(3);
		expect(getOverallStats().totalPremiumRequests).toBe(2);
	}, 15_000);

	it("retries an incomplete final entry without losing its preceding service tier", async () => {
		const reply = assistant("completed");
		const split = Math.floor(reply.length / 2);
		const file = await session(tier("priority") + reply.slice(0, split));
		await syncAllSessions({ workers: 1 });
		expect(getOverallStats().totalRequests).toBe(0);
		await fs.appendFile(file, reply.slice(split));
		await syncAllSessions({ workers: 1 });
		expect(getOverallStats().totalRequests).toBe(1);
		expect(getOverallStats().totalPremiumRequests).toBe(1);
	});

	it("detects a same-inode rewrite that grows past the previous cursor", async () => {
		const file = await session(tier("priority") + assistant("old"));
		await syncAllSessions({ workers: 1 });
		await fs.writeFile(file, assistant("new") + JSON.stringify({ type: "custom", padding: "x".repeat(8192) }) + "\n");
		await syncAllSessions({ workers: 1 });
		expect(getRecentRequests().map(row => row.entryId)).toEqual(["new"]);
		expect(getOverallStats().totalPremiumRequests).toBe(0);
	});

	it("rolls back replacement deletions and the cursor when a derived-row write fails", async () => {
		const file = await session(tier("priority") + assistant("old"));
		await syncAllSessions({ workers: 1 });
		const oldOffset = getFileOffset(file);
		const db = await initDb();
		db.exec(
			"CREATE TRIGGER reject_new BEFORE INSERT ON messages WHEN NEW.entry_id = 'new' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
		);
		await fs.writeFile(file, assistant("new"));
		await expect(syncAllSessions({ workers: 1 })).rejects.toThrow("injected write failure");
		expect(getRecentRequests().map(row => row.entryId)).toEqual(["old"]);
		expect(getFileOffset(file)).toEqual(oldOffset);
		db.exec("DROP TRIGGER reject_new");
		await syncAllSessions({ workers: 1 });
		expect(getRecentRequests().map(row => row.entryId)).toEqual(["new"]);
	});

	it("keeps a request still present in a fork when its original transcript is replaced", async () => {
		const file = await session(assistant("shared"));
		await syncAllSessions({ workers: 1 });
		await Bun.write(path.join(path.dirname(file), "fork.jsonl"), assistant("shared"));
		await syncAllSessions({ workers: 1 });
		expect(getOverallStats().totalRequests).toBe(1);
		await fs.writeFile(file, assistant("new"));
		await syncAllSessions({ workers: 1 });
		expect(
			getRecentRequests()
				.map(row => row.entryId)
				.sort(),
		).toEqual(["new", "shared"]);
	});

	it("resumes fork reconciliation after interruption following a committed replacement", async () => {
		const file = await session(assistant("shared"));
		await syncAllSessions({ workers: 1 });
		await Bun.write(path.join(path.dirname(file), "fork.jsonl"), assistant("shared"));
		await syncAllSessions({ workers: 1 });
		await fs.writeFile(file, assistant("new"));
		await expect(
			syncAllSessions({
				workers: 1,
				onProgress(progress) {
					if (progress.sessionFile === file) throw new Error("interrupted after commit");
				},
			}),
		).rejects.toThrow("interrupted after commit");
		closeDb();
		await syncAllSessions({ workers: 1 });
		expect(
			getRecentRequests()
				.map(row => row.entryId)
				.sort(),
		).toEqual(["new", "shared"]);
	});
});
