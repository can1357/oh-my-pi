/**
 * Client half of the machine-global text-prediction daemon.
 *
 * The composer's word-completion provider (`@oh-my-pi/pi-tui/prompt/word-completion`)
 * reaches the daemon through {@link textPredictionBackend}. The first request
 * starts the daemon under the `text-predict` global broker when nothing is
 * listening; one socket per process then carries every request. Failures never
 * surface to the editor: a query that cannot be answered shows no ghost text.
 */
import * as fs from "node:fs/promises";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { PredictedWord } from "@oh-my-pi/pi-natives";
import type { WordCompletionEngine, WordPredictionBackend } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { getAgentDir, logger, ptree, VERSION } from "@oh-my-pi/pi-utils";
import { daemonClientForGlobal } from "../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../launch/ensure";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";
import { connectJsonlSocket, LineParser, writeJsonLine } from "../tiny/jsonl-socket";
import {
	TEXT_PREDICT_AGENT_DIR_ENV,
	TEXT_PREDICT_BROKER_SCOPE,
	TEXT_PREDICT_READY_PATTERN,
	TEXT_PREDICT_SOCKET_ENV,
	TEXT_PREDICT_WORKER_ARG,
	type TextPredictMethod,
	type TextPredictRequest,
	type TextPredictResponse,
	type TextPredictTarget,
	textPredictDaemon,
} from "./protocol";

const LABEL = "text-predict daemon";
const CONNECT_TIMEOUT_MS = 1_500;
/** Daemon start plus a cold engine load (first bootstrap from history, SmolLM weights). */
const READY_TIMEOUT_MS = 30_000;
/** A first `complete` may wait for its engine to open and ingest history. */
const COMPLETE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** After the daemon could not be reached, stay quiet this long before trying again. */
const RETRY_AFTER_MS = 30_000;
/** probe→describe→start rounds; bounds cross-process start races and wedged-daemon replacement. */
const ENSURE_ATTEMPTS = 3;

/**
 * Daemon target for a configured method. `auto` stays `auto` (the daemon picks
 * SmolLM once loaded, ngram until then); `apple` exists only on macOS and
 * falls back to `auto` elsewhere.
 */
export function resolveTextPredictTarget(method: WordCompletionEngine): TextPredictTarget {
	if (method === "apple" && process.platform !== "darwin") return "auto";
	return method;
}

/** One daemon answer: the suggestion and the engine that produced it. */
export interface TextPrediction {
	engine: TextPredictMethod;
	suggestion: PredictedWord | null;
}

