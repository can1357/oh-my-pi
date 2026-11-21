import type { TinyLocalModelKey } from "./models";

/**
 * Wire protocol between `TinyTitleClient` and a tiny-model worker.
 *
 * One worker per local model: the ONNX worker (`worker.ts`, the omp binary
 * re-entered with {@link TINY_WORKER_ARG}) or the MLX worker (`mlx-server.py`),
 * each a child of the omp daemon's `infer` module. The worker speaks this
 * newline-delimited JSON over stdin/stdout; clients speak the same lines over
 * their daemon tunnel and the daemon rewrites request ids. Requests are
 * message-level so both workers render the chat template with their own
 * tokenizer; the client owns prompt construction and title extraction.
 */

/**
 * Hidden subcommand on the main CLI that boots the ONNX tiny-model worker.
 * Kept in sync with the dispatch in `cli.ts`.
 */
export const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
/** Env var naming the single local model the ONNX worker serves. */
export const TINY_WORKER_MODEL_ENV = "OMP_TINY_WORKER_MODEL";
/** Env var overriding the unit's idle grace (milliseconds); for tests. */
export const TINY_WORKER_IDLE_MS_ENV = "OMP_TINY_WORKER_IDLE_MS";

/** Inference engine a worker runs; part of the unit key so ONNX and MLX workers for one model coexist. */
export type TinyWorkerBackend = "onnx" | "mlx";

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
	  };

export type TinyWorkerResponse =
	| { type: "pong"; id: string }
	| { type: "progress"; id: string; event: TinyTitleProgressEvent }
	| { type: "loaded"; id: string }
	| { type: "text"; id: string; text: string }
	| { type: "error"; id: string; error: string };
