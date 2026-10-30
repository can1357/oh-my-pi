/** Newline-JSON protocol shared by omp and standalone local embedding clients. */
import * as path from "node:path";
import type { SharedWorkerControl, SharedWorkerPong } from "@oh-my-pi/pi-utils/shared-worker-protocol";

/** Endpoint the detached omp embedding server must own. */
export const MNEMOPI_EMBED_SOCKET_ENV = "OMP_MNEMOPI_EMBED_SOCKET";
/** Model named in the detached server's process title and logs. */
export const MNEMOPI_EMBED_MODEL_ENV = "OMP_MNEMOPI_EMBED_MODEL";
/** Launch tag echoed in pong; omp replaces servers from a different version. */
export const MNEMOPI_EMBED_TAG_ENV = "OMP_MNEMOPI_EMBED_TAG";
/** Override for the detached omp server's idle window in milliseconds. */
export const MNEMOPI_EMBED_IDLE_MS_ENV = "OMP_MNEMOPI_EMBED_IDLE_MS";
export const MNEMOPI_EMBED_IDLE_MS = 15 * 60 * 1_000;

/** Fastembed model identifier, e.g. `fast-bge-small-en-v1.5`. */
export type MnemopiEmbedModelId = string;

export type MnemopiEmbedCall =
	| { type: "init"; id: string; model: MnemopiEmbedModelId; cacheDir?: string }
	| { type: "embed"; id: string; model: MnemopiEmbedModelId; cacheDir?: string; texts: string[]; batchSize?: number };

export type MnemopiEmbedServerRequest = SharedWorkerControl | MnemopiEmbedCall;
export type MnemopiEmbedServerResponse =
	| SharedWorkerPong
	| { type: "ready"; id: string }
	| { type: "vectors"; id: string; vectors: number[][] }
	| { type: "error"; id: string; error: string };

/** One endpoint per fastembed model and resolved cache directory, on every platform. */
export function mnemopiEmbedServerName(model: MnemopiEmbedModelId, cacheDir: string): string {
	return `${model}-${Bun.hash.crc32(path.resolve(cacheDir)).toString(16).padStart(8, "0")}`;
}
