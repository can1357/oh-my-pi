/**
 * Wire types between the parent (`MnemopiEmbedClient`) and the local
 * embeddings subprocess. The parent owns the subprocess lifecycle (graceful
 * work, hard `SIGKILL` on shutdown); the protocol carries no explicit close
 * handshake — once the parent decides to terminate, it signals the OS to reap
 * the child so `onnxruntime-node`'s NAPI finalizer never runs in the main
 * agent address space (it crashes Bun on Windows shutdown — issue #3031, the
 * mnemopi sibling of the tiny-model fix from #1606/#1607). See
 * `embed-client.ts` for the spawn/kill glue.
 */

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

export interface MnemopiEmbedTransport {
	send(message: MnemopiEmbedWorkerOutbound): void;
	onMessage(handler: (message: MnemopiEmbedWorkerInbound) => void): () => void;
}
