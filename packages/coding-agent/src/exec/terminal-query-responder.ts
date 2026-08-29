/**
 * Answers terminal capability queries emitted by programs running on OMP's
 * headless user-shell PTY (the `!` / `!!` hotkey path).
 *
 * The PTY advertises `TERM=xterm-256color`, so stdout is a TTY and
 * capability-probing tools (`gh` via termenv, anything issuing terminfo
 * cursor/device-attribute probes) write a query escape to stdout and block
 * until the terminal replies on stdin. Nothing on the OMP side plays terminal,
 * so those tools wait out their full response timeout — the ~5s `pselect6()`
 * stall in issue #10214.
 *
 * This scanner watches the raw PTY output for the standard queries and returns
 * the replies a real terminal would send, so the caller writes them back into
 * the PTY. Queries can straddle chunk boundaries, so an unfinished trailing
 * escape is buffered until the next chunk completes it.
 */
export class TerminalQueryResponder {
	/** Trailing bytes that may be the start of an unfinished query escape. */
	#residual = "";

	/**
	 * Feed one raw PTY output chunk. Returns the reply bytes to write back to
	 * the PTY, or an empty string when the chunk held no answerable query.
	 */
	feed(chunk: string): string {
		const buf = this.#residual + chunk;
		let responses = "";
		let lastEnd = 0;
		QUERY.lastIndex = 0;
		for (let m = QUERY.exec(buf); m !== null; m = QUERY.exec(buf)) {
			lastEnd = m.index + m[0].length;
			responses += replyFor(m);
		}
		// Keep only a short unmatched trailing escape as residual: a query split
		// across chunks completes on the next feed, while a long tail is ordinary
		// output that will never become a query.
		const tailEsc = buf.lastIndexOf("\x1b");
		this.#residual = tailEsc >= lastEnd && buf.length - tailEsc <= MAX_PARTIAL_QUERY ? buf.slice(tailEsc) : "";
		return responses;
	}
}

/** Longest query escape we answer, bounding the cross-chunk residual buffer. */
const MAX_PARTIAL_QUERY = 32;

// CSI DSR/DA queries (ending in `n` or `c`) and OSC 10/11 color queries. Only
// the forms with canned answers are matched; anything else stays plain output.
const QUERY = /\x1b\[([?>=]?)([0-9;]*)([nc])|\x1b\](10|11);\?(\x07|\x1b\\)/gu;

/** Map a matched query to the reply a real xterm-class terminal would send. */
function replyFor(m: RegExpExecArray): string {
	const final = m[3];
	if (final !== undefined) {
		const intermediate = m[1];
		const params = m[2] ?? "";
		if (final === "c") {
			// Device attributes.
			if (intermediate === ">") return "\x1b[>0;10;1c"; // secondary DA
			if (intermediate === "" || intermediate === "0") return "\x1b[?1;2c"; // primary DA (VT100 + AVO)
			return ""; // tertiary (`=`) DA has no widely-expected reply
		}
		// Device status report.
		if (intermediate !== "") return "";
		const ps = params.split(";", 1)[0];
		if (ps === "6") return "\x1b[1;1R"; // cursor position report
		if (ps === "5") return "\x1b[0n"; // terminal OK
		return "";
	}
	// OSC color queries: hand back neutral colors so probes resolve instead of
	// blocking. The terminator is echoed to match the requester's framing.
	const selector = m[4];
	const terminator = m[5] ?? "\x07";
	if (selector === "10") return `\x1b]10;rgb:ffff/ffff/ffff${terminator}`; // foreground
	if (selector === "11") return `\x1b]11;rgb:0000/0000/0000${terminator}`; // background
	return "";
}
