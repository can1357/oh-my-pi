/**
 * Persistent state of the daemon: one sqlite database (WAL) under the daemon
 * dir. Rows are written on unit state transitions only, never per output
 * chunk. Launch environments (often the whole client env) are stored once per
 * distinct content in `envs` and referenced by hash.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import {
	type DaemonCompletionEvent,
	type ProcSpec,
	scopeKey,
	type UnitPolicy,
	type UnitScope,
	type UnitSnapshot,
} from "./protocol";

const SCHEMA_VERSION = 1;

/** Daemon-owned fds a `survive: "exec"` unit needs after an in-place re-exec. */
export type StoredChildFds =
	| { kind: "pipe"; stdin: number; stdout: number; stderr: number }
	| { kind: "pty"; master: number };

/** Completion bookkeeping of a unit's owner. */
export interface StoredCompletionState {
	capable: boolean;
	subscriptionId?: string;
}

/** One unit as persisted. */
export interface StoredUnit {
	id: string;
	kind: string;
	scope: UnitScope;
	key: string;
	label: string;
	policy: UnitPolicy;
	proc?: ProcSpec;
	snapshot: UnitSnapshot;
	pid?: number;
	/** `Process.startTime()` of `pid`; guards re-adoption against pid reuse. */
	pidStartedAt?: number;
	childFds?: StoredChildFds;
	/** `ModuleUnit.snapshot()` captured before a re-exec. */
	moduleState?: unknown;
	/** Bytes of the unit log already read (detached units). */
	outputOffset: number;
	owner?: string;
	completion: StoredCompletionState;
	pendingCompletions: DaemonCompletionEvent[];
}

interface UnitRow {
	id: string;
	kind: string;
	scope: string;
	key: string;
	label: string;
	policy: string;
	proc: string | null;
	env_hash: string | null;
	snapshot: string;
	pid: number | null;
	pid_started_at: number | null;
	child_fds: string | null;
	module_state: string | null;
	output_offset: number;
	owner: string | null;
	completion: string;
	pending_completions: string;
}

interface EnvRow {
	hash: string;
	env: string;
}

function migrate(db: Database): void {
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	if (version >= SCHEMA_VERSION) return;
	db.transaction(() => {
		if (version < 1) {
			db.run(`CREATE TABLE IF NOT EXISTS envs (hash TEXT PRIMARY KEY, env TEXT NOT NULL)`);
			db.run(`CREATE TABLE IF NOT EXISTS units (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				scope TEXT NOT NULL,
				scope_key TEXT NOT NULL,
				key TEXT NOT NULL,
				label TEXT NOT NULL,
				policy TEXT NOT NULL,
				proc TEXT,
				env_hash TEXT REFERENCES envs(hash),
				snapshot TEXT NOT NULL,
				pid INTEGER,
				pid_started_at INTEGER,
				child_fds TEXT,
				module_state TEXT,
				output_offset INTEGER NOT NULL DEFAULT 0,
				owner TEXT,
				completion TEXT NOT NULL DEFAULT '{"capable":false}',
				pending_completions TEXT NOT NULL DEFAULT '[]',
				updated_at INTEGER NOT NULL
			)`);
			db.run(`CREATE INDEX IF NOT EXISTS units_identity ON units(kind, scope_key, key)`);
			db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		}
		db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	})();
}

function serializeEnv(env: Record<string, string>): string {
	const sorted: Record<string, string> = {};
	for (const name of Object.keys(env).sort()) sorted[name] = env[name];
	return JSON.stringify(sorted);
}

function decodeRow(row: UnitRow, env: Record<string, string> | undefined): StoredUnit {
	const procBase = row.proc === null ? undefined : (JSON.parse(row.proc) as Omit<ProcSpec, "env">);
	return {
		id: row.id,
		kind: row.kind,
		scope: JSON.parse(row.scope) as UnitScope,
		key: row.key,
		label: row.label,
		policy: JSON.parse(row.policy) as UnitPolicy,
		proc: procBase ? { ...procBase, env: env ?? {} } : undefined,
		snapshot: JSON.parse(row.snapshot) as UnitSnapshot,
		pid: row.pid ?? undefined,
		pidStartedAt: row.pid_started_at ?? undefined,
		childFds: row.child_fds === null ? undefined : (JSON.parse(row.child_fds) as StoredChildFds),
		moduleState: row.module_state === null ? undefined : JSON.parse(row.module_state),
		outputOffset: row.output_offset,
		owner: row.owner ?? undefined,
		completion: JSON.parse(row.completion) as StoredCompletionState,
		pendingCompletions: JSON.parse(row.pending_completions) as DaemonCompletionEvent[],
	};
}

