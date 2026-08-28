import type { TinyLocalModelKey, TinyTitleLocalModelKey } from "./models";

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

export type TinyTitleWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "generate"; id: string; modelKey: TinyTitleLocalModelKey; message: string; systemPrompt?: string }
	| {
			type: "complete";
			id: string;
			modelKey: TinyLocalModelKey;
			prompt: string;
			maxTokens?: number;
			systemPrompt?: string;
	  }
	| { type: "download"; id: string; modelKey: TinyLocalModelKey };

export type TinyTitleWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "title"; id: string; title: string | null }
	| { type: "completion"; id: string; text: string | null }
	| { type: "downloaded"; id: string }
	| { type: "error"; id: string; error: string }
	| { type: "progress"; id: string; event: TinyTitleProgressEvent }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> };

/**
 * Wire transport between the parent (`TinyTitleClient`) and the tiny-model
 * subprocess. The parent owns the subprocess lifecycle (graceful work, hard
 * kill on shutdown); the protocol therefore carries no explicit close
 * handshake — once the parent decides to terminate, it signals the OS to
 * reap the child so `onnxruntime-node`'s NAPI finalizer never runs in any
 * shared address space. See `title-client.ts` for the spawn/kill glue.
 */
export interface TinyTitleTransport {
	send(message: TinyTitleWorkerOutbound): void;
	onMessage(handler: (message: TinyTitleWorkerInbound) => void): () => void;
}
