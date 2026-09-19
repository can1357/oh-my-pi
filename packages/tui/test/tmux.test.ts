import { describe, expect, it } from "bun:test";
import { parseTmuxClientTermtype, resolveTmuxClientTerminal } from "../src/tmux";

describe("parseTmuxClientTermtype", () => {
	it("splits a client's terminal-type reply into name and version", () => {
		// tmux stores the payload of the client's `CSI > 0 q` reply verbatim, and
		// emulators answer in one of two shapes — space-separated (`WezTerm …`,
		// `iTerm2 …`, `ghostty …`) or parenthesized (`XTerm(370)`, `kitty(…)`).
		expect(parseTmuxClientTermtype("WezTerm 20260905-175422-0f4b5596")).toEqual({
			name: "WezTerm",
			version: "20260905-175422-0f4b5596",
		});
		expect(parseTmuxClientTermtype("iTerm2 3.5.0\n")).toEqual({ name: "iTerm2", version: "3.5.0" });
		expect(parseTmuxClientTermtype("kitty(0.31.0)")).toEqual({ name: "kitty", version: "0.31.0" });
		expect(parseTmuxClientTermtype("WezTerm")).toEqual({ name: "WezTerm", version: null });
	});

	it("yields nothing for replies that carry no identity", () => {
		// "if available": clients that never answered, tmux releases that expand
		// the unknown format to an empty string, and payloads that carry no
		// leading name all have to leave detection alone.
		expect(parseTmuxClientTermtype(undefined)).toBeNull();
		expect(parseTmuxClientTermtype("")).toBeNull();
		expect(parseTmuxClientTermtype("  \n")).toBeNull();
		expect(parseTmuxClientTermtype("(0.31.0)")).toBeNull();
	});
});

describe("resolveTmuxClientTerminal", () => {
	it("skips the probe without a tmux session and under the test runner", () => {
		expect(resolveTmuxClientTerminal({})).toBeNull();
		expect(resolveTmuxClientTerminal({ TERM: "tmux-256color" })).toBeNull();
		// The suite must never shell out: its synthetic envs and the developer's
		// own tmux session would otherwise decide detection results. The probe
		// itself is covered next to the other TERMINAL_ID subprocess tests.
		expect(resolveTmuxClientTerminal({ TMUX: "/tmp/tmux-1000/default,4242,0" })).toBeNull();
	});
});
