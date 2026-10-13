import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger, readLines, Snowflake } from "@oh-my-pi/pi-utils";
import { filterEnv, resolveExplicitPythonRuntime, resolvePythonRuntime } from "../eval/py/runtime";
import { stageRunnerScript } from "../eval/runner-cache";
import WORKER_SCRIPT from "./worker.py" with { type: "text" };
import {
	MNEMOSYNE_OSS_PROTOCOL_VERSION,
	MNEMOSYNE_OSS_REQUIRED_METHODS,
	type MnemosyneOssWorkerCapabilities,
	type MnemosyneOssWorkerContext,
	type MnemosyneOssWorkerMethod,
	type MnemosyneOssWorkerRequest,
	type MnemosyneOssWorkerResponse,
} from "./worker-protocol";

const STDERR_TAIL_LIMIT = 16_384;
const CANCEL_GRACE_MS = 250;

export interface MnemosyneOssWorkerRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Set for every operation that can mutate the SDK or its database. */
	mutation?: boolean;
}

export interface MnemosyneOssWorkerClientOptions {
	context: MnemosyneOssWorkerContext;
	cwd: string;
	executable?: string;
	requestTimeoutMs: number;
	shutdownTimeoutMs: number;
}

interface PendingRequest<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer?: Timer;
	removeAbort?: () => void;
	mutation: boolean;
	method: MnemosyneOssWorkerMethod;
	cancellationError?: Error;
}

/**
 * One supervised Python SDK worker for an immutable Mnemosyne bank scope.
 * Requests are deliberately serialized: the SDK is synchronous and SQLite
 * mutations must preserve caller order.
 */
export class MnemosyneOssWorkerClient {
	readonly #options: MnemosyneOssWorkerClientOptions;
	#process?: Bun.Subprocess;
	#writer?: Bun.FileSink;
	#temporaryConfigDir?: string;
	#pending = new Map<string, PendingRequest<unknown>>();
	#queue: Promise<void> = Promise.resolve();
	#startup?: Promise<void>;
	#shutdownPromise?: Promise<void>;
	#stderrTail = "";
	#closed = false;
	#crashed = false;

	constructor(options: MnemosyneOssWorkerClientOptions) {
		this.#options = options;
	}

	async capabilities(signal?: AbortSignal): Promise<MnemosyneOssWorkerCapabilities> {
		return await this.request<MnemosyneOssWorkerCapabilities>("capabilities", {}, { signal });
	}

