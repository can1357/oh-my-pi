/**
 * Fixtures shared by the tests that run the session archive, its transcript
 * index and session resumes under every session storage: file storage and
 * SQLite always, and PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database. Every SQL store a test
 * opens uses its own table, dropped when the test ends.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, vi } from "bun:test";
import * as path from "node:path";
import type { ArchiveSearchHit } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { sessionDirForCwd } from "@oh-my-pi/pi-coding-agent/session/session-paths";
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
import * as transcriptIndex from "@oh-my-pi/pi-coding-agent/session/transcript-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./settings-test-state";

export type Backend = "file" | SqlSessionStorageAdapter;

export const SQL_URLS: Record<SqlSessionStorageAdapter, string | undefined> = {
	sqlite: "sqlite",
	postgres: process.env.OMP_TEST_SQL_POSTGRES_URL,
	mysql: process.env.OMP_TEST_SQL_MYSQL_URL,
};
export const SQL_BACKENDS = (Object.keys(SQL_URLS) as SqlSessionStorageAdapter[]).filter(adapter => SQL_URLS[adapter]);
export const BACKENDS: Backend[] = ["file", ...SQL_BACKENDS];
export const AT = "2026-03-01T00:00:00.000Z";

/** One test file's state: a temp agent directory, and the SQL clients and cleanups its tests opened. */
export interface SqlSessionTestEnv {
	readonly tempDir: TempDir;
	/** The process default storage before the test, restored after it. */
	readonly previousStorage: SessionStorage;
	/** Clients ended after each test. */
	readonly clients: SQL[];
	/** Run after each test, last first, before the clients end. */
	readonly cleanups: Array<() => Promise<void>>;
	/** A tag no other table, schema or role of this run has. */
	uniqueTag(): string;
	/**
	 * Opens `backend`'s storage. Each call for a SQL backend is a new client of
	 * the same database and table, as each omp process holds its own.
	 */
	backendOpener(backend: Backend): () => Promise<SessionStorage>;
	/** Installs `backend`'s storage as the process default, as `main.ts` does for `session.storage`. */
	installBackend(backend: Backend): Promise<{ storage: SessionStorage; connect: () => Promise<SessionStorage> }>;
}

/** Registers `beforeEach`/`afterEach` for a test file and returns its state. */
export function useSqlSessionTestEnv(prefix: string): SqlSessionTestEnv {
	let seq = 0;
	let tempDir: TempDir | undefined;
	let settingsState: SettingsTestState | undefined;
	let previousStorage: SessionStorage | undefined;
	const clients: SQL[] = [];
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		settingsState = beginSettingsTest();
		previousStorage = defaultSessionStorage();
		tempDir = TempDir.createSync(prefix);
		HistoryStorage.close();
		closeSessionIndex();
		transcriptIndex.closeTranscriptIndex();
		setAgentDir(tempDir.join("agent"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (previousStorage) setDefaultSessionStorage(previousStorage);
		HistoryStorage.close();
		closeSessionIndex();
		transcriptIndex.closeTranscriptIndex();
		clearOmpExtensionCliRoots();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		for (const client of clients.splice(0)) await client.end();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		tempDir?.removeSync();
	});

	const env: SqlSessionTestEnv = {
		get tempDir() {
			if (!tempDir) throw new Error("the SQL session test env is read outside a test");
			return tempDir;
		},
		get previousStorage() {
			if (!previousStorage) throw new Error("the SQL session test env is read outside a test");
			return previousStorage;
		},
		clients,
		cleanups,
		uniqueTag: () => `${process.pid}_${Date.now().toString(36)}_${seq++}`,
		backendOpener(backend) {
			if (backend === "file") return async () => new FileSessionStorage();
			const table = `omp_aar_${env.uniqueTag()}`;
			const url = backend === "sqlite" ? `sqlite:${env.tempDir.join("sessions.db")}` : SQL_URLS[backend]!;
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
		},
		async installBackend(backend) {
			const connect = env.backendOpener(backend);
			const storage = await connect();
			setDefaultSessionStorage(storage);
			return { storage, connect };
		},
	};
	return env;
}

export function header(id: string, cwd: string, at: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd })}\n`;
}

export function message(
	id: string,
	parentId: string | null,
	at: string,
	role: "user" | "assistant",
	text: string,
): string {
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
export function longTranscript(id: string, cwd: string): { content: string; messages: number } {
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
export async function storeSession(
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

export async function archiveCall(params: Record<string, unknown>, cwd: string) {
	const session = { cwd, settings: Settings.isolated() } as unknown as ToolSession;
	return createArchivePrelude(session).invoke(params, { session, toolCallId: "archive-test" });
}

export async function archive<T>(params: Record<string, unknown>, cwd: string): Promise<T> {
	return (await archiveCall(params, cwd)).details as T;
}

/** Whether an `archive.search` in `cwd` says the transcript index is still catching up. */
export async function searchSaysCatchingUp(query: string, cwd: string): Promise<boolean> {
	const result = await archiveCall({ action: "search", query }, cwd);
	return result.content.some(part => "text" in part && part.text.includes("still catching up"));
}

export const searchIds = (hits: ArchiveSearchHit[]) => hits.map(hit => hit.id);
