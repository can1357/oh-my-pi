/**
 * Durable persistence for the capture-to-agent workflow.
 *
 * Backed by bun:sqlite (the repo's convention for durable structured state).
 * The mapping between capture request, run, oh-my-pk session, runner, and
 * Telegram thread lives here so it survives process, bot, runner, and gateway
 * restarts. Screenshot bytes are stored on disk; only metadata is in SQLite.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	type CaptureAsset,
	type CaptureRun,
	type CaptureRunEvent,
	type CaptureRunStatus,
	type CaptureScreenshotMimeType,
	type CaptureSourceType,
	isCaptureRunStatus,
	isCaptureSourceType,
	isValidAssetId,
} from "./types";

export interface CaptureStoreOptions {
	dataDir: string;
	/** Override the database location; ":memory:" keeps tests hermetic. */
	dbPath?: string;
	now?: () => string;
}

interface RunRow {
	id: string;
	request_id: string;
	instruction: string;
	source_type: string;
	session_id: string | null;
	session_file: string | null;
	runner_id: string | null;
	workspace_id: string | null;
	agent_role: string | null;
	status: string;
	error: string | null;
	result_summary: string | null;
	submitted_by: string | null;
	screenshot_asset_id: string | null;
	telegram_chat_id: string | null;
	telegram_topic_id: string | null;
	telegram_root_message_id: string | null;
	created_at: string;
	updated_at: string;
}

interface AssetRow {
	id: string;
	run_id: string | null;
	mime_type: string;
	byte_size: number;
	width: number | null;
	height: number | null;
	file_path: string;
	created_at: string;
}

export interface CaptureAuditEntry {
	at: string;
	action: string;
	runId?: string;
	actor?: string;
	detail?: string;
}

