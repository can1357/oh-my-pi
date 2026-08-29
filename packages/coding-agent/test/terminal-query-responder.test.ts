import { describe, expect, it } from "bun:test";
import { TerminalQueryResponder } from "@oh-my-pi/pi-coding-agent/exec/terminal-query-responder";

/**
 * The `!`/`!!` user-shell PTY advertises `TERM=xterm-256color`, so probing
 * tools (`gh` via termenv) emit terminal queries and block on the reply. The
 * responder must answer those queries so the tool proceeds instead of waiting
 * out its timeout (issue #10214), while leaving ordinary output untouched so
 * injected bytes never corrupt the shell's stdin.
 */
describe("TerminalQueryResponder", () => {
	it("answers a cursor-position query (the terminator gh's probe waits on)", () => {
		expect(new TerminalQueryResponder().feed("\x1b[6n")).toBe("\x1b[1;1R");
	});

	it("answers device-status, primary and secondary device-attribute queries", () => {
		const r = new TerminalQueryResponder();
		expect(r.feed("\x1b[5n")).toBe("\x1b[0n");
		expect(r.feed("\x1b[c")).toBe("\x1b[?1;2c");
		expect(r.feed("\x1b[0c")).toBe("\x1b[?1;2c");
		expect(r.feed("\x1b[>c")).toBe("\x1b[>0;10;1c");
	});

	it("answers OSC background/foreground color queries, echoing the terminator", () => {
		const r = new TerminalQueryResponder();
		// BEL-terminated request → BEL-terminated reply.
		expect(r.feed("\x1b]11;?\x07")).toBe("\x1b]11;rgb:0000/0000/0000\x07");
		// ST-terminated request → ST-terminated reply.
		expect(r.feed("\x1b]10;?\x1b\\")).toBe("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
	});

	it("reassembles a query split across chunk boundaries", () => {
		const r = new TerminalQueryResponder();
		expect(r.feed("output\x1b[")).toBe("");
		expect(r.feed("6n")).toBe("\x1b[1;1R");
	});

	it("concatenates replies for the OSC + cursor probe pair gh emits together", () => {
		expect(new TerminalQueryResponder().feed("\x1b]11;?\x07\x1b[6n")).toBe("\x1b]11;rgb:0000/0000/0000\x07\x1b[1;1R");
	});

	it("stays silent on ordinary output so it never injects into the shell", () => {
		const r = new TerminalQueryResponder();
		// SGR color, cursor movement, and plain text are not queries.
		expect(r.feed("\x1b[31mred\x1b[0m\x1b[2Aplain text\n")).toBe("");
	});
});