	request<T>(
		method: MnemosyneOssWorkerMethod,
		params: Record<string, unknown> = {},
		options: MnemosyneOssWorkerRequestOptions = {},
	): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("Mnemosyne OSS worker is closed."));
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const run = async (): Promise<void> => {
			// An aborted request that has not reached the queue must never start a
			// worker or write a protocol message.
			if (options.signal?.aborted) {
				reject(toAbortError(options.signal));
				return;
			}
			try {
				resolve(await this.#send<T>(method, params, options));
			} catch (error) {
				// Only safe, read-only requests can be replayed. A mutation that
				// reached the child must surface an unknown outcome after a crash.
				if (!options.mutation && !options.signal?.aborted && this.#crashed) {
					try {
						await this.#disposeProcess();
						resolve(await this.#send<T>(method, params, options));
					} catch (retryError) {
						reject(toError(retryError));
					}
					return;
				}
				reject(toError(error));
			}
		};
		this.#queue = this.#queue.then(run, run);
		return promise;
	}

	/** Idempotently flushes the child and removes its private runtime config. */
	async shutdown(): Promise<void> {
		if (this.#shutdownPromise) return await this.#shutdownPromise;
		this.#closed = true;
		const run = async (): Promise<void> => {
			try {
				if (this.#process) {
					await this.#send("shutdown", {}, { timeoutMs: this.#options.shutdownTimeoutMs, mutation: true });
				}
			} catch (error) {
				logger.debug("Mnemosyne OSS worker shutdown request failed", { error: String(error) });
			} finally {
				await this.#disposeProcess();
			}
		};
		this.#shutdownPromise = this.#queue.then(run, run);
		return await this.#shutdownPromise;
	}

	async #send<T>(
		method: MnemosyneOssWorkerMethod,
		params: Record<string, unknown>,
		options: MnemosyneOssWorkerRequestOptions,
	): Promise<T> {
		await this.#ensureStarted();
		if (options.signal?.aborted) throw toAbortError(options.signal);
		const id = Snowflake.next();
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
		const pending: PendingRequest<T> = {
			resolve,
			reject,
			mutation: options.mutation === true,
			method,
		};
		if (timeoutMs > 0) {
			pending.timer = setTimeout(() => {
				void this.#cancelInFlight(
					id,
					pending,
					new Error(`Mnemosyne OSS ${method} timed out after ${timeoutMs}ms.`),
				);
			}, timeoutMs);
		}
		const signal = options.signal;
		if (signal) {
			const abort = (): void => {
				void this.#cancelInFlight(id, pending, toAbortError(signal));
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending as PendingRequest<unknown>);
		const request: MnemosyneOssWorkerRequest = { jsonrpc: "2.0", id, method, params };
		try {
			if (!this.#writer) throw new Error("Mnemosyne OSS worker stdin is not open.");
			await this.#writer.write(`${JSON.stringify(request)}\n`);
			await this.#writer.flush();
		} catch (error) {
			this.#settlePending(id, undefined, toError(error));
		}
		return await promise;
	}

	async #ensureStarted(): Promise<void> {
		if (this.#process) return;
		if (!this.#startup) {
			this.#startup = this.#start().finally(() => {
				this.#startup = undefined;
			});
		}
		await this.#startup;
	}

	async #start(): Promise<void> {
		const temporaryConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mnemosyne-oss-config-"));
		this.#temporaryConfigDir = temporaryConfigDir;
		try {
			const runtime = this.#options.executable
				? resolveExplicitPythonRuntime(this.#options.executable, this.#options.cwd, filterEnv(process.env))
				: resolvePythonRuntime(this.#options.cwd, filterEnv(process.env));
			const environment = buildWorkerEnvironment(runtime.env, temporaryConfigDir, this.#options.context);
			const scriptPath = await stageRunnerScript("omp-mnemosyne-oss-worker", "py", WORKER_SCRIPT);
			const child = Bun.spawn([runtime.pythonPath, "-u", scriptPath], {
				cwd: this.#options.cwd,
				env: environment,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			this.#process = child;
			this.#writer = child.stdin;
			this.#stderrTail = "";
			this.#crashed = false;
			void this.#drainStdout(child, child.stdout as ReadableStream<Uint8Array>);
			void this.#drainStderr(child.stderr as ReadableStream<Uint8Array>);
			void child.exited.then(exitCode => {
				if (this.#process === child) {
					this.#failProcess(new Error(`Mnemosyne OSS worker exited with code ${exitCode}.`));
				}
			});

			await this.#send(
				"initialize",
				{ context: this.#options.context },
				{ timeoutMs: this.#options.requestTimeoutMs },
			);
			const capabilities = await this.#send<MnemosyneOssWorkerCapabilities>(
				"capabilities",
				{},
				{ timeoutMs: this.#options.requestTimeoutMs },
			);
			validateCapabilities(capabilities);
		} catch (error) {
			await this.#disposeProcess();
			throw toError(error);
		}
	}

	async #drainStdout(child: Bun.Subprocess, stream: ReadableStream<Uint8Array>): Promise<void> {
		try {
			for await (const line of readLines(stream)) {
				const text = new TextDecoder().decode(line).trim();
				if (!text) {
					this.#failProcess(new Error("Mnemosyne OSS worker emitted an empty JSON-RPC line."));
					return;
				}
				let response: MnemosyneOssWorkerResponse;
				try {
					response = JSON.parse(text) as MnemosyneOssWorkerResponse;
				} catch {
					this.#failProcess(new Error("Mnemosyne OSS worker emitted malformed JSON-RPC output."));
					return;
				}
				if (!isResponse(response) || !this.#pending.has(response.id)) {
					this.#failProcess(
						new Error("Mnemosyne OSS worker emitted an invalid or unsolicited JSON-RPC response."),
					);
					return;
				}
				if ("error" in response) {
					this.#settlePending(response.id, undefined, rpcError(response.error.message, response.error.code));
				} else {
					this.#settlePending(response.id, response.result, undefined);
				}
			}
			if (this.#process === child) this.#failProcess(new Error("Mnemosyne OSS worker closed stdout unexpectedly."));
		} catch (error) {
			if (this.#process === child) this.#failProcess(toError(error));
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		try {
			for await (const line of readLines(stream)) {
				this.#stderrTail = `${this.#stderrTail}${new TextDecoder().decode(line)}\n`.slice(-STDERR_TAIL_LIMIT);
			}
		} catch (error) {
			logger.debug("Mnemosyne OSS worker stderr drain failed", { error: String(error) });
		}
	}

	async #cancelInFlight(id: string, pending: PendingRequest<unknown>, error: Error): Promise<void> {
		if (this.#pending.get(id) !== pending || pending.cancellationError) return;
		pending.cancellationError = error;
		try {
			if (!this.#writer) throw new Error("Mnemosyne OSS worker stdin is not open.");
			const cancellation = { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } };
			await this.#writer.write(`${JSON.stringify(cancellation)}\n`);
			await this.#writer.flush();
		} catch {
			// The process will be terminated below; the original cancellation
			// reason remains the useful error for the caller.
		}
		await Bun.sleep(CANCEL_GRACE_MS);
		if (this.#pending.get(id) !== pending) return;
		this.#settlePending(id, undefined, pending.mutation ? unknownMutationError(error) : error);
		await this.#disposeProcess();
	}

	#settlePending(id: string, result: unknown, error: Error | undefined): void {
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		if (pending.cancellationError) {
			pending.reject(pending.mutation ? unknownMutationError(pending.cancellationError) : pending.cancellationError);
		} else if (error) pending.reject(error);
		else pending.resolve(result);
	}

	#failProcess(error: Error): void {
		if (!this.#process && this.#pending.size === 0) return;
		this.#crashed = true;
		const detail = this.#stderrTail.trim();
		const failure = detail ? new Error(`${error.message}\n${detail}`) : error;
		for (const [id, pending] of [...this.#pending.entries()]) {
			this.#settlePending(id, undefined, pending.mutation ? unknownMutationError(failure) : failure);
		}
		void this.#disposeProcess();
	}

	async #disposeProcess(): Promise<void> {
		const child = this.#process;
		const writer = this.#writer;
		this.#process = undefined;
		this.#writer = undefined;
		try {
			await writer?.end();
		} catch {}
		if (child && child.exitCode === null) {
			try {
				child.kill();
			} catch {}
			await Promise.race([child.exited, Bun.sleep(this.#options.shutdownTimeoutMs)]);
			if (child.exitCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		}
		const temporaryConfigDir = this.#temporaryConfigDir;
		this.#temporaryConfigDir = undefined;
		if (temporaryConfigDir) await fs.rm(temporaryConfigDir, { recursive: true, force: true });
	}
}

function validateCapabilities(capabilities: MnemosyneOssWorkerCapabilities): void {
	if (!capabilities || typeof capabilities !== "object") {
		throw new Error("Mnemosyne OSS worker handshake returned no capabilities.");
	}
	if (capabilities.protocol !== MNEMOSYNE_OSS_PROTOCOL_VERSION) {
		throw new Error(
			`Mnemosyne OSS worker protocol ${String(capabilities.protocol)} is unsupported; expected ${MNEMOSYNE_OSS_PROTOCOL_VERSION}.`,
		);
	}
	const python = parsePythonVersion(capabilities.python_version);
	if (!python || python.major < 3 || (python.major === 3 && python.minor < 10)) {
		throw new Error(`Mnemosyne OSS requires Python 3.10+, found ${String(capabilities.python_version)}.`);
	}
	const sdk = /^([0-9]+)(?:\.|$)/.exec(capabilities.sdk_version);
	if (sdk?.[1] !== "4") {
		throw new Error(`Mnemosyne OSS requires SDK major 4, found ${String(capabilities.sdk_version)}.`);
	}
	if (!Array.isArray(capabilities.operations)) {
		throw new Error("Mnemosyne OSS worker handshake returned no operation list.");
	}
	const missingMethods = MNEMOSYNE_OSS_REQUIRED_METHODS.filter(method => !capabilities.operations.includes(method));
	if (missingMethods.length > 0) {
		throw new Error(`Mnemosyne OSS worker is missing required operations: ${missingMethods.join(", ")}.`);
	}
	if (capabilities.embedding_mode !== "local" && capabilities.embedding_mode !== "lexical") {
		throw new Error(
			`Mnemosyne OSS worker reported unsupported embedding mode ${String(capabilities.embedding_mode)}.`,
		);
	}
	if (capabilities.consolidation_mode !== "local" && capabilities.consolidation_mode !== "heuristic") {
		throw new Error(
			`Mnemosyne OSS worker reported unsupported consolidation mode ${String(capabilities.consolidation_mode)}.`,
		);
	}
}

function isResponse(value: unknown): value is MnemosyneOssWorkerResponse {
	if (!value || typeof value !== "object") return false;
	const response = value as Record<string, unknown>;
	if (response.jsonrpc !== "2.0" || typeof response.id !== "string") return false;
	const hasResult = Object.hasOwn(response, "result");
	const error = response.error;
	if (hasResult === (error !== undefined)) return false;
	if (error === undefined) return true;
	if (!error || typeof error !== "object") return false;
	const details = error as Record<string, unknown>;
	return typeof details.code === "number" && typeof details.message === "string";
}

function parsePythonVersion(version: unknown): { major: number; minor: number } | undefined {
	if (typeof version !== "string") return undefined;
	const match = /^(\d+)\.(\d+)/.exec(version.trim());
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

function rpcError(message: string, code: number): Error {
	const error = new Error(`Mnemosyne OSS worker error (${code}): ${message}`);
	return error;
}
function unknownMutationError(error: Error): Error {
	return new Error(`${error.message} operation outcome unknown; the mutation was not replayed.`);
}

function buildWorkerEnvironment(
	runtimeEnv: Record<string, string | undefined>,
	temporaryConfigDir: string,
	context: MnemosyneOssWorkerContext,
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(runtimeEnv)) {
		if (value !== undefined && !key.startsWith("MNEMOSYNE_")) environment[key] = value;
	}
	environment.PYTHONUNBUFFERED = "1";
	environment.PYTHONIOENCODING = "utf-8";
	// Mnemosyne seeds config.yaml from this private directory. The shared
	// database path is passed only in the immutable protocol context.
	environment.MNEMOSYNE_DATA_DIR = temporaryConfigDir;
	environment.MNEMOSYNE_FORCE_LOCAL = "1";
	environment.MNEMOSYNE_AUTO_MIGRATE = context.auto_migrate ? "1" : "0";
	if (context.embedding_mode === "local") {
		environment.MNEMOSYNE_EMBEDDING_MODEL = context.embedding_model ?? "";
	} else {
		environment.MNEMOSYNE_NO_EMBEDDINGS = "1";
		environment.MNEMOSYNE_SKIP_EMBEDDINGS = "1";
		environment.MNEMOSYNE_EMBEDDINGS_OFF = "1";
		environment.MNEMOSYNE_EMBEDDING_MODEL = "";
	}
	environment.MNEMOSYNE_REMOTE_EMBEDDINGS = "";
	environment.MNEMOSYNE_LLM_ENABLED = context.consolidation_mode === "local" ? "true" : "false";
	environment.MNEMOSYNE_LLM_REPO = context.local_llm_repo ?? "";
	environment.MNEMOSYNE_LLM_FILE = context.local_llm_file ?? "";
	environment.MNEMOSYNE_REMOTE_LLM = "";
	environment.MNEMOSYNE_REMOTE_MODALITY = "";
	environment.MNEMOSYNE_SYNC_ENABLED = "0";
	for (const key of [
		"MNEMOSYNE_EMBEDDING_API_KEY",
		"MNEMOSYNE_EMBEDDING_API_URL",
		"MNEMOSYNE_LLM_API_KEY",
		"MNEMOSYNE_LLM_API_URL",
		"MNEMOSYNE_MODALITY_API_KEY",
		"MNEMOSYNE_MODALITY_API_URL",
		"MNEMOSYNE_SYNC_API_KEY",
		"MNEMOSYNE_SYNC_API_URL",
	])
		environment[key] = "";
	return environment;
}

function toAbortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Mnemosyne OSS worker request aborted.");
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
