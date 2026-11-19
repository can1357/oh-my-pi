/**
 * Wire types for local mnemopi embeddings. The onnxruntime worker
 * (`embed-worker.ts`) is a child of the omp daemon's `infer` module and reads
 * {@link MnemopiEmbedWorkerInbound} lines on stdin, writing
 * {@link MnemopiEmbedWorkerOutbound} lines on stdout; clients speak the same
 * lines over their daemon tunnel. The daemon SIGKILLs the worker (on wedge,
 * idle, or stop) and the worker SIGKILLs itself when stdin closes, so
 * `onnxruntime-node`'s NAPI finalizer never runs (it crashes Bun on Windows
 * shutdown — issue #3031, the mnemopi sibling of #1606/#1607).
 */

/**
 * Hidden subcommand on the main CLI that boots the onnxruntime embeddings
 * worker. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";
/** Env var overriding the unit's idle grace (milliseconds); for tests. */
export const MNEMOPI_EMBED_IDLE_MS_ENV = "OMP_MNEMOPI_EMBED_IDLE_MS";

/** Identifier of the fastembed model the worker should load (e.g. `fast-bge-base-en-v1.5`). */
export type MnemopiEmbedModelId = string;

export type MnemopiEmbedWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "init"; id: string; model: MnemopiEmbedModelId; cacheDir?: string }
	// `embed` always carries the same `model` / `cacheDir` the wrapper was
	// initialized with so a fresh subprocess (after the parent SIGKILLed the
	// previous one but mnemopi still holds the cached `LocalEmbeddingModel`)
	// can lazily reload the model on demand instead of returning
	// "embed before init".
	| { type: "embed"; id: string; model: MnemopiEmbedModelId; cacheDir?: string; texts: string[]; batchSize?: number };

export type MnemopiEmbedWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "ready"; id: string }
	| { type: "vectors"; id: string; vectors: number[][] }
	| { type: "error"; id: string; error: string }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> };

/** Model work a client sends. */
export type MnemopiEmbedCall = Extract<MnemopiEmbedWorkerInbound, { type: "init" | "embed" }>;
