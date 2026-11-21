/**
 * Features that once read only the session files on disk, run under every
 * session storage: `archive.search` and its transcript index, the archive's
 * message counts, `agent://<pid>` and `agent://<pid>/<id>` for another
 * instance's agents, and resuming a session whose recorded folder is gone.
 * Under `session.storage: sql` the transcript is a table row, so a disk read
 * finds nothing, and another process's rows show only after a refresh.
 *
 * Runs against file storage and SQLite always, and against PostgreSQL and
 * MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database. Every SQL test uses its own table and drops it when done.
 */
import { $, SQL } from "bun";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchiveSearchHit, ArchiveSession } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { syncTranscripts } from "@oh-my-pi/pi-coding-agent/daemon/modules/transcripts";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import * as mesh from "@oh-my-pi/pi-coding-agent/irc/mesh";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionDirForCwd, writeTerminalBreadcrumb } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import * as transcriptIndex from "@oh-my-pi/pi-coding-agent/session/transcript-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getSessionsDir, getTranscriptIndexDbPath, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeAssistantMessage } from "../session-manager/helpers";

type Backend = "file" | SqlSessionStorageAdapter;

const SQL_URLS: Record<SqlSessionStorageAdapter, string | undefined> = {
	sqlite: "sqlite",
	postgres: process.env.OMP_TEST_SQL_POSTGRES_URL,
	mysql: process.env.OMP_TEST_SQL_MYSQL_URL,
};
const SQL_BACKENDS = (Object.keys(SQL_URLS) as SqlSessionStorageAdapter[]).filter(adapter => SQL_URLS[adapter]);
const BACKENDS: Backend[] = ["file", ...SQL_BACKENDS];
const AT = "2026-03-01T00:00:00.000Z";

let tableSeq = 0;
let tempDir: TempDir;
let settingsState: SettingsTestState | undefined;
let previousStorage: SessionStorage;
const clients: SQL[] = [];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	settingsState = beginSettingsTest();
	previousStorage = defaultSessionStorage();
	tempDir = TempDir.createSync("@omp-sql-archive-agents-resume-");
	HistoryStorage.close();
	closeSessionIndex();
	transcriptIndex.closeTranscriptIndex();
	setAgentDir(tempDir.join("agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	setDefaultSessionStorage(previousStorage);
	HistoryStorage.close();
	closeSessionIndex();
	transcriptIndex.closeTranscriptIndex();
	clearOmpExtensionCliRoots();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const client of clients.splice(0)) await client.end();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	tempDir.removeSync();
});

/**
 * Opens `backend`'s storage. Each call for a SQL backend is a new client of
 * the same database and table, as each omp process holds its own.
 */
function backendOpener(backend: Backend): () => Promise<SessionStorage> {
	if (backend === "file") return async () => new FileSessionStorage();
	const table = `omp_aar_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	const url = backend === "sqlite" ? `sqlite:${tempDir.join("sessions.db")}` : SQL_URLS[backend]!;
	let first: SQL | undefined;
	return async () => {
		const client = new SQL(url);
		clients.push(client);
		if (!first) {
			first = client;
			cleanups.push(async () => {
				await client.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
				await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
			});
		}
		return SqlSessionStorage.create({ client, table, adapter: backend });
	};
}

/** Installs `backend`'s storage as the process default, as `main.ts` does for `session.storage`. */
async function installBackend(
	backend: Backend,
): Promise<{ storage: SessionStorage; connect: () => Promise<SessionStorage> }> {
	const connect = backendOpener(backend);
	const storage = await connect();
	setDefaultSessionStorage(storage);
	return { storage, connect };
}

function header(id: string, cwd: string, at: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd })}\n`;
}

function message(id: string, parentId: string | null, at: string, role: "user" | "assistant", text: string): string {
	const body =
		role === "user"
			? { role, content: text, timestamp: 1 }
			: { ...makeAssistantMessage(), content: [{ type: "text", text }] };
	return `${JSON.stringify({ type: "message", id, parentId, timestamp: at, message: body })}\n`;
}

/**
 * A transcript several read windows long: multibyte text throughout, so
 * windows end inside characters, one line longer than a window, and
 * `omega final token` last. Its first prompt is longer than the listing's
 * 4 KiB prefix and its first reply comes late, in neither the listing's head
 * nor its tail, so listing it scans its lines.
 */
