import * as path from "node:path";
import { isFastembedModelCached } from "@oh-my-pi/pi-mnemopi/core/fastembed-model-cache";
import { getFastembedCacheDir, getMnemopiEmbedRuntimeDir, logger, VERSION } from "@oh-my-pi/pi-utils";
import { MNEMOPI_EMBED_SERVER_WORKER_ARG } from "../cli/worker-selectors";
import { trackDownload } from "../downloads/activity";
import {
	connectSharedWorker,
	LazyWorkerHandle,
	type SharedWorkerLaunch,
	smokeTestSharedWorker,
	spawnDetached,
	WORKER_CONNECTION_CLOSED,
} from "../subprocess/shared-worker";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	inferenceWorkerEnv,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import {
	MNEMOPI_EMBED_MODEL_ENV,
	MNEMOPI_EMBED_SOCKET_ENV,
	MNEMOPI_EMBED_TAG_ENV,
	type MnemopiEmbedCall,
	type MnemopiEmbedModelId,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
	type MnemopiEmbedWorkerInbound,
	type MnemopiEmbedWorkerOutbound,
} from "./embed-protocol";

/**
 * Transport a {@link MnemopiEmbedClient} drives: in an omp process, the
 * connection to the machine-shared embedding server for one (model, cache
 * dir); inside that server, the IPC channel to its private onnxruntime child.
 */
export type MnemopiEmbedWorkerHandle = RefCountedWorkerHandle<
	MnemopiEmbedCall,
	MnemopiEmbedWorkerOutbound | MnemopiEmbedServerResponse
>;

type PendingRequest =
	| { kind: "init"; key: string; resolve: (error: string | undefined) => void }
	| { kind: "embed"; key: string; resolve: (vectors: number[][] | Error) => void };

/** One live transport per (model, cache dir). */
interface KeyedWorker {
	handle: MnemopiEmbedWorkerHandle;
	unsubscribe: () => void;
	refed: boolean;
}

/**
 * Hidden subcommand on the main CLI that boots the onnxruntime child of the
 * shared embedding server. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/**
 * Spawn the onnxruntime embeddings child. Exported for tests and the smoke
 * probe; the shared server goes through {@link spawnMnemopiEmbedWorker}. The
 * child inherits the server env — fastembed honours `HF_HUB_*`,
 * `HTTPS_PROXY`, etc., and `loadFastembed()` reads the same `OMP_*`
 * runtime-install knobs.
 */
