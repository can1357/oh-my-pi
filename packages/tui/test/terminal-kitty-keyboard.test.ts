import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
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
//
// Kitty keeps the keyboard-mode stack per screen and swaps it when the
// alternate screen is entered or left, so a frame can only be popped while its
// own screen is the active one.

const KITTY_PUSH = /\x1b\[>\d+u/g;
const KITTY_POP = /\x1b\[<u/g;

function countMatches(haystack: string, pattern: RegExp): number {
	return [...haystack.matchAll(pattern)].length;
}

class ModalProbe implements Component {
	invalidate(): void {}
	render(): string[] {
		return ["modal"];
	}
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

	it("asks for the flags before it arms the terminal, so the reply carries the parent's flags", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		// The query has to come first in the same write: the terminal answers
		// it while it parses that sequence, before the push that follows it is
		// applied. The reply therefore describes the flags that were in effect
		// before omp's own frame overwrote the stack top — a parent
		// application's flags. With the push first, the reply would report
		// omp's own arming level and the parent's event-type reporting would
		// be lost.
		const out = harness.writes.join("");
		expect(out.indexOf("\x1b[?u")).toBeGreaterThanOrEqual(0);
		expect(out.indexOf("\x1b[?u")).toBeLessThan(out.indexOf("\x1b[>5u"));
	});

	it("keeps the arming frame on its own screen when an overlay is entered before the probe resolves", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		// The arming frame is on the main screen: the push went out with the
		// negotiation, before the overlay existed.
		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[?1049h");
		harness.writes.length = 0;

		// The terminal answers the DA1 sentinel but never the kitty query, so
		// the unconfirmed arming frame comes due while the alternate screen is
		// active.
		await harness.feed("\x1b[?1;2c");

		// Kitty's keyboard-mode stack is per screen: popping the alternate
		// screen's stack would take a frame omp does not own and leave omp's
		// own frame behind for the parent shell to inherit.
		expect(harness.writes.join("")).not.toContain("\x1b[<u");

		// Leaving the overlay returns to the main screen, where omp's frame
		// can be popped.
		overlay.hide();
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[<u");
	});

	it("keeps the arming frame on its own screen when the probe times out on the alternate screen", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();

		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[?1049h");
		harness.writes.length = 0;

		// The terminal never answers the query, so the negotiation gives up
		// after its 150 ms probe window. The wait is a real delay on purpose:
		// the probe window is a platform timer inside the terminal, and the
		// harness drives the real one, so no deterministic clock can stand in
		// for it.
		await Bun.sleep(250);

		// The frame stays on the main screen, where it was pushed.
		expect(harness.writes.join("")).not.toContain("\x1b[<u");

		overlay.hide();
		await harness.settle();
		expect(harness.writes.join("")).toContain("\x1b[<u");
	});

	it("takes the arming frame back off the stack when the input is drained during the negotiation", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		await harness.settle();
		harness.writes.length = 0;

		// The shutdown starts inside the 150 ms negotiation window: the
		// arming frame is on the kitty stack even though the terminal never
		// confirmed kitty support, so the drain has to pop it instead of
		// leaving it behind for the parent shell to inherit.
		await harness.terminal.drainInput(10, 5);

		expect(harness.terminal.kittyProtocolActive).toBe(false);
		expect(harness.writes.join("")).toContain("\x1b[<u");
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
