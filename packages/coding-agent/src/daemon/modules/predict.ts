/**
 * `predict` module: ghost-text word completion for one agent directory per unit.
 *
 * A unit lazily opens one `TextPredictor` per requested engine inside the
 * daemon (the native engines run on their own threads), keeps each learning
 * engine current with `history.db` (rows past a persisted row-id cursor, on
 * open and on every `sync`), and persists on a 5-minute debounce and on
 * flush/stop. A learning engine that starts from empty state first learns the
 * Claude Code and Codex prompt histories (`foreign-history.ts`). `smollm`
 * requests are answered by SmolLM and ngram together (`blend.ts`). Engine
 * state that fails to load is wiped and rebuilt the same way.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import { type PredictedWord, TextPredictor } from "@oh-my-pi/pi-natives";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { blendPredictions } from "../../predict/blend";
import { readForeignPrompts } from "../../predict/foreign-history";
import {
	TEXT_PREDICT_KIND,
	TEXT_PREDICT_METHODS,
	type TextPredictCallMethod,
	type TextPredictCalls,
	type TextPredictMethod,
	type TextPredictOpenParams,
} from "../../predict/protocol";
import { smolLmWeightsReady } from "../../predict/smollm-weights";
import { openSqliteReadConnection } from "../../tools/sqlite-reader";
import type { DaemonModule, ModuleUnit } from "../module";
import type { UnitPolicy } from "../protocol";

/** Bumped on incompatible changes to {@link TextPredictOpenParams} or {@link TextPredictCalls}. */
const PREDICT_MODULE_VERSION = 1;
/** Idle window after the last lease and call before the unit flushes and stops. */
const IDLE_MS = 15 * 60_000;
/**
 * Persist learned state once changes have been quiet this long. Each persist
 * rewrites the whole engine snapshot (~1 MB for ngram) plus `cursor.json`, so
 * typing must not trigger one every few seconds. Durability trade-off: a crash
 * loses only accept/reject feedback since the last persist; prompts are
 * re-learned on the next open by ingesting `history.db` rows past the persisted
 * cursor. Flush and stop still persist.
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

const POLICY: UnitPolicy = {
	hold: "leases",
	idleMs: IDLE_MS,
	onIdle: "flush-stop",
	restart: "no",
	survive: "none",
};

function parseOpenParams(params: unknown): TextPredictOpenParams {
	if (
		isRecord(params) &&
		typeof params.agentDir === "string" &&
		typeof params.historyDbPath === "string" &&
		typeof params.modelDir === "string" &&
		isRecord(params.stateDirs)
	) {
		const stateDirs = params.stateDirs;
		if (TEXT_PREDICT_METHODS.every(method => typeof stateDirs[method] === "string")) {
			return params as unknown as TextPredictOpenParams;
		}
	}
	throw new Error("predict: open params need agentDir, historyDbPath, modelDir, and stateDirs");
}

function requireString(params: Record<string, unknown>, field: string): string {
	const value = params[field];
	if (typeof value !== "string") throw new Error(`predict: ${field} must be a string`);
	return value;
}

function requireMethod(params: Record<string, unknown>): TextPredictMethod {
	const method = params.method;
	if (typeof method !== "string" || !(TEXT_PREDICT_METHODS as readonly string[]).includes(method)) {
		throw new Error(`predict: unknown method ${String(method)}`);
	}
	return method as TextPredictMethod;
}

/** Persisted history cursor, or `undefined` when the engine has no persisted state yet. */
async function readCursor(stateDir: string): Promise<number | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(stateDir, CURSOR_FILE)).json();
		if (isRecord(raw) && typeof raw.historyId === "number") return raw.historyId;
		return 0;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn("text-predict: unreadable history cursor; re-ingesting", { stateDir, error: String(error) });
		return 0;
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
class Engine {
	/** Highest `history.id` fed to `observe`. */
	cursor: number;
	/** Foreign prompt histories still owed to empty state (see {@link readForeignPrompts}). */
	#seed: boolean;
	/** Cursor value covered by the last successful persist. */
	#persistedCursor: number;
	#dirty = false;
	#ingesting: Promise<number> = Promise.resolve(0);

	constructor(
		readonly method: TextPredictMethod,
		readonly stateDir: string,
		readonly predictor: TextPredictor,
		cursor: number | undefined,
	) {
		this.cursor = cursor ?? 0;
		this.#persistedCursor = this.cursor;
		this.#seed = cursor === undefined;
	}