export function createMnemopiEmbedSubprocess(): SpawnedSubprocess<MnemopiEmbedWorkerOutbound> {
	return createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(MNEMOPI_EMBED_WORKER_ARG),
		env: inferenceWorkerEnv(),
		exitLabel: "mnemopi embed subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<MnemopiEmbedWorkerOutbound>): MnemopiEmbedWorkerHandle {
	const { proc } = spawned;
	// Embed keeps its own guarded `proc.send` (neutralizes only the synchronous
	// throw, not the async EPIPE rejection) rather than the shared `safeSend`
	// the other workers use — behaviour preserved verbatim.
	return {
		...createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
			try {
				proc.send(message);
			} catch (error) {
				logger.debug("mnemopi-embed: send to subprocess failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

function createUnavailableMnemopiEmbedWorker(error: unknown): MnemopiEmbedWorkerHandle {
	return {
		...createUnavailableWorker<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

/** Spawn the shared server's onnxruntime child (or an unavailable stand-in when spawning throws). */
export function spawnMnemopiEmbedWorker(): MnemopiEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createMnemopiEmbedSubprocess()),
		createUnavailableMnemopiEmbedWorker,
		"mnemopi embed worker spawn failed; local embeddings disabled",
	);
}

/** Shared-server name for one (model, cache dir): the model id plus a hash of the resolved cache dir. */
export function mnemopiEmbedServerName(model: MnemopiEmbedModelId, cacheDir: string): string {
	return `${model}-${Bun.hash.crc32(path.resolve(cacheDir)).toString(16).padStart(8, "0")}`;
}

/** How to start the shared embedding server for `model`; `env` overlays the inherited environment. @internal */
export function mnemopiEmbedLaunch(model: MnemopiEmbedModelId, env: Record<string, string> = {}): SharedWorkerLaunch {
	return {
		label: `mnemopi embed server for ${model}`,
		tag: VERSION,
		spawn(endpoint, logPath) {
			const command = resolveWorkerSpawnCmd(MNEMOPI_EMBED_SERVER_WORKER_ARG);
			// The server never loads onnxruntime itself; its child gets the
			// native library path from `inferenceWorkerEnv()` at spawn time.
			const serverEnv = workerEnvFromParent({
				...env,
				[MNEMOPI_EMBED_SOCKET_ENV]: endpoint,
				[MNEMOPI_EMBED_MODEL_ENV]: model,
				[MNEMOPI_EMBED_TAG_ENV]: VERSION,
			});
			return Promise.resolve(spawnDetached(command.cmd, command.cwd, serverEnv, logPath));
		},
	};
}

/** Lazily reach (or spawn) the shared embedding server for (model, cacheDir). */
function connectMnemopiEmbedServer(model: MnemopiEmbedModelId, cacheDir: string | undefined): MnemopiEmbedWorkerHandle {
	const name = mnemopiEmbedServerName(model, cacheDir ?? getFastembedCacheDir());
	return new LazyWorkerHandle<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>(() =>
		connectSharedWorker(mnemopiEmbedLaunch(model), getMnemopiEmbedRuntimeDir(), name),
	);
}

/**
 * Per-model wrapper produced by {@link MnemopiEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts and yields the resulting vectors in
 * a single asynchronous batch — fastembed's own iterator was emitting batches
 * that the child collects anyway, and per-batch round-trips would not improve
 * throughput.
 */
export interface MnemopiSubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

/**
 * Upper bound on a steady-state embed round-trip. Initialization is
 * intentionally exempt: first use may spend several minutes installing
 * fastembed and downloading the model, and killing that work can strand the
 * runtime install lock. Once initialization succeeds, a longer embed stall
 * means a hung native runtime (issue #4792) that would otherwise pin whatever
 * awaits the embed — a turn's memory recall or the headless shutdown
 * consolidation — indefinitely (issue #7352). On expiry the embed fails and
 * the (model, cache dir) transport is terminated: an omp process drops its
 * server connection, and the server SIGKILLs its wedged onnxruntime child, so
 * the next request gets a fresh one.
 */
const EMBED_REQUEST_TIMEOUT_MS = 120_000;

/** Race marker for {@link MnemopiEmbedClient.#awaitRequest}. */
const REQUEST_TIMED_OUT = Symbol("mnemopi.embed.timedOut");

/**
 * Correlates `init`/`embed` calls over one transport per (model, cache dir).
 * Transport-agnostic: omp processes run it over shared-server connections
 * ({@link mnemopiEmbedClient}); the shared server runs it over its private
 * onnxruntime child.
 */
export class MnemopiEmbedClient {
	#workers = new Map<string, KeyedWorker>();
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#connect: (model: MnemopiEmbedModelId, cacheDir: string | undefined) => MnemopiEmbedWorkerHandle;
	#requestTimeoutMs: number;

	constructor(
		connect: (
			model: MnemopiEmbedModelId,
			cacheDir: string | undefined,
		) => MnemopiEmbedWorkerHandle = connectMnemopiEmbedServer,
		requestTimeoutMs: number = EMBED_REQUEST_TIMEOUT_MS,
	) {
		this.#connect = connect;
		this.#requestTimeoutMs = requestTimeoutMs;
	}

	/**
	 * Load the named fastembed model, tracking a first-use download in the
	 * download HUD. Resolves to a thin wrapper whose `embed()` round-trips
	 * through the same transport, or `null` when the model cannot be loaded
	 * (missing peer, native load failure, unreachable server, etc.).
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

	/** Load the model on its transport; resolves `undefined` once ready, else the failure text. Not bounded by the request timeout. */
	async load(model: MnemopiEmbedModelId, cacheDir: string | undefined): Promise<string | undefined> {
		const key = workerKey(model, cacheDir);
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		try {
			const worker = this.#ensureWorker(key, model, cacheDir);
			this.#addPending(id, { kind: "init", key, resolve });
			worker.handle.send({ type: "init", id, model, cacheDir });
			return await promise;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			this.#deletePending(id);
		}
	}

	/** Embed `texts` with the model, bounded by {@link EMBED_REQUEST_TIMEOUT_MS}; rejects on worker error or timeout. */
	async embed(
		model: MnemopiEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const key = workerKey(model, cacheDir);
		const worker = this.#ensureWorker(key, model, cacheDir);
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#addPending(id, { kind: "embed", key, resolve });
		try {
			// Carry the (model, cacheDir) on every embed: a transport dropped and
			// re-established between two embeds on the same cached wrapper would
			// otherwise reach a fresh child that never saw `init`. The child's
			// `ensureLoaded` is idempotent, so steady-state embeds pay nothing.
			worker.handle.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await this.#awaitRequest(key, promise);
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#deletePending(id);
		}
	}

	/** Drop every transport and fail everything in flight. */
	async terminate(): Promise<void> {
		const workers = [...this.#workers.values()];
		this.#workers.clear();
		for (const pending of this.#pending.values()) settle(pending, "mnemopi embed worker terminated");
		this.#pending.clear();
		for (const worker of workers) {
			worker.unsubscribe();
			try {
				await worker.handle.terminate();
			} catch {
				// Already gone.
			}
		}
	}

	/**
	 * Await one steady-state embed reply, bounded by the request timeout. The
	 * timer is `unref`'d so a pending request has only the transport reference
	 * keeping the event loop alive. On expiry the (model, cache dir) transport
	 * is dropped — faulting its other in-flight requests and letting the next
	 * call start over — before the request rejects (issue #7352).
	 */
	async #awaitRequest<T>(key: string, promise: Promise<T>): Promise<T> {
		const { promise: timedOut, resolve: fire } = Promise.withResolvers<typeof REQUEST_TIMED_OUT>();
		const timer = setTimeout(() => fire(REQUEST_TIMED_OUT), this.#requestTimeoutMs);
		timer.unref();
		try {
			const winner = await Promise.race([promise, timedOut]);
			if (winner === REQUEST_TIMED_OUT) {
				this.#dropWorker(key, "mnemopi embed worker request timed out");
				throw new Error("mnemopi embed worker request timed out");
			}
			return winner;
		} finally {
			clearTimeout(timer);
		}
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

	#ensureWorker(key: string, model: MnemopiEmbedModelId, cacheDir: string | undefined): KeyedWorker {
		const existing = this.#workers.get(key);
		if (existing) return existing;
		const handle = this.#connect(model, cacheDir);
		const unsubscribeMessage = handle.onMessage(message => this.#handleMessage(message));
		const unsubscribeError = handle.onError(error => this.#handleWorkerError(key, error));
		const worker: KeyedWorker = {
			handle,
			refed: false,
			unsubscribe: () => {
				unsubscribeMessage();
				unsubscribeError();
			},
		};
		this.#workers.set(key, worker);
		return worker;
	}

	/** Register a pending request and keep its transport referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef(request.key);
	}

	/** Drop a pending request and unref its transport once nothing is in flight on it. */
	#deletePending(id: string): void {
		const request = this.#pending.get(id);
		if (!request) return;
		this.#pending.delete(id);
		this.#syncWorkerRef(request.key);
	}

	/**
	 * Transports start unreferenced so an idle interactive or daemon session
	 * never blocks exit. Keep one referenced only while a request on it is
	 * pending so short-lived print-mode commands cannot exit before recall
	 * receives its response (issue #12067).
	 */
	#syncWorkerRef(key: string): void {
		const worker = this.#workers.get(key);
		if (!worker) return;
		let inFlight = false;
		for (const pending of this.#pending.values()) {
			if (pending.key !== key) continue;
			inFlight = true;
			break;
		}
		if (inFlight === worker.refed) return;
		worker.refed = inFlight;
		if (inFlight) worker.handle.ref();
		else worker.handle.unref();
	}

	#handleMessage(message: MnemopiEmbedWorkerOutbound | MnemopiEmbedServerResponse): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#deletePending(message.id);
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

	/** Forget the (model, cache dir) transport and fail its in-flight requests; returns how many failed. */
	#dropWorker(key: string, reason: string): number {
		const worker = this.#workers.get(key);
		if (worker) {
			this.#workers.delete(key);
			worker.unsubscribe();
			void worker.handle.terminate().catch(() => {});
		}
		let failed = 0;
		for (const [id, pending] of this.#pending) {
			if (pending.key !== key) continue;
			this.#pending.delete(id);
			settle(pending, reason);
			failed += 1;
		}
		return failed;
	}

	#handleWorkerError(key: string, error: Error): void {
		const failed = this.#dropWorker(key, error.message);
		// A shared server idling out between requests is routine; losing requests is not.
		if (failed === 0 && error.message.startsWith(WORKER_CONNECTION_CLOSED)) {
			logger.debug("mnemopi-embed: embedding server went away while idle", { key });
		} else {
			logger.warn("mnemopi-embed: worker error", { error: error.message, failedRequests: failed });
		}
	}
}

/** Map key of one (model, cache dir) transport. */
function workerKey(model: MnemopiEmbedModelId, cacheDir: string | undefined): string {
	return `${model}\u0000${cacheDir ?? ""}`;
}

/** Fail a pending request with `reason`. */
function settle(pending: PendingRequest, reason: string): void {
	if (pending.kind === "init") pending.resolve(reason);
	else pending.resolve(new Error(reason));
}

/** This process's embedding client; every (model, cache dir) goes through its machine-shared server. */
export const mnemopiEmbedClient = new MnemopiEmbedClient();

/** Drop this process's server connections; the servers keep serving other omp processes until idle. */
export async function shutdownMnemopiEmbedClient(): Promise<void> {
	await mnemopiEmbedClient.terminate();
}

/** Distribution smoke test: the onnxruntime child ping/pongs over IPC, and the shared server answers its tagged ping. */
export async function smokeTestMnemopiEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createMnemopiEmbedSubprocess()), "mnemopi embed worker", timeoutMs);
	await smokeTestSharedWorker(mnemopiEmbedLaunch("smoke"), getMnemopiEmbedRuntimeDir(), "smoke", timeoutMs);
}