export interface StoredRunEvent {
	seq: number;
	at: string;
	event: CaptureRunEvent;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS capture_requests (
	request_id TEXT PRIMARY KEY,
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_runs (
	id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL UNIQUE,
	instruction TEXT NOT NULL,
	source_type TEXT NOT NULL,
	session_id TEXT,
	session_file TEXT,
	runner_id TEXT,
	workspace_id TEXT,
	agent_role TEXT,
	status TEXT NOT NULL,
	error TEXT,
	result_summary TEXT,
	submitted_by TEXT,
	screenshot_asset_id TEXT,
	telegram_chat_id TEXT,
	telegram_topic_id TEXT,
	telegram_root_message_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_runs_chat ON capture_runs (telegram_chat_id, telegram_topic_id, created_at);
CREATE TABLE IF NOT EXISTS capture_assets (
	id TEXT PRIMARY KEY,
	run_id TEXT,
	mime_type TEXT NOT NULL,
	byte_size INTEGER NOT NULL,
	width INTEGER,
	height INTEGER,
	file_path TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	at TEXT NOT NULL,
	payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capture_events_run ON capture_events (run_id, seq);
CREATE TABLE IF NOT EXISTS capture_collab_messages (
	adapter TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	topic_id TEXT,
	run_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (adapter, channel_id, message_id)
);
CREATE TABLE IF NOT EXISTS telegram_updates (
	update_id INTEGER PRIMARY KEY,
	processed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_followup_keys (
	run_id TEXT NOT NULL,
	key TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (run_id, key)
);
CREATE TABLE IF NOT EXISTS capture_audit (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	action TEXT NOT NULL,
	run_id TEXT,
	actor TEXT,
	detail TEXT
);
`;

function rowToRun(row: RunRow): CaptureRun {
	const status: CaptureRunStatus = isCaptureRunStatus(row.status) ? row.status : "failed";
	const sourceType: CaptureSourceType = isCaptureSourceType(row.source_type) ? row.source_type : "full-screen";
	return {
		id: row.id,
		requestId: row.request_id,
		instruction: row.instruction,
		sourceType,
		status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.session_id !== null ? { sessionId: row.session_id } : {}),
		...(row.session_file !== null ? { sessionFile: row.session_file } : {}),
		...(row.runner_id !== null ? { runnerId: row.runner_id } : {}),
		...(row.workspace_id !== null ? { workspaceId: row.workspace_id } : {}),
		...(row.agent_role !== null ? { agentRole: row.agent_role } : {}),
		...(row.error !== null ? { error: row.error } : {}),
		...(row.result_summary !== null ? { resultSummary: row.result_summary } : {}),
		...(row.submitted_by !== null ? { submittedBy: row.submitted_by } : {}),
		...(row.screenshot_asset_id !== null ? { screenshotAssetId: row.screenshot_asset_id } : {}),
		...(row.telegram_chat_id !== null ? { telegramChatId: row.telegram_chat_id } : {}),
		...(row.telegram_topic_id !== null ? { telegramTopicId: row.telegram_topic_id } : {}),
		...(row.telegram_root_message_id !== null ? { telegramRootMessageId: row.telegram_root_message_id } : {}),
	};
}

function rowToAsset(row: AssetRow): CaptureAsset {
	return {
		id: row.id,
		mimeType: row.mime_type === "image/jpeg" ? "image/jpeg" : "image/png",
		byteSize: row.byte_size,
		filePath: row.file_path,
		createdAt: row.created_at,
		...(row.run_id !== null ? { runId: row.run_id } : {}),
		...(row.width !== null ? { width: row.width } : {}),
		...(row.height !== null ? { height: row.height } : {}),
	};
}

export interface RunPatch {
	status?: CaptureRunStatus;
	sessionId?: string;
	sessionFile?: string;
	runnerId?: string;
	workspaceId?: string;
	/** `undefined` leaves the value unchanged; `null` clears it to SQL NULL. */
	error?: string | null;
	/** `undefined` leaves the value unchanged; `null` clears it to SQL NULL. */
	resultSummary?: string | null;
	screenshotAssetId?: string;
	telegramChatId?: string;
	telegramTopicId?: string;
	telegramRootMessageId?: string;
}

export class CaptureStore {
	readonly #db: Database;
	readonly #assetsDir: string;
	readonly #now: () => string;

	constructor(options: CaptureStoreOptions) {
		fs.mkdirSync(options.dataDir, { recursive: true });
		this.#assetsDir = path.join(options.dataDir, "assets");
		fs.mkdirSync(this.#assetsDir, { recursive: true });
		this.#db = new Database(options.dbPath ?? path.join(options.dataDir, "capture.db"));
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec(SCHEMA);
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	close(): void {
		this.#db.close();
	}

	/**
	 * Persist the raw request and its run atomically. Idempotent: replaying the
	 * same requestId returns the already-created run with `created: false`.
	 */
	createRun(requestId: string, requestPayload: unknown, run: CaptureRun): { run: CaptureRun; created: boolean } {
		const insert = this.#db.transaction(() => {
			const existing = this.#db
				.query<RunRow, [string]>("SELECT * FROM capture_runs WHERE request_id = ?")
				.get(requestId);
			if (existing) return { run: rowToRun(existing), created: false };
			this.#db
				.query(
					"INSERT INTO capture_requests (request_id, payload, created_at) VALUES (?, ?, ?) ON CONFLICT(request_id) DO NOTHING",
				)
				.run(requestId, JSON.stringify(requestPayload ?? null), this.#now());
			this.#db
				.query(
					`INSERT INTO capture_runs (
						id, request_id, instruction, source_type, session_id, session_file, runner_id, workspace_id,
						agent_role, status, error, result_summary, submitted_by, screenshot_asset_id,
						telegram_chat_id, telegram_topic_id, telegram_root_message_id, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					run.id,
					run.requestId,
					run.instruction,
					run.sourceType,
					run.sessionId ?? null,
					run.sessionFile ?? null,
					run.runnerId ?? null,
					run.workspaceId ?? null,
					run.agentRole ?? null,
					run.status,
					run.error ?? null,
					run.resultSummary ?? null,
					run.submittedBy ?? null,
					run.screenshotAssetId ?? null,
					run.telegramChatId ?? null,
					run.telegramTopicId ?? null,
					run.telegramRootMessageId ?? null,
					run.createdAt,
					run.updatedAt,
				);
			return { run, created: true };
		});
		return insert();
	}

	getRun(id: string): CaptureRun | undefined {
		const row = this.#db.query<RunRow, [string]>("SELECT * FROM capture_runs WHERE id = ?").get(id);
		return row ? rowToRun(row) : undefined;
	}

	getRunByRequestId(requestId: string): CaptureRun | undefined {
		const row = this.#db.query<RunRow, [string]>("SELECT * FROM capture_runs WHERE request_id = ?").get(requestId);
		return row ? rowToRun(row) : undefined;
	}

	listRuns(limit = 50): CaptureRun[] {
		const rows = this.#db
			.query<RunRow, [number]>("SELECT * FROM capture_runs ORDER BY created_at DESC, id DESC LIMIT ?")
			.all(Math.max(1, Math.min(limit, 500)));
		return rows.map(rowToRun);
	}

	updateRun(id: string, patch: RunPatch): CaptureRun | undefined {
		const run = this.getRun(id);
		if (!run) return undefined;
		// definedEntries keeps null (an explicit clear) and drops undefined (unchanged);
		// stripNulls then removes cleared optionals from the returned object so it matches
		// CaptureRun, while `?? null` below persists them as SQL NULL.
		const next = stripNulls({ ...run, ...definedEntries(patch), updatedAt: this.#now() });
		this.#db
			.query(
				`UPDATE capture_runs SET
					status = ?, session_id = ?, session_file = ?, runner_id = ?, workspace_id = ?, error = ?,
					result_summary = ?, screenshot_asset_id = ?, telegram_chat_id = ?, telegram_topic_id = ?,
					telegram_root_message_id = ?, updated_at = ?
				WHERE id = ?`,
			)
			.run(
				next.status,
				next.sessionId ?? null,
				next.sessionFile ?? null,
				next.runnerId ?? null,
				next.workspaceId ?? null,
				next.error ?? null,
				next.resultSummary ?? null,
				next.screenshotAssetId ?? null,
				next.telegramChatId ?? null,
				next.telegramTopicId ?? null,
				next.telegramRootMessageId ?? null,
				next.updatedAt,
				id,
			);
		return next;
	}

	/** Append a run event to the durable log; returns its monotonic sequence number. */
	appendEvent(runId: string, event: CaptureRunEvent): number {
		const result = this.#db
			.query("INSERT INTO capture_events (run_id, at, payload) VALUES (?, ?, ?)")
			.run(runId, this.#now(), JSON.stringify(event));
		return Number(result.lastInsertRowid);
	}

	listEvents(runId: string, afterSeq = 0, limit = 500): StoredRunEvent[] {
		const rows = this.#db
			.query<{ seq: number; at: string; payload: string }, [string, number, number]>(
				"SELECT seq, at, payload FROM capture_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
			)
			.all(runId, afterSeq, Math.max(1, Math.min(limit, 2_000)));
		const events: StoredRunEvent[] = [];
		for (const row of rows) {
			try {
				events.push({ seq: row.seq, at: row.at, event: JSON.parse(row.payload) as CaptureRunEvent });
			} catch {
				// Skip unreadable rows rather than failing the whole replay.
			}
		}
		return events;
	}

	async saveAsset(
		bytes: Uint8Array,
		mimeType: CaptureScreenshotMimeType,
		options: { runId?: string; width?: number; height?: number } = {},
	): Promise<CaptureAsset> {
		const id = crypto.randomUUID();
		const extension = mimeType === "image/jpeg" ? "jpg" : "png";
		const filePath = path.join(this.#assetsDir, `${id}.${extension}`);
		await Bun.write(filePath, bytes);
		const createdAt = this.#now();
		try {
			this.#db
				.query(
					"INSERT INTO capture_assets (id, run_id, mime_type, byte_size, width, height, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					options.runId ?? null,
					mimeType,
					bytes.byteLength,
					options.width ?? null,
					options.height ?? null,
					filePath,
					createdAt,
				);
		} catch (error) {
			// The row was never written; remove the orphaned file so retention has nothing to miss.
			await fs.promises.unlink(filePath).catch(() => {});
			throw error;
		}
		return {
			id,
			mimeType,
			byteSize: bytes.byteLength,
			filePath,
			createdAt,
			...(options.runId !== undefined ? { runId: options.runId } : {}),
			...(options.width !== undefined ? { width: options.width } : {}),
			...(options.height !== undefined ? { height: options.height } : {}),
		};
	}

	getAsset(id: string): CaptureAsset | undefined {
		if (!isValidAssetId(id)) return undefined;
		const row = this.#db.query<AssetRow, [string]>("SELECT * FROM capture_assets WHERE id = ?").get(id);
		return row ? rowToAsset(row) : undefined;
	}

	async readAssetBytes(id: string): Promise<{ asset: CaptureAsset; bytes: Uint8Array } | undefined> {
		const asset = this.getAsset(id);
		if (!asset) return undefined;
		try {
			const bytes = await Bun.file(asset.filePath).bytes();
			return { asset, bytes };
		} catch {
			return undefined;
		}
	}

	/** Delete asset rows and files older than the retention window. Returns deleted count. */
	async cleanupExpiredAssets(retentionDays: number, now: Date = new Date()): Promise<number> {
		const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
		const rows = this.#db.query<AssetRow, [string]>("SELECT * FROM capture_assets WHERE created_at < ?").all(cutoff);
		let removed = 0;
		for (const row of rows) {
			try {
				await fs.promises.unlink(row.file_path);
			} catch (error) {
				// A missing file is fine (already gone); any other I/O error means the
				// bytes may still be on disk, so keep the row and retry next sweep.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
			}
			this.#db.query("DELETE FROM capture_assets WHERE id = ?").run(row.id);
			removed += 1;
		}
		return removed;
	}

	recordCollabMessage(
		adapter: string,
		channelId: string,
		messageId: string,
		runId: string,
		kind: "root" | "reply",
		topicId?: string,
	): void {
		this.#db
			.query(
				"INSERT INTO capture_collab_messages (adapter, channel_id, message_id, topic_id, run_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(adapter, channel_id, message_id) DO NOTHING",
			)
			.run(adapter, channelId, messageId, topicId ?? null, runId, kind, this.#now());
	}

	findRunIdByCollabMessage(adapter: string, channelId: string, messageId: string): string | undefined {
		const row = this.#db
			.query<{ run_id: string }, [string, string, string]>(
				"SELECT run_id FROM capture_collab_messages WHERE adapter = ? AND channel_id = ? AND message_id = ?",
			)
			.get(adapter, channelId, messageId);
		return row?.run_id;
	}

	/** Most recent run bound to a chat (and, when provided, forum topic). */
	findLatestRunForChat(chatId: string, topicId?: string): CaptureRun | undefined {
		const row = topicId
			? this.#db
					.query<RunRow, [string, string]>(
						"SELECT * FROM capture_runs WHERE telegram_chat_id = ? AND telegram_topic_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
					)
					.get(chatId, topicId)
			: this.#db
					.query<RunRow, [string]>(
						"SELECT * FROM capture_runs WHERE telegram_chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
					)
					.get(chatId);
		return row ? rowToRun(row) : undefined;
	}

	/** Atomically claim a Telegram update id. Returns false when it was already processed. */
	claimTelegramUpdate(updateId: number): boolean {
		const result = this.#db
			.query(
				"INSERT INTO telegram_updates (update_id, processed_at) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING",
			)
			.run(updateId, this.#now());
		return result.changes > 0;
	}

	/**
	 * Durably reserve a follow-up idempotency key for a run. Returns false when the
	 * key was already reserved (a duplicate). Survives settled turns and restarts,
	 * unlike an in-memory set; release the reservation if the follow-up is rejected.
	 */
	claimFollowUpKey(runId: string, key: string): boolean {
		const result = this.#db
			.query(
				"INSERT INTO capture_followup_keys (run_id, key, created_at) VALUES (?, ?, ?) ON CONFLICT(run_id, key) DO NOTHING",
			)
			.run(runId, key, this.#now());
		return result.changes > 0;
	}

	/** Release a previously claimed follow-up key so a rejected turn can be retried. */
	releaseFollowUpKey(runId: string, key: string): void {
		this.#db.query("DELETE FROM capture_followup_keys WHERE run_id = ? AND key = ?").run(runId, key);
	}

	audit(action: string, options: { runId?: string; actor?: string; detail?: string } = {}): void {
		this.#db
			.query("INSERT INTO capture_audit (at, action, run_id, actor, detail) VALUES (?, ?, ?, ?, ?)")
			.run(this.#now(), action, options.runId ?? null, options.actor ?? null, options.detail ?? null);
	}

	listAudit(runId: string, limit = 200): CaptureAuditEntry[] {
		const rows = this.#db
			.query<
				{ at: string; action: string; run_id: string | null; actor: string | null; detail: string | null },
				[string, number]
			>("SELECT at, action, run_id, actor, detail FROM capture_audit WHERE run_id = ? ORDER BY seq ASC LIMIT ?")
			.all(runId, Math.max(1, Math.min(limit, 1_000)));
		return rows.map(row => ({
			at: row.at,
			action: row.action,
			...(row.run_id !== null ? { runId: row.run_id } : {}),
			...(row.actor !== null ? { actor: row.actor } : {}),
			...(row.detail !== null ? { detail: row.detail } : {}),
		}));
	}
}

function definedEntries<T extends object>(patch: T): Partial<T> {
	return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Drop keys whose value is null (an applied clear) so the object matches its non-nullable type. */
function stripNulls<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], null> } {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as {
		[K in keyof T]: Exclude<T[K], null>;
	};
}