	get dirty(): boolean {
		return this.#dirty || this.cursor !== this.#persistedCursor;
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
		this.#dirty = false;
		try {
			await this.predictor.persist();
			await Bun.write(path.join(this.stateDir, CURSOR_FILE), JSON.stringify({ historyId: cursor }));
			this.#persistedCursor = cursor;
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
		let db: Database;
		try {
			db = await openSqliteReadConnection(historyDbPath);
		} catch (error) {
			// No history yet (fresh install) is not an error.
			if (!isEnoent(error)) logger.debug("text-predict: history unavailable", { error: String(error) });
			return ingested;
		}
		try {
			const page = db.query<{ id: number; prompt: string }, [number, number]>(
				"SELECT id, prompt FROM history WHERE id > ? AND typeof(prompt) = 'text' ORDER BY id LIMIT ?",
			);
			for (;;) {
				const rows = page.all(this.cursor, INGEST_BATCH);
				if (rows.length === 0) break;
				await this.predictor.observe(rows.map(row => row.prompt));
				this.cursor = rows.at(-1)?.id ?? this.cursor;
				ingested += rows.length;
				if (rows.length < INGEST_BATCH) break;
			}
		} finally {
			db.close();
		}
		return ingested;
	}
}

/** The engines of one agent directory; engines open lazily on their first call. */
class PredictUnit implements ModuleUnit {
	readonly label: string;
	readonly ready = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;
	readonly #params: TextPredictOpenParams;
	readonly #engines = new Map<TextPredictMethod, Promise<Engine>>();
	readonly #failedAt = new Map<TextPredictMethod, number>();
	/** Engines whose weights were missing, keyed to when that was observed. */
	readonly #missingAt = new Map<TextPredictMethod, number>();
	readonly #persistCadence = new PersistCadence(
		PERSIST_DEBOUNCE_MS,
		PERSIST_MAX_DIRTY_MS,
		() => void this.#persistAll(),
	);
	readonly #resolveExited: (exit: { exitCode?: number; reason?: string }) => void;
	#inFlight = 0;
	#stopped = false;

	constructor(params: TextPredictOpenParams) {
		this.#params = params;
		this.label = `text prediction (${params.agentDir})`;
		const { promise, resolve } = Promise.withResolvers<{ exitCode?: number; reason?: string }>();
		this.exited = promise;
		this.#resolveExited = resolve;
	}

	pids(): number[] {
		return [];
	}

	busy(): boolean {
		return this.#inFlight > 0;
	}

	attach(): void {
		throw new Error("predict units take calls, not tunnels");
	}

	async flush(): Promise<void> {
		this.#persistCadence.cancel();
		await this.#persistAll();
	}

	async stop(reason: string): Promise<void> {
		if (this.#stopped) return this.exited.then(() => undefined);
		this.#stopped = true;
		this.#persistCadence.cancel();
		await this.#persistAll();
		this.#engines.clear();
		this.#resolveExited({ reason });
	}

	/** Serve one `call`; counted as in-flight work for the idle timer. */
	async call(method: string, params: unknown): Promise<unknown> {
		if (this.#stopped) throw new Error("predict unit stopped");
		this.#inFlight++;
		try {
			return await this.#handle(method, isRecord(params) ? params : {});
		} finally {
			this.#inFlight--;
		}
	}

	async #handle(
		method: string,
		params: Record<string, unknown>,
	): Promise<TextPredictCalls[TextPredictCallMethod]["result"]> {
		switch (method) {
			case "complete": {
				const engine = requireMethod(params);
				const before = requireString(params, "before");
				const prefix = requireString(params, "prefix");
				if (engine === "smollm") return this.#blend(before, prefix);
				return (await this.#engine(engine)).predictor.complete(before, prefix);
			}
			case "feedback": {
				const engine = await this.#engine(requireMethod(params));
				if (typeof params.accepted !== "boolean") throw new Error("predict: accepted must be a boolean");
				await engine.predictor.feedback(
					requireString(params, "before"),
					requireString(params, "prefix"),
					requireString(params, "suggestion"),
					params.accepted,
				);
				engine.markDirty();
				this.#persistCadence.touch();
				return null;
			}
			case "sync": {
				let ingested = 0;
				for (const pending of this.#engines.values()) {
					const engine = await pending.catch(() => undefined);
					if (engine) ingested += await engine.ingest(this.#params.historyDbPath);
				}
				if (ingested > 0) this.#persistCadence.touch();
				return { ingested };
			}
			default:
				throw new Error(`predict: unknown call ${method}`);
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
			if (!(await smolLmWeightsReady(this.#params.modelDir))) throw new SmolLmWeightsMissingError();
			modelDir = this.#params.modelDir;
		}
		const stateDir = this.#params.stateDirs[method];
		await fs.mkdir(stateDir, { recursive: true });
		const startedAt = performance.now();
		// SmolLM only serves the blend, which gates on its own score.
		const showThreshold = method === "smollm" ? 0 : undefined;
		let predictor = new TextPredictor({ method, stateDir, modelDir, showThreshold });
		let cursor: number | undefined;
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
		const ingested = await engine.ingest(this.#params.historyDbPath);
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

/** Text prediction, one global unit per agent directory (key: `textPredictKey`). */
export const predictModule: DaemonModule = {
	kind: TEXT_PREDICT_KIND,
	version: PREDICT_MODULE_VERSION,
	policy: () => POLICY,
	open: (_context, request) => new PredictUnit(parseOpenParams(request.params)),
	async call(_context, method, params, _client, unit) {
		if (!unit) throw new Error("predict calls must name a unit");
		if (!(unit.unit instanceof PredictUnit))
			throw new Error(`predict: unit ${unit.snapshot.id} is not a predict unit`);
		return unit.unit.call(method, params);
	},
};
