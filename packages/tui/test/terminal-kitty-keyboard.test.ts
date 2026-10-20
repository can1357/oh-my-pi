import { afterEach, describe, expect, it } from "bun:test";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

// Kitty keyboard negotiation must arm the terminal in the same write as the
// query it asks. `CSI ? u` alone leaves the terminal unarmed, and an unarmed
// terminal keeps encoding Shift+Enter as a bare CR that omp reads as submit
// instead of a newline (#12411).
//
// The query comes first in that write, so the terminal answers it before omp's
// push is applied: the reply describes the flags a parent application pushed,
// and omp's own frame is the top of the kitty stack. Every push omp makes must
// be matched by exactly one pop — a frame left behind keeps the terminal
// reporting kitty keys after omp exits.

const KITTY_PUSH = /\x1b\[>\d+u/g;
const KITTY_POP = /\x1b\[<u/g;

function countMatches(haystack: string, pattern: RegExp): number {
	return [...haystack.matchAll(pattern)].length;
}

describe("ProcessTerminal kitty keyboard arming", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	it("arms the terminal in the same write as the query", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		// The query precedes the push on purpose: the terminal answers it
		// before the push is applied, so the reply still describes the flags a
		// parent application pushed and omp's own frame is the stack top.
		expect(harness.writes.join("")).toContain("\x1b[?u\x1b[>5u\x1b[c");
	});

	it("arms ConPTY hosts with disambiguation only", async () => {
		// ConPTY drops Shift+letter keypresses when flag 4 (report alternate
		// keys) is set, so the arming push asks for disambiguation only.
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: true });
		await harness.settle();

		expect(harness.writes.join("")).toContain("\x1b[?u\x1b[>1u\x1b[c");
	});

	it("arms the terminal before the negotiation reply arrives", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		// The reply has not come back yet, but the terminal is already armed:
		// a Shift+Enter pressed in the meantime arrives as `CSI 13;2u` instead
		// of a bare CR.
		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(harness.writes.join("")).toContain("\x1b[>5u");
	});

	it("pops the arming frame when the terminal never answers the query", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		harness.writes.length = 0;

		// Only the DA1 sentinel comes back: the terminal never confirmed the
		// arming push, so omp takes its frame back off the kitty stack instead
		// of leaving the terminal reporting kitty keys it cannot decode.
		await harness.feed("\x1b[?1;2c");

		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(harness.writes.join("")).toContain("\x1b[<u");
	});

	it("raises its own frame to keep a parent application's event-type reporting", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		harness.writes.length = 0;

		// The parent application pushed flags = 3 (event types). The reply
		// describes the parent's frame, so omp's own frame — which sits above
		// it — is raised in place instead of pushing a second frame.
		await harness.feed("\x1b[?3u");

		expect(harness.terminal.kittyEnableSequence).toBe("\x1b[>7u");
		const out = harness.writes.join("");
		expect(out).toContain("\x1b[=7;1u");
		expect(out).not.toContain("\x1b[>7u");
	});

	it.each([
		{ host: "a fresh terminal", reply: "\x1b[?0u" },
		{ host: "a parent application", reply: "\x1b[?3u" },
	])("keeps the kitty stack balanced with $host", async ({ reply }) => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		const writes = harness.writes;

		await harness.feed(reply, "\x1b[?1;2c");

		// The exit path takes omp's frame back off the kitty stack.
		harness.dispose();
		harness = undefined;

		const out = writes.join("");
		// Every push omp made must be matched by exactly one pop: a frame left
		// behind keeps the terminal reporting kitty keys after omp exits.
		expect(countMatches(out, KITTY_PUSH)).toBe(countMatches(out, KITTY_POP));
		// One push (the arming) and one pop (on exit) — a parent application's
		// frame is neither pushed over nor popped.
		expect(countMatches(out, KITTY_PUSH)).toBe(1);
	});
});
