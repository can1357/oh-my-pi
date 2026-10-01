import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TrialRow } from "./types";

export interface TbSummaryRow {
	model: string;
	trials: number;
	passed: number;
	errors: number;
	agentTimeouts: number;
	meanReward: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	meanTurns: number;
	meanAgentMs: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS epochs (
	epoch INTEGER PRIMARY KEY,
	started_at INTEGER NOT NULL,
	finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS trials (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	epoch INTEGER NOT NULL,
	model TEXT NOT NULL,
	task TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	status TEXT NOT NULL,
	reward REAL,
	agent_timed_out INTEGER NOT NULL,
	input_tokens INTEGER,
	output_tokens INTEGER,
	cache_read_tokens INTEGER,
	cache_write_tokens INTEGER,
	cost_usd REAL,
	turns INTEGER,
	agent_ms INTEGER,
	verifier_ms INTEGER,
	wall_ms INTEGER,
	error TEXT,
	trial_dir TEXT NOT NULL,
	started_at INTEGER,
	finished_at INTEGER,
	UNIQUE(epoch, model, task, attempt)
);
`;

const SUMMARY_COLUMNS = `
	model,
	COUNT(*) AS trials,
	SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed,
	SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
	SUM(agent_timed_out) AS agentTimeouts,
	COALESCE(AVG(COALESCE(reward, 0)), 0) AS meanReward,
	COALESCE(SUM(cost_usd), 0) AS costUsd,
	COALESCE(SUM(input_tokens), 0) AS inputTokens,
	COALESCE(SUM(output_tokens), 0) AS outputTokens,
	COALESCE(AVG(turns), 0) AS meanTurns,
	COALESCE(AVG(agent_ms), 0) AS meanAgentMs`;

export class TbStore {
	#db: Database;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
		this.#db = new Database(dbPath);
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run(SCHEMA);
	}

	resumeEpoch(): number | null {
		const row = this.#db
			.query("SELECT epoch FROM epochs WHERE finished_at IS NULL ORDER BY epoch DESC LIMIT 1")
			.get() as { epoch: number } | null;
		return row?.epoch ?? null;
	}

	beginEpoch(): number {
		const row = this.#db.query("SELECT COALESCE(MAX(epoch), 0) + 1 AS epoch FROM epochs").get() as { epoch: number };
		this.#db.query("INSERT INTO epochs (epoch, started_at) VALUES (?, ?)").run(row.epoch, Date.now());
		return row.epoch;
	}

	finishEpoch(epoch: number): void {
		this.#db.query("UPDATE epochs SET finished_at = ? WHERE epoch = ?").run(Date.now(), epoch);
	}

	completedKeys(epoch: number): Set<string> {
		const rows = this.#db.query("SELECT model, task, attempt FROM trials WHERE epoch = ?").all(epoch) as Array<{
			model: string;
			task: string;
			attempt: number;
		}>;
		return new Set(rows.map(row => `${row.model}\u0000${row.task}\u0000${row.attempt}`));
	}

	insertTrial(row: TrialRow): void {
		this.#db
			.query(
				`INSERT INTO trials (
					epoch, model, task, attempt, status, reward, agent_timed_out,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
					cost_usd, turns, agent_ms, verifier_ms, wall_ms, error, trial_dir,
					started_at, finished_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(epoch, model, task, attempt) DO UPDATE SET
					status = excluded.status,
					reward = excluded.reward,
					agent_timed_out = excluded.agent_timed_out,
					input_tokens = excluded.input_tokens,
					output_tokens = excluded.output_tokens,
					cache_read_tokens = excluded.cache_read_tokens,
					cache_write_tokens = excluded.cache_write_tokens,
					cost_usd = excluded.cost_usd,
					turns = excluded.turns,
					agent_ms = excluded.agent_ms,
					verifier_ms = excluded.verifier_ms,
					wall_ms = excluded.wall_ms,
					error = excluded.error,
					trial_dir = excluded.trial_dir,
					started_at = excluded.started_at,
					finished_at = excluded.finished_at`,
			)
			.run(
				row.epoch,
				row.model,
				row.task,
				row.attempt,
				row.status,
				row.reward,
				row.agentTimedOut ? 1 : 0,
				row.inputTokens,
				row.outputTokens,
				row.cacheReadTokens,
				row.cacheWriteTokens,
				row.costUsd,
				row.turns,
				row.agentMs,
				row.verifierMs,
				row.wallMs,
				row.error,
				row.trialDir,
				row.startedAt,
				row.finishedAt,
			);
	}

	epochSummary(epoch: number): TbSummaryRow[] {
		return this.#db
			.query(`SELECT ${SUMMARY_COLUMNS} FROM trials WHERE epoch = ? GROUP BY model ORDER BY model`)
			.all(epoch) as TbSummaryRow[];
	}

	overallSummary(): TbSummaryRow[] {
		return this.#db
			.query(`SELECT ${SUMMARY_COLUMNS} FROM trials GROUP BY model ORDER BY model`)
			.all() as TbSummaryRow[];
	}

	epochSpend(epoch: number): number {
		const row = this.#db
			.query("SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM trials WHERE epoch = ?")
			.get(epoch) as { spend: number };
		return row.spend;
	}

	close(): void {
		this.#db.close();
	}
}