interface PendingRequest {
	resolve(response: TextPredictResponse): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/** One JSONL connection to the daemon with id-matched responses. */
class DaemonConnection {
	#socket: net.Socket;
	#pending = new Map<number, PendingRequest>();
	#nextId = 1;
	closed = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;
		const parser = new LineParser(line => {
			let response: TextPredictResponse;
			try {
				response = JSON.parse(line);
			} catch (error) {
				logger.warn("text-predict: malformed response line", { error: String(error) });
				return;
			}
			const pending = this.#pending.get(response.id);
			if (!pending) return;
			this.#pending.delete(response.id);
			clearTimeout(pending.timer);
			pending.resolve(response);
		});
		socket.on("data", (chunk: string) => parser.push(chunk));
		socket.on("error", () => {
			// "close" always follows.
		});
		socket.once("close", () => {
			this.closed = true;
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("text-predict daemon connection closed"));
			}
			this.#pending.clear();
		});
	}

	request(build: (id: number) => TextPredictRequest, timeoutMs: number): Promise<TextPredictResponse> {
		if (this.closed) return Promise.reject(new Error("text-predict daemon connection closed"));
		const request = build(this.#nextId++);
		const { promise, resolve, reject } = Promise.withResolvers<TextPredictResponse>();
		const timer = setTimeout(() => {
			this.#pending.delete(request.id);
			reject(new Error(`text-predict ${request.op} timed out`));
		}, timeoutMs);
		this.#pending.set(request.id, { resolve, reject, timer });
		writeJsonLine(this.#socket, request);
		return promise;
	}

	close(): void {
		this.#socket.destroy();
	}
}

/** Connect and confirm the daemon speaks this omp version; `undefined` when nothing usable listens. */
async function connectDaemon(endpoint: string): Promise<DaemonConnection | undefined> {
	let socket: net.Socket;
	try {
		socket = await connectJsonlSocket(endpoint, CONNECT_TIMEOUT_MS);
	} catch {
		return undefined;
	}
	const connection = new DaemonConnection(socket);
	try {
		const pong = await connection.request(id => ({ id, op: "ping" }), REQUEST_TIMEOUT_MS);
		if (pong.ok && pong.op === "ping" && pong.version === VERSION) return connection;
		// A daemon from another omp version: retire it so this version's starts.
		await connection.request(id => ({ id, op: "shutdown" }), REQUEST_TIMEOUT_MS).catch(() => undefined);
	} catch (error) {
		logger.debug("text-predict: daemon ping failed", { endpoint, error: String(error) });
	}
	connection.close();
	return undefined;
}

/** Find or start the daemon serving `agentDir` under the global broker. */
async function ensureDaemon(agentDir: string): Promise<DaemonConnection> {
	const broker = await daemonClientForGlobal(TEXT_PREDICT_BROKER_SCOPE);
	await broker.request({ op: "ping" });
	const { name, endpoint } = textPredictDaemon(broker.projectDir, agentDir);
	const spawn = resolveWorkerSpawnCmd(TEXT_PREDICT_WORKER_ARG);
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		const live = await connectDaemon(endpoint);
		if (live) return live;
		const existing = await describeQuietly(broker, name, LABEL);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) {
				await waitReady(broker, name, LABEL, undefined, READY_TIMEOUT_MS);
				const ready = await connectDaemon(endpoint);
				if (ready) return ready;
			}
			// Live record but nothing usable listening: replace it.
			await stopQuietly(broker, name, LABEL);
			continue;
		}
		try {
			await broker.request({
				op: "start",
				spec: {
					name,
					application: spawn.cmd[0]!,
					args: spawn.cmd.slice(1),
					env: { [TEXT_PREDICT_SOCKET_ENV]: endpoint, [TEXT_PREDICT_AGENT_DIR_ENV]: agentDir },
					cwd: spawn.cwd ?? broker.projectDir,
					pty: false,
					ready: { log: TEXT_PREDICT_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
		} catch (error) {
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("text-predict: daemon start contention", { name, error: String(error) });
		}
	}
	throw new Error("text-predict daemon did not start");
}

/** Process-wide daemon access shared by every editor and the submit hook. */
class TextPredictionClient {
	#connection: DaemonConnection | undefined;
	#connecting: Promise<DaemonConnection> | undefined;
	#retryAt = 0;
	#backends = new Map<TextPredictTarget, WordPredictionBackend>();

	backend(method: WordCompletionEngine): WordPredictionBackend {
		const resolved = resolveTextPredictTarget(method);
		let backend = this.#backends.get(resolved);
		if (!backend) {
			backend = {
				complete: async (before, prefix) => {
					try {
						return (await this.complete(resolved, before, prefix)).suggestion?.suffix ?? null;
					} catch (error) {
						logger.debug("text-predict: completion unavailable", { error: String(error) });
						return null;
					}
				},
				feedback: (before, prefix, suggestion, accepted) => {
					this.#request(
						id => ({ id, op: "feedback", method: resolved, before, prefix, suggestion, accepted }),
						REQUEST_TIMEOUT_MS,
					).catch(error => logger.debug("text-predict: feedback dropped", { error: String(error) }));
				},
			};
			this.#backends.set(resolved, backend);
		}
		return backend;
	}

	/** Drop the daemon connection so a short-lived command can exit. */
	close(): void {
		this.#connection?.close();
		this.#connection = undefined;
	}

	/**
	 * Ask `target` for the ghost text after `prefix`, with its confidence.
	 *
	 * @throws when the daemon is unreachable or the engine reports an error
	 * (e.g. it failed to load).
	 */
	async complete(target: TextPredictTarget, before: string, prefix: string): Promise<TextPrediction> {
		const response = await this.#request(
			id => ({ id, op: "complete", method: target, before, prefix }),
			COMPLETE_TIMEOUT_MS,
		);
		if (!response.ok) throw new Error(response.error);
		if (response.op !== "complete") throw new Error(`text-predict: unexpected ${response.op} response`);
		return { engine: response.engine, suggestion: response.suggestion };
	}

	/**
	 * Tell a running daemon new history rows exist. Without a live connection
	 * nothing needs telling: the daemon ingests everything new when it starts.
	 */
	sync(): void {
		const connection = this.#connection;
		if (!connection || connection.closed) return;
		connection
			.request(id => ({ id, op: "sync" }), REQUEST_TIMEOUT_MS)
			.catch(error => logger.debug("text-predict: sync dropped", { error: String(error) }));
	}

	async #request(build: (id: number) => TextPredictRequest, timeoutMs: number): Promise<TextPredictResponse> {
		const connection = await this.#connect();
		return connection.request(build, timeoutMs);
	}

	#connect(): Promise<DaemonConnection> {
		const current = this.#connection;
		if (current && !current.closed) return Promise.resolve(current);
		if (this.#connecting) return this.#connecting;
		if (Date.now() < this.#retryAt) return Promise.reject(new Error("text-predict daemon unavailable"));
		const connecting = ensureDaemon(getAgentDir()).then(
			connection => {
				this.#connection = connection;
				this.#connecting = undefined;
				return connection;
			},
			(error: unknown) => {
				this.#connecting = undefined;
				this.#retryAt = Date.now() + RETRY_AFTER_MS;
				logger.warn("text-predict: daemon unavailable; word completion paused", { error: String(error) });
				throw error;
			},
		);
		this.#connecting = connecting;
		return connecting;
	}
}

