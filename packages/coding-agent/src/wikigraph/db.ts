import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { getWikigraphDbPath } from "./paths";
import { WIKIGRAPH_SCHEMA_SQL } from "./schema";

export interface WikigraphDbHandle {
	db: Database;
	path: string;
	notes: string[];
	prepare<TResult, TParams extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<TResult, TParams>;
	close(): void;
}

let handle: WikigraphDbHandle | undefined;
let exitHandlerRegistered = false;

function isCantOpen(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.includes("SQLITE_CANTOPEN") || error.message.includes("unable to open database file");
}

async function ensureParentDir(dbPath: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
	} catch (error) {
		throw new Error(
			`wikigraph: cannot create index at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function migrate(db: Database): void {
	// Install the busy handler BEFORE any lock-taking statement. See #2421.
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode=WAL");
	db.exec(WIKIGRAPH_SCHEMA_SQL);
}

function createHandle(db: Database, dbPath: string, notes: string[]): WikigraphDbHandle {
	const statements = new Map<string, Statement<unknown, SQLQueryBindings[]>>();
	return {
		db,
		path: dbPath,
		notes,
		prepare<TResult, TParams extends SQLQueryBindings[] = SQLQueryBindings[]>(
			sql: string,
		): Statement<TResult, TParams> {
			let stmt = statements.get(sql);
			if (!stmt) {
				stmt = db.prepare(sql) as Statement<unknown, SQLQueryBindings[]>;
				statements.set(sql, stmt);
			}
			return stmt as Statement<TResult, TParams>;
		},
		close(): void {
			for (const stmt of statements.values()) stmt.finalize();
			statements.clear();
			db.close();
		},
	};
}

async function openAt(dbPath: string, notes: string[]): Promise<WikigraphDbHandle> {
	await ensureParentDir(dbPath);
	const db = new Database(dbPath);
	migrate(db);
	return createHandle(db, dbPath, notes);
}

export async function openWikigraphDb(dbPath = getWikigraphDbPath()): Promise<WikigraphDbHandle> {
	const notes: string[] = [];
	try {
		return await openAt(dbPath, notes);
	} catch (error) {
		if (!isCantOpen(error)) throw error;
		const fallbackPath = path.join(os.tmpdir(), "omp-wikigraph", `${Bun.hash(process.cwd()).toString(16)}.sqlite`);
		const message = `wikigraph: cannot create index at ${dbPath}; using ${fallbackPath}`;
		notes.push(message);
		logger.warn(message, { error });
		return openAt(fallbackPath, notes);
	}
}

export async function getWikigraphDb(): Promise<WikigraphDbHandle> {
	if (!handle) {
		handle = await openWikigraphDb();
		if (!exitHandlerRegistered) {
			process.on("exit", () => {
				try {
					handle?.close();
				} catch {
					// Exit cleanup must not throw.
				}
			});
			exitHandlerRegistered = true;
		}
	}
	return handle;
}

export function closeWikigraphDb(): void {
	if (!handle) return;
	handle.close();
	handle = undefined;
}
