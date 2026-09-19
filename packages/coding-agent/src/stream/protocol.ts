/**
 * Local protocol between an interactive session and the `omp stream` process
 * in the same working directory.
 *
 * Transport: newline-delimited JSON over the Unix socket / named pipe at
 * {@link streamSocketEndpoint}. The streamer assigns each connected session a
 * wire pane id and forwards the session's frames as `StreamPaneFrame`s; the
 * session never learns about other panes or the stream server.
 *
 * Rows are already normalized and redacted when they cross this socket (see
 * `publisher.ts`); the streamer is a pure multiplexer.
 */
import type { StreamChatMessage, StreamRow } from "@oh-my-pi/pi-wire";

export const STREAM_LOCAL_PROTO = 1;

/** Session → streamer. `hello` is the first frame on the socket. */
export type StreamSessionFrame =
	| { t: "hello"; proto: number; sessionId: string; title: string; cols: number; rows: number }
	| { t: "resize"; cols: number; rows: number }
	| { t: "history"; rows: StreamRow[] }
	| { t: "viewport"; rows: StreamRow[] }
	| { t: "patch"; ops: [index: number, row: StreamRow][]; rows: number }
	| { t: "reset" }
	| { t: "paused"; paused: boolean };

/** Streamer → session. `welcome` answers `hello`; `bye` precedes an orderly close. */
export type StreamStreamerFrame =
	| { t: "welcome"; proto: number; channel: string; url: string }
	| { t: "viewers"; n: number }
	| { t: "chat"; msg: StreamChatMessage }
	| { t: "bye"; reason: string };

/** Encode one frame for the newline-delimited socket. */
export function encodeStreamFrame(frame: StreamSessionFrame | StreamStreamerFrame): string {
	return `${JSON.stringify(frame)}\n`;
}
