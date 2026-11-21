/**
 * Client for local mnemopi embeddings. Each (model, cache dir) is one `infer`
 * unit in the omp daemon (`daemon/modules/infer.ts`), backed by an
 * onnxruntime child (`embed-worker.ts`); this process holds a lease and a
 * tunnel per pair and correlates `init`/`embed` requests over it. The daemon
 * shares the unit with every omp process, reaps a wedged child (120 s embed
 * bound), and stops it once idle.
 */
import * as path from "node:path";
import { isFastembedModelCached } from "@oh-my-pi/pi-mnemopi/core/fastembed-model-cache";
import { $env, getFastembedCacheDir, logger } from "@oh-my-pi/pi-utils";
import {
	INFER_CONNECTION_CLOSED,
	InferConnection,
	type InferOpenSpec,
	smokeTestInferWorker,
} from "../daemon/modules/infer";
import { trackDownload } from "../downloads/activity";
import { inferenceWorkerEnv, resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS } from "../subprocess/worker-client";
import {
	MNEMOPI_EMBED_IDLE_MS_ENV,
	MNEMOPI_EMBED_WORKER_ARG,
	type MnemopiEmbedCall,
	type MnemopiEmbedModelId,
	type MnemopiEmbedWorkerOutbound,
} from "./embed-protocol";

type EmbedConnection = InferConnection<MnemopiEmbedCall | { type: "ping"; id: string }, MnemopiEmbedWorkerOutbound>;

type PendingRequest =
	| { kind: "init"; key: string; resolve: (error: string | undefined) => void }
	| { kind: "embed"; key: string; resolve: (vectors: number[][] | Error) => void };

/** Unit key of one (model, cache dir): the model id plus a hash of the resolved cache dir. */
export function mnemopiEmbedUnitKey(model: MnemopiEmbedModelId, cacheDir: string): string {
	return `embed:${model}:${Bun.hash.crc32(path.resolve(cacheDir)).toString(16).padStart(8, "0")}`;
}

/** Daemon open spec for the embedding worker serving (model, cacheDir). */
function mnemopiEmbedOpenSpec(model: MnemopiEmbedModelId, cacheDir: string): InferOpenSpec {
	const command = resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG);
	const [application, ...args] = command.cmd;
	const idleMs = Number($env[MNEMOPI_EMBED_IDLE_MS_ENV]);
	return {
		key: mnemopiEmbedUnitKey(model, cacheDir),
		params: {
			worker: "embed",
			label: `mnemopi embed ${model}`,
			application: application!,
			args,
			cwd: command.cwd ?? process.cwd(),
			env: inferenceWorkerEnv(),
			idleMs: idleMs > 0 ? idleMs : undefined,
		},
	};
}

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts and yields the resulting vectors in
 * a single asynchronous batch — fastembed's own iterator was emitting batches
 * that the worker collects anyway, and per-batch round-trips would not improve
 * throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

/** Correlates `init`/`embed` calls over one daemon tunnel per (model, cache dir). */
export class MnemopiEmbedClient {
	#connections = new Map<string, EmbedConnection>();
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;

