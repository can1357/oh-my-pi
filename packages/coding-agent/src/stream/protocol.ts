/**
 * Local protocol between an interactive session and the `omp stream` process
 * in the same working directory.
 *
 * Transport: newline-delimited JSON over the native IPC endpoint at
 * {@link streamSocketEndpoint}. The streamer assigns each connected session a
 * wire pane id and forwards the session's frames as `StreamPaneFrame`s; the
 * session never learns about other panes or the stream server.
 *
 * Rows are already normalized and redacted when they cross this socket (see
 * `paint-encoder.ts`); the streamer is a pure multiplexer. The same screen
 * frames are persisted by session recordings (`recording.ts`).
 */
import { type } from "@oh-my-pi/omptype";
import { STREAM_HISTORY_LIMIT, type StreamChatMessage, type StreamRow } from "@oh-my-pi/pi-wire";

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

/** Screen-content frames: everything a session emits after `hello` except the pause flag. */
export type StreamScreenFrame = Exclude<StreamSessionFrame, { t: "hello" } | { t: "paused" }>;

/** Materialized screen of one session: bounded scrollback plus the live viewport. */
export interface StreamScreen {
	cols: number;
	rows: number;
	history: StreamRow[];
	viewport: StreamRow[];
}

/** Streamer → session. `welcome` answers `hello`; `bye` precedes an orderly close. */
export type StreamStreamerFrame =
	| { t: "welcome"; proto: number; channel: string; url: string }
	| { t: "viewers"; n: number }
	| { t: "chat"; msg: StreamChatMessage }
	| { t: "bye"; reason: string };

/** Longest line the streamer accepts from a session; a peer exceeding it is dropped. */
export const MAX_LOCAL_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Apply one screen frame to a materialized screen. Shared by the streamer's
 * reconnect-replay state and recording playback so both reconstruct identical
 * screens from the same frame sequence.
 */
export function applyScreenFrame(screen: StreamScreen, frame: StreamScreenFrame): void {
	switch (frame.t) {
		case "resize":
			screen.cols = frame.cols;
			screen.rows = frame.rows;
			fitViewport(screen.viewport, frame.rows);
			break;
		case "history": {
			const overflow = screen.history.length + frame.rows.length - STREAM_HISTORY_LIMIT;
			if (overflow >= screen.history.length) {
				screen.history = frame.rows.slice(-STREAM_HISTORY_LIMIT);
			} else {
				if (overflow > 0) screen.history.splice(0, overflow);
				screen.history.push(...frame.rows);
			}
			break;
		}
		case "viewport":
			screen.viewport = frame.rows.slice();
			break;
		case "patch":
			screen.rows = frame.rows;
			fitViewport(screen.viewport, frame.rows);
			for (const [index, row] of frame.ops) {
				if (index >= 0 && index < frame.rows) screen.viewport[index] = row;
			}
			break;
		case "reset":
			screen.history = [];
			screen.viewport = [];
			break;
	}
}

function fitViewport(viewport: StreamRow[], rows: number): void {
	if (viewport.length > rows) viewport.length = rows;
	while (viewport.length < rows) viewport.push("");
}

/** Non-negative integer terminal dimension. */
const Dimension = type("number.integer >= 0");

const SessionFrame = type({
	t: "'hello'",
	proto: "number.integer",
	sessionId: "string",
	title: "string",
	cols: Dimension,
	rows: Dimension,
})
	.or({ t: "'resize'", cols: Dimension, rows: Dimension })
	.or({ t: "'history' | 'viewport'", rows: "string[]" })
	.or({ t: "'patch'", rows: Dimension, ops: type(["number.integer", "string"]).array() })
	.or({ t: "'reset'" })
	.or({ t: "'paused'", paused: "boolean" });

/** Structural validation of an untrusted session frame (socket peer or recording file). */
export function isSessionFrame(value: unknown): value is StreamSessionFrame {
	return SessionFrame.allows(value);
}

/** Non-negative integer terminal dimension. */
export function isDimension(value: unknown): value is number {
	return Dimension.allows(value);
}
