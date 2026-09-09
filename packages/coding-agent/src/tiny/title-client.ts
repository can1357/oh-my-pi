/**
 * Client for the per-model tiny-model workers.
 *
 * Each local model is served by one worker process on the machine — the ONNX
 * worker (`worker.ts`) or, with `PI_TINY_DEVICE=mlx`, the MLX worker
 * (`mlx-server.py`) — that owns a socket named after the model. This client
 * connects to it, spawning it detached when it is not running, and lets it
 * die on its own once idle. Prompt construction and title extraction live
 * here so both workers only ever see message-level `chat` requests.
 */
import * as fs from "node:fs";
import type * as net from "node:net";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { $env, getTinyWorkerRuntimeDir, logger, prompt } from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };
import { settings } from "../config/settings";
import { stageRunnerScript } from "../eval/runner-cache";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import {
	inferenceWorkerEnv,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
} from "../subprocess/worker-client";
import { MLX_DEVICE, resolveTinyModelDevicePreference, tinyMlxSupported, tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import { connectJsonlSocket, LineParser, writeJsonLine } from "./jsonl-socket";
import { formatTitleUserMessage } from "./message-preproc";
import { ensureTinyMlxRuntime, getTinyMlxModelDir, MLX_LM_VERSION } from "./mlx-runtime";
import MLX_SERVER_SCRIPT from "./mlx-server.py" with { type: "text" };
import {
	getTinyLocalModelSpec,
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
} from "./models";
import { normalizeGeneratedTitle } from "./text";
import {
	TINY_WORKER_ARG,
	TINY_WORKER_IDLE_MS_ENV,
	TINY_WORKER_MODEL_ENV,
	TINY_WORKER_SOCKET_ENV,
	TINY_WORKER_TAG_ENV,
	type TinyChatMessage,
	type TinyTitleProgressEvent,
	type TinyWorkerBackend,
	type TinyWorkerRequest,
	type TinyWorkerResponse,
	tinyWorkerEndpoint,
	tinyWorkerLogPath,
} from "./title-protocol";

const TITLE_PREFILL = "<title>";
const TITLE_CLOSE = "</title>";
const TITLE_MAX_NEW_TOKENS = 20;
const MEMORY_COMPLETION_DEFAULT_MAX_NEW_TOKENS = 256;
const COMPLETION_MAX_NEW_TOKENS = 1024;
const TINY_TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt, { includeExamples: false });
const MLX_IDLE_SECONDS = 15 * 60;

const CONNECT_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_INTERVAL_MS = 200;
/** Time for a spawned worker to bind its socket; a compiled binary may first side-install its runtime. */
const READY_TIMEOUT_MS = 120_000;
/** Time for a stale worker to honour `shutdown` and release its socket. */
const SHUTDOWN_WAIT_MS = 5_000;

type WorkerHandle = RefCountedWorkerHandle<TinyWorkerRequest, TinyWorkerResponse>;

type PendingRequest =
	| { kind: "title"; modelKey: TinyLocalModelKey; source: string; resolve: (title: string | null) => void }
	| { kind: "completion"; modelKey: TinyLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "load"; modelKey: TinyLocalModelKey; resolve: (result: TinyTitleDownloadResult) => void };

export interface TinyTitleDownloadResult {
	ok: boolean;
	error?: string;
}

export interface TinyTitleDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyTitleProgressEvent) => void;
}

/**
 * Per-request controls for {@link TinyTitleClient.generate}.
 *
 * Carries the optional abort signal and title-system-prompt override used by
 * callers that customize automatic session-title generation.
 */
export interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

export interface TinyModelCompletionOptions {
	maxTokens?: number;
	signal?: AbortSignal;
	systemPrompt?: string;
}

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

// ── Device / dtype resolution ────────────────────────────────────────

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (e.g. `omp --smoke-test`); fall back to env/default.
		return undefined;
	}
}

/**
 * Resolve the `PI_TINY_DEVICE` / `PI_TINY_DTYPE` vars a worker should run
 * with. A present env var wins; otherwise the mapped persisted setting is
 * used. Only resolved keys are returned — never the default sentinel — so the
 * worker's built-in defaults apply for anything absent. Pure for testability;
 * see {@link tinyModelEnv} for the settings glue.
 * @internal
 */