let sharedClient: TextPredictionClient | undefined;

/** Word-prediction backend for a configured engine, served by the daemon. */
export function textPredictionBackend(method: WordCompletionEngine): WordPredictionBackend {
	sharedClient ??= new TextPredictionClient();
	return sharedClient.backend(method);
}

/**
 * One completion from the daemon with its confidence, for diagnostics such as
 * `omp predict`. Unlike the editor backend, failures reject instead of
 * degrading to no ghost text.
 */
export function requestTextPrediction(
	method: WordCompletionEngine,
	before: string,
	prefix: string,
): Promise<TextPrediction> {
	sharedClient ??= new TextPredictionClient();
	return sharedClient.complete(resolveTextPredictTarget(method), before, prefix);
}

/**
 * Close this process's daemon connection (the daemon keeps running). For
 * short-lived commands such as `omp predict`; the composer keeps its
 * connection for the process lifetime.
 */
export function closeTextPrediction(): void {
	sharedClient?.close();
	sharedClient = undefined;
}

/** Ask a running daemon to ingest newly written history rows. */
export function syncTextPrediction(): void {
	sharedClient?.sync();
}

/**
 * Distribution smoke test: start the worker through the CLI entry with an
 * empty agent directory, then ping it, answer one `ngram` completion, sync,
 * and shut it down.
 */
export async function smokeTestTextPredictDaemon(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-text-predict-smoke-"));
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-text-predict-smoke-${process.pid.toString(36)}`
			: path.join(root, "text-predict.sock");
	const spawn = resolveWorkerSpawnCmd(TEXT_PREDICT_WORKER_ARG);
	const proc = ptree.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({
			[TEXT_PREDICT_SOCKET_ENV]: endpoint,
			[TEXT_PREDICT_AGENT_DIR_ENV]: path.join(root, "agent"),
		}),
	});
	let connection: DaemonConnection | undefined;
	try {
		const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
		while (!connection && Date.now() < deadline && proc.exitCode === null) {
			connection = await connectDaemon(endpoint);
			if (!connection) await Bun.sleep(200);
		}
		if (!connection) {
			throw new Error(
				`text-predict smoke failed: daemon never answered (${proc.peekStderr().slice(-500) || "no stderr"})`,
			);
		}
		const completion = await connection.request(
			id => ({ id, op: "complete", method: "ngram", before: "please ", prefix: "re" }),
			SMOKE_TEST_TIMEOUT_MS,
		);
		if (!completion.ok || completion.op !== "complete") {
			throw new Error(`text-predict smoke failed: ${completion.ok ? completion.op : completion.error}`);
		}
		const sync = await connection.request(id => ({ id, op: "sync" }), SMOKE_TEST_TIMEOUT_MS);
		if (!sync.ok || sync.op !== "sync") throw new Error("text-predict smoke failed: sync was rejected");
		await connection.request(id => ({ id, op: "shutdown" }), SMOKE_TEST_TIMEOUT_MS);
		await proc.exited;
	} finally {
		connection?.close();
		proc.kill();
		await proc.exited.catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
}
