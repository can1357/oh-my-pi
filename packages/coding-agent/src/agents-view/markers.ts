/**
 * In-band control markers between an attach client and a hosted session, carried on
 * the daemon PTY tunnel itself (no side channel):
 *
 * - attach (client → hosted, PTY input): `ESC _ omp-attach ; <token> ; <base64 JSON> ESC \`,
 *   an APC naming the viewer terminal. The hosted TUI's input layer consumes it
 *   (`ProcessTerminal.onAttachMarker`) and restarts its terminal against that viewer.
 * - detach (hosted → client, PTY output): `ESC ] 7799 ; omp-detach ; <token> BEL`, written
 *   after the hosted TUI handed the viewer's terminal back. The client strips it and stops.
 *
 * Both carry the hosted process's attach token (random per process, published only in
 * its private status record), so a marker that reaches the other side as content (a
 * paste, a program printing the bytes) does nothing.
 */
import { OMP_ATTACH_APC_PREFIX } from "@oh-my-pi/pi-tui/terminal";
import { classifyTerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";

/**
 * Environment variables terminal capability detection reads to identify the viewer
 * (emulator markers, version and feature hints, remote login). Multiplexer session
 * markers are not among them: they name control sockets of the viewer's machine and
 * travel normalized as {@link ViewerIdentity.multiplexer}.
 */
export const VIEWER_ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERM_FEATURES",
	"COLORTERM",
	"LC_TERMINAL",
	"LC_TERMINAL_VERSION",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"VSCODE_PID",
	"ALACRITTY_WINDOW_ID",
	"WT_SESSION",
	"PASEO_TERMINAL_ID",
	"SSH_CONNECTION",
	"SSH_CLIENT",
	"SSH_TTY",
] as const;

/** The viewer terminal an attach client reports, so the hosted TUI renders for it. */
export interface ViewerIdentity {
	/** The viewer's values of {@link VIEWER_ENV_KEYS}; absent keys are unset for it. */
	env: Record<string, string>;
	/** Multiplexer the viewer runs inside (`tmux`, `screen`, …), as classification names it. */
	multiplexer?: string;
	cols: number;
	rows: number;
}

const DETACH_PREFIX = "\x1b]7799;omp-detach;";
const DETACH_TERMINATOR = "\x07";
const APC_TERMINATOR = "\x1b\\";
/** Tokens are `crypto.randomUUID()` strings. */
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Identity strings are environment values: printable ASCII only, bounded. */
const IDENTITY_VALUE = /^[\x21-\x7e][\x20-\x7e]{0,255}$/;
const MULTIPLEXER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_DIMENSION = 10_000;
const VIEWER_ENV_KEY_SET: ReadonlySet<string> = new Set(VIEWER_ENV_KEYS);

/** A fresh attach token for this hosted process. */
export function newAttachToken(): string {
	return crypto.randomUUID();
}

/** Whether `token` has the shape {@link newAttachToken} produces. */
export function isAttachToken(token: string): boolean {
	return TOKEN_PATTERN.test(token);
}

/** The viewer identity of this process's terminal. */
export function viewerIdentityFromEnv(env: NodeJS.ProcessEnv, cols: number, rows: number): ViewerIdentity {
	const viewerEnv: Record<string, string> = {};
	for (const name of VIEWER_ENV_KEYS) {
		const value = env[name];
		if (value !== undefined && IDENTITY_VALUE.test(value)) viewerEnv[name] = value;
	}
	const multiplexer = classifyTerminalMultiplexer(env) ?? undefined;
	return { env: viewerEnv, ...(multiplexer ? { multiplexer } : {}), cols, rows };
}

/** Encode the attach APC for `viewer`. The base64 payload keeps the APC free of ESC/BEL/ST bytes. */
export function encodeAttachMarker(token: string, viewer: ViewerIdentity): string {
	const payload = Buffer.from(JSON.stringify(viewer), "utf8").toString("base64");
	return `${OMP_ATTACH_APC_PREFIX}${token};${payload}${APC_TERMINATOR}`;
}