function longTranscript(id: string, cwd: string): { content: string; messages: number } {
	let content = header(id, cwd, AT);
	let messages = 0;
	let parent: string | null = null;
	const add = (role: "user" | "assistant", text: string) => {
		const next = `m${messages}`;
		content += message(next, parent, AT, role, text);
		parent = next;
		messages++;
	};
	add("user", `start ${"pasted log ".repeat(600)}`);
	for (let i = 0; i < 40; i++) add("user", `mixed ${i} ${"é€😀a".repeat(2500 + i * 37)} end ${i}`);
	add("user", `long-line ${"é".repeat(700_000)} long-end`);
	add("assistant", "the first reply");
	for (let i = 0; i < 20; i++) add("user", `after ${i} ${"€😀é".repeat(2000 + i * 11)} done ${i}`);
	add("user", "omega final token");
	return { content, messages };
}

/** Writes `content` as session `id` of project `cwd` through `storage`; returns its key. */
async function storeSession(
	storage: SessionStorage,
	cwd: string,
	id: string,
	at: string,
	content: string,
): Promise<string> {
	const dir = sessionDirForCwd(cwd);
	storage.ensureDirSync(dir);
	const file = path.join(dir, `${new Date(at).getTime()}_${id}.jsonl`);
	await storage.writeText(file, content);
	return file;
}

async function archiveCall(params: Record<string, unknown>, cwd: string) {
	const session = { cwd, settings: Settings.isolated() } as unknown as ToolSession;
	return createArchivePrelude(session).invoke(params, { session, toolCallId: "archive-test" });
}

async function archive<T>(params: Record<string, unknown>, cwd: string): Promise<T> {
	return (await archiveCall(params, cwd)).details as T;
}

/** Whether an `archive.search` in `cwd` says the transcript index is still catching up. */
async function searchSaysCatchingUp(query: string, cwd: string): Promise<boolean> {
	const result = await archiveCall({ action: "search", query }, cwd);
	return result.content.some(part => "text" in part && part.text.includes("still catching up"));
}

const searchIds = (hits: ArchiveSearchHit[]) => hits.map(hit => hit.id);

