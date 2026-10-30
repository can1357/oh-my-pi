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
import type { MnemopiEmbedCall, MnemopiEmbedServerResponse } from "@oh-my-pi/pi-mnemopi/embed-protocol";
import type { SharedWorkerControl } from "@oh-my-pi/pi-utils/shared-worker-protocol";

export * from "@oh-my-pi/pi-mnemopi/embed-protocol";

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
