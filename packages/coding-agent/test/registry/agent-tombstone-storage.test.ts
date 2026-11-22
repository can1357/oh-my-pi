/**
 * An explicit kill leaves a `<transcript>.tombstone` sidecar so a later
 * persisted-subagent scan lists the agent as killed, not parked. The sidecar
 * is a local file whatever the session storage. Under `session.storage: sql`
 * the transcript is a row, so the directory the sidecar goes in may not exist
 * yet; the kill must still record it. Under file storage the transcript's own
 * directory holds it, and a missing one means the transcript is gone: the
 * kill fails, as it always has, and makes no directory. Which of the two
 * holds is said by the storage that holds the agent's transcript, never by
 * the process default: the live session's, else the one the ref was
 * registered with (the session being built, a roster scan, a restored worker),
 * attached with, or reopened from, recorded before any listener hears of the
 * ref. An agent on a worker thread is covered by agents-bridge.test.ts.
 *
 * Each kill is read back the way a restart reads it: a fresh registry scans
 * the transcripts through the storage and lists the agent as killed.
 *
 * The SQL cases run against SQLite always, and against PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database, each in a table of its own that is dropped when the case ends.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { VIBE_LIFECYCLE_CUSTOM_TYPE, VIBE_LIFECYCLE_VERSION } from "@oh-my-pi/pi-coding-agent/vibe/lifecycle";
import { VIBE_CLI_AGENT, type VibeParentSession, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const SQL_BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let tableSeq = 0;

describe("agent kill tombstone storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** A SQL store on `backend` in a table of its own: SQLite in memory, else on the server. */
	async function sqlStorage(backend: (typeof SQL_BACKENDS)[number]): Promise<SqlSessionStorage> {
		const client = new SQL(backend.url!);
		const table = `omp_tomb_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
		cleanups.push(async () => {
			await client.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
			await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
			await client.end();
		});
		const storage = await SqlSessionStorage.create({ client, table, adapter: backend.adapter });
		cleanups.push(() => storage.drain());
		return storage;
	}

	function useDefault(storage: SessionStorage): void {
		const previous = defaultSessionStorage();
		setDefaultSessionStorage(storage);
		cleanups.push(() => setDefaultSessionStorage(previous));
	}

	function tempDir(prefix: string): TempDir {
		const dir = TempDir.createSync(prefix);
		cleanups.push(() => dir.removeSync());
		return dir;
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

	/** A session double whose manager reads its transcript through `storage`. */
	function sessionOn(storage: SessionStorage, onDispose = () => {}): AgentSession {
		return {
			dispose: async () => onDispose(),
			sessionManager: { getStorage: () => storage },
		} as unknown as AgentSession;
	}

	/** A live subagent whose session reads its transcript through `storage`. */
	function registerLive(workerId: string, sessionFile: string, storage: SessionStorage, onDispose = () => {}) {
		return AgentRegistry.global().register({
			id: workerId,
			displayName: "task",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: sessionOn(storage, onDispose),
			sessionFile,
			status: "running",
		});
	}

	/** A main transcript at `<dir>/main.jsonl` and a subagent's at `<dir>/main/<id>.jsonl`, both in `storage`. */
	async function subagentTranscript(dir: TempDir, storage: SessionStorage, workerId: string) {
		const root = dir.join("main.jsonl");
		await storage.writeText(root, transcript("main"));
		const sessionFile = dir.join("main", `${workerId}.jsonl`);
		await storage.writeText(sessionFile, transcript(workerId));
		return { root, sessionFile };
	}

	/** How a restart lists `workerId`: a fresh registry scanning the transcripts through `storage`. */
	async function rescanned(root: string, storage: SessionStorage, workerId: string): Promise<AgentRef | undefined> {
		const fresh = new AgentRegistry();
		await ensurePersistedRoster(fresh, root, storage);
		return fresh.get(workerId);
	}

	it("records the kill of a subagent whose transcript file storage holds", async () => {
		const storage = new FileSessionStorage();
		useDefault(storage);
		const dir = tempDir("@omp-tombstone-storage-");
		const workerId = "Killed-Sub";
		const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
		let disposed = 0;
		const ref = registerLive(workerId, sessionFile, storage, () => disposed++);

		expect(await AgentLifecycleManager.global().release(workerId, ref, { tombstone: true })).toBe(true);

		expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
		expect(disposed).toBe(1);
		expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
		expect(await rescanned(root, storage, workerId)).toMatchObject({ status: "aborted", sessionFile });
	});

	// A file-backed transcript whose directory is gone (removed by hand or by a
	// sweep) has nothing to mark: the write fails with ENOENT and the kill
	// reports it, as rpc-cancel-subagent.test.ts expects, whatever the process
	// default is. Making the directory would leave an empty transcript tree
	// behind with only a sidecar in it.
	describe("a file-backed subagent whose transcript directory is gone", () => {
		const defaults = [
			{ name: "a file-storage default", storage: async () => new FileSessionStorage() as SessionStorage },
			{
				name: "a SQL-storage default",
				storage: async () => sqlStorage(SQL_BACKENDS[0]!) as Promise<SessionStorage>,
			},
		];
		for (const { name, storage: makeDefault } of defaults) {
			it(`fails the kill and makes no directory under ${name}`, async () => {
				useDefault(await makeDefault());
				const dir = tempDir("@omp-tombstone-gone-");
				const workerId = "Gone-Sub";
				const sessionFile = dir.join("gone", `${workerId}.jsonl`);
				let disposed = 0;
				const ref = registerLive(workerId, sessionFile, new FileSessionStorage(), () => disposed++);

				await expect(
					AgentLifecycleManager.global().release(workerId, ref, { tombstone: true }),
				).rejects.toMatchObject({ code: "ENOENT" });

				expect(fs.existsSync(dir.join("gone"))).toBe(false);
				// The kill still stops the agent: the session is disposed and the ref is terminal.
				expect(disposed).toBe(1);
				expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
			});
		}
	});

	for (const backend of SQL_BACKENDS) {
		// Except where a case says otherwise, the process default is file storage
		// (an SDK host that never installs another), while the subagent's
		// transcript is a row in the SQL storage its session uses. Only that
		// storage says whether the directory beside the transcript exists.
		describe.skipIf(!backend.url)(`a SQL-backed subagent on ${backend.adapter}`, () => {
			/** Kill `ref` and check the sidecar, the ref, and the rescan; the transcript's directory never existed before. */
			async function expectKillRecorded(ref: AgentRef, root: string, sessionFile: string, storage: SessionStorage) {
				expect(fs.existsSync(path.dirname(sessionFile))).toBe(false);

				expect(await AgentLifecycleManager.global().release(ref.id, ref, { tombstone: true })).toBe(true);

				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
				expect(AgentRegistry.global().get(ref.id)).toMatchObject({ status: "aborted", session: null });
				expect(await rescanned(root, storage, ref.id)).toMatchObject({ status: "aborted", sessionFile });
			}

			it("records the kill of a subagent whose transcript the default SQL storage holds", async () => {
				const storage = await sqlStorage(backend);
				useDefault(storage);
				const dir = tempDir("@omp-tombstone-storage-");
				const workerId = "Killed-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
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

				await expectKillRecorded(ref, root, sessionFile, storage);
				expect(disposed).toBe(1);
			});

			it("records the kill of a live subagent from its session's storage", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-child-");
				const workerId = "Live-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);

				await expectKillRecorded(registerLive(workerId, sessionFile, storage), root, sessionFile, storage);
			});

			it("records the kill of a parked subagent from the storage its roster scan read", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-child-");
				const workerId = "Parked-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
				await ensurePersistedRoster(AgentRegistry.global(), root, storage);
				const ref = AgentRegistry.global().get(workerId);
				expect(ref).toMatchObject({ status: "parked", session: null, sessionFile });

				await expectKillRecorded(ref!, root, sessionFile, storage);
			});

			// The registration's own record: once the session detaches, nothing else names its storage.
			it("records the kill of a subagent whose session detached, from the session it was registered with", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-detached-");
				const workerId = "Detached-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
				const ref = registerLive(workerId, sessionFile, storage);
				expect(AgentRegistry.global().detachSession(workerId, ref)).toBe(true);

				await expectKillRecorded(ref, root, sessionFile, storage);
			});

			// The attach's record: the ref was registered knowing no storage.
			it("records the kill of a subagent whose session attached after registration, then detached", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-attached-");
				const workerId = "Attached-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
				const registry = AgentRegistry.global();
				const ref = registry.register({
					id: workerId,
					displayName: "task",
					kind: "sub",
					parentId: MAIN_AGENT_ID,
					session: null,
					sessionFile,
					status: "running",
				});
				expect(registry.attachSession(workerId, sessionOn(storage), sessionFile, ref)).toBe(true);
				expect(registry.detachSession(workerId, ref)).toBe(true);

				await expectKillRecorded(ref, root, sessionFile, storage);
			});

			// The reopen's record: the reopened generation never had a session of its own.
			it("records the second kill of a killed subagent that was reopened", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-reopened-");
				const workerId = "Reopened-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
				const first = registerLive(workerId, sessionFile, storage);
				expect(await AgentLifecycleManager.global().release(workerId, first, { tombstone: true })).toBe(true);
				// The sidecar directory goes, as a sweep or a move would take it.
				fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
				const reopened = AgentRegistry.global().reopen(workerId, first);
				expect(reopened).toMatchObject({ status: "parked", session: null, sessionFile });

				await expectKillRecorded(reopened!, root, sessionFile, storage);
			});

			// The reuse's record: a revival reuses a parked ref whose storage nothing recorded.
			it("records the kill of a parked subagent reused for a revival that has not attached its session", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-reused-");
				const workerId = "Reused-Sub";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
				const registry = AgentRegistry.global();
				const input = {
					id: workerId,
					displayName: "task",
					kind: "sub" as const,
					parentId: MAIN_AGENT_ID,
					session: null,
					sessionFile,
					status: "parked" as const,
				};
				const parked = registry.register(input);
				expect(registry.registerIfAvailable({ ...input, storage }, parked)).toBe(parked);

				await expectKillRecorded(parked, root, sessionFile, storage);
			});

			// sdk.ts registers the subagent's ref before it builds the session and
			// attaches it; a kill in between (an RPC cancel) finds no live session.
			it("records the kill of a subagent killed while createAgentSession builds it", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-sdk-window-");
				const workerId = "Window-Sub";
				const authStorage = await AuthStorage.create(dir.join("auth.db"));
				cleanups.push(() => authStorage.close());
				authStorage.keys.setRuntime("openai", "test-key");
				await storage.writeText(dir.join("sessions", "main.jsonl"), transcript("main"));
				const sessionManager = SessionManager.create(dir.path(), dir.join("sessions", "main"), storage);
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("expected a planned session file");
				expect(fs.existsSync(path.dirname(sessionFile))).toBe(false);
				let killed: Promise<{ ok: boolean } | { error: unknown }> | undefined;
				const stop = AgentRegistry.global().onChange(event => {
					if (event.type !== "registered" || event.ref.id !== workerId || killed) return;
					killed = AgentLifecycleManager.global()
						.release(workerId, event.ref, { tombstone: true })
						.then(
							ok => ({ ok }),
							error => ({ error }),
						);
				});
				cleanups.push(stop);

				// The killed ref refuses the session, so construction reports the kill.
				await expect(
					createAgentSession({
						cwd: dir.path(),
						agentDir: dir.path(),
						modelRegistry: new ModelRegistry(authStorage),
						sessionManager,
						settings: Settings.isolated({ "archive.enabled": false }),
						model: getBundledModel("openai", "gpt-4o-mini"),
						agentId: workerId,
						taskDepth: 1,
						parentAgentId: MAIN_AGENT_ID,
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMCP: false,
						enableLsp: false,
						skipPythonPreflight: true,
					}),
				).rejects.toThrow(`Agent "${workerId}" was replaced during session initialization.`);

				expect(await killed).toEqual({ ok: true });
				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
				expect(AgentRegistry.global().get(workerId)).toMatchObject({ status: "aborted", session: null });
				await sessionManager.close();
			}, 30_000);

			/** Kills `workerId` from the first `registered` event of a parked ref, as a listener would. */
			function killOnParkedRegistration(workerId: string): () => Promise<{ ok: boolean } | { error: string }> {
				let killed: Promise<{ ok: boolean } | { error: string }> | undefined;
				const stop = AgentRegistry.global().onChange(event => {
					if (event.type !== "registered" || event.ref.id !== workerId || event.ref.status !== "parked" || killed)
						return;
					killed = AgentLifecycleManager.global()
						.release(workerId, event.ref, { tombstone: true })
						.then(
							ok => ({ ok }),
							error => ({ error: String(error) }),
						);
				});
				cleanups.push(stop);
				return async () => {
					if (!killed) throw new Error(`no parked registration of ${workerId}`);
					return killed;
				};
			}

			// The reopen records its storage before it announces the ref, so a listener's kill finds it.
			it("records the kill a registered listener makes while a killed subagent is reopened", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-reopen-listener-");
				const workerId = "Reopen-Listener";
				const { sessionFile } = await subagentTranscript(dir, storage, workerId);
				const first = registerLive(workerId, sessionFile, storage);
				expect(await AgentLifecycleManager.global().release(workerId, first, { tombstone: true })).toBe(true);
				fs.rmSync(path.dirname(sessionFile), { recursive: true, force: true });
				const killed = killOnParkedRegistration(workerId);

				AgentRegistry.global().reopen(workerId, first);

				expect(await killed()).toEqual({ ok: true });
				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
			});

			// The roster scan records its storage before it announces the ref, so a listener's kill finds it.
			it("records the kill a registered listener makes while the roster scan registers a subagent", async () => {
				useDefault(new FileSessionStorage());
				const storage = await sqlStorage(backend);
				const dir = tempDir("@omp-tombstone-sql-scan-listener-");
				const workerId = "Scan-Listener";
				const { root, sessionFile } = await subagentTranscript(dir, storage, workerId);
				const killed = killOnParkedRegistration(workerId);

				await ensurePersistedRoster(AgentRegistry.global(), root, storage);

				expect(await killed()).toEqual({ ok: true });
				expect(fs.existsSync(`${sessionFile}.tombstone`)).toBe(true);
				expect(await rescanned(root, storage, workerId)).toMatchObject({ status: "aborted", sessionFile });
			});

			// A registration that names both a live session and a storage takes the session's.
			it("takes a live session's storage over the one its registration names", async () => {
				const storage = await sqlStorage(backend);
				useDefault(storage);
				const dir = tempDir("@omp-tombstone-session-wins-");
				const workerId = "Both-Sub";
				const sessionFile = dir.join("gone", `${workerId}.jsonl`);
				const registry = AgentRegistry.global();
				const ref = registry.register({
					id: workerId,
					displayName: "task",
					kind: "sub",
					parentId: MAIN_AGENT_ID,
					session: sessionOn(new FileSessionStorage()),
					sessionFile,
					status: "running",
					storage,
				});
				expect(registry.detachSession(workerId, ref)).toBe(true);

				await expect(
					AgentLifecycleManager.global().release(workerId, ref, { tombstone: true }),
				).rejects.toMatchObject({
					code: "ENOENT",
				});
				expect(fs.existsSync(dir.join("gone"))).toBe(false);
			});

			describe("a vibe worker restored from its parent's journal", () => {
				/** A vibe parent whose journal (`events`) and child transcripts live in `storage`. */
				function vibeParent(parentFile: string, storage: SessionStorage, events: object[]): VibeParentSession {
					const entries = events.map((data, i) => ({
						type: "custom",
						customType: VIBE_LIFECYCLE_CUSTOM_TYPE,
						id: `e${i}`,
						parentId: i === 0 ? null : `e${i - 1}`,
						timestamp: new Date(Date.UTC(2026, 10, 21, 0, 0, i)).toISOString(),
						data,
					}));
					return {
						getAgentId: () => MAIN_AGENT_ID,
						getSessionId: () => "vibe-parent",
						getSessionFile: () => parentFile,
						sessionManager: {
							getEntries: () => entries,
							getBranch: () => entries,
							getStorage: () => storage,
						} as unknown as VibeParentSession["sessionManager"],
						settings: Settings.isolated(),
					};
				}

				function event(id: string, fields: object): object {
					return {
						version: VIBE_LIFECYCLE_VERSION,
						id,
						ownerId: MAIN_AGENT_ID,
						parentSessionId: "vibe-parent",
						...fields,
					};
				}

				/** A worker transcript the restore accepts: its header and the `session_init` a spawn writes. */
				async function workerTranscript(dir: TempDir, storage: SessionStorage, workerId: string) {
					const paths = await subagentTranscript(dir, storage, workerId);
					const init = {
						type: "session_init",
						id: "i1",
						parentId: null,
						timestamp: "2026-11-02T00:00:00.500Z",
						systemPrompt: "",
						task: "work",
						tools: [],
					};
					const [header, ...rest] = transcript(workerId).split("\n");
					await storage.writeText(paths.sessionFile, [header, JSON.stringify(init), ...rest].join("\n"));
					return paths;
				}

				function spawned(id: string): object {
					return event(id, {
						action: "spawn",
						cli: "good",
						agent: VIBE_CLI_AGENT.good,
						childSessionFile: `${id}.jsonl`,
						createdAt: 1,
					});
				}

				it("records the kill of a worker restored parked", async () => {
					useDefault(new FileSessionStorage());
					const storage = await sqlStorage(backend);
					const dir = tempDir("@omp-tombstone-sql-vibe-");
					const workerId = "Vibe-Parked";
					const { root, sessionFile } = await workerTranscript(dir, storage, workerId);
					const parent = vibeParent(root, storage, [
						spawned(workerId),
						event(workerId, { action: "turn-settled", turn: 1 }),
					]);

					expect(await VibeSessionRegistry.global().rehydrate(parent)).toBe(1);
					const ref = AgentRegistry.global().get(workerId);
					expect(ref).toMatchObject({ status: "parked", session: null, sessionFile });

					await expectKillRecorded(ref!, root, sessionFile, storage);
				});

				it("records the kill of a worker restored killed, then reopened", async () => {
					useDefault(new FileSessionStorage());
					const storage = await sqlStorage(backend);
					const dir = tempDir("@omp-tombstone-sql-vibe-");
					const workerId = "Vibe-Killed";
					const { root, sessionFile } = await workerTranscript(dir, storage, workerId);
					const parent = vibeParent(root, storage, [
						spawned(workerId),
						event(workerId, { action: "turn-settled", turn: 1 }),
						event(workerId, { action: "tombstone", reason: "explicit-kill" }),
					]);

					expect(await VibeSessionRegistry.global().rehydrate(parent)).toBe(0);
					const killed = AgentRegistry.global().get(workerId);
					expect(killed).toMatchObject({ status: "aborted", session: null, sessionFile });
					const reopened = AgentRegistry.global().reopen(workerId, killed!);
					expect(reopened).toMatchObject({ status: "parked", session: null, sessionFile });

					await expectKillRecorded(reopened!, root, sessionFile, storage);
				});
			});
		});
	}
});
