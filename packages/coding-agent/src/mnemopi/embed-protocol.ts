/**
 * Wire types for local mnemopi embeddings, on two legs:
 *
 * - omp process ⇄ shared embedding server (`embed-server.ts`): newline JSON
 *   over a native IPC endpoint, one server per (model, cache dir) per machine.
 * - shared server ⇄ its onnxruntime child (`embed-worker.ts`): Bun IPC. The
 *   server owns the child (hard `SIGKILL` on wedge, idle exit, or shutdown);
 *   that leg carries no close handshake so `onnxruntime-node`'s NAPI finalizer
 *   never runs (it crashes Bun on Windows shutdown — issue #3031, the mnemopi
 *   sibling of the tiny-model fix from #1606/#1607).
 */
import type { SharedWorkerControl, SharedWorkerPong } from "../subprocess/shared-worker";

/** Env var carrying the endpoint the shared server must own. */
export const MNEMOPI_EMBED_SOCKET_ENV = "OMP_MNEMOPI_EMBED_SOCKET";
/** Env var naming the model the shared server serves (process title and logs). */
export const MNEMOPI_EMBED_MODEL_ENV = "OMP_MNEMOPI_EMBED_MODEL";
/** Env var carrying the launch tag the server echoes in `pong`, so a server from another omp version is replaced. */
export const MNEMOPI_EMBED_TAG_ENV = "OMP_MNEMOPI_EMBED_TAG";
/** Env var overriding the idle exit window (milliseconds); for tests. */
export const MNEMOPI_EMBED_IDLE_MS_ENV = "OMP_MNEMOPI_EMBED_IDLE_MS";
/** Idle window (nothing in flight, no request received) after which the server exits and the model's memory is freed. */
export const MNEMOPI_EMBED_IDLE_MS = 15 * 60 * 1_000;

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

/** Model work both legs carry. */
export type MnemopiEmbedCall = Extract<MnemopiEmbedWorkerInbound, { type: "init" | "embed" }>;

/** Requests an omp process sends the shared server. */
export type MnemopiEmbedServerRequest = SharedWorkerControl | MnemopiEmbedCall;

/** Replies the shared server sends an omp process. */
export type MnemopiEmbedServerResponse =
	| SharedWorkerPong
	| Extract<MnemopiEmbedWorkerOutbound, { type: "ready" | "vectors" | "error" }>;

export interface MnemopiEmbedTransport {
	send(message: MnemopiEmbedWorkerOutbound): void;
	onMessage(handler: (message: MnemopiEmbedWorkerInbound) => void): () => void;
}
