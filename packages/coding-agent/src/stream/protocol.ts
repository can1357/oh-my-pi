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
 * `paint-encoder.ts`); the streamer is a pure multiplexer. The same screen
 * frames are persisted by session recordings (`recording.ts`).
 */
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

/** Encode one frame for the newline-delimited socket. */
export function encodeStreamFrame(frame: StreamSessionFrame | StreamStreamerFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

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

/** Structural validation of an untrusted session frame (socket peer or recording file). */
export function isSessionFrame(value: unknown): value is StreamSessionFrame {
	if (!value || typeof value !== "object" || !("t" in value) || typeof value.t !== "string") return false;
	const frame = value as Record<string, unknown>;
	switch (frame.t) {
		case "hello":
			return (
				typeof frame.proto === "number" &&
				Number.isInteger(frame.proto) &&
				typeof frame.sessionId === "string" &&
				typeof frame.title === "string" &&
				isDimension(frame.cols) &&
				isDimension(frame.rows)
			);
		case "resize":
			return isDimension(frame.cols) && isDimension(frame.rows);
		case "history":
		case "viewport":
			return Array.isArray(frame.rows) && frame.rows.every(row => typeof row === "string");
		case "patch":
			return (
				isDimension(frame.rows) &&
				Array.isArray(frame.ops) &&
				frame.ops.every(
					op =>
						Array.isArray(op) &&
						op.length === 2 &&
						typeof op[0] === "number" &&
						Number.isInteger(op[0]) &&
						typeof op[1] === "string",
				)
			);
		case "reset":
			return true;
		case "paused":
			return typeof frame.paused === "boolean";
		default:
			return false;
	}
}

/** Non-negative integer terminal dimension. */
export function isDimension(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
