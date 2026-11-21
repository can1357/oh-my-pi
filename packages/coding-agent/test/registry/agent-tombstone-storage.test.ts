/**
 * An explicit kill leaves a `<transcript>.tombstone` sidecar so a later
 * persisted-subagent scan lists the agent as killed, not parked. The sidecar
 * is a local file whatever the session storage. Under `session.storage: sql`
 * the transcript is a row, so the directory the sidecar goes in may not exist
 * yet; the kill must still record it.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("agent kill tombstone storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`records the kill of a subagent whose transcript ${kind} storage holds`, async () => {
			const previous = defaultSessionStorage();
			let storage: SessionStorage = new FileSessionStorage();
			if (kind === "sql") {
				const client = new SQL("sqlite::memory:");
				storage = await SqlSessionStorage.create({ client });
				cleanups.push(() => client.end());
			}
			setDefaultSessionStorage(storage);
			cleanups.push(() => setDefaultSessionStorage(previous));
			const dir = TempDir.createSync("@omp-tombstone-storage-");
			cleanups.push(() => dir.removeSync());
			const workerId = "Killed-Sub";
			const sessionFile = dir.join("main", `${workerId}.jsonl`);
			await storage.writeText(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: workerId, timestamp: "2026-11-02T00:00:00.000Z", cwd: "/tmp" })}\n`,
			);
			let disposed = 0;
			const session = {
				dispose: async () => {
					disposed++;
				},
			} as unknown as AgentSession;
			const ref = AgentRegistry.global().register({
				id: workerId,
				displayName: "task",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session,
				sessionFile,
				status: "running",
			});

			expect(await AgentLifecycleManager.global().release(workerId, ref, { tombstone: true })).toBe(true);

			expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
			expect(disposed).toBe(1);
			expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
		});
	}

	// The process default is file storage (an SDK host that never installs another),
	// while the subagent's transcript is a row in the SQL storage its session uses.
	// Only that storage says whether the directory beside the transcript exists.
	describe("a SQL-backed subagent under a file-storage default", () => {
		async function sqlTranscriptTree(): Promise<{ storage: SqlSessionStorage; dir: TempDir }> {
			const previous = defaultSessionStorage();
			setDefaultSessionStorage(new FileSessionStorage());
			cleanups.push(() => setDefaultSessionStorage(previous));
			const client = new SQL("sqlite::memory:");
			cleanups.push(() => client.end());
			const dir = TempDir.createSync("@omp-tombstone-sql-child-");
			cleanups.push(() => dir.removeSync());
			return { storage: await SqlSessionStorage.create({ client }), dir };
		}

		function transcript(id: string): string {
			const header = { type: "session", version: 3, id, timestamp: "2026-11-02T00:00:00.000Z", cwd: "/tmp" };
			const prompt = {
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-02T00:00:01.000Z",
				message: { role: "user", content: "work", timestamp: 1 },
			};
			return `${JSON.stringify(header)}\n${JSON.stringify(prompt)}\n`;
		}

		it("records the kill of a live subagent from its session's storage", async () => {
			const { storage, dir } = await sqlTranscriptTree();
			const workerId = "Live-Sub";
			const sessionFile = dir.join("main", `${workerId}.jsonl`);
			await storage.writeText(sessionFile, transcript(workerId));
			expect(fs.existsSync(dir.join("main"))).toBe(false);
			const session = {
				dispose: async () => {},
				sessionManager: { getStorage: () => storage },
			} as unknown as AgentSession;
			const ref = AgentRegistry.global().register({
				id: workerId,
				displayName: "task",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session,
				sessionFile,
				status: "running",
			});

			expect(await AgentLifecycleManager.global().release(workerId, ref, { tombstone: true })).toBe(true);

			expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
		});

		it("records the kill of a parked subagent from the storage its roster scan read", async () => {
			const { storage, dir } = await sqlTranscriptTree();
			const root = dir.join("main.jsonl");
			await storage.writeText(root, transcript("main"));
			const workerId = "Parked-Sub";
			const sessionFile = dir.join("main", `${workerId}.jsonl`);
			await storage.writeText(sessionFile, transcript(workerId));
			await ensurePersistedRoster(AgentRegistry.global(), root, storage);
			const ref = AgentRegistry.global().get(workerId);
			expect(ref).toMatchObject({ status: "parked", session: null, sessionFile });
			expect(fs.existsSync(dir.join("main"))).toBe(false);

			expect(await AgentLifecycleManager.global().release(workerId, ref!, { tombstone: true })).toBe(true);

			expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
		});
	});
});