describe("the session archive over the session storage", () => {
	it.each(BACKENDS)(
		"archive.search finds a session the %s storage holds by its transcript, and a line added after a sync",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			const later = "2026-03-01T00:00:01.000Z";
			const id = `search-${crypto.randomUUID()}`;
			const content =
				header(id, project, AT) +
				message("u1", null, AT, "user", "plan the quarterly migration") +
				message("a1", "u1", later, "assistant", "The quarterly migration runs on Friday.");
			const file = await storeSession(storage, project, id, AT, content);
			const found = (hits: ArchiveSearchHit[]) =>
				hits.map(hit => [hit.id, hit.matches.map(m => [m.source, m.text])]);

			expect(await syncTranscripts()).toEqual({ outcome: "synced", files: 1, messages: 2 });
			expect(found(await archive({ action: "search", query: "quarterly migration" }, project))).toEqual([
				[
					id,
					[
						["assistant", "The quarterly migration runs on Friday."],
						["user", "plan the quarterly migration"],
					],
				],
			]);

			// The next sync reads on from where the last one stopped.
			await storage.writeText(file, content + message("u2", "a1", later, "user", "also rotate the signing keys"));
			expect(await syncTranscripts()).toEqual({ outcome: "synced", files: 1, messages: 1 });
			expect(found(await archive({ action: "search", query: "signing keys" }, project))).toEqual([
				[id, [["user", "also rotate the signing keys"]]],
			]);
		},
	);

	it.each(BACKENDS)("counts every message of a long session the %s storage holds", async backend => {
		const { storage } = await installBackend(backend);
		const project = tempDir.join("project");
		const id = `count-${crypto.randomUUID()}`;
		// 60 messages, far past the 4 KiB prefix a listing parses.
		let content = header(id, project, AT);
		let parent: string | null = null;
		for (let turn = 0; turn < 30; turn++) {
			content += message(`u${turn}`, parent, AT, "user", `question ${turn}: ${"why ".repeat(20)}`);
			content += message(`a${turn}`, `u${turn}`, AT, "assistant", `answer ${turn}: ${"because ".repeat(15)}`);
			parent = `a${turn}`;
		}
		await storeSession(storage, project, id, AT, content);

		const sessions = await archive<ArchiveSession[]>({ action: "sessions" }, project);
		expect(sessions.map(session => [session.id, session.messages])).toEqual([[id, 60]]);
	});

	it.each(SQL_BACKENDS)(
		"lists and counts a %s-stored transcript several read windows long without ever reading it whole",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			const id = `windows-${crypto.randomUUID()}`;
			const { content, messages } = longTranscript(id, project);
			const file = await storeSession(storage, project, id, AT, content);
			const whole = Buffer.byteLength(content, "utf-8");
			const readWhole = vi.spyOn(storage, "readText");
			const readFrom = storage.readTextFrom!.bind(storage);
			const windows: number[] = [];
			vi.spyOn(storage, "readTextFrom").mockImplementation(async (key, offset, maxBytes) => {
				const read = await readFrom(key, offset, maxBytes);
				if (key === file) windows.push(Buffer.byteLength(read.text, "utf-8"));
				return read;
			});

			const sessions = await archive<ArchiveSession[]>({ action: "sessions" }, project);

			expect(sessions.map(session => [session.id, session.messages])).toEqual([[id, messages]]);
			expect(readWhole.mock.calls.filter(([key]) => key === file)).toEqual([]);
			expect(windows.length).toBeGreaterThan(1);
			expect(Math.max(...windows)).toBeLessThan(whole);
		},
	);

	it("lists a SQLite session whose first prompt outgrows the listing's prefix without reading it whole", async () => {
		const { storage } = await installBackend("sqlite");
		const project = tempDir.join("project");
		const manager = SessionManager.create(project, undefined, storage);
		// A pasted log longer than the 4 KiB the listing reads first, then long replies.
		manager.appendMessage({ role: "user", content: `please review this log: ${"x".repeat(6000)}`, timestamp: 1 });
		for (let i = 0; i < 24; i++) {
			manager.appendMessage({
				...makeAssistantMessage(),
				content: [{ type: "text", text: `reply ${i} ${"y".repeat(100_000)}` }],
			});
			manager.appendMessage({ role: "user", content: `turn ${i}`, timestamp: 2 + i });
		}
		await manager.flush();
		const file = manager.getSessionFile()!;
		await manager.close();
		await storage.refresh?.();
		const readWhole = vi.spyOn(storage, "readText");

		const archived = await archive<ArchiveSession[]>({ action: "sessions" }, project);
		closeSessionIndex();
		const picked = await SessionManager.list(project, undefined, storage);

		expect(archived.map(session => session.id)).toEqual([manager.getSessionId()]);
		expect(picked.map(session => session.path)).toEqual([file]);
		expect(readWhole.mock.calls.filter(([key]) => key === file)).toEqual([]);
	});

	it.each(SQL_BACKENDS)(
		"keeps one transcript index for %s and one for the session files, so neither sync drops the other's sessions",
		async backend => {
			const { storage } = await installBackend(backend);
			// Another project's omp on file storage wrote a session file.
			const other = tempDir.join("other");
			fs.mkdirSync(sessionDirForCwd(other), { recursive: true });
			fs.writeFileSync(
				path.join(sessionDirForCwd(other), "1000_file.jsonl"),
				header("file-session", other, AT) + message("u1", null, AT, "user", "alphafile token"),
			);
			const project = tempDir.join("project");
			await storeSession(
				storage,
				project,
				"sql-session",
				AT,
				header("sql-session", project, AT) + message("u1", null, AT, "user", "betasql token"),
			);
			const sessionsRoot = getSessionsDir();

			const files1 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot });
			const sql1 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot, storage });
			const files2 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot });
			const sql2 = await transcriptIndex.syncTranscriptIndex({ sessionsRoot, storage });

			// Each indexed its one session once; after the other's sync, neither reads anything again.
			expect([files1.messages, sql1.messages, files2.messages, sql2.messages]).toEqual([1, 1, 0, 0]);
		},
	);

	it.each(SQL_BACKENDS)(
		"archive.search under %s finds the table's sessions after a file-storage process synced its index",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			await storeSession(
				storage,
				project,
				"sql-session",
				AT,
				header("sql-session", project, AT) + message("u1", null, AT, "user", "betasql quarterly"),
			);
			const other = tempDir.join("other");
			fs.mkdirSync(sessionDirForCwd(other), { recursive: true });
			fs.writeFileSync(
				path.join(sessionDirForCwd(other), "1000_file.jsonl"),
				header("file-session", other, AT) + message("u1", null, AT, "user", "alphafile token"),
			);
			expect(searchIds(await archive({ action: "search", query: "betasql" }, project))).toEqual(["sql-session"]);

			// That process's sync of the JSONL tree into the agent dir's index, as the daemon runs it.
			await transcriptIndex.syncTranscriptIndex({
				dbPath: getTranscriptIndexDbPath(),
				sessionsRoot: getSessionsDir(),
			});

			expect(searchIds(await archive({ action: "search", query: "betasql" }, project))).toEqual(["sql-session"]);
		},
	);

	/** Alternate syncs of `stores`, as their processes would, and what each store's own search then finds. */
	async function syncAndSearch(stores: SessionStorage[], words: string[], project: string) {
		const synced: number[] = [];
		for (const storage of [...stores, ...stores]) {
			synced.push((await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage })).messages);
		}
		const found: string[][][] = [];
		for (const storage of stores) {
			setDefaultSessionStorage(storage);
			const hits: string[][] = [];
			for (const word of words) hits.push(searchIds(await archive({ action: "search", query: word }, project)));
			found.push(hits);
		}
		return { synced, found };
	}

	it("keeps one transcript index for each of two in-memory SQLite databases, and one for two stores of one", async () => {
		const first = new SQL("sqlite::memory:");
		const second = new SQL("sqlite::memory:");
		clients.push(first, second);
		const a = await SqlSessionStorage.create({ client: first });
		const b = await SqlSessionStorage.create({ client: second });
		const project = tempDir.join("project");
		const turn = (id: string, text: string) => header(id, project, AT) + message("u1", null, AT, "user", text);
		await storeSession(a, project, "memory-a", AT, turn("memory-a", "alphamemory token"));
		await storeSession(b, project, "memory-b", AT, turn("memory-b", "betamemory token"));

		// Each indexed its own session once; the other's sync dropped nothing of it.
		expect(await syncAndSearch([a, b], ["alphamemory", "betamemory"], project)).toEqual({
			synced: [1, 1, 0, 0],
			found: [
				[["memory-a"], []],
				[[], ["memory-b"]],
			],
		});
		// A second store of the first database is the same store, and keeps the same index.
		const again = await SqlSessionStorage.create({ client: first });
		expect(transcriptIndex.transcriptIndexDbPath(again)).toBe(transcriptIndex.transcriptIndexDbPath(a));
		expect(transcriptIndex.transcriptIndexDbPath(b)).not.toBe(transcriptIndex.transcriptIndexDbPath(a));
	});

	it.each(SQL_BACKENDS)("a second client of one %s table shares that table's transcript index", async backend => {
		const { storage, connect } = await installBackend(backend);
		const project = tempDir.join("project");
		await storeSession(
			storage,
			project,
			"shared-session",
			AT,
			header("shared-session", project, AT) + message("u1", null, AT, "user", "gammashared token"),
		);
		// Another omp process of the same store, with its own client.
		const other = await connect();
		expect(transcriptIndex.transcriptIndexDbPath(other)).toBe(transcriptIndex.transcriptIndexDbPath(storage));
		expect((await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage })).messages).toBe(1);
		expect(await transcriptIndex.syncTranscriptIndex({ sessionsRoot: getSessionsDir(), storage: other })).toEqual({
			outcome: "synced",
			files: 0,
			messages: 0,
		});
	});

	it.skipIf(!SQL_URLS.postgres)(
		"keeps one transcript index for each of two PostgreSQL schemas behind one table name",
		async () => {
			const url = SQL_URLS.postgres!;
			const admin = new SQL(url);
			clients.push(admin);
			const tag = `${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
			const schemas = [`omp_sa_${tag}`, `omp_sb_${tag}`];
			for (const schema of schemas) await admin.unsafe(`CREATE SCHEMA ${schema}`);
			cleanups.push(async () => {
				for (const schema of schemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			});
			const stores: SessionStorage[] = [];
			for (const schema of schemas) {
				// Each client resolves the unqualified table in its own schema.
				const client = new SQL({ url, connection: { search_path: schema } } as never);
				clients.push(client);
				stores.push(await SqlSessionStorage.create({ client, table: `omp_schema_${tag}`, adapter: "postgres" }));
			}
			const [a, b] = stores;
			const project = tempDir.join("project");
			const turn = (id: string, text: string) => header(id, project, AT) + message("u1", null, AT, "user", text);
			await storeSession(a!, project, "schema-a", AT, turn("schema-a", "alphaschema token"));
			await storeSession(b!, project, "schema-b", AT, turn("schema-b", "betaschema token"));
			await b!.refresh?.();
			expect(b!.existsSync(path.join(sessionDirForCwd(project), `${new Date(AT).getTime()}_schema-a.jsonl`))).toBe(
				false,
			);

			expect(await syncAndSearch(stores, ["alphaschema", "betaschema"], project)).toEqual({
				synced: [1, 1, 0, 0],
				found: [
					[["schema-a"], []],
					[[], ["schema-b"]],
				],
			});
		},
	);

	it.skipIf(!SQL_URLS.postgres)(
		"keeps one transcript index for each of two PostgreSQL tables reached past a schema that holds neither",
		async () => {
			const url = SQL_URLS.postgres!;
			const admin = new SQL(url);
			clients.push(admin);
			const tag = `${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
			const [empty, schemaA, schemaB] = ["s", "a", "b"].map(name => `omp_s${name}_${tag}`) as [
				string,
				string,
				string,
			];
			for (const schema of [empty, schemaA, schemaB]) await admin.unsafe(`CREATE SCHEMA ${schema}`);
			cleanups.push(async () => {
				for (const schema of [empty, schemaA, schemaB])
					await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			});
			const table = `omp_path_${tag}`;
			const open = async (searchPath: string, createTable: boolean) => {
				const client = new SQL({ url, connection: { search_path: searchPath } } as never);
				clients.push(client);
				return SqlSessionStorage.create({ client, table, adapter: "postgres", createTable });
			};
			const project = tempDir.join("project");
			const turn = (id: string, text: string) => header(id, project, AT) + message("u1", null, AT, "user", text);
			// The tables, made in two schemas as a migration would, each with its session.
			await storeSession(await open(schemaA, true), project, "path-a", AT, turn("path-a", "alphapath token"));
			await storeSession(await open(schemaB, true), project, "path-b", AT, turn("path-b", "betapath token"));
			// The stores: the first schema on both search paths exists and holds no table, so current_schema() is the same.
			const stores = [await open(`${empty},${schemaA}`, false), await open(`${empty},${schemaB}`, false)];
			for (const storage of stores) await storage.refresh?.();
			const dir = sessionDirForCwd(project);
			expect(stores.map(storage => storage.listFilesSync(dir, "*.jsonl").map(file => path.basename(file)))).toEqual([
				[`${new Date(AT).getTime()}_path-a.jsonl`],
				[`${new Date(AT).getTime()}_path-b.jsonl`],
			]);

			expect(await syncAndSearch(stores, ["alphapath", "betapath"], project)).toEqual({
				synced: [1, 1, 0, 0],
				found: [
					[["path-a"], []],
					[[], ["path-b"]],
				],
			});
		},
	);

	it.each(SQL_BACKENDS)("a %s store started again keeps its transcript index", async backend => {
		const { storage } = await installBackend(backend);
		const before = transcriptIndex.transcriptIndexDbPath(storage);
		await (storage as SqlSessionStorage).initialize();
		expect(transcriptIndex.transcriptIndexDbPath(storage)).toBe(before);
	});

	it.each(SQL_BACKENDS)(
		"a %s sync that cannot list the store, or whose read fails part-way, keeps what it read and leaves the index stale",
		async backend => {
			const { storage } = await installBackend(backend);
			const project = tempDir.join("project");
			const id = `fail-${crypto.randomUUID()}`;
			const { content, messages } = longTranscript(id, project);
			await storeSession(storage, project, id, AT, content);

			// The database is unreachable from the start: the listing's refresh fails.
			const outage = vi
				.spyOn(storage, "refresh")
				.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
			expect(await syncTranscripts()).toEqual({ outcome: "partial", files: 0, messages: 0 });
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(false);
			expect(await searchSaysCatchingUp("omega final token", project)).toBe(true);
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(false);
			outage.mockRestore();

			const readFrom = storage.readTextFrom!.bind(storage);
			const failure = vi.spyOn(storage, "readTextFrom").mockImplementation(async (key, offset, maxBytes) => {
				if (offset > 0) throw new Error("connection lost");
				return readFrom(key, offset, maxBytes);
			});

			const first = await syncTranscripts();
			expect(first.outcome).toBe("partial");
			expect(first.messages).toBeGreaterThan(0);
			expect(first.messages).toBeLessThan(messages);
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(false);

			failure.mockRestore();
			const second = await syncTranscripts();
			expect(second).toEqual({ outcome: "synced", files: 1, messages: messages - first.messages });
			expect(transcriptIndex.isTranscriptIndexFresh(60_000)).toBe(true);
			expect(searchIds(await archive({ action: "search", query: "omega final token" }, project))).toEqual([id]);
		},
	);
});

