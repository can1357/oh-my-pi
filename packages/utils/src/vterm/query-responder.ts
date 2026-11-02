/**
 * Options for {@link TerminalQueryResponder}.
 */
export interface TerminalQueryResponderOptions {
	/**
	 * The PTY host opens the session with its own cursor-position query
	 * (`CSI 6 n`), which the PTY layer has already answered — ConPTY's
	 * `PSEUDOCONSOLE_INHERIT_CURSOR` handshake. Leave that first cursor query
	 * unanswered: the host consumes exactly one report, so a second one would
	 * reach the program as input it never asked for. Every later cursor query
	 * is answered. Defaults to `false`.
	 */
	hostCursorHandshake?: boolean;
}

/**
 * Answers terminal capability queries emitted by programs on a headless PTY.
 *
 * A PTY that advertises `TERM=xterm-256color` but has no terminal behind it
 * leaves capability probes unanswered: a program writes a query escape to
 * stdout and blocks on stdin until the reply arrives (or its timeout expires,
 * seconds later). This scanner watches raw PTY output for the standard queries
 * and returns the bytes a real xterm-class terminal would send back, so the
 * caller can write them into the PTY. It keeps no screen state — cursor
 * position reports are answered with the home position — which makes it cheap
 * enough to run on every byte of a long-lived supervised process. Use the full
 * {@link Terminal} when the caller also renders the output.
 *
 * Queries can straddle chunk boundaries, so an unfinished trailing escape is
 * carried into the next {@link feed}.
 */
export class TerminalQueryResponder {
	/** Trailing bytes that may be the start of an unfinished query escape. */
	#residual = "";
	/** Whether the next cursor query is the host's already-answered session-start handshake. */
	#hostCursorHandshakePending: boolean;

	constructor(options: TerminalQueryResponderOptions = {}) {
		this.#hostCursorHandshakePending = options.hostCursorHandshake ?? false;
	}

	/**
	 * Feed one raw PTY output chunk. Returns the reply bytes to write back into
	 * the PTY, or an empty string when the chunk held no answerable query.
	 */
	feed(chunk: string): string {
		const buffer = this.#residual + chunk;
		let replies = "";
		let lastEnd = 0;
		QUERY.lastIndex = 0;
		for (let match = QUERY.exec(buffer); match !== null; match = QUERY.exec(buffer)) {
			lastEnd = match.index + match[0].length;
			const reply = replyFor(match);
			if (reply === CURSOR_POSITION_REPORT && this.#hostCursorHandshakePending) {
				this.#hostCursorHandshakePending = false;
				continue;
			}
			replies += reply;
		}
		// Keep only a short unmatched trailing escape: a query split across
		// chunks completes on the next feed, while a long tail is ordinary output
		// that can never become a query.
		const tailEscape = buffer.lastIndexOf("\x1b");
		this.#residual =
			tailEscape >= lastEnd && buffer.length - tailEscape <= MAX_PARTIAL_QUERY ? buffer.slice(tailEscape) : "";
		return replies;
	}
}

/** Cursor position report for the home position: there is no screen to locate the cursor on. */
const CURSOR_POSITION_REPORT = "\x1b[1;1R";

/** Longest query escape we answer, bounding the cross-chunk residual. */
const MAX_PARTIAL_QUERY = 32;

/**
 * CSI DSR/DA queries (final byte `n` or `c`) and OSC 10/11 color queries. Only
 * forms with canned answers are matched; everything else stays plain output.
 */
const QUERY = /\x1b\[([?>=]?)([0-9;]*)([nc])|\x1b\](10|11);\?(\x07|\x1b\\)/gu;

/** Reply a real xterm-class terminal would send for one matched query. */
function replyFor(match: RegExpExecArray): string {
	const final = match[3];
	if (final !== undefined) {
		const intermediate = match[1];
		const params = match[2] ?? "";
		if (final === "c") {
			if (intermediate === ">") return "\x1b[>0;10;1c"; // secondary DA: VT100-class, firmware 10
			if (intermediate === "" || intermediate === "0") return "\x1b[?1;2c"; // primary DA: VT100 with AVO
			return ""; // tertiary (`=`) DA has no widely expected reply
		}
		if (intermediate !== "") return ""; // private DSR forms (DECXCPR, appearance) stay unanswered
		const selector = params.split(";", 1)[0];
		if (selector === "6") return CURSOR_POSITION_REPORT;
		if (selector === "5") return "\x1b[0n"; // device status: OK
		return "";
	}
	// OSC color queries: neutral colors, terminated the way the request was.
	const selector = match[4];
	const terminator = match[5] ?? "\x07";
	if (selector === "10") return `\x1b]10;rgb:ffff/ffff/ffff${terminator}`; // foreground
	if (selector === "11") return `\x1b]11;rgb:0000/0000/0000${terminator}`; // background
	return "";
}
