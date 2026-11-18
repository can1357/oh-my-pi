import type { SttModelKey } from "./models";

export type SttProgressStatus = "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";

export interface SttProgressFileState {
	loaded: number;
	total: number;
}

export interface SttProgressEvent {
	modelKey: SttModelKey;
	status: SttProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, SttProgressFileState>;
	task?: string;
	model?: string;
}

export type SttWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "transcribe"; id: string; modelKey: SttModelKey; audio: Float32Array; language?: string }
	| { type: "download"; id: string; modelKey: SttModelKey }
	// ── Live streaming session ──
	// `stream_start` warms the model and opens a session; `stream_audio` feeds
	// 16 kHz mono float frames as they arrive from the recorder; `stream_stop`
	// flushes the trailing speech segment and ends the session; `stream_cancel`
	// tears it down without a final flush. All carry the same `id`.
	| { type: "stream_start"; id: string; modelKey: SttModelKey; language?: string }
	| { type: "stream_audio"; id: string; audio: Float32Array }
	| { type: "stream_stop"; id: string }
	| { type: "stream_cancel"; id: string };

export type SttWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "transcription"; id: string; text: string }
	| { type: "downloaded"; id: string }
	| { type: "error"; id: string; error: string }
	| { type: "progress"; id: string; event: SttProgressEvent }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	// ── Live streaming session ──
	// `partial` is the volatile transcript of the in-progress speech segment
	// (refreshed as more audio arrives, never appended verbatim); `segment` is a
	// finalized segment committed once at an endpoint; `stream_done` carries the
	// full transcript (all committed segments joined) when the session ends.
	| { type: "partial"; id: string; text: string }
	| { type: "segment"; id: string; index: number; text: string }
	| { type: "stream_done"; id: string; text: string };

/**
 * Worker-side transport. Messages cross both hops (client tunnel <-> daemon
 * `speech` module <-> worker stdio) as the binary frames of
 * `daemon/modules/speech-frames.ts`; `audio` travels as a raw f32le payload.
 * The daemon owns the worker process and SIGKILLs it on stop, so the protocol
 * has no close handshake and `onnxruntime-node`'s NAPI finalizer never runs
 * (its destructor segfaults Bun on shutdown; issue #1606).
 */
export interface SttTransport {
	send(message: SttWorkerOutbound): void;
	onMessage(handler: (message: SttWorkerInbound) => void): () => void;
}
