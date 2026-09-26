/**
 * Server half of the machine-global text-prediction daemon (worker selector
 * `__omp_worker_text_predict`, started through the `text-predict` global broker).
 *
 * Lazily opens one `TextPredictor` per requested engine, keeps each learning
 * engine current with `history.db` (rows past a persisted row-id cursor, on
 * open and on every `sync`), persists on a debounce and on exit, and exits
 * after an idle window. Engine state that fails to load is wiped and rebuilt
 * from the full history.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import { TextPredictor } from "@oh-my-pi/pi-natives";
import { getHistoryDbPath, isEnoent, logger, postmortem, VERSION, withFileLock } from "@oh-my-pi/pi-utils";
import { LineParser, writeJsonLine } from "../tiny/jsonl-socket";
import { endpointAlive } from "../tiny/worker-server";
import { openSqliteReadConnection } from "../tools/sqlite-reader";
import {
	TEXT_PREDICT_AGENT_DIR_ENV,
	TEXT_PREDICT_SOCKET_ENV,
	type TextPredictMethod,
	type TextPredictRequest,
	type TextPredictResponse,
	type TextPredictTarget,
	textPredictReadyBanner,
} from "./protocol";
import { ensureSmolLmWeights } from "./smollm-weights";

/** Exit after this long without a request; clients restart the daemon on demand. */
const IDLE_EXIT_MS = 15 * 60_000;
/** Persist learned state this long after the last change. */
const PERSIST_DEBOUNCE_MS = 30_000;
/** History rows per `observe` batch during ingestion. */
const INGEST_BATCH = 1_000;
/** After an engine fails to open, requests for it fail fast for this long before a retry. */
const OPEN_RETRY_MS = 60_000;
const SHUTDOWN_BUDGET_MS = 2_000;
const CURSOR_FILE = "cursor.json";

async function readCursor(stateDir: string): Promise<number> {
	try {
		const raw: unknown = await Bun.file(path.join(stateDir, CURSOR_FILE)).json();
		if (typeof raw === "object" && raw !== null && "historyId" in raw && typeof raw.historyId === "number") {
			return raw.historyId;
		}
		return 0;
	} catch (error) {
		if (isEnoent(error)) return 0;
		logger.warn("text-predict: unreadable history cursor; re-ingesting", { stateDir, error: String(error) });
		return 0;
	}
}

/** One open engine plus the history position its persisted state covers. */
class Engine {
	/** Highest `history.id` fed to `observe`. */
	cursor: number;
	/** Cursor value covered by the last successful persist. */
	#persistedCursor: number;
	#dirty = false;
	#ingesting: Promise<number> = Promise.resolve(0);

	constructor(
		readonly method: TextPredictMethod,
		readonly stateDir: string,
		readonly predictor: TextPredictor,
		cursor: number,
	) {
		this.cursor = cursor;
		this.#persistedCursor = cursor;
	}

	get dirty(): boolean {
		return this.#dirty || this.cursor !== this.#persistedCursor;
	}

	markDirty(): void {
		this.#dirty = true;
	}

	/** Feed history rows past the cursor through `observe`, one ingestion at a time. */
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
		let db: Database;
		try {
			db = await openSqliteReadConnection(historyDbPath);
		} catch (error) {
			// No history yet (fresh install) is not an error.
			if (!isEnoent(error)) logger.debug("text-predict: history unavailable", { error: String(error) });
			return 0;
		}
		let ingested = 0;
		try {
			const page = db.query<{ id: number; prompt: string }, [number, number]>(
				"SELECT id, prompt FROM history WHERE id > ? ORDER BY id LIMIT ?",
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

/** Serves every connection; engines open lazily on their first request. */
class TextPredictDaemon {
	#agentDir: string;
	#historyDbPath: string;
	#engines = new Map<TextPredictMethod, Promise<Engine>>();
	/** Engines whose open finished, so `auto` can tell "loaded" from "still opening" without waiting. */
	#loaded = new Map<TextPredictMethod, Engine>();
	#failedAt = new Map<TextPredictMethod, number>();
	#connections = new Set<net.Socket>();
	#server: net.Server | undefined;
	#endpoint = "";
	#idleTimer: NodeJS.Timeout | undefined;
	#persistTimer: NodeJS.Timeout | undefined;
	#inFlight = 0;
	#stopped = Promise.withResolvers<void>();
	#stopping: Promise<void> | undefined;

	constructor(agentDir: string) {
		this.#agentDir = agentDir;
		this.#historyDbPath = getHistoryDbPath(agentDir);
	}

	/** Bind `endpoint` and serve until idle exit or `shutdown`. */
	async serve(endpoint: string): Promise<void> {
		this.#endpoint = endpoint;
		if (process.platform === "win32") {
			await this.#listen(endpoint);
		} else {
			await withFileLock(`${endpoint}.bind`, async () => {
				await this.#clearStaleSocket(endpoint);
				await this.#listen(endpoint);
			});
		}
		const cancelCleanup = postmortem.register("text-predict-daemon", () => this.#shutdown());
		this.#armIdle();
		process.stdout.write(`${textPredictReadyBanner(endpoint)}\n`);
		try {
			await this.#stopped.promise;
		} finally {
			cancelCleanup();
		}
	}

	#listen(endpoint: string): Promise<void> {
		const server = net.createServer(socket => this.#accept(socket));
		this.#server = server;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.off("error", reject);
			resolve();
		});
		return promise;
	}

	async #clearStaleSocket(endpoint: string): Promise<void> {
		try {
			await fs.stat(endpoint);
		} catch {
			return;
		}
		if (await endpointAlive(endpoint)) throw new Error(`text-predict daemon already listening on ${endpoint}`);
		await fs.unlink(endpoint);
	}

	#accept(socket: net.Socket): void {
		this.#connections.add(socket);
		socket.setEncoding("utf-8");
		const parser = new LineParser(line => {
			let request: TextPredictRequest;
			try {
				request = JSON.parse(line);
			} catch (error) {
				logger.warn("text-predict: malformed request line", { error: String(error) });
				return;
			}
			void this.#dispatch(request).then(response => writeJsonLine(socket, response));
		});
		socket.on("data", (chunk: string) => parser.push(chunk));
		socket.on("error", () => {
			// "close" always follows.
		});
		socket.once("close", () => this.#connections.delete(socket));
	}

	async #dispatch(request: TextPredictRequest): Promise<TextPredictResponse> {
		this.#inFlight++;
		this.#armIdle();
		try {
			return await this.#handle(request);
		} catch (error) {
			return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			this.#inFlight--;
			this.#armIdle();
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
				const engine = await this.#target(request.method);
				const suggestion = await engine.predictor.complete(request.before, request.prefix);
				return { id: request.id, ok: true, op: "complete", engine: engine.method, suggestion };
			}
			case "feedback": {
				const engine = await this.#target(request.method);
				await engine.predictor.feedback(request.before, request.prefix, request.suggestion, request.accepted);
				engine.markDirty();
				this.#schedulePersist();
				return { id: request.id, ok: true, op: "feedback" };
			}
			case "sync": {
				let ingested = 0;
				for (const pending of this.#engines.values()) {
					const engine = await pending.catch(() => undefined);
					if (engine) ingested += await engine.ingest(this.#historyDbPath);
				}
				if (ingested > 0) this.#schedulePersist();
				return { id: request.id, ok: true, op: "sync", ingested };
			}
			case "shutdown":
				setImmediate(() => void this.#shutdown().finally(() => process.exit(0)));
				return { id: request.id, ok: true, op: "shutdown" };
		}
	}

	/**
	 * Engine serving `target`. `auto` prefers SmolLM but never waits for it:
	 * until SmolLM has loaded (first-use weight download, engine open) or while
	 * it cannot load, ngram answers and SmolLM keeps opening in the background.
	 */
	#target(target: TextPredictTarget): Promise<Engine> {
		if (target !== "auto") return this.#engine(target);
		const smollm = this.#loaded.get("smollm");
		if (smollm) return Promise.resolve(smollm);
		// Start (or retry after OPEN_RETRY_MS) the SmolLM open; its failure is logged in #engine.
		this.#engine("smollm").catch(() => {});
		return this.#engine("ngram");
	}