	/**
	 * Load the named fastembed model, tracking a first-use download in the
	 * download HUD. Resolves to a thin wrapper whose `embed()` round-trips
	 * through the same unit, or `null` when the model cannot be loaded
	 * (missing peer, native load failure, unreachable daemon, etc.).
	 */
	async initialize(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): Promise<MnemopiSubprocessEmbeddingModel | null> {
		// fastembed exposes no byte progress; any missing model file means this
		// init downloads it.
		const cached = await isFastembedModelCached(model, cacheDir ?? getFastembedCacheDir());
		const tracker = cached ? undefined : trackDownload(model.replace(/^fast-/, ""), { detail: "downloading" });
		const error = await this.load(model, cacheDir);
		if (error !== undefined) {
			tracker?.fail(error);
			logger.debug("mnemopi-embed: init failed", { model, error });
			return null;
		}
		tracker?.done();
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	/** Load the model; resolves `undefined` once ready, else the failure text. */
	async load(model: MnemopiEmbedModelId, cacheDir: string | undefined): Promise<string | undefined> {
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		try {
			const { key, connection } = this.#ensureConnection(model, cacheDir);
			this.#pending.set(id, { kind: "init", key, resolve });
			connection.send({ type: "init", id, model, cacheDir });
			return await promise;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			this.#pending.delete(id);
		}
	}

	/** Embed `texts` with the model; rejects on worker error, worker wedge (daemon-side timeout), or lost tunnel. */
	async embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const { key, connection } = this.#ensureConnection(model, cacheDir);
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#pending.set(id, { kind: "embed", key, resolve });
		try {
			// Carry the (model, cacheDir) on every embed: a worker respawned after
			// a wedge never saw `init`. Its `ensureLoaded` is idempotent, so
			// steady-state embeds pay nothing.
			connection.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await promise;
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#pending.delete(id);
		}
	}

	/** Drop every tunnel and fail everything in flight. */
	async terminate(): Promise<void> {
		const connections = [...this.#connections.values()];
		this.#connections.clear();
		for (const pending of this.#pending.values()) settle(pending, "mnemopi embed client terminated");
		this.#pending.clear();
		await Promise.all(connections.map(connection => connection.close()));
	}

	async *#streamEmbed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		// Mnemopi's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra round-trips.
		yield await this.embed(model, cacheDir, texts, batchSize);
	}

	#ensureConnection(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
	): { key: string; connection: EmbedConnection } {
		const resolvedCacheDir = cacheDir ?? getFastembedCacheDir();
		const key = mnemopiEmbedUnitKey(model, resolvedCacheDir);
		const existing = this.#connections.get(key);
		if (existing) return { key, connection: existing };
		const connection: EmbedConnection = new InferConnection(
			async () => mnemopiEmbedOpenSpec(model, resolvedCacheDir),
			message => this.#handleMessage(message),
			error => this.#handleClosed(key, connection, error),
		);
		this.#connections.set(key, connection);
		return { key, connection };
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound): void {
		if (message.type === "log" || message.type === "pong") return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.type === "ready") {
			if (pending.kind === "init") pending.resolve(undefined);
			return;
		}
		if (message.type === "vectors") {
			if (pending.kind === "embed") pending.resolve(message.vectors);
			return;
		}
		logger.debug("mnemopi-embed: worker returned error", { error: message.error });
		settle(pending, message.error);
	}

	/** The tunnel ended (daemon restart, unit stopped, open failed): fail its requests; the next call re-opens. */
	#handleClosed(key: string, connection: EmbedConnection, error: Error): void {
		if (this.#connections.get(key) === connection) this.#connections.delete(key);
		let failed = 0;
		for (const [id, pending] of this.#pending) {
			if (pending.key !== key) continue;
			this.#pending.delete(id);
			settle(pending, error.message);
			failed += 1;
		}
		if (failed === 0 && error.message.startsWith(INFER_CONNECTION_CLOSED)) {
			logger.debug("mnemopi-embed: embedding unit went away while idle", { key });
		} else {
			logger.warn("mnemopi-embed: connection error", { error: error.message, failedRequests: failed });
		}
	}
}

/** Fail a pending request with `reason`. */
function settle(pending: PendingRequest, reason: string): void {
	if (pending.kind === "init") pending.resolve(reason);
	else pending.resolve(new Error(reason));
}

/** This process's embedding client. */
export const mnemopiEmbedClient = new MnemopiEmbedClient();

/** Drop this process's tunnels; the daemon keeps the units for other omp processes until idle. */
export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

/** Distribution smoke test: the daemon starts the onnxruntime worker and it answers `ping` over stdio. */
export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const spec = mnemopiEmbedOpenSpec("smoke", getFastembedCacheDir());
	await smokeTestInferWorker({ ...spec, key: `${spec.key}:smoke` }, timeoutMs);
}