export function tinyWorkerEnvOverlay(
	env: Record<string, string | undefined>,
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	const device = env.PI_TINY_DEVICE || tinyModelDeviceSettingToEnv(deviceSetting);
	if (device) overlay.PI_TINY_DEVICE = device;
	const dtype = env.PI_TINY_DTYPE || tinyModelDtypeSettingToEnv(dtypeSetting);
	if (dtype) overlay.PI_TINY_DTYPE = dtype;
	return overlay;
}

/** Resolved device/dtype vars for this process (env over `providers.tinyModelDevice` / `providers.tinyModelDtype`). */
function tinyModelEnv(): Record<string, string> {
	return tinyWorkerEnvOverlay(
		$env,
		readTinyModelSetting("providers.tinyModelDevice"),
		readTinyModelSetting("providers.tinyModelDtype"),
	);
}

/**
 * Env for an ONNX inference subprocess with the resolved device/dtype —
 * used for the tiny worker and reused verbatim by the STT and TTS workers,
 * which share the same device/dtype resolution.
 */
export function tinyWorkerEnv(): Record<string, string> {
	return inferenceWorkerEnv(tinyModelEnv());
}

/** Set once the mlx-lm bootstrap fails in this process; later workers fall back to ONNX. */
let mlxUnavailable = false;

/** Whether a worker started now would run the MLX backend (device resolves to `mlx` on Apple silicon). */
export function tinyWorkerUsesMlx(): boolean {
	return (
		!mlxUnavailable &&
		tinyMlxSupported() &&
		resolveTinyModelDevicePreference(tinyModelEnv().PI_TINY_DEVICE).device === MLX_DEVICE
	);
}

// ── Worker socket handle ─────────────────────────────────────────────

/** Error surfaced when the worker closes the socket (idle exit or replacement); the client reconnects on demand. */
export const TINY_WORKER_CLOSED = "tiny worker connection closed";

/**
 * Wrap a live worker socket. An unexpected close surfaces as an error whose
 * message starts with {@link TINY_WORKER_CLOSED}, followed by the tail of the
 * worker's log so a native crash (`onnxruntime` load failure, missing model
 * file) reaches the caller instead of a bare "closed".
 */
