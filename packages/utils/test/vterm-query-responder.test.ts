import { describe, expect, test } from "bun:test";
import { TerminalQueryResponder } from "../src/vterm";

/**
 * Programs on a headless PTY block until their capability probes are answered.
 * The responder must reply to the blocking query forms and stay silent on
 * ordinary output, since every reply is written into the program's stdin.
 */
describe("TerminalQueryResponder", () => {
	test("answers cursor position, device status, and device attribute queries", () => {
		const responder = new TerminalQueryResponder();
		expect(responder.feed("\x1b[6n")).toBe("\x1b[1;1R");
		expect(responder.feed("\x1b[5n")).toBe("\x1b[0n");
		expect(responder.feed("\x1b[c")).toBe("\x1b[?1;2c");
		expect(responder.feed("\x1b[0c")).toBe("\x1b[?1;2c");
		expect(responder.feed("\x1b[>c")).toBe("\x1b[>0;10;1c");
	});

	test("answers OSC color queries with the requester's terminator", () => {
		const responder = new TerminalQueryResponder();
		expect(responder.feed("\x1b]11;?\x07")).toBe("\x1b]11;rgb:0000/0000/0000\x07");
		expect(responder.feed("\x1b]10;?\x1b\\")).toBe("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
	});

	test("reassembles a query split across output chunks", () => {
		const responder = new TerminalQueryResponder();
		expect(responder.feed("prompt> \x1b[")).toBe("");
		expect(responder.feed("6n")).toBe("\x1b[1;1R");
	});

	test("replies in query order when one chunk carries several probes", () => {
		expect(new TerminalQueryResponder().feed("\x1b]11;?\x07\x1b[6n")).toBe("\x1b]11;rgb:0000/0000/0000\x07\x1b[1;1R");
	});

	test("stays silent on styling, cursor movement, private DSR forms, and plain text", () => {
		const responder = new TerminalQueryResponder();
		expect(responder.feed("\x1b[31mred\x1b[0m\x1b[2A\x1b[?6n\x1b[=cplain\n")).toBe("");
		expect(responder.feed("more plain output\n")).toBe("");
	});
});
