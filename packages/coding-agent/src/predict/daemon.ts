/**
 * Server half of the machine-global text-prediction daemon (worker selector
 * `__omp_worker_text_predict`, started through the `text-predict` global broker).
 *
 * Lazily opens one `TextPredictor` per requested engine, keeps each learning
 * engine current with `history.db` (rows past a persisted row-id cursor, on
 * open and on every `sync`), persists on a 5-minute debounce and on exit, and exits
 * after an idle window. A learning engine that starts from empty state first
 * learns the Claude Code and Codex prompt histories (`foreign-history.ts`).
 * `smollm` requests are answered by SmolLM and ngram together (`blend.ts`).
 * Engine state that fails to load is wiped and rebuilt the same way.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type PredictedWord, TextPredictor } from "@oh-my-pi/pi-natives";
import { getHistoryDbPath, getPredictStateDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import { sqliteFileIdentity, withSqliteStoreLease } from "@oh-my-pi/pi-utils/sqlite";
import { JsonLineServer } from "../subprocess/jsonl-server";
import { openSqliteReadConnectionSync } from "../tools/sqlite-reader";
import { blendPredictions } from "./blend";
import { readForeignPrompts } from "./foreign-history";
import {
	TEXT_PREDICT_AGENT_DIR_ENV,
	TEXT_PREDICT_SOCKET_ENV,
	type TextPredictMethod,
	type TextPredictRequest,
	type TextPredictResponse,
	textPredictReadyBanner,
} from "./protocol";
import { getSmolLmModelDir, smolLmWeightsReady } from "./smollm-weights";

/** Exit after this long without a request; clients restart the daemon on demand. */
const IDLE_EXIT_MS = 15 * 60_000;
/**
 * Persist learned state once changes have been quiet this long. Each persist
 * rewrites the whole engine snapshot (~1 MB for ngram) plus `cursor.json`, so
 * typing must not trigger one every few seconds. Durability trade-off: a crash
 * loses only accept/reject feedback since the last persist; prompts are
 * re-learned on the next open by ingesting `history.db` rows past the persisted
 * cursor. Idle exit and shutdown still persist (`onStop`).
 */
const PERSIST_DEBOUNCE_MS = 5 * 60_000;
/** Persist at the latest this long after the first unpersisted change, even while changes keep arriving. */
const PERSIST_MAX_DIRTY_MS = 15 * 60_000;
/** History rows per `observe` batch during ingestion. */
const INGEST_BATCH = 1_000;
/** After an engine fails to open, requests for it fail fast for this long before a retry. */
const OPEN_RETRY_MS = 60_000;
/** While SmolLM weights are missing (composer still fetching), recheck the marker at most this often. */
const WEIGHTS_RECHECK_MS = 5_000;
const CURSOR_FILE = "cursor.json";

export interface HistoryCursor {
	/** Decimal SQLite rowid; values above 2^53 stay exact. */
	historyId: string;
	historyIdentity?: string;
}

const HISTORY_ID_PATTERN = /^(?:0|[1-9]\d{0,19})$/;

function parseHistoryCursorId(value: unknown): string {
	if (typeof value === "string" && HISTORY_ID_PATTERN.test(value) && BigInt(value) <= 9223372036854775807n)
		return value;
	// Existing checkpoints predate decimal ids; migrate only values JS represented exactly.
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
	return "0";
}

/** A legacy cursor without an identity re-ingests once rather than skipping a replacement's low ids. */
export async function readCursor(stateDir: string): Promise<HistoryCursor | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(stateDir, CURSOR_FILE)).json();
		const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
		const historyId = record ? parseHistoryCursorId(record.historyId) : undefined;
		if (historyId !== undefined) {
			const identity = record?.historyIdentity;
			return { historyId, historyIdentity: typeof identity === "string" ? identity : undefined };
		}
		return { historyId: "0" };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("text-predict: unreadable history cursor; re-ingesting", { stateDir, error: String(error) });
		return { historyId: "0" };
	}
}

/** SmolLM was requested before its weights exist; not a load failure, so no retry backoff. */
class SmolLmWeightsMissingError extends Error {
	constructor() {
		super(
			"SmolLM weights are not downloaded yet (the editor fetches them on first use, or run `omp tiny-models download smollm`)",
		);
	}
}

