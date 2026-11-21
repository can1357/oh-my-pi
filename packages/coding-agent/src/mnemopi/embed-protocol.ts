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
import type { MnemopiEmbedCall, MnemopiEmbedServerResponse } from "@oh-my-pi/pi-mnemopi/embed-protocol";
import type { SharedWorkerControl } from "@oh-my-pi/pi-utils/shared-worker-protocol";

export * from "@oh-my-pi/pi-mnemopi/embed-protocol";

/**
 * Hidden subcommand on the main CLI that boots the onnxruntime embeddings
 * worker. Kept in sync with the dispatch in `cli.ts`.
 */
export const MNEMOPI_EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

/** The private ONNX child also answers untagged pings for the distribution smoke probe. */
export type MnemopiEmbedWorkerInbound = Extract<SharedWorkerControl, { type: "ping" }> | MnemopiEmbedCall;
export type MnemopiEmbedWorkerOutbound =
	| Extract<MnemopiEmbedServerResponse, { type: "ready" | "vectors" | "error" }>
	| { type: "pong"; id: string }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> };

export interface MnemopiEmbedTransport {
	send(message: MnemopiEmbedWorkerOutbound): void;
	onMessage(handler: (message: MnemopiEmbedWorkerInbound) => void): () => void;
}