function createSocketWorkerHandle(socket: net.Socket, logPath: string): WorkerHandle {
	const messages = new Set<(message: TinyWorkerResponse) => void>();
	const errors = new Set<(error: Error) => void>();
	let terminated = false;
	const parser = new LineParser(line => {
		const message = JSON.parse(line) as TinyWorkerResponse;
		for (const handler of messages) handler(message);
	});
	socket.on("data", (chunk: string) => parser.push(chunk));
	socket.once("close", () => {
		if (terminated) return;
		void logTail(logPath).then(tail => {
			const error = new Error(tail ? `${TINY_WORKER_CLOSED}: ${tail}` : TINY_WORKER_CLOSED);
			for (const handler of errors) handler(error);
		});
	});
	return {
		send(message) {
			writeJsonLine(socket, message);
		},
		onMessage(handler) {
			messages.add(handler);
			return () => messages.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		terminate() {
			terminated = true;
			socket.destroy();
			return Promise.resolve();
		},
		ref() {
			socket.ref();
		},
		unref() {
			socket.unref();
		},
	};
}

/**
 * Handle that resolves its backing worker asynchronously. `TinyTitleClient`
 * needs a handle synchronously (it subscribes and sends in the same tick), but
 * reaching a worker means probing and possibly spawning; sends queue until
 * the connection lands, and a failed connect surfaces through `onError`.
 */
class LazyWorkerHandle implements WorkerHandle {
	#inner: WorkerHandle | null = null;
	#queue: TinyWorkerRequest[] = [];
	#messages = new Set<(message: TinyWorkerResponse) => void>();
	#errors = new Set<(error: Error) => void>();
	#refed = false;
	#terminated = false;

	constructor(connect: () => Promise<WorkerHandle>) {
		connect().then(
			inner => {
				if (this.#terminated) {
					void inner.terminate();
					return;
				}
				this.#inner = inner;
				inner.onMessage(message => {
					for (const handler of this.#messages) handler(message);
				});
				inner.onError(error => {
					for (const handler of this.#errors) handler(error);
				});
				if (this.#refed) inner.ref();
				else inner.unref();
				const queued = this.#queue;
				this.#queue = [];
				for (const message of queued) inner.send(message);
			},
			(error: unknown) => {
				if (this.#terminated) return;
				const failure = error instanceof Error ? error : new Error(String(error));
				for (const handler of this.#errors) handler(failure);
			},
		);
	}

	send(message: TinyWorkerRequest): void {
		if (this.#inner) this.#inner.send(message);
		else this.#queue.push(message);
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messages.add(handler);
		return () => this.#messages.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errors.add(handler);
		return () => this.#errors.delete(handler);
	}

	terminate(): Promise<void> {
		this.#terminated = true;
		this.#queue = [];
		return this.#inner?.terminate() ?? Promise.resolve();
	}

	ref(): void {
		this.#refed = true;
		this.#inner?.ref();
	}

	unref(): void {
		this.#refed = false;
		this.#inner?.unref();
	}
}

// ── Worker discovery / spawn ─────────────────────────────────────────

type ProbeResult = { kind: "live"; socket: net.Socket } | { kind: "stale" } | { kind: "absent" };

/** Connect and ping. `stale` means a worker answered with a different launch tag (and was told to shut down). */
async function probeTinyWorker(endpoint: string, tag: string): Promise<ProbeResult> {
	let socket: net.Socket | undefined;
	try {
		socket = await connectJsonlSocket(endpoint, CONNECT_TIMEOUT_MS);
		const pong = Promise.withResolvers<TinyWorkerResponse | null>();
		const parser = new LineParser(line => pong.resolve(JSON.parse(line) as TinyWorkerResponse));
		const onData = (chunk: string): void => parser.push(chunk);
		socket.on("data", onData);
		socket.once("close", () => pong.resolve(null));
		const timer = setTimeout(() => pong.resolve(null), PROBE_TIMEOUT_MS);
		writeJsonLine(socket, { type: "ping", id: "probe" } satisfies TinyWorkerRequest);
		const reply = await pong.promise;
		clearTimeout(timer);
		socket.off("data", onData);
		if (reply?.type === "pong" && reply.tag === tag) return { kind: "live", socket };
		if (reply?.type === "pong") {
			logger.debug("tiny-title: worker launch tag mismatch; replacing", {
				endpoint,
				running: reply.tag,
				expected: tag,
			});
			writeJsonLine(socket, { type: "shutdown", id: "replace" } satisfies TinyWorkerRequest);
			socket.destroy();
			return { kind: "stale" };
		}
	} catch {
		// Not listening (or refused); the caller spawns one.
	}
	socket?.destroy();
	return { kind: "absent" };
}

interface SpawnedWorker {
	proc: Subprocess;
	logPath: string;
}

/** How to start one worker: its backend (socket name), launch tag, and spawn recipe. */
export interface WorkerLaunch {
	backend: TinyWorkerBackend;
	tag: string;
	spawn(endpoint: string, logPath: string): Promise<SpawnedWorker>;
}

/** Detach a worker so it outlives this omp process; its output goes to a per-worker log file. */
function spawnDetached(
	cmd: string[],
	cwd: string | undefined,
	env: Record<string, string>,
	logPath: string,
): SpawnedWorker {
	const log = fs.openSync(logPath, "w");
	try {
		const proc = Bun.spawn({
			cmd,
			cwd,
			env,
			detached: true,
			stdin: "ignore",
			stdout: log,
			stderr: log,
			windowsHide: true,
		});
		proc.unref();
		return { proc, logPath };
	} finally {
		fs.closeSync(log);
	}
}

/** How to start the ONNX worker for `modelKey` with the resolved device/dtype env. @internal */
export function onnxLaunch(modelKey: TinyLocalModelKey, modelEnv: Record<string, string>): WorkerLaunch {
	const tag = `${packageJson.version}|onnx|${modelEnv.PI_TINY_DEVICE ?? ""}|${modelEnv.PI_TINY_DTYPE ?? ""}`;
	return {
		backend: "onnx",
		tag,
		spawn(endpoint, logPath) {
			const command = resolveWorkerSpawnCmd(TINY_WORKER_ARG);
			const env = inferenceWorkerEnv({
				...modelEnv,
				[TINY_WORKER_SOCKET_ENV]: endpoint,
				[TINY_WORKER_MODEL_ENV]: modelKey,
				[TINY_WORKER_TAG_ENV]: tag,
			});
			return Promise.resolve(spawnDetached(command.cmd, command.cwd, env, logPath));
		},
	};
}

function mlxLaunch(modelKey: TinyLocalModelKey, emitProgress: (event: TinyTitleProgressEvent) => void): WorkerLaunch {
	const spec = getTinyLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown tiny local model: ${modelKey}`);
	const tag = `mlx|${MLX_LM_VERSION}|${Bun.hash.crc32(MLX_SERVER_SCRIPT).toString(16)}`;
	return {
		backend: "mlx",
		tag,
		async spawn(endpoint, logPath) {
			const python = await ensureTinyMlxRuntime(phase =>
				emitProgress({ modelKey, status: phase, name: `mlx-lm@${MLX_LM_VERSION}` }),
			);
			const script = await stageRunnerScript("omp-tiny-mlx", "py", MLX_SERVER_SCRIPT);
			const env = inferenceWorkerEnv({
				PYTHONUNBUFFERED: "1",
				PYTHONIOENCODING: "utf-8",
				TRANSFORMERS_VERBOSITY: "error",
				HF_HUB_DISABLE_PROGRESS_BARS: "1",
				TOKENIZERS_PARALLELISM: "false",
			});
			const idleSeconds = Number($env[TINY_WORKER_IDLE_MS_ENV]) / 1000 || MLX_IDLE_SECONDS;
			const cmd = [
				python,
				"-u",
				script,
				"--socket",
				endpoint,
				"--tag",
				tag,
				"--model-key",
				modelKey,
				"--repo",
				spec.mlxRepo,
				"--dir",
				getTinyMlxModelDir(spec.mlxRepo),
				"--idle-seconds",
				String(idleSeconds),
			];
			return spawnDetached(cmd, undefined, env, logPath);
		},
	};
}

async function waitForEndpointRelease(endpoint: string): Promise<void> {
	const deadline = Date.now() + SHUTDOWN_WAIT_MS;
	while (Date.now() < deadline) {
		if ((await probeTinyWorker(endpoint, "")).kind === "absent") return;
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
}

/** Last 500 chars of a worker's log, minus its readiness banner; `""` when absent or empty. */
async function logTail(logPath: string): Promise<string> {
	try {
		const text = await Bun.file(logPath).text();
		return text
			.split("\n")
			.filter(line => !line.startsWith("omp tiny worker listening on "))
			.join("\n")
			.trim()
			.slice(-500);
	} catch {
		return "";
	}
}

/**
 * Connect to the worker serving `modelKey`, spawning it when absent or
 * replacing it when its launch tag is stale. A concurrent omp process may win
 * the spawn race; our child then fails to bind and exits while the probe
 * adopts the winner.
 */
export async function connectTinyWorker(
	launch: WorkerLaunch,
	modelKey: TinyLocalModelKey,
	runtimeDir = getTinyWorkerRuntimeDir(),
): Promise<WorkerHandle> {
	await fs.promises.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const endpoint = tinyWorkerEndpoint(runtimeDir, modelKey, launch.backend);
	const logPath = tinyWorkerLogPath(runtimeDir, modelKey, launch.backend);
	const probed = await probeTinyWorker(endpoint, launch.tag);
	if (probed.kind === "live") return createSocketWorkerHandle(probed.socket, logPath);
	if (probed.kind === "stale") await waitForEndpointRelease(endpoint);
	const spawned = await launch.spawn(endpoint, logPath);
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const result = await probeTinyWorker(endpoint, launch.tag);
		if (result.kind === "live") return createSocketWorkerHandle(result.socket, logPath);
		if (spawned.proc.exitCode !== null) {
			// Our child is gone: either it lost the bind race to a sibling omp
			// (already adopted above if so) or it crashed.
			const tail = await logTail(spawned.logPath);
			throw new Error(
				`tiny ${launch.backend} worker for ${modelKey} exited with code ${spawned.proc.exitCode}${tail ? `: ${tail}` : ""}`,
			);
		}
		await Bun.sleep(PROBE_INTERVAL_MS);
	}
	throw new Error(
		`tiny ${launch.backend} worker for ${modelKey} did not bind ${endpoint} within ${READY_TIMEOUT_MS}ms`,
	);
}

// ── Prompt construction / output parsing ─────────────────────────────

function buildTitleMessages(message: string, systemPrompt?: string): TinyChatMessage[] {
	return [
		{ role: "system", content: systemPrompt?.trim() || TINY_TITLE_SYSTEM_PROMPT },
		{ role: "user", content: formatTitleUserMessage(message) },
	];
}

function buildCompletionMessages(promptText: string, systemPrompt?: string): TinyChatMessage[] {
	const userMessage: TinyChatMessage = { role: "user", content: promptText };
	const system = systemPrompt?.trim();
	return system ? [{ role: "system", content: system }, userMessage] : [userMessage];
}

function extractTinyTitle(text: string, sourceText: string): string | null {
	const titleStart = text.lastIndexOf(TITLE_PREFILL);
	const withoutPrefix = titleStart >= 0 ? text.slice(titleStart + TITLE_PREFILL.length) : text;
	// Self-closing tag: <title/> or <title /> (only when the prefill is present).
	if (titleStart >= 0 && /^\s*\/>/.test(withoutPrefix)) return null;
	const closeIndex = withoutPrefix.indexOf(TITLE_CLOSE);
	const withoutClose = closeIndex >= 0 ? withoutPrefix.slice(0, closeIndex) : withoutPrefix;
	const tagIndex = withoutClose.indexOf("<");
	const withoutTag = tagIndex >= 0 ? withoutClose.slice(0, tagIndex) : withoutClose;
	return normalizeGeneratedTitle(withoutTag, sourceText);
}

// ── Client ───────────────────────────────────────────────────────────

/** One connection per model this process has used; the worker behind it is shared machine-wide. */
interface ModelWorker {
	handle: WorkerHandle;
	unsubscribe: () => void;
	refed: boolean;
}

export class TinyTitleClient {
	#workers = new Map<TinyLocalModelKey, ModelWorker>();
	#pending = new Map<string, PendingRequest>();
	#failedModels = new Set<TinyLocalModelKey>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#nextRequestId = 0;
	#connect: (modelKey: TinyLocalModelKey) => Promise<WorkerHandle>;

	constructor(connect?: (modelKey: TinyLocalModelKey) => Promise<WorkerHandle>) {
		this.#connect = connect ?? (modelKey => this.#connectDefault(modelKey));
	}

	async #connectDefault(modelKey: TinyLocalModelKey): Promise<WorkerHandle> {
		if (tinyWorkerUsesMlx()) {
			try {
				return await connectTinyWorker(
					mlxLaunch(modelKey, event => this.#emitProgress(event)),
					modelKey,
				);
			} catch (error) {
				mlxUnavailable = true;
				logger.warn("tiny-title: MLX worker unavailable; falling back to ONNX CPU", {
					modelKey,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return connectTinyWorker(onnxLaunch(modelKey, tinyModelEnv()), modelKey);
	}

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	/**
	 * Reach the model's worker ahead of first use without loading anything, so
	 * the first {@link generate} finds a live connection instead of paying the
	 * probe/spawn latency on the submit hot path (issue #6462). No-ops for
	 * online / non-local keys and for models already marked failed.
	 */
	prewarm(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey) || this.#failedModels.has(modelKey)) return;
		try {
			this.#ensureWorker(modelKey).handle.send({ type: "ping", id: String(++this.#nextRequestId) });
		} catch (error) {
			logger.debug("tiny-title: prewarm failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const request: TinyWorkerRequest = {
			type: "chat",
			id: String(++this.#nextRequestId),
			messages: buildTitleMessages(message, options.systemPrompt),
			prefill: TITLE_PREFILL,
			stop: TITLE_CLOSE,
			maxNewTokens: TITLE_MAX_NEW_TOKENS,
		};
		return this.#run(request, { kind: "title", modelKey, source: message, resolve }, promise, options.signal, () =>
			resolve(null),
		);
	}

	async complete(
		modelKey: string,
		promptText: string,
		options: TinyModelCompletionOptions = {},
	): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;
		const requested = options.maxTokens ?? MEMORY_COMPLETION_DEFAULT_MAX_NEW_TOKENS;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const request: TinyWorkerRequest = {
			type: "chat",
			id: String(++this.#nextRequestId),
			messages: buildCompletionMessages(promptText, options.systemPrompt),
			maxNewTokens: Math.min(Math.max(1, requested), COMPLETION_MAX_NEW_TOKENS),
		};
		return this.#run(request, { kind: "completion", modelKey, resolve }, promise, options.signal, () =>
			resolve(null),
		);
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<TinyTitleDownloadResult> {
		if (!isTinyLocalModelKey(modelKey)) return { ok: false };
		if (options.signal?.aborted) return { ok: false };
		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const { promise, resolve } = Promise.withResolvers<TinyTitleDownloadResult>();
			const request: TinyWorkerRequest = { type: "load", id: String(++this.#nextRequestId) };
			return await this.#run(request, { kind: "load", modelKey, resolve }, promise, options.signal, () =>
				resolve({ ok: false }),
			);
		} finally {
			unsubscribe?.();
		}
	}

	/**
	 * Register `pending`, send `request` to the model's worker, and hand back
	 * `promise` (settled by the correlated reply, a worker error, `onAbort`, or
	 * a send failure) with the bookkeeping detached once it settles.
	 */
	#run<T>(
		request: TinyWorkerRequest,
		pending: PendingRequest,
		promise: Promise<T>,
		signal: AbortSignal | undefined,
		onAbort: () => void,
	): Promise<T> {
		const abort = (): void => {
			if (!this.#pending.delete(request.id)) return;
			this.#syncWorkerRef(pending.modelKey);
			onAbort();
		};
		try {
			const worker = this.#ensureWorker(pending.modelKey);
			this.#pending.set(request.id, pending);
			this.#syncWorkerRef(pending.modelKey);
			signal?.addEventListener("abort", abort, { once: true });
			worker.handle.send(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("tiny-title: local request failed", {
				modelKey: pending.modelKey,
				kind: pending.kind,
				error: message,
			});
			this.#pending.delete(request.id);
			this.#fail(pending, message);
		}
		return promise.finally(() => {
			signal?.removeEventListener("abort", abort);
			if (this.#pending.delete(request.id)) this.#syncWorkerRef(pending.modelKey);
		});
	}

	async terminate(): Promise<void> {
		const workers = [...this.#workers.values()];
		this.#workers.clear();
		for (const pending of this.#pending.values()) this.#fail(pending, undefined);
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

	#ensureWorker(modelKey: TinyLocalModelKey): ModelWorker {
		const existing = this.#workers.get(modelKey);
		if (existing) return existing;
		const handle = new LazyWorkerHandle(() => this.#connect(modelKey));
		const unsubscribeMessage = handle.onMessage(message => this.#handleMessage(modelKey, message));
		const unsubscribeError = handle.onError(error => this.#handleWorkerError(modelKey, error));
		const worker: ModelWorker = {
			handle,
			refed: false,
			unsubscribe: () => {
				unsubscribeMessage();
				unsubscribeError();
			},
		};
		this.#workers.set(modelKey, worker);
		return worker;
	}

	/**
	 * Keep the socket referenced only while a request for that model is in
	 * flight, so idle TUI sessions can exit while short-lived CLI downloads
	 * are not starved by Bun draining the event loop first.
	 */
	#syncWorkerRef(modelKey: TinyLocalModelKey): void {
		const worker = this.#workers.get(modelKey);
		if (!worker) return;
		let inFlight = false;
		for (const pending of this.#pending.values()) {
			if (pending.modelKey === modelKey) {
				inFlight = true;
				break;
			}
		}
		if (inFlight === worker.refed) return;
		worker.refed = inFlight;
		if (inFlight) worker.handle.ref();
		else worker.handle.unref();
	}

	#handleMessage(modelKey: TinyLocalModelKey, message: TinyWorkerResponse): void {
		if (message.type === "pong") return;
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		this.#syncWorkerRef(modelKey);
		if (message.type === "error") {
			logger.debug("tiny-title: worker returned error", { modelKey, error: message.error });
			this.#markFailedModel(pending);
			this.#fail(pending, message.error);
			// One worker serves one model: a failed load/generation leaves nothing
			// worth staying connected to. Sibling requests for the model fault too.
			this.#dropWorker(modelKey, message.error);
			return;
		}
		if (message.type === "text") {
			if (pending.kind === "title") pending.resolve(extractTinyTitle(message.text, pending.source));
			else if (pending.kind === "completion") pending.resolve(message.text.trim() || null);
			return;
		}
		if (pending.kind === "load") pending.resolve({ ok: true });
	}

	#fail(pending: PendingRequest, error: string | undefined): void {
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "load") pending.resolve(error === undefined ? { ok: false } : { ok: false, error });
		else pending.resolve(null);
	}

	#markFailedModel(pending: PendingRequest): void {
		if (pending.kind !== "load") this.#failedModels.add(pending.modelKey);
	}

	#emitProgress(event: TinyTitleProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	/** Forget the model's connection and fail every request still in flight for it. Returns how many failed. */
	#dropWorker(modelKey: TinyLocalModelKey, error: string): number {
		const worker = this.#workers.get(modelKey);
		if (worker) {
			this.#workers.delete(modelKey);
			worker.unsubscribe();
			void worker.handle.terminate();
		}
		let failed = 0;
		for (const [id, pending] of this.#pending) {
			if (pending.modelKey !== modelKey) continue;
			this.#pending.delete(id);
			this.#fail(pending, error);
			failed += 1;
		}
		return failed;
	}

	/** The model's worker went away or could not be reached. */
	#handleWorkerError(modelKey: TinyLocalModelKey, error: Error): void {
		const failed = this.#dropWorker(modelKey, error.message);
		// A worker exiting on its own while idle is routine; losing requests is not.
		if (failed === 0 && error.message.startsWith(TINY_WORKER_CLOSED)) {
			logger.debug("tiny-title: worker went away while idle", { modelKey });
		} else {
			logger.warn("tiny-title: worker error", { modelKey, error: error.message, failedRequests: failed });
		}
	}
}

export const tinyTitleClient = new TinyTitleClient();

/** Alias for the shared tiny-model worker client (titles + memory completions). */
export const tinyModelClient = tinyTitleClient;

/** Drop this process's worker connections; the workers themselves keep serving others until idle. */
export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

/** Exercise ONNX worker startup and the tagged ping handshake for distribution smoke tests. */
export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await fs.promises.mkdir(getTinyWorkerRuntimeDir(), { recursive: true, mode: 0o700 });
	const dir = await fs.promises.mkdtemp(path.join(getTinyWorkerRuntimeDir(), "smoke-"));
	const modelKey: TinyLocalModelKey = "lfm2.5-230m";
	const launch = onnxLaunch(modelKey, {});
	const endpoint = tinyWorkerEndpoint(dir, modelKey, "onnx");
	const spawned = await launch.spawn(endpoint, tinyWorkerLogPath(dir, modelKey, "onnx"));
	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const result = await probeTinyWorker(endpoint, launch.tag);
			if (result.kind === "live") {
				result.socket.destroy();
				return;
			}
			if (spawned.proc.exitCode !== null) break;
			await Bun.sleep(PROBE_INTERVAL_MS);
		}
		throw new Error(`tiny worker smoke failed: no tagged pong (${(await logTail(spawned.logPath)) || "no output"})`);
	} finally {
		// The worker was spawned unref'd; re-reference it so awaiting its exit
		// cannot drain the event loop and end the smoke run early.
		spawned.proc.ref();
		spawned.proc.kill();
		await spawned.proc.exited.catch(() => {});
		await fs.promises.rm(dir, { recursive: true, force: true });
	}
}