/**
 * Trailing debounce capped by a maximum dirty age: each change pushes the
 * flush to `debounceMs` after it, but never past `maxDirtyMs` after the first
 * unflushed change. Consecutive flushes are therefore at least `debounceMs`
 * apart, and a steady stream of changes still flushes every `maxDirtyMs`.
 */
export class PersistCadence {
	readonly #debounceMs: number;
	readonly #maxDirtyMs: number;
	readonly #flush: () => void;
	#timer: NodeJS.Timeout | undefined;
	#dirtySince: number | undefined;

	constructor(debounceMs: number, maxDirtyMs: number, flush: () => void) {
		this.#debounceMs = debounceMs;
		this.#maxDirtyMs = maxDirtyMs;
		this.#flush = flush;
	}

	/** Record a change and (re)arm the flush. */
	touch(): void {
		const now = Date.now();
		this.#dirtySince ??= now;
		const delay = Math.max(0, Math.min(this.#debounceMs, this.#dirtySince + this.#maxDirtyMs - now));
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#dirtySince = undefined;
			this.#flush();
		}, delay);
	}

	/** Drop a pending flush (the caller persists on stop instead). */
	cancel(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#dirtySince = undefined;
	}
}

/** One open engine plus the history position its persisted state covers. */
export class Engine {
	/** Highest `history.id` fed to `observe`. */
	cursor: string;
	/** Foreign prompt histories still owed to empty state (see {@link readForeignPrompts}). */
	#seed: boolean;
	/** Cursor value covered by the last successful persist. */
	#persistedCursor: string;
	#historyIdentity?: string;
	#persistedIdentity?: string;
	#dirty = false;
	#ingesting: Promise<number> = Promise.resolve(0);

	constructor(
		readonly method: TextPredictMethod,
		readonly stateDir: string,
		readonly predictor: TextPredictor,
		checkpoint: HistoryCursor | undefined,
	) {
		this.cursor = parseHistoryCursorId(checkpoint?.historyId);
		this.#historyIdentity = checkpoint?.historyIdentity;
		this.#persistedIdentity = this.#historyIdentity;
		this.#persistedCursor = this.cursor;
		this.#seed = checkpoint === undefined;
	}

	get dirty(): boolean {
		return this.#dirty || this.cursor !== this.#persistedCursor || this.#historyIdentity !== this.#persistedIdentity;
	}

	markDirty(): void {
		this.#dirty = true;
	}

	/**
	 * Feed history rows past the cursor through `observe`, one ingestion at a
	 * time; empty state first learns the foreign prompt histories.
	 */
	ingest(historyDbPath: string): Promise<number> {
		// `apple` only wraps the system dictionary; it learns nothing.
		if (this.method === "apple") return Promise.resolve(0);
		const run = (): Promise<number> => this.#ingestNow(historyDbPath);
		this.#ingesting = this.#ingesting.then(run, run);
		return this.#ingesting;
	}

	async persist(): Promise<void> {
		if (!this.dirty) return;
		const cursor = this.cursor;
		const historyIdentity = this.#historyIdentity;
		this.#dirty = false;
		try {
			await this.predictor.persist();
			await Bun.write(path.join(this.stateDir, CURSOR_FILE), JSON.stringify({ historyId: cursor, historyIdentity }));
			this.#persistedCursor = cursor;
			this.#persistedIdentity = historyIdentity;
		} catch (error) {
			this.#dirty = true;
			throw error;
		}
	}

