/**
 * Shared SQLite ledger for the usage governor (spec 3.5 and 4.4). One file per agent
 * dir, WAL, disposable. Each admission is one short `BEGIN IMMEDIATE` transaction that
 * observes the snapshot, evaluates every window, and either reserves or records a wait.
 * No sleeping and no network happen inside a transaction.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import { isPidAlive, openSqliteDatabaseSync } from "@oh-my-pi/pi-utils";
import {
	admissionVerdict,
	calibrateCostPerRequest,
	evaluateWindow,
	GOVERNOR_GENERATION_MS,
	type WindowDecision,
} from "./policy";
import type {
	UsageAdmissionOutcome,
	UsageGovernorWaitRecord,
	UsageGovernorWaitReason,
	UsageRequestSource,
} from "./types";

/** Reservations and observations stay this long after their reset, for calibration and pacing reads. */
const RESULT_RETENTION_MS = 60 * 60_000;
/** Calibration rows are kept for a week after their last update. */
const CALIBRATION_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Most recent wait records kept. */
const WAIT_RECORD_LIMIT = 500;
/** Minimum spacing between retention sweeps. */
const PRUNE_INTERVAL_MS = 60_000;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reservations (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	grant_id TEXT NOT NULL,
	quota_key TEXT NOT NULL,
	generation INTEGER NOT NULL,
	created_at_ms INTEGER NOT NULL,
	settled_at_ms INTEGER,
	pid INTEGER NOT NULL,
	provider TEXT NOT NULL,
	credential_id INTEGER,
	model_id TEXT,
	role TEXT,
	source TEXT NOT NULL,
	session_id TEXT,
	interactive INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reservations_quota ON reservations(quota_key, generation, created_at_ms);
CREATE INDEX IF NOT EXISTS reservations_grant ON reservations(grant_id);
CREATE TABLE IF NOT EXISTS observations (
	quota_key TEXT NOT NULL,
	generation INTEGER NOT NULL,
	first_observed_at_ms INTEGER NOT NULL,
	first_used REAL NOT NULL,
	last_observed_at_ms INTEGER NOT NULL,
	last_used REAL NOT NULL,
	resets_at_ms INTEGER,
	duration_ms INTEGER,
	PRIMARY KEY (quota_key, generation)
);
CREATE TABLE IF NOT EXISTS calibration (
	quota_key TEXT PRIMARY KEY,
	cost_per_request REAL NOT NULL,
	samples INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS waits (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	started_at_ms INTEGER NOT NULL,
	ended_at_ms INTEGER,
	outcome TEXT,
	provider TEXT NOT NULL,
	credential_id INTEGER,
	model_id TEXT,
	role TEXT,
	source TEXT NOT NULL,
	session_id TEXT,
	pid INTEGER NOT NULL,
	reason TEXT NOT NULL,
	binding_label TEXT,
	used REAL,
	allowed REAL,
	until_ms INTEGER,
	resets_at_ms INTEGER
);
`;

/** One applicable window of a request, as the governor derived it from a cached snapshot. */
export interface LedgerWindow {
	quotaKey: string;
	generation: number;
	label: string;
	resetsAt: number;
	durationMs?: number;
	usedFraction?: number;
	exhausted: boolean;
	fetchedAt: number;
	/** Reserve fraction `r` for this request. */
	reserve: number;
}

/** Who is sending and what they are sending; written to the ledger for display and accounting. */
export interface LedgerRequestIdentity {
	provider: string;
	credentialId?: number;
	modelId?: string;
	role?: string;
	source: UsageRequestSource;
	sessionId?: string;
	interactive: boolean;
	pid: number;
}

/** One admission attempt. */
export interface LedgerAdmitRequest extends LedgerRequestIdentity {
	grantId: string;
	nowMs: number;
	/** Share of the window's allowance usable ahead of linear pacing (0..1). */
	lead: number;
	windows: readonly LedgerWindow[];
	/** Wait record already open for this request, when an earlier attempt waited. */
	waitId?: number;
}

/** Result of one admission attempt. */
export type LedgerAdmitResult =
	| { kind: "admitted"; reserved: number }
	| {
			kind: "wait";
			admissibleAtMs: number;
			/** Wait record id; the caller passes it back on the next attempt. */
			waitId: number;
			reason: UsageGovernorWaitReason;
			bindingLabel: string;
			usedFraction?: number;
			allowedFraction?: number;
			resetsAtMs: number;
	  };

/** A window evaluated against the ledger, for admission and status alike. */
export interface EvaluatedLedgerWindow extends LedgerWindow {
	decision: WindowDecision;
	/** Reservations created after the snapshot, across all processes. */
	pending: number;
	/** Pending reservations whose process is still alive and has not settled. */
	inFlight: number;
	/** Calibrated cost per request; undefined until calibrated. */
	costPerRequest?: number;
}

interface ObservationRow {
	first_observed_at_ms: number;
	first_used: number;
	last_observed_at_ms: number;
	last_used: number;
}

interface WaitRow {
	id: number;
	started_at_ms: number;
	ended_at_ms: number | null;
	outcome: string | null;
	provider: string;
	credential_id: number | null;
	model_id: string | null;
	role: string | null;
	source: string;
	session_id: string | null;
	pid: number;
	reason: string;
	binding_label: string | null;
	used: number | null;
	allowed: number | null;
	until_ms: number | null;
	resets_at_ms: number | null;
}

/** Open ledger handle. Methods are synchronous and short; errors propagate to the governor, which fails open. */
export class UsageLedger {
	readonly #db: Database;
	#lastPruneMs = 0;

	private constructor(db: Database) {
		this.#db = db;
	}

	/** Open or create the ledger at `dbPath`, recovering a corrupt file once. Throws when the file cannot be opened. */
	static open(dbPath: string): UsageLedger {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(dbPath, db => new UsageLedger(initialize(db)), { recoverCorruption: true });
	}

	/** Release the file handle. The ledger is disposable; a later open recreates it if needed. */
	close(): void {
		this.#db.close();
	}

	/**
	 * Observe the snapshots, evaluate every window, and either reserve for all of them or
	 * record a wait. One `BEGIN IMMEDIATE` transaction; no sleeping, no network.
	 */
	admit(request: LedgerAdmitRequest): LedgerAdmitResult {
		return this.#db
			.transaction((): LedgerAdmitResult => {
				this.#maybePrune(request.nowMs);
				const evaluated = this.#evaluate(request.windows, request.nowMs, request.lead, true);
				const { admissibleAtMs, bindingIndex } = admissionVerdict(
					evaluated.map(window => window.decision),
					request.nowMs,
				);
				if (bindingIndex !== undefined && admissibleAtMs > request.nowMs) {
					const binding = evaluated[bindingIndex];
					const waitId =
						request.waitId === undefined
							? this.#insertWait(request, binding, admissibleAtMs)
							: this.#updateWait(request.waitId, binding, admissibleAtMs);
					return {
						kind: "wait",
						admissibleAtMs,
						waitId,
						reason: binding.decision.reason ?? "over-allowance",
						bindingLabel: binding.label,
						usedFraction: binding.usedFraction,
						allowedFraction: binding.decision.allowedFraction,
						resetsAtMs: binding.resetsAt,
					};
				}
				const insert = this.#db.query(
					`INSERT INTO reservations (grant_id, quota_key, generation, created_at_ms, settled_at_ms, pid, provider,
					credential_id, model_id, role, source, session_id, interactive)
				 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
				);
				for (const window of request.windows) {
					insert.run(
						request.grantId,
						window.quotaKey,
						window.generation,
						request.nowMs,
						request.pid,
						request.provider,
						request.credentialId ?? null,
						request.modelId ?? null,
						request.role ?? null,
						request.source,
						request.sessionId ?? null,
						request.interactive ? 1 : 0,
					);
				}
				return { kind: "admitted", reserved: request.windows.length };
			})
			.immediate();
	}

	/**
	 * Settle a grant. `not-sent` deletes its reservations; `sent` keeps them counting, since a
	 * sent request consumes quota whether or not its snapshot has arrived.
	 */
	settle(grantId: string, outcome: UsageAdmissionOutcome, nowMs: number): void {
		if (outcome === "not-sent") {
			this.#db.query("DELETE FROM reservations WHERE grant_id = ?").run(grantId);
			return;
		}
		this.#db
			.query("UPDATE reservations SET settled_at_ms = ? WHERE grant_id = ? AND settled_at_ms IS NULL")
			.run(nowMs, grantId);
	}

	/** Close a wait record as admitted or aborted. */
	endWait(waitId: number, outcome: "admitted" | "aborted", nowMs: number): void {
		this.#db.query("UPDATE waits SET ended_at_ms = ?, outcome = ? WHERE id = ?").run(nowMs, outcome, waitId);
	}

	/** Read-only evaluation of windows for status: no observation, no calibration write, no prune. */
	inspect(windows: readonly LedgerWindow[], nowMs: number, lead: number): EvaluatedLedgerWindow[] {
		return this.#evaluate(windows, nowMs, lead, false);
	}

	/** Most recent wait records, newest first. */
	recentWaits(limit: number): UsageGovernorWaitRecord[] {
		const rows = this.#db.query<WaitRow, [number]>("SELECT * FROM waits ORDER BY id DESC LIMIT ?").all(limit);
		return rows.map(row => ({
			startedAtMs: row.started_at_ms,
			endedAtMs: row.ended_at_ms ?? undefined,
			outcome: row.outcome === "admitted" || row.outcome === "aborted" ? row.outcome : undefined,
			provider: row.provider,
			credentialId: row.credential_id ?? undefined,
			modelId: row.model_id ?? undefined,
			role: row.role ?? undefined,
			source: row.source as UsageRequestSource,
			sessionId: row.session_id ?? undefined,
			pid: row.pid,
			reason: row.reason as UsageGovernorWaitReason,
			bindingLabel: row.binding_label ?? undefined,
			usedFraction: row.used ?? undefined,
			allowedFraction: row.allowed ?? undefined,
			untilMs: row.until_ms ?? undefined,
			resetsAtMs: row.resets_at_ms ?? undefined,
		}));
	}

	/**
	 * Observe each window's snapshot (when `write`), count reservations, calibrate, and decide.
	 * Runs inside the caller's transaction when writing.
	 */
	#evaluate(windows: readonly LedgerWindow[], nowMs: number, lead: number, write: boolean): EvaluatedLedgerWindow[] {
		return windows.map(window => {
			if (write) this.#observe(window);
			const pending = this.#countPending(window.quotaKey, window.fetchedAt);
			const costPerRequest = this.#calibrate(window, write);
			const decision = evaluateWindow({
				nowMs,
				lead,
				reserve: window.reserve,
				resetsAt: window.resetsAt,
				durationMs: window.durationMs,
				usedFraction: window.usedFraction,
				exhausted: window.exhausted,
				fetchedAt: window.fetchedAt,
				pending,
				costPerRequest: costPerRequest ?? 0,
			});
			return {
				...window,
				decision,
				pending,
				inFlight: this.#countInFlight(window.quotaKey, window.fetchedAt),
				costPerRequest,
			};
		});
	}

	#observe(window: LedgerWindow): void {
		const used = window.usedFraction;
		if (used === undefined) return;
		const row = this.#observation(window);
		if (!row) {
			this.#db
				.query(
					`INSERT INTO observations (quota_key, generation, first_observed_at_ms, first_used,
						last_observed_at_ms, last_used, resets_at_ms, duration_ms)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					window.quotaKey,
					window.generation,
					window.fetchedAt,
					used,
					window.fetchedAt,
					used,
					window.resetsAt,
					window.durationMs ?? null,
				);
			return;
		}
		if (window.fetchedAt <= row.last_observed_at_ms) return;
		this.#db
			.query(
				`UPDATE observations SET last_observed_at_ms = ?, last_used = ?, resets_at_ms = ?, duration_ms = ?
				 WHERE quota_key = ? AND generation = ?`,
			)
			.run(window.fetchedAt, used, window.resetsAt, window.durationMs ?? null, window.quotaKey, window.generation);
	}

	#observation(window: LedgerWindow): ObservationRow | null {
		return this.#db
			.query<ObservationRow, [string, number]>(
				`SELECT first_observed_at_ms, first_used, last_observed_at_ms, last_used
				 FROM observations WHERE quota_key = ? AND generation = ?`,
			)
			.get(window.quotaKey, window.generation);
	}

	/**
	 * Cost per request for the window. A value measured from this generation's observations is
	 * persisted when `write`; otherwise the stored value for the quota (from an earlier generation)
	 * applies.
	 */
	#calibrate(window: LedgerWindow, write: boolean): number | undefined {
		const observation = this.#observation(window);
		const prior = this.#db
			.query<{ cost_per_request: number }, [string]>("SELECT cost_per_request FROM calibration WHERE quota_key = ?")
			.get(window.quotaKey);
		let measured: number | undefined;
		let samples = 0;
		if (observation) {
			const counted = this.#db
				.query<{ n: number }, [string, number, number, number]>(
					`SELECT COUNT(*) AS n FROM reservations
					 WHERE quota_key = ? AND generation = ? AND created_at_ms > ? AND created_at_ms <= ?`,
				)
				.get(window.quotaKey, window.generation, observation.first_observed_at_ms, observation.last_observed_at_ms);
			samples = counted?.n ?? 0;
			measured = calibrateCostPerRequest(
				{ firstUsed: observation.first_used, lastUsed: observation.last_used, samples },
				undefined,
			);
		}
		if (write && measured !== undefined) {
			this.#db
				.query(
					`INSERT INTO calibration (quota_key, cost_per_request, samples, updated_at_ms) VALUES (?, ?, ?, ?)
					 ON CONFLICT (quota_key) DO UPDATE SET cost_per_request = excluded.cost_per_request,
						samples = excluded.samples, updated_at_ms = excluded.updated_at_ms`,
				)
				.run(window.quotaKey, measured, samples, Date.now());
		}
		return measured ?? prior?.cost_per_request;
	}

	#countPending(quotaKey: string, fetchedAt: number): number {
		const row = this.#db
			.query<{ n: number }, [string, number]>(
				"SELECT COUNT(*) AS n FROM reservations WHERE quota_key = ? AND created_at_ms >= ?",
			)
			.get(quotaKey, fetchedAt);
		return row?.n ?? 0;
	}

	#countInFlight(quotaKey: string, fetchedAt: number): number {
		const rows = this.#db
			.query<{ pid: number; n: number }, [string, number]>(
				`SELECT pid, COUNT(*) AS n FROM reservations
				 WHERE quota_key = ? AND created_at_ms >= ? AND settled_at_ms IS NULL GROUP BY pid`,
			)
			.all(quotaKey, fetchedAt);
		let total = 0;
		for (const row of rows) {
			if (isPidAlive(row.pid)) total += row.n;
		}
		return total;
	}

	#insertWait(request: LedgerAdmitRequest, binding: EvaluatedLedgerWindow, admissibleAtMs: number): number {
		const result = this.#db
			.query(
				`INSERT INTO waits (started_at_ms, provider, credential_id, model_id, role, source, session_id, pid, reason,
					binding_label, used, allowed, until_ms, resets_at_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				request.nowMs,
				request.provider,
				request.credentialId ?? null,
				request.modelId ?? null,
				request.role ?? null,
				request.source,
				request.sessionId ?? null,
				request.pid,
				binding.decision.reason ?? "over-allowance",
				binding.label,
				binding.usedFraction ?? null,
				binding.decision.allowedFraction ?? null,
				admissibleAtMs,
				binding.resetsAt,
			);
		return Number(result.lastInsertRowid);
	}

	#updateWait(waitId: number, binding: EvaluatedLedgerWindow, admissibleAtMs: number): number {
		this.#db
			.query(
				`UPDATE waits SET reason = ?, binding_label = ?, used = ?, allowed = ?, until_ms = ?, resets_at_ms = ?
				 WHERE id = ?`,
			)
			.run(
				binding.decision.reason ?? "over-allowance",
				binding.label,
				binding.usedFraction ?? null,
				binding.decision.allowedFraction ?? null,
				admissibleAtMs,
				binding.resetsAt,
				waitId,
			);
		return waitId;
	}

	#maybePrune(nowMs: number): void {
		if (nowMs - this.#lastPruneMs < PRUNE_INTERVAL_MS) return;
		this.#lastPruneMs = nowMs;
		this.#db
			.query("DELETE FROM reservations WHERE (generation + 1) * ? + ? < ?")
			.run(GOVERNOR_GENERATION_MS, RESULT_RETENTION_MS, nowMs);
		this.#db
			.query("DELETE FROM observations WHERE (generation + 1) * ? + ? < ?")
			.run(GOVERNOR_GENERATION_MS, RESULT_RETENTION_MS, nowMs);
		this.#db.query("DELETE FROM calibration WHERE updated_at_ms < ?").run(nowMs - CALIBRATION_RETENTION_MS);
		this.#db
			.query("DELETE FROM waits WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM waits) - ?")
			.run(WAIT_RECORD_LIMIT);
	}
}

function initialize(db: Database): Database {
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	if (version > SCHEMA_VERSION) {
		throw new Error(`usage governor ledger schema ${version} is newer than supported ${SCHEMA_VERSION}`);
	}
	db.run(SCHEMA);
	if (version < SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	return db;
}
