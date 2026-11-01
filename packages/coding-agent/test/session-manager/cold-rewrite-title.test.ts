import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SQL } from "bun";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

let dir: TempDir;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
beforeEach(() => {
	dir = TempDir.createSync("@pi-cold-rewrite-title-");
	setAgentDir(path.join(dir.path(), "agent"));
});
afterEach(async () => {
	setAgentDir(originalAgentDir ?? fallbackAgentDir);
	if (!originalAgentDir) delete process.env.PI_CODING_AGENT_DIR;
	await dir.remove();
});
const modes = ["default", "external-six", "external-seven"] as const;

describe("turn-one title while a real SQLite cold rewrite is unconfirmed", () => {
	for (const mode of modes)
		for (const timing of ["synchronous", "held"] as const)
			for (const fail of [false, true]) {
				it(`${mode}: ${timing} rename ${fail ? "reports only the real publish failure without a fallback" : "resolves and notifies after ordered publication"}`, async () => {
					const client = new SQL("sqlite::memory:");
					if (mode !== "default")
						await client.unsafe(
							`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT${mode === "external-seven" ? ", title_indexed_size INTEGER" : ""})`,
						);
					const gate = Promise.withResolvers<void>(),
						started = Promise.withResolvers<void>();
					const failure = new Error("actual cold SQLite publish failed");
					let publications = 0,
						first = true;
					const wrapped: SqlSessionStorageClient = {
						options: { adapter: "sqlite" },
						async unsafe(query, values) {
							if (query.startsWith("INSERT INTO") || query.startsWith("UPDATE omp_session_files SET content")) {
								publications++;
								if (first) {
									first = false;
									started.resolve();
									await gate.promise;
									if (fail) throw failure;
								}
							}
							return client.unsafe(query, values);
						},
						transaction(callback) {
							return client.transaction(async transaction => callback(transaction));
						},
					};
					let manager: SessionManager | undefined;
					try {
						const storage = await SqlSessionStorage.create({ client: wrapped, createTable: mode === "default" });
						manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"), storage);
						const errors: Error[] = [],
							notifications: Array<string | undefined> = [];
						manager.onPersistenceError(error => errors.push(error));
						manager.onSessionNameChanged(() => notifications.push(manager!.getSessionName()));
						const user = manager.appendMessage({ role: "user", content: "turn one", timestamp: 1 });
						const assistant = manager.appendMessage(makeAssistantMessage());
						if (timing === "held") await started.promise;
						const naming = manager.setSessionName("Turn one auto title", "auto").then(
							() => undefined,
							error => error,
						);
						await started.promise;
						const before = manager.captureState();
						expect(before.expectedDiskSize).toBeNull();
						expect(before.onDisk).toBe(false);
						gate.resolve();
						const result = await naming;
						await storage.drain().catch(() => {});
						for (let i = 0; i < 16; i++) await Promise.resolve();
						const file = manager.getSessionFile()!;
						const rows = await client.unsafe("SELECT content FROM omp_session_files WHERE path = ?", [file]);
						if (fail) {
							expect(result).toBe(failure);
							expect(errors).toEqual([failure]);
							expect(notifications).toEqual([]);
							expect(manager.captureState().expectedDiskSize).toBeNull();
							expect(rows).toHaveLength(0);
							expect(publications).toBe(1);
						} else {
							expect(result).toBeUndefined();
							expect(errors).toEqual([]);
							expect(notifications).toEqual(["Turn one auto title"]);
							await manager.flush();
							expect(manager.captureState().onDisk).toBe(true);
							expect(manager.captureState().needsRewrite).toBe(false);
							const content = rows[0].content as string;
							expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(content));
							const records = content
								.split("\n")
								.filter(Boolean)
								.map(
									line =>
										JSON.parse(line) as {
											type: string;
											id?: string;
											parentId?: string | null;
											title?: string;
										},
								);
							const entries = records.filter(entry => entry.type !== "session" && entry.id !== undefined);
							expect(entries.map(entry => entry.id).slice(0, 2)).toEqual([user, assistant]);
							expect(entries).toHaveLength(3);
							expect(entries[2]).toMatchObject({
								type: "title_change",
								title: "Turn one auto title",
								parentId: assistant,
							});
							expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
							expect(publications).toBe(2);
							const reopenedStorage = await SqlSessionStorage.create({
								client,
								createTable: mode === "default",
							});
							const reader = await SessionManager.open(file, path.join(dir.path(), "sessions"), reopenedStorage);
							try {
								expect(reader.getSessionId()).toBe(manager.getSessionId());
								expect(reader.getSessionName()).toBe("Turn one auto title");
								expect(reader.getEntries().map(entry => entry.id)).toEqual(entries.map(entry => entry.id!));
							} finally {
								await reader.close();
								reader.releaseRetainedEntries();
							}
							await manager.close();
							manager.releaseRetainedEntries();
						}
					} finally {
						gate.resolve();
						manager?.seal();
						manager?.releaseRetainedEntries();
						await client.end();
					}
				});
			}
});