describe("agent://<pid> over the session storage", () => {
	/** The peer instance `pid`, whose main session is `sessionFile`, as the agent mesh reports it. */
	function meshPeer(pid: number, sessionFile: string): void {
		spyOn(mesh, "agentMesh").mockReturnValue({
			peer: (asked: number) => (asked === pid ? { pid, status: "idle", sessionFile, agents: [] } : undefined),
			peers: () => [],
		} as never);
	}

	it.each(BACKENDS)(
		"reads another instance's subagent from the transcript its own %s client wrote after this store loaded",
		async backend => {
			const { connect } = await installBackend(backend);
			// The peer instance writes through its own client, after this process's store loaded.
			const peer = await connect();
			const project = tempDir.join("project");
			const peerSession = await storeSession(
				peer,
				project,
				`peer-${crypto.randomUUID()}`,
				AT,
				header("peer-main", project, AT),
			);
			// The peer's roster no longer lists the subagent: only its transcript is left.
			const transcript = path.join(peerSession.slice(0, -".jsonl".length), "Worker.jsonl");
			peer.ensureDirSync(path.dirname(transcript));
			await peer.writeText(
				transcript,
				header("worker", project, AT) +
					message("u1", null, AT, "user", "find the race") +
					message("a1", "u1", AT, "assistant", "The race is in the flush path."),
			);
			const pid = process.pid + 1;
			meshPeer(pid, peerSession);

			const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${pid}/Worker`), {
				settings: Settings.isolated({ "task.crossInstance": true }),
			});
			expect(resource.content).toContain("The race is in the flush path.");
			expect(resource.notes).toEqual([
				"No published output; progress from session file (read-only) (not registered)",
			]);
		},
	);

	it.each(BACKENDS)(
		"reads another instance's main agent from the session its own %s client wrote after this store loaded",
		async backend => {
			const { connect } = await installBackend(backend);
			const peer = await connect();
			const project = tempDir.join("project");
			const peerSession = await storeSession(
				peer,
				project,
				`peer-${crypto.randomUUID()}`,
				AT,
				header("peer-main", project, AT) +
					message("u1", null, AT, "user", "main question") +
					message("a1", "u1", AT, "assistant", "Main answer from the peer."),
			);
			const pid = process.pid + 2;
			meshPeer(pid, peerSession);

			const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${pid}`), {
				settings: Settings.isolated({ "task.crossInstance": true }),
			});
			expect(resource.content).toContain("Main answer from the peer.");
		},
	);
});

