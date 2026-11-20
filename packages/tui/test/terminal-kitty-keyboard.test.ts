import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import type { AltGrHost } from "@oh-my-pi/pi-tui/windows-altgr";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
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

// These suites drive the real ProcessTerminal start()/probe pipeline, so they
// opt out of the test-default headless suppression and restore it per case.
let previousHeadless = false;

const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const originalSshConnection = Bun.env.SSH_CONNECTION;
const originalSshTty = Bun.env.SSH_TTY;
const originalSshClient = Bun.env.SSH_CLIENT;

/**
 * A raw ProcessTerminal whose input handler is observable. The render harness
 * routes the input into the TUI instead, which hides what the input path does
 * with a key press.
 */
function setupRawTerminal(options?: { conpty?: boolean; altGrHost?: AltGrHost }): {
	terminal: ProcessTerminal;
	received: string[];
} {
	const received: string[] = [];
	previousHeadless = setTerminalHeadless(false);
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const terminal = new ProcessTerminal({ conpty: false, ...options });
	terminal.start(
		data => received.push(data),
		() => {},
	);
	return { terminal, received };
}

describe("ProcessTerminal kitty keyboard arming", () => {
	let harness: ProcessTerminalRenderHarness | undefined;
	let rawTerminal: ProcessTerminal | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		rawTerminal?.stop();
		rawTerminal = undefined;
		vi.restoreAllMocks();
		vi.useRealTimers();
		setTerminalHeadless(previousHeadless);
		if (processPlatformDescriptor) Object.defineProperty(process, "platform", processPlatformDescriptor);
		else Reflect.deleteProperty(process, "platform");
		for (const [name, value] of [
			["SSH_CONNECTION", originalSshConnection],
			["SSH_TTY", originalSshTty],
			["SSH_CLIENT", originalSshClient],
		] as const) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
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
		harness.writes.length = 0;

		// The parent application pushed flags = 3 (event types). The reply
		// describes the parent's frame, so omp's own frame — which sits above
		// it — is raised in place instead of pushing a second frame.
		//
		// Fed in the same tick as the negotiation: a reply that arrives after
		// the 150 ms probe window finds the arming frame already popped and
		// pushes a frame of its own, so the in-place rewrite under test here
		// would never happen.
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
		const writes = harness.writes;

		// Fed in the same tick as the negotiation: a reply that arrives after
		// the 150 ms probe window finds the arming frame already popped and
		// pushes a frame of its own, so the single-push balance under test here
		// would not hold.
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
	it("arms the active screen when the kitty reply arrives after an overlay", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		const writes = harness.writes;

		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();
		// The negotiation has not resolved yet, so the overlay entered without a
		// kitty frame: the alternate screen's kitty stack carries nothing of
		// omp's.
		const entered = writes.join("");
		expect(entered).toContain("\x1b[?1049h");
		expect(entered.slice(entered.indexOf("\x1b[?1049h"))).not.toContain("\x1b[>5u");

		// The reply arrives while the overlay holds the alternate screen.
		const beforeReply = writes.length;
		await harness.feed("\x1b[?0u");

		// The alternate screen has to carry a frame of omp's own now: the keys
		// inside the overlay stay legacy-encoded otherwise, and the overlay's
		// exit pop would take a frame omp does not own.
		expect(writes.slice(beforeReply).join("")).toContain("\x1b[>5u");

		// The overlay's exit pops the frame the reply pushed, and every push
		// omp made is matched by exactly one pop.
		overlay.hide();
		await harness.settle();
		harness.dispose();
		harness = undefined;

		const out = writes.join("");
		expect(countMatches(out, KITTY_PUSH)).toBe(2);
		expect(countMatches(out, KITTY_POP)).toBe(2);
	});

	it("pops the alternate-screen kitty frame before the mode is cleared", async () => {
		harness = createProcessTerminalRenderHarness(100, 30, { conpty: false });
		const writes = harness.writes;

		// The kitty reply confirms the protocol before the overlay opens, so the
		// overlay pushes a kitty frame of its own on the alternate screen.
		await harness.feed("\x1b[?0u");
		expect(harness.terminal.kittyProtocolActive).toBe(true);

		const overlay = harness.tui.showOverlay(new ModalProbe(), {
			fullscreen: true,
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		});
		await harness.settle();
		expect(writes.join("")).toContain("\x1b[?1049h\x1b[>5u");

		// The shutdown drains the input while the overlay still holds the
		// alternate screen.
		await harness.terminal.drainInput(10, 5);

		// The overlay's frame has to go back before the mode is cleared: the
		// alternate-screen exit omits the `CSI < u` that balances it once the
		// mode is off, and the frame would stay on that stack for the next
		// application that enters the alternate screen.
		expect(writes.join("")).toContain("\x1b[<u");
		expect(harness.terminal.kittyProtocolActive).toBe(false);

		overlay.hide();
		await harness.settle();
		harness.dispose();
		harness = undefined;

		const out = writes.join("");
		// The pop happened while the alternate screen was still the active one:
		// a pop emitted after the switch back would reach the main screen's
		// stack instead and leave the overlay's frame behind.
		expect(out.indexOf("\x1b[<u")).toBeGreaterThanOrEqual(0);
		expect(out.indexOf("\x1b[<u")).toBeLessThan(out.indexOf("\x1b[?1049l"));
		expect(countMatches(out, KITTY_PUSH)).toBe(2);
		expect(countMatches(out, KITTY_POP)).toBe(2);
	});

	it("holds a split kitty key until its tail arrives during the provisional arming", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupRawTerminal();
		rawTerminal = terminal;

		// The negotiation armed the terminal, but the reply has not arrived
		// yet: the terminal already encodes kitty-style keys, so the tail of a
		// split CSI-u belongs to the same key press.
		process.stdin.emit("data", "\x1b[13;2");
		vi.advanceTimersByTime(60);
		vi.advanceTimersByTime(10);
		process.stdin.emit("data", "u");

		// The whole key press arrives as one sequence: the legacy flush would
		// deliver the prefix as text and the tail as a separate keystroke, so
		// Shift+Enter would never reach the composer as a newline.
		expect(received).toEqual(["\x1b[13;2u"]);
	});

	it("decodes AltGr during the provisional kitty arming", () => {
		// A Hungarian layout: AltGr+F produces "[".
		const altGrHost: AltGrHost = {
			activeLayer: () => new Map([["102:0", "["]]),
			isRightAltDown: () => true,
		};
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		// Keep the modifyOtherKeys fallback inert: it would install the
		// win32-input-mode decoder and rewrite the very sequence under test.
		Bun.env.SSH_CONNECTION = "192.0.2.10 54321 192.0.2.20 22";
		delete Bun.env.SSH_TTY;
		delete Bun.env.SSH_CLIENT;

		const { terminal, received } = setupRawTerminal({ conpty: true, altGrHost });
		rawTerminal = terminal;

		// The reply has not arrived yet, but the terminal is already armed: the
		// chord is a kitty sequence from the first keystroke on, so the layout
		// text is recovered instead of the Alt chord reaching the keybindings.
		process.stdin.emit("data", "\x1b[102;3u");
		expect(received).toEqual(["["]);

		// The negotiation gives up: the provisional state is rolled back and
		// the chord reaches the keybindings as the Alt chord it is.
		process.stdin.emit("data", "\x1b[?1;2c");
		received.length = 0;
		process.stdin.emit("data", "\x1b[102;3u");
		expect(received).toEqual(["\x1b[102;3u"]);
	});
});