function readUnits(db: Database): StoredUnit[] {
	const envs = new Map<string, Record<string, string>>();
	for (const row of db.query<EnvRow, []>("SELECT hash, env FROM envs").all()) {
		envs.set(row.hash, JSON.parse(row.env) as Record<string, string>);
	}
	const units: StoredUnit[] = [];
	for (const row of db.query<UnitRow, []>("SELECT * FROM units").all()) {
		try {
			units.push(decodeRow(row, row.env_hash === null ? undefined : envs.get(row.env_hash)));
		} catch (error) {
			logger.warn("Skipping malformed daemon unit row", {
				id: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return units;
}

/** Read/write handle on the daemon store; only the daemon process opens it writable. */
export class DaemonStore {
	readonly #path: string;
	#db: Database;
	/** Last serialized row per unit; an unchanged row is not rewritten. */
	readonly #written = new Map<string, string>();

	private constructor(dbPath: string, db: Database) {
		this.#path = dbPath;
		this.#db = db;
	}

	static open(dbPath: string): DaemonStore {
		return new DaemonStore(dbPath, DaemonStore.#openDatabase(dbPath));
	}

	static #openDatabase(dbPath: string): Database {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		const db = new Database(dbPath, { create: true });
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("PRAGMA busy_timeout = 2000");
		db.run("PRAGMA foreign_keys = ON");
		migrate(db);
		try {
			fs.chmodSync(dbPath, 0o600);
		} catch {
			// Best effort: the daemon dir is already 0700.
		}
		return db;
	}

	/** Open the database again after {@link close}, when a re-exec failed and this image keeps serving. */
	reopen(): void {
		this.#db = DaemonStore.#openDatabase(this.#path);
	}

	/** Every persisted unit. */
	loadUnits(): StoredUnit[] {
		return readUnits(this.#db);
	}

	/** Insert or update one unit; a no-op when nothing changed since the last write. */
	saveUnit(unit: StoredUnit): void {
		let hash: string | null = null;
		let proc: string | null = null;
		let envText: string | undefined;
		if (unit.proc) {
			const { env, ...rest } = unit.proc;
			envText = serializeEnv(env);
			hash = new Bun.CryptoHasher("sha256").update(envText).digest("hex");
			proc = JSON.stringify(rest);
		}
		const values = {
			$id: unit.id,
			$kind: unit.kind,
			$scope: JSON.stringify(unit.scope),
			$scope_key: scopeKey(unit.scope),
			$key: unit.key,
			$label: unit.label,
			$policy: JSON.stringify(unit.policy),
			$proc: proc,
			$env_hash: hash,
			$snapshot: JSON.stringify(unit.snapshot),
			$pid: unit.pid ?? null,
			$pid_started_at: unit.pidStartedAt ?? null,
			$child_fds: unit.childFds === undefined ? null : JSON.stringify(unit.childFds),
			$module_state: unit.moduleState === undefined ? null : JSON.stringify(unit.moduleState),
			$output_offset: unit.outputOffset,
			$owner: unit.owner ?? null,
			$completion: JSON.stringify(unit.completion),
			$pending_completions: JSON.stringify(unit.pendingCompletions),
		};
		const serialized = JSON.stringify(values);
		if (this.#written.get(unit.id) === serialized) return;
		this.#db.transaction(() => {
			if (hash !== null && envText !== undefined) {
				this.#db.query("INSERT OR IGNORE INTO envs (hash, env) VALUES (?, ?)").run(hash, envText);
			}
			this.#db
				.query(
					`INSERT INTO units (id, kind, scope, scope_key, key, label, policy, proc, env_hash, snapshot, pid,
						pid_started_at, child_fds, module_state, output_offset, owner, completion, pending_completions, updated_at)
					VALUES ($id, $kind, $scope, $scope_key, $key, $label, $policy, $proc, $env_hash, $snapshot, $pid,
						$pid_started_at, $child_fds, $module_state, $output_offset, $owner, $completion, $pending_completions, $updated_at)
					ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, scope = excluded.scope, scope_key = excluded.scope_key,
						key = excluded.key, label = excluded.label, policy = excluded.policy, proc = excluded.proc,
						env_hash = excluded.env_hash, snapshot = excluded.snapshot, pid = excluded.pid,
						pid_started_at = excluded.pid_started_at, child_fds = excluded.child_fds,
						module_state = excluded.module_state, output_offset = excluded.output_offset, owner = excluded.owner,
						completion = excluded.completion, pending_completions = excluded.pending_completions,
						updated_at = excluded.updated_at`,
				)
				.run({ ...values, $updated_at: Date.now() });
			this.#collectEnvs();
		})();
		this.#written.set(unit.id, serialized);
	}

	deleteUnit(id: string): void {
		this.#db.transaction(() => {
			this.#db.query("DELETE FROM units WHERE id = ?").run(id);
			this.#collectEnvs();
		})();
		this.#written.delete(id);
	}

	getMeta(key: string): string | undefined {
		return this.#db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
	}

	setMeta(key: string, value: string): void {
		this.#db
			.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	close(): void {
		this.#db.close();
	}

	#collectEnvs(): void {
		this.#db.run("DELETE FROM envs WHERE hash NOT IN (SELECT env_hash FROM units WHERE env_hash IS NOT NULL)");
	}
}

/** Read the persisted units without opening the store for writing (offline `omp ps`). Empty when absent. */
export function readStoredUnits(dbPath: string): StoredUnit[] {
	if (!fs.existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		return readUnits(db);
	} catch (error) {
		logger.debug("Daemon store is unreadable", { error: error instanceof Error ? error.message : String(error) });
		return [];
	} finally {
		db.close();
	}
}