function dimension(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION
		? value
		: undefined;
}

/**
 * Parse an attach APC payload (the bytes between `omp-attach;` and ST) addressed to
 * `token`. Undefined when the token differs or the identity is invalid; unusable or
 * unknown identity variables are dropped individually, since a viewer without e.g.
 * `TERM_PROGRAM` is ordinary.
 */
export function parseAttachPayload(payload: string, token: string): ViewerIdentity | undefined {
	const separator = payload.indexOf(";");
	if (separator < 0 || payload.slice(0, separator) !== token || !isAttachToken(token)) return undefined;
	const body = payload.slice(separator + 1);
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	const cols = dimension(record.cols);
	const rows = dimension(record.rows);
	if (cols === undefined || rows === undefined) return undefined;
	const env: Record<string, string> = {};
	if (typeof record.env === "object" && record.env !== null) {
		for (const [name, value] of Object.entries(record.env)) {
			if (VIEWER_ENV_KEY_SET.has(name) && typeof value === "string" && IDENTITY_VALUE.test(value)) env[name] = value;
		}
	}
	const multiplexer =
		typeof record.multiplexer === "string" && MULTIPLEXER_ID.test(record.multiplexer)
			? record.multiplexer
			: undefined;
	return { env, ...(multiplexer ? { multiplexer } : {}), cols, rows };
}

/** Detach marker the hosted session with attach token `token` writes to its PTY output. */
export function encodeDetachMarker(token: string): string {
	return `${DETACH_PREFIX}${token}${DETACH_TERMINATOR}`;
}

const EMPTY = Buffer.alloc(0);

/** What {@link DetachMarkerMatcher.feed} lets through, and whether the marker was seen. */
export interface DetachScan {
	output: Uint8Array;
	detached: boolean;
}

/**
 * Split-safe scanner for one session's detach marker over the tunnel's output bytes.
 * Chunk boundaries follow the PTY and socket, not the hosted writes, so a marker may
 * arrive in any number of pieces: a chunk tail that could still begin the marker is
 * held back until the next chunk decides it. Bytes before the marker pass through;
 * the marker and everything after it are dropped (the hosted TUI already handed the
 * viewer's terminal back, so later output is not for this viewer). A detach marker
 * with another token is ordinary output and passes through.
 */
export class DetachMarkerMatcher {
	readonly #marker: Buffer;
	#held: Buffer = EMPTY;
	#detached = false;

	constructor(token: string) {
		this.#marker = Buffer.from(encodeDetachMarker(token), "latin1");
	}

	get detached(): boolean {
		return this.#detached;
	}

	feed(chunk: Uint8Array): DetachScan {
		if (this.#detached) return { output: EMPTY, detached: true };
		const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const data = this.#held.length > 0 ? Buffer.concat([this.#held, incoming]) : incoming;
		this.#held = EMPTY;
		const index = data.indexOf(this.#marker);
		if (index >= 0) {
			this.#detached = true;
			return { output: data.subarray(0, index), detached: true };
		}
		const keep = this.#partialMarkerSuffix(data);
		if (keep === 0) return { output: data, detached: false };
		// Copy: `incoming` may alias a buffer the caller reuses.
		this.#held = Buffer.from(data.subarray(data.length - keep));
		return { output: data.subarray(0, data.length - keep), detached: false };
	}

	/** Length of the longest tail of `data` that is a proper prefix of the marker. */
	#partialMarkerSuffix(data: Buffer): number {
		const marker = this.#marker;
		const max = Math.min(marker.length - 1, data.length);
		for (let length = max; length > 0; length--) {
			if (data[data.length - length] !== 0x1b) continue;
			if (data.compare(marker, 0, length, data.length - length, data.length) === 0) return length;
		}
		return 0;
	}
}
