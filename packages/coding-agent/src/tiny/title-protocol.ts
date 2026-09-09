import * as path from "node:path";
import type { TinyLocalModelKey } from "./models";

/**
 * Wire protocol between `TinyTitleClient` and a tiny-model worker.
 *
 * One worker per local model: the ONNX worker (`worker.ts`, the omp binary
 * re-entered with {@link TINY_WORKER_ARG}) or the MLX worker (`mlx-server.py`)
 * owns a Unix socket / named pipe named after the model, serves every omp
 * process on the machine over newline-delimited JSON, and exits on its own
 * once idle. Requests are message-level so both workers render the chat
 * template with their own tokenizer; the client owns prompt construction and
 * title extraction.
 */

/**
 * Hidden subcommand on the main CLI that boots the ONNX tiny-model worker.
 * Kept in sync with the dispatch in `cli.ts`.
 */
export const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
/** Env var carrying the endpoint the ONNX worker must own. */
export const TINY_WORKER_SOCKET_ENV = "OMP_TINY_WORKER_SOCKET";
/** Env var naming the single local model the ONNX worker serves. */
export const TINY_WORKER_MODEL_ENV = "OMP_TINY_WORKER_MODEL";
/** Env var carrying the launch tag the worker echoes in `pong` so stale workers get replaced. */
export const TINY_WORKER_TAG_ENV = "OMP_TINY_WORKER_TAG";
/** Env var overriding the idle exit window (milliseconds); for tests. */
export const TINY_WORKER_IDLE_MS_ENV = "OMP_TINY_WORKER_IDLE_MS";
/** Idle window (nothing in flight, no request received) after which a worker exits to free model memory. */
export const TINY_WORKER_IDLE_MS = 15 * 60 * 1_000;

/** Inference engine a worker runs; part of the socket name so ONNX and MLX workers for one model coexist. */
export type TinyWorkerBackend = "onnx" | "mlx";

const workerName = (modelKey: TinyLocalModelKey, backend: TinyWorkerBackend): string =>
	`${modelKey}-${backend}`.replace(/[^A-Za-z0-9._-]/g, "_");

/** Resolve the Unix socket or Windows named pipe for one (model, backend) worker. */
export function tinyWorkerEndpoint(
	runtimeDir: string,
	modelKey: TinyLocalModelKey,
	backend: TinyWorkerBackend,
): string {
	const name = workerName(modelKey, backend);
	if (process.platform === "win32") {
		const key = Bun.hash.crc32(path.resolve(runtimeDir, name)).toString(16).padStart(8, "0");
		return `\\\\.\\pipe\\omp-tiny-${name}-${key}`;
	}
	return path.join(runtimeDir, `${name}.sock`);
}

/**
 * Stdout/stderr log file for one (model, backend) worker. Derived from
 * `runtimeDir`, not the endpoint: on Windows the endpoint is a named pipe
 * (`\\.\pipe\…`), which cannot be opened as a file.
 */
export function tinyWorkerLogPath(runtimeDir: string, modelKey: TinyLocalModelKey, backend: TinyWorkerBackend): string {
	return path.join(runtimeDir, `${workerName(modelKey, backend)}.log`);
}

export type TinyTitleProgressStatus =
	| "initiate"
	| "download"
	| "progress"
	| "progress_total"
	| "done"
	| "ready"
	| "error";

export interface TinyTitleProgressFileState {
	loaded: number;
	total: number;
}

export interface TinyTitleProgressEvent {
	modelKey: TinyLocalModelKey;
	status: TinyTitleProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, TinyTitleProgressFileState>;
	task?: string;
	model?: string;
}

/** Chat turn handed to a worker; the worker renders it with the model's own chat template. */
export interface TinyChatMessage {
	role: "system" | "user";
	content: string;
}

export type TinyWorkerRequest =
	| { type: "ping"; id: string }
	/** Download (if needed) and load the worker's model, streaming `progress` then `loaded`. */
	| { type: "load"; id: string }
	/** One greedy generation; loads the model first when it is not resident. Replies with generated text only. */
	| {
			type: "chat";
			id: string;
			messages: readonly TinyChatMessage[];
			/** Appended verbatim after the generation prompt so the model continues it. */
			prefill?: string;
			/** Stop once this text appears in the generated output. */
			stop?: string;
			maxNewTokens: number;
	  }
	/** Exit now (a client found a stale launch tag and will respawn). */
	| { type: "shutdown"; id: string };

export type TinyWorkerResponse =
	| { type: "pong"; id: string; tag: string }
	| { type: "progress"; id: string; event: TinyTitleProgressEvent }
	| { type: "loaded"; id: string }
	| { type: "text"; id: string; text: string }
	| { type: "error"; id: string; error: string };