	async #ingestNow(historyDbPath: string): Promise<number> {
		let ingested = 0;
		if (this.#seed) {
			const prompts = await readForeignPrompts();
			for (let at = 0; at < prompts.length; at += INGEST_BATCH) {
				await this.predictor.observe(prompts.slice(at, at + INGEST_BATCH));
			}
			this.#seed = false;
			if (prompts.length > 0) this.markDirty();
			ingested += prompts.length;
		}
		for (;;) {
			let batch: { rows: Array<{ id: string; prompt: string }>; identity: string; cursor: string };
			try {
				batch = withSqliteStoreLease(historyDbPath, () => {
					const db = openSqliteReadConnectionSync(historyDbPath);
					try {
						const identity = sqliteFileIdentity(historyDbPath);
						if (typeof identity !== "string") throw new Error("Could not identify the history store");
						const cursor = identity === this.#historyIdentity ? this.cursor : "0";
						const rows = db
							.query<{ id: string; prompt: string }, [string, number]>(
								"SELECT CAST(id AS TEXT) AS id, prompt FROM history WHERE id > CAST(? AS INTEGER) AND typeof(prompt) = 'text' ORDER BY id LIMIT ?",
							)
							.all(cursor, INGEST_BATCH);
						return { rows, identity, cursor };
					} finally {
						db.close();
					}
				});
			} catch (error) {
				// No history yet (fresh install) is not an error.
				if (!isEnoent(error)) logger.debug("text-predict: history unavailable", { error: String(error) });
				return ingested;
			}
			const { rows, identity, cursor } = batch;
			if (rows.length) await this.predictor.observe(rows.map(row => row.prompt));
			this.cursor = rows.at(-1)?.id ?? cursor;
			this.#historyIdentity = identity;
			ingested += rows.length;
			if (rows.length < INGEST_BATCH) break;
		}
		return ingested;
	}
}