describe.skipIf(process.platform === "win32")("resuming a session whose folder is gone", () => {
	const GIT_ENV = {
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	let repo: string;

	beforeEach(async () => {
		Object.assign(process.env, GIT_ENV, { OMP_WORKTREE_DIR: tempDir.join("wt-base") });
		repo = tempDir.join("repo");
		fs.mkdirSync(repo, { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
	});

	/** A session written in a `/wt` worktree that `omp worktree clear` then removed; `writer` keeps it open. */
	async function strandedSession(
		storage: SessionStorage,
	): Promise<{ writer: SessionManager; file: string; id: string }> {
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/gone");
		const writer = SessionManager.create(worktree, undefined, storage);
		writer.appendMessage({ role: "user", content: "work in the worktree", timestamp: 1 });
		writer.appendMessage(makeAssistantMessage());
		await writer.flush();
		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
		return { writer, file: writer.getSessionFile()!, id: writer.getSessionId() };
	}

	function textsOf(entries: FileEntry[]): string[] {
		return entries.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string"
				? [entry.message.content]
				: [],
		);
	}

	it("--resume moves a removed worktree's session into the checkout without asking under file storage", async () => {
		const { storage } = await installBackend("file");
		const { writer, file, id } = await strandedSession(storage);
		await writer.close();
		const asked: string[] = [];

		const resumed = await createSessionManager(
			parseArgs(["--resume", id.slice(0, 13)]),
			repo,
			Settings.isolated(),
			async session => {
				asked.push(session.id);
				return "accepted";
			},
		);
		try {
			expect(asked).toEqual([]);
			expect(path.dirname(resumed!.getSessionFile()!)).toBe(SessionManager.getDefaultSessionDir(repo));
			expect(fs.existsSync(file)).toBe(false);
		} finally {
			await resumed?.close();
		}
	});

	it.each(SQL_BACKENDS)(
		"--resume leaves a removed worktree's session where %s stores it while another process writes it",
		async backend => {
			const { storage, connect } = await installBackend(backend);
			// The omp that was running in the worktree, with its own client of the store.
			const { writer, file, id } = await strandedSession(await connect());
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				repo,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(resumed!.getSessionFile()).toBe(file);
				expect(asked).toEqual([]);
				// That process writes on, and the resumed session reads what it wrote.
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(resumed!.getSessionFile()!, storage))).toEqual([
					"work in the worktree",
					"the writer went on",
				]);
			} finally {
				await resumed?.close();
				await writer.close();
			}
		},
	);

	it("the start-up resume picker opens a removed worktree's session where SQLite stores it", async () => {
		// What `session.storage: sql` with a SQLite connection file installs at start.
		const database = tempDir.join("picker.db");
		const dsnFile = tempDir.join("session.dsn");
		fs.writeFileSync(dsnFile, `sqlite:${database}`);
		Object.assign(process.env, { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile });
		const client = new SQL(`sqlite:${database}`);
		clients.push(client);
		const { writer, file } = await strandedSession(await SqlSessionStorage.create({ client }));
		await writer.close();
		setProjectDir(repo);
		const opened: string[] = [];
		const relocated: string[] = [];
		class Chosen extends Error {}
		vi.spyOn(SessionManager, "openRelocated").mockImplementation(async sessionPath => {
			relocated.push(sessionPath);
			throw new Chosen();
		});
		const open = SessionManager.open.bind(SessionManager);
		vi.spyOn(SessionManager, "open").mockImplementation(async (sessionPath, ...rest) => {
			if (sessionPath !== file) return open(sessionPath, ...rest);
			opened.push(sessionPath);
			throw new Chosen();
		});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code ?? 0})`);
		}) as typeof process.exit);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const parsed = parseArgs(["--resume", "--print"]);
		Object.assign(parsed, { noExtensions: true, noSkills: true, noRules: true, noTools: true, noLsp: true });

		try {
			await expect(
				runRootCommand(parsed, ["--resume", "--print"], {
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
					selectSession: async () => ({ path: file }) as SessionInfo,
				}),
			).rejects.toBeInstanceOf(Chosen);
		} finally {
			authStorage.close();
		}
		expect({ opened, relocated }).toEqual({ opened: [file], relocated: [] });
	}, 30_000);

	it.each(SQL_BACKENDS)(
		"the in-session resume picker resumes a removed worktree's session where %s stores it",
		async backend => {
			const { storage, connect } = await installBackend(backend);
			const { writer, file } = await strandedSession(await connect());
			await writer.close();
			await storage.refresh?.();
			const relocated: string[] = [];
			vi.spyOn(SessionManager, "openRelocated").mockImplementation(async sessionPath => {
				relocated.push(sessionPath);
				throw new Error("moved");
			});
			const switchSession = vi.fn(async (_sessionPath: string) => false);
			const settings = Settings.isolated();
			vi.spyOn(settings, "flush").mockImplementation(async () => {});
			const ctx = {
				session: { switchSession },
				sessionManager: {
					getCwd: () => repo,
					getSessionDir: () => SessionManager.getDefaultSessionDir(repo),
					getSessionFile: () => undefined,
					getStorage: () => storage,
				},
				settings,
				prepareSessionSwitch: vi.fn(async () => {}),
				resetObserverRegistry: vi.fn(),
				showError: vi.fn(),
			} as unknown as InteractiveModeContext;

			await new SelectorController(ctx).handleResumeSession(file);

			expect({ switched: switchSession.mock.calls.map(([sessionPath]) => sessionPath), relocated }).toEqual({
				switched: [file],
				relocated: [],
			});
		},
	);

	it.each(SQL_BACKENDS)(
		"--continue after the project folder was renamed continues the session where %s stores it",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-rename";
			const { storage, connect } = await installBackend(backend);
			const before = tempDir.join("project-before");
			const after = tempDir.join("project-after");
			fs.mkdirSync(before);
			const writer = SessionManager.create(before, undefined, await connect());
			writer.appendMessage({ role: "user", content: "work before the rename", timestamp: 1 });
			writer.appendMessage(makeAssistantMessage());
			await writer.flush();
			const file = writer.getSessionFile()!;
			writeTerminalBreadcrumb(before, file);
			// `mv`: the same directory at a new path, the evidence of a rename `--continue` looks for.
			fs.renameSync(before, after);
			// A launch's store starts with what other clients committed before it.
			await storage.refresh?.();

			const resumed = await SessionManager.continueRecent(after, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
				writer.appendMessage({ role: "user", content: "the writer went on", timestamp: 2 });
				await writer.flush();
				await storage.refresh?.();
				expect(textsOf(await loadEntriesFromFile(file, storage))).toEqual([
					"work before the rename",
					"the writer went on",
				]);
			} finally {
				await resumed.close();
				await writer.close();
			}
		},
	);

	it.each(SQL_BACKENDS)(
		"--continue resumes the terminal's last session when another %s client wrote it after this store loaded",
		async backend => {
			process.env.TMUX_PANE = "%sql-continue-breadcrumb";
			const { storage, connect } = await installBackend(backend);
			const project = tempDir.join("project");
			fs.mkdirSync(project);
			// Another omp process ran this terminal's last session, then another terminal's newer one.
			const other = await connect();
			const turn = (text: string) =>
				message("u1", null, AT, "user", text) + message("a1", "u1", AT, "assistant", "noted");
			const file = await storeSession(
				other,
				project,
				`last-${crypto.randomUUID()}`,
				AT,
				header("last-session", project, AT) + turn("this terminal"),
			);
			await storeSession(
				other,
				project,
				`newer-${crypto.randomUUID()}`,
				"2026-03-02T00:00:00.000Z",
				header("newer-session", project, AT) + turn("another terminal"),
			);
			writeTerminalBreadcrumb(project, file);

			const resumed = await SessionManager.continueRecent(project, undefined, storage);
			try {
				expect(resumed.getSessionFile()).toBe(file);
			} finally {
				await resumed.close();
			}
		},
	);

	it.each(SQL_BACKENDS)(
		"--resume <id> from a renamed folder offers the move of a %s-stored session, and accepting files it there",
		async backend => {
			const { storage } = await installBackend(backend);
			const before = tempDir.join("project-before");
			const after = tempDir.join("project-after");
			fs.mkdirSync(before);
			const writer = SessionManager.create(before, undefined, storage);
			writer.appendMessage({ role: "user", content: "work before the rename", timestamp: 1 });
			writer.appendMessage(makeAssistantMessage());
			await writer.flush();
			const file = writer.getSessionFile()!;
			const id = writer.getSessionId();
			await writer.close();
			fs.renameSync(before, after);
			setProjectDir(after);
			const asked: string[] = [];

			const resumed = await createSessionManager(
				parseArgs(["--resume", id.slice(0, 13)]),
				after,
				Settings.isolated(),
				async session => {
					asked.push(session.id);
					return "accepted";
				},
			);
			try {
				expect(asked).toEqual([id]);
				expect(path.dirname(resumed!.getSessionFile()!)).toBe(sessionDirForCwd(after));
				expect(storage.existsSync(file)).toBe(false);
			} finally {
				await resumed?.close();
			}
		},
	);
});
