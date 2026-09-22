/**
 * Wire types for `omp stream`: Twitch-style live screen sharing at
 * `live.omp.sh/<username>`.
 *
 * Independent from collab. A publisher (`omp stream`) sends plaintext JSON
 * screen deltas for one or more panes (one pane per omp session attached in
 * the same working directory); the stream server materializes each pane
 * (viewport + bounded history) so late viewers receive a snapshot without
 * touching the publisher, fans frames out to viewers, and hosts chat.
 *
 * Rows are terminal lines carrying only SGR and OSC 8 escapes; the publisher
 * strips every other sequence, truncates to the pane width, and redacts
 * secrets before a row leaves the session process.
 */

/** Default stream server; its host route derives the channel from the bearer identity. */
export const DEFAULT_STREAM_URL = "https://live.omp.sh";

/** Protocol version carried in `hello`/`snapshot`; the server rejects mismatches. */
export const STREAM_PROTO = 1;

/** Channel names are Stencil usernames: lowercase letters, numbers, and underscores; 3–32 chars. */
export const STREAM_CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_]{2,31}$/;

/** Longest accepted stream and pane title. */
export const STREAM_TITLE_MAX = 120;
/** Longest accepted chat display name. */
export const STREAM_CHAT_NAME_MAX = 24;
/** Longest accepted chat message. */
export const STREAM_CHAT_TEXT_MAX = 500;
/** History rows the server retains per pane; older rows fall off the top. */
export const STREAM_HISTORY_LIMIT = 2000;

/** One terminal row: ANSI text limited to SGR + OSC 8, width-truncated. */
export type StreamRow = string;

/**
 * Per-pane screen deltas. `pane` ids are assigned by the publisher and are
 * unique for the lifetime of one host connection.
 *
 * - `history` appends rows committed above the viewport (append-only).
 * - `viewport` replaces the whole live viewport.
 * - `patch` rewrites individual viewport rows; `rows` is the new viewport
 *   length (shrinks drop trailing rows, growth fills with empty rows before
 *   ops apply).
 * - `reset` clears history and viewport (the session cleared its screen).
 */
export type StreamPaneFrame =
	| { t: "pane-open"; pane: number; title: string; cols: number; rows: number }
	| { t: "pane-close"; pane: number }
	| { t: "resize"; pane: number; cols: number; rows: number }
	| { t: "history"; pane: number; rows: StreamRow[] }
	| { t: "viewport"; pane: number; rows: StreamRow[] }
	| { t: "patch"; pane: number; ops: [index: number, row: StreamRow][]; rows: number }
	| { t: "reset"; pane: number }
	| { t: "paused"; pane: number; paused: boolean };

/** Publisher → server. `hello` is the first frame on the socket. */
export type StreamHostFrame =
	| { t: "hello"; proto: number; title: string }
	| { t: "title"; title: string }
	/** Message typed by the streamer; broadcast with `host: true`. */
	| { t: "chat"; text: string }
	| StreamPaneFrame;

export interface StreamChatMessage {
	/** Monotonic per channel-session; viewers use it for de-duplication. */
	id: number;
	name: string;
	text: string;
	/** Unix milliseconds. */
	ts: number;
	/** Set when the streamer sent it. */
	host?: boolean;
}

/** Server → publisher. */
export type StreamServerToHost =
	/** `user` is the stencil.so username the bearer resolved to; shown as the host's chat name. */
	| { t: "welcome"; proto: number; channel: string; url: string; user?: string }
	| { t: "viewers"; n: number }
	| { t: "chat"; msg: StreamChatMessage }
	| { t: "error"; message: string };

/** Directory entry served by `GET /api/channels` and `GET /api/channels/<name>`. */
export interface StreamChannelInfo {
	name: string;
	title: string;
	live: boolean;
	viewers: number;
	panes: number;
	/** stencil.so username of the channel owner (the first authenticated host). */
	owner?: string;
	/** Unix milliseconds of the current live session; absent when offline. */
	startedAt?: number;
}

/** Materialized pane state delivered to a joining viewer. */
export interface StreamPaneSnapshot {
	id: number;
	title: string;
	cols: number;
	rows: number;
	history: StreamRow[];
	viewport: StreamRow[];
	paused: boolean;
}

/**
 * Server → viewer. `snapshot` is the first frame after connect and again
 * whenever the publisher reconnects; `offline` means the publisher left and
 * the viewer should keep the socket open for the next `snapshot`.
 */
export type StreamServerToViewer =
	| {
			t: "snapshot";
			proto: number;
			channel: StreamChannelInfo;
			panes: StreamPaneSnapshot[];
			chat: StreamChatMessage[];
	  }
	| { t: "offline" }
	| { t: "title"; title: string }
	| { t: "viewers"; n: number }
	| { t: "chat"; msg: StreamChatMessage }
	| StreamPaneFrame;

/** Viewer → server. The display name travels with each message until accounts exist. */
export type StreamViewerFrame = { t: "chat"; name: string; text: string };

/** WebSocket close codes used by the stream server. */
export const STREAM_CLOSE_HOST_CONFLICT = 4009;
export const STREAM_CLOSE_BAD_CHANNEL = 4004;
export const STREAM_CLOSE_PROTO_MISMATCH = 4010;
/** Host bearer token missing, expired, or not issued by the stencil.so issuer. */
export const STREAM_CLOSE_UNAUTHORIZED = 4401;
/** Channel is owned by a different stencil.so account. */
export const STREAM_CLOSE_FORBIDDEN = 4403;

/** Provider id under which `/login` stores the stencil.so credential; `STENCIL_API_KEY` overrides it. */
export const STREAM_AUTH_PROVIDER = "stencil";
export const STREAM_AUTH_ENV = "STENCIL_API_KEY";

/** HTTP/WS route layout of the stream server, relative to `DEFAULT_STREAM_URL`. */
export const STREAM_ROUTES = {
	channels: "/api/channels",
	channel: (name: string) => `/api/channels/${name}`,
	/** The server derives the host channel from the authenticated username. */
	host: "/ws/host",
	watch: (name: string) => `/ws/watch/${name}`,
	page: (name: string) => `/${name}`,
} as const;