/** Serves every connection; engines open lazily on their first request. */
class TextPredictDaemon {
	#agentDir: string;
	#historyDbPath: string;
	#engines = new Map<TextPredictMethod, Promise<Engine>>();
	#failedAt = new Map<TextPredictMethod, number>();
	/** Engines whose weights were missing, keyed to when that was observed. */
	#missingAt = new Map<TextPredictMethod, number>();
	#persistCadence = new PersistCadence(PERSIST_DEBOUNCE_MS, PERSIST_MAX_DIRTY_MS, () => void this.#persistAll());
	#server = new JsonLineServer<TextPredictRequest, TextPredictResponse>({
		name: "text-predict",
		cleanupLabel: "text-predict-daemon",
		idleMs: IDLE_EXIT_MS,
		banner: textPredictReadyBanner,
		onRequest: (request, reply) =>
			void this.#server.busy(() => this.#dispatch(request)).then(response => reply.send(response)),
		beforeStop: () => this.#persistCadence.cancel(),
		onStop: () => this.#persistAll(),
	});

	constructor(agentDir: string) {
		this.#agentDir = agentDir;
		this.#historyDbPath = getHistoryDbPath(agentDir);
	}

	/** Bind `endpoint` and serve until idle exit or `shutdown`. */
	serve(endpoint: string): Promise<void> {
		return this.#server.serve(endpoint);
	}

	async #dispatch(request: TextPredictRequest): Promise<TextPredictResponse> {
		try {
			return await this.#handle(request);
		} catch (error) {
			return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async #handle(request: TextPredictRequest): Promise<TextPredictResponse> {
		switch (request.op) {
			case "ping":
				return {
					id: request.id,
					ok: true,
					op: "ping",
					version: VERSION,
					pid: process.pid,
					engines: [...this.#engines.keys()],
				};
			case "complete": {
				const suggestion =
					request.method === "smollm"
						? await this.#blend(request.before, request.prefix)
						: await (await this.#engine(request.method)).predictor.complete(request.before, request.prefix);
				return { id: request.id, ok: true, op: "complete", suggestion };
			}
			case "feedback": {
				const engine = await this.#engine(request.method);
				await engine.predictor.feedback(request.before, request.prefix, request.suggestion, request.accepted);
				engine.markDirty();
				this.#persistCadence.touch();
				return { id: request.id, ok: true, op: "feedback" };
			}
			case "sync": {
				let ingested = 0;
				for (const pending of this.#engines.values()) {
					const engine = await pending.catch(() => undefined);
					if (engine) ingested += await engine.ingest(this.#historyDbPath);
				}
				if (ingested > 0) this.#persistCadence.touch();
				return { id: request.id, ok: true, op: "sync", ingested };
			}
			case "shutdown":
				setImmediate(() => this.#server.exit("shutdown requested"));
				return { id: request.id, ok: true, op: "shutdown" };
		}
	}

	/**
	 * The `smollm` setting: SmolLM's and ngram's answers blended
	 * ({@link blendPredictions}). Until SmolLM loads (weights still
	 * downloading) or while it cannot, ngram answers alone through the blend.
	 */
	async #blend(before: string, prefix: string): Promise<PredictedWord | null> {
		const [ngram, smollm] = await Promise.all([
			this.#engine("ngram").then(engine => engine.predictor.complete(before, prefix)),
			this.#engine("smollm").then(
				engine => engine.predictor.complete(before, prefix),
				() => null,
			),
		]);
		return blendPredictions(ngram, smollm);
	}

	#engine(method: TextPredictMethod): Promise<Engine> {
		const now = Date.now();
		const failedAt = this.#failedAt.get(method);
		if (failedAt !== undefined && now - failedAt >= OPEN_RETRY_MS) {
			this.#failedAt.delete(method);
			this.#engines.delete(method);
		}
		const missingAt = this.#missingAt.get(method);
		if (missingAt !== undefined && now - missingAt >= WEIGHTS_RECHECK_MS) {
			this.#missingAt.delete(method);
			this.#engines.delete(method);
		}
		let pending = this.#engines.get(method);
		if (!pending) {
			pending = this.#open(method);
			this.#engines.set(method, pending);
			pending.catch(error => {
				if (error instanceof SmolLmWeightsMissingError) {
					// Rechecked after WEIGHTS_RECHECK_MS: the composer is fetching them.
					this.#missingAt.set(method, Date.now());
					return;
				}
				this.#failedAt.set(method, Date.now());
				logger.warn("text-predict: engine unavailable", { method, error: String(error) });
			});
		}
		return pending;
	}

	async #open(method: TextPredictMethod): Promise<Engine> {
		let modelDir: string | undefined;
		if (method === "smollm") {
			if (!(await smolLmWeightsReady())) throw new SmolLmWeightsMissingError();
			modelDir = getSmolLmModelDir();
		}
		const stateDir = getPredictStateDir(this.#agentDir, method);
		await fs.mkdir(stateDir, { recursive: true });
		const startedAt = performance.now();
		// SmolLM only serves the blend, which gates on its own score.
		const showThreshold = method === "smollm" ? 0 : undefined;
		let predictor = new TextPredictor({ method, stateDir, modelDir, showThreshold });
		let cursor: HistoryCursor | undefined;
		try {
			await predictor.ready();
			cursor = await readCursor(stateDir);
		} catch (error) {
			// Unloadable state (corrupt, or from an incompatible engine version):
			// start over and rebuild it like a fresh install.
			logger.warn("text-predict: engine state failed to load; rebuilding", { method, error: String(error) });
			await fs.rm(stateDir, { recursive: true, force: true });
			await fs.mkdir(stateDir, { recursive: true });
			predictor = new TextPredictor({ method, stateDir, modelDir, showThreshold });
			await predictor.ready();
			cursor = undefined;
		}
		const engine = new Engine(method, stateDir, predictor, cursor);
		const ingested = await engine.ingest(this.#historyDbPath);
		if (ingested > 0) this.#persistCadence.touch();
		logger.debug("text-predict: engine ready", {
			method,
			ingested,
			ms: Math.round(performance.now() - startedAt),
		});
		return engine;
	}

	async #persistAll(): Promise<void> {
		for (const pending of this.#engines.values()) {
			const engine = await pending.catch(() => undefined);
			if (!engine) continue;
			try {
				await engine.persist();
			} catch (error) {
				logger.warn("text-predict: persist failed", { method: engine.method, error: String(error) });
			}
		}
	}
}

/** Worker entry: serve the endpoint and agent directory named by the broker spec environment. */
export async function startTextPredictDaemonFromEnvironment(): Promise<void> {
	const endpoint = Bun.env[TEXT_PREDICT_SOCKET_ENV];
	const agentDir = Bun.env[TEXT_PREDICT_AGENT_DIR_ENV];
	if (!endpoint || !agentDir) {
		throw new Error(`${TEXT_PREDICT_SOCKET_ENV} and ${TEXT_PREDICT_AGENT_DIR_ENV} must be set`);
	}
	await new TextPredictDaemon(agentDir).serve(endpoint);
}