	#engine(method: TextPredictMethod): Promise<Engine> {
		const failedAt = this.#failedAt.get(method);
		if (failedAt !== undefined && Date.now() - failedAt >= OPEN_RETRY_MS) {
			this.#failedAt.delete(method);
			this.#engines.delete(method);
		}
		let pending = this.#engines.get(method);
		if (!pending) {
			pending = this.#open(method);
			this.#engines.set(method, pending);
			pending.then(
				engine => this.#loaded.set(method, engine),
				error => {
					this.#failedAt.set(method, Date.now());
					logger.warn("text-predict: engine unavailable", { method, error: String(error) });
				},
			);
		}
		return pending;
	}

	async #open(method: TextPredictMethod): Promise<Engine> {
		const stateDir = path.join(this.#agentDir, "predict", method);
		await fs.mkdir(stateDir, { recursive: true });
		const modelDir = method === "smollm" ? await ensureSmolLmWeights() : undefined;
		const startedAt = performance.now();
		let predictor = new TextPredictor({ method, stateDir, modelDir });
		let cursor: number;
		try {
			await predictor.ready();
			cursor = await readCursor(stateDir);
		} catch (error) {
			// Unloadable state (corrupt, or from an incompatible engine version):
			// start over and rebuild it from the whole history.
			logger.warn("text-predict: engine state failed to load; rebuilding", { method, error: String(error) });
			await fs.rm(stateDir, { recursive: true, force: true });
			await fs.mkdir(stateDir, { recursive: true });
			predictor = new TextPredictor({ method, stateDir, modelDir });
			await predictor.ready();
			cursor = 0;
		}
		const engine = new Engine(method, stateDir, predictor, cursor);
		const ingested = await engine.ingest(this.#historyDbPath);
		if (ingested > 0) this.#schedulePersist();
		logger.debug("text-predict: engine ready", {
			method,
			ingested,
			ms: Math.round(performance.now() - startedAt),
		});
		return engine;
	}

	#schedulePersist(): void {
		if (this.#persistTimer) return;
		this.#persistTimer = setTimeout(() => {
			this.#persistTimer = undefined;
			void this.#persistAll();
		}, PERSIST_DEBOUNCE_MS);
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

	#armIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (this.#inFlight > 0) {
				this.#armIdle();
				return;
			}
			logger.debug("text-predict: idle; exiting", { endpoint: this.#endpoint });
			void this.#shutdown().finally(() => process.exit(0));
		}, IDLE_EXIT_MS);
	}

	#shutdown(): Promise<void> {
		this.#stopping ??= this.#stop();
		return this.#stopping;
	}

	async #stop(): Promise<void> {
		clearTimeout(this.#idleTimer);
		clearTimeout(this.#persistTimer);
		this.#persistTimer = undefined;
		for (const socket of this.#connections) socket.destroy();
		this.#connections.clear();
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await Promise.race([closed.promise, Bun.sleep(SHUTDOWN_BUDGET_MS)]);
		}
		await this.#persistAll();
		if (process.platform !== "win32") {
			try {
				await fs.unlink(this.#endpoint);
			} catch {
				// Already removed.
			}
		}
		this.#stopped.resolve();
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
