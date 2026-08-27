import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { extractPrintableText } from "@oh-my-pi/pi-tui/keys";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import {
	type CellDimensions,
	getCellDimensions,
	getTerminalInfo,
	setCellDimensions,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalWslDistroName = Bun.env.WSL_DISTRO_NAME;
const originalWslInterop = Bun.env.WSL_INTEROP;
const originalWtSession = Bun.env.WT_SESSION;
const originalTermProgram = Bun.env.TERM_PROGRAM;
const originalTmux = Bun.env.TMUX;

// These suites drive the real ProcessTerminal start()/probe pipeline, so they
// opt out of the test-default headless suppression and restore it per case.
let previousHeadless = false;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

describe("ProcessTerminal OSC 11 appearance detection", () => {
	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
		delete Bun.env.TMUX;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process, "platform", processPlatformDescriptor);
		restoreEnv("WSL_INTEROP", originalWslInterop);
		restoreEnv("WSL_DISTRO_NAME", originalWslDistroName);
		restoreEnv("WT_SESSION", originalWtSession);
		restoreEnv("TERM_PROGRAM", originalTermProgram);
		restoreEnv("TMUX", originalTmux);
	});

	function setupTerminal() {
		const writes: string[] = [];
		const received: string[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			data => received.push(data),
			() => {},
		);

		const queryCount = () => writes.filter(w => w === "\x1b]11;?\x07").length;
		const sentinelCount = () => writes.filter(w => w === "\x1b[c").length;

		return { terminal, writes, received, queryCount, sentinelCount };
	}

	it("swallows the DA1 sentinel even when the OSC 11 reply arrives first", () => {
		const { terminal, writes, received } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(received).toEqual([]);
		expect(writes).toContain("\x1b]11;?\x07");
		expect(writes).toContain("\x1b[c");

		terminal.stop();
	});

	it("queues overlapping OSC 11 queries until both in-flight DA1 sentinels are consumed", () => {
		vi.useFakeTimers();
		const { terminal, queryCount, sentinelCount } = setupTerminal();

		// Startup writes one OSC 11 query and one OSC 11 DA1 sentinel; the kitty
		// keyboard probe's sentinel is fused into a combined `\x1b[?u\x1b[c` write,
		// so it does not appear under the bare `\x1b[c` filter.
		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		process.stdin.emit("data", "\x1b[?997;1n");
		vi.advanceTimersByTime(100);

		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		// First DA1 drains the keyboard sentinel; OSC 11 still pending.
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(queryCount()).toBe(1);

		// Second DA1 drains the OSC 11 sentinel and kicks the queued re-query.
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(queryCount()).toBe(2);
		expect(sentinelCount()).toBe(2);

		terminal.stop();
	});

	it("preserves an explicit refresh token queued behind an automatic OSC 11 query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Seed the current appearance and drain all startup probe sentinels.
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");

		const events: Array<{ kind: "report" | "change"; appearance: string; token: number | undefined }> = [];
		terminal.onAppearanceReport?.((appearance, token) => {
			events.push({ kind: "report", appearance, token });
		});
		terminal.onAppearanceChange((appearance, token) => {
			events.push({ kind: "change", appearance, token });
		});
		events.length = 0;

		// Mode 2031 starts an automatic query. The explicit refresh must queue
		// behind it rather than lending its identity to the in-flight response.
		process.stdin.emit("data", "\x1b[?997;1n");
		vi.advanceTimersByTime(100);
		expect(queryCount()).toBe(2);
		const supersededToken = 41;
		const requestToken = 42;
		expect(terminal.refreshAppearance?.(supersededToken)).toBe(supersededToken);
		expect(terminal.refreshAppearance?.(requestToken)).toBe(requestToken);
		expect(queryCount()).toBe(2);

		// The automatic response is unchanged and therefore reports without a
		// change callback or request token. Its DA1 starts the queued refresh.
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(queryCount()).toBe(3);

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		terminal.stop();

		expect(events).toEqual([
			{ kind: "report", appearance: "dark", token: undefined },
			{ kind: "report", appearance: "light", token: requestToken },
			{ kind: "change", appearance: "light", token: requestToken },
		]);
	});

	it("reports every OSC 11 response while change callbacks remain deduplicated", () => {
		const { terminal } = setupTerminal();
		const reports: Array<{ reported: string; current: string | undefined }> = [];
		const changes: string[] = [];
		let selfUnsubscribeCalls = 0;
		const unsubscribeSelf = terminal.onAppearanceReport?.(() => {
			selfUnsubscribeCalls++;
			unsubscribeSelf?.();
		});
		terminal.onAppearanceReport?.(() => {
			throw new Error("report callback failure");
		});
		const unsubscribeCollector = terminal.onAppearanceReport?.(appearance => {
			reports.push({ reported: appearance, current: terminal.appearance });
		});
		terminal.onAppearanceChange(appearance => changes.push(appearance));

		// Complete the startup query and drain every startup probe sentinel before
		// issuing explicit refreshes, so each response belongs to a real query cycle.
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");

		terminal.refreshAppearance?.();
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		terminal.refreshAppearance?.();
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		// Stop before asserting so a failed expectation cannot leak stdin listeners
		// or terminal modes into subsequent tests.
		terminal.stop();
		unsubscribeCollector?.();
		unsubscribeCollector?.();

		expect(reports).toEqual([
			{ reported: "dark", current: "dark" },
			{ reported: "dark", current: "dark" },
			{ reported: "light", current: "light" },
		]);
		expect(selfUnsubscribeCalls).toBe(1);
		expect(changes).toEqual(["dark", "light"]);
	});

	it("replays already detected OSC 11 appearance to late subscribers", () => {
		const { terminal } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));
		const detected = terminal.appearance;

		// Stop before asserting: a failing expect must not leak a live terminal
		// (stdin listeners, kitty push) into subsequent tests.
		terminal.stop();

		expect(detected).toBe("light");
		expect(appearances).toEqual(["light"]);
	});

	it("2-digit hex OSC 11 response is correctly normalized", () => {
		const { terminal } = setupTerminal();

		// Send dark 2-digit response + DA1
		process.stdin.emit("data", "\x1b]11;rgb:1a/1a/1a\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("2-digit hex light background is detected correctly", () => {
		const { terminal } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ff/ff/ff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("light");

		terminal.stop();
	});

	it("Mode 2031 debounce: multiple notifications coalesce into one re-query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Complete the initial OSC 11 + DA1 cycle (2 startup DA1 sentinels: keyboard + OSC 11)
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");

		const baseline = queryCount();

		// Send 3 rapid Mode 2031 notifications
		process.stdin.emit("data", "\x1b[?997;1n");
		process.stdin.emit("data", "\x1b[?997;1n");
		process.stdin.emit("data", "\x1b[?997;1n");

		// Advance past debounce
		vi.advanceTimersByTime(100);

		// Only one additional query should have been sent (debounced)
		expect(queryCount()).toBe(baseline + 1);

		terminal.stop();
	});

	it("does not periodically re-query OSC 11 once startup probes complete (#3297)", () => {
		vi.useFakeTimers();
		const { terminal, queryCount } = setupTerminal();

		// Drain the startup OSC 11 + DA1 (keyboard probe + OSC 11 sentinels).
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");

		const afterInitial = queryCount();

		// Advance well past the previous 30 s poll interval. Earlier builds
		// fired an OSC 11 + DA1 probe every 30 s here, which wiped the user's
		// active text selection on several terminals (Terminal.app, Warp, VS
		// Code, older Alacritty/WezTerm) — the report in #3297. No periodic
		// query may fire now; mid-session theme tracking is delegated entirely
		// to Mode 2031 push notifications.
		vi.advanceTimersByTime(10 * 60_000);

		expect(queryCount()).toBe(afterInitial);

		terminal.stop();
	});

	it("periodically re-queries OSC 11 under native Windows Terminal when Mode 2031 is unavailable (#5091)", () => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		Bun.env.WT_SESSION = "test-wt-session";
		Bun.env.TERM_PROGRAM = "Windows_Terminal";
		const { terminal, queryCount } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?2031;0$y");
		// Drain startup sentinels in send order: keyboard, OSC 11, DEC 2026,
		// DEC 2048, DEC 2031, and xterm ?1010/?1011.
		for (let i = 0; i < 7; i++) {
			process.stdin.emit("data", "\x1b[?1;2c");
		}
		const afterStartup = queryCount();

		vi.advanceTimersByTime(30_000);

		expect(queryCount()).toBe(afterStartup + 1);

		terminal.stop();
	});

	it("refreshAppearance() issues exactly one OSC 11 re-query per call (#5352)", () => {
		const { terminal, queryCount } = setupTerminal();

		// Drain the OSC 11 reply and all seven startup DA1 sentinels (keyboard,
		// OSC 11, and the DECRQM probes for 2026/2048/2031/1010/1011) so the
		// probe FIFO is empty before the refresh gesture.
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");
		const afterInitial = queryCount();

		// An explicit refresh gesture (Ctrl+L) issues one bounded probe.
		terminal.refreshAppearance?.();
		const afterFirstRefresh = queryCount();

		// Complete that query's cycle, then refresh again: still one probe each.
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		terminal.refreshAppearance?.();
		const afterSecondRefresh = queryCount();

		terminal.stop();
		const afterStop = queryCount();
		terminal.refreshAppearance?.();
		const afterStoppedRefresh = queryCount();

		expect(afterFirstRefresh).toBe(afterInitial + 1);
		expect(afterSecondRefresh).toBe(afterInitial + 2);
		expect(afterStoppedRefresh).toBe(afterStop);
	});

	it("passes an explicit appearance refresh through tmux without changing the startup probe", () => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		const { terminal, writes } = setupTerminal();

		expect(writes).toContain("\x1b]11;?\x07");
		expect(writes).toContain("\x1b[c");

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");
		terminal.refreshAppearance?.();

		expect(writes).toContain("\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\");

		terminal.stop();
	});

	it("reads tmux's refreshed cache without passing a DA1 reply through tmux", () => {
		vi.useFakeTimers();
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		const { terminal, received, queryCount } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");
		const reports: Array<{ appearance: string; token: number | undefined }> = [];
		terminal.onAppearanceReport?.((appearance, token) => reports.push({ appearance, token }));
		const beforeRefresh = queryCount();

		const token = 42;
		terminal.refreshAppearance?.(token);
		expect(queryCount()).toBe(beforeRefresh);

		// A fragmented outer DA1 reply can be decoded by tmux as an Alt+[ key
		// followed by printable capability bytes. Wait for the OSC 11 response to
		// reach tmux's cache, then query that cache directly with a local sentinel.
		vi.advanceTimersByTime(99);
		expect(queryCount()).toBe(beforeRefresh);
		vi.advanceTimersByTime(1);
		expect(queryCount()).toBe(beforeRefresh + 1);

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		const detected = terminal.appearance;
		terminal.stop();

		expect(detected).toBe("light");
		expect(reports).toEqual([{ appearance: "light", token }]);
		expect(received).toEqual([]);
	});

	it("cancels a pending tmux appearance cache read during teardown", () => {
		vi.useFakeTimers();
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		const { terminal, queryCount, sentinelCount } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");
		const directQueriesBeforeRefresh = queryCount();
		const directSentinelsBeforeRefresh = sentinelCount();

		terminal.refreshAppearance?.();
		expect(vi.getTimerCount()).toBe(1);
		terminal.stop();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);

		expect(queryCount()).toBe(directQueriesBeforeRefresh);
		expect(sentinelCount()).toBe(directSentinelsBeforeRefresh);
	});

	it("refreshAppearance() re-evaluates a changed background through the callback pipeline", () => {
		const { terminal } = setupTerminal();
		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));

		// Startup classifies the terminal as light.
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");
		expect(terminal.appearance).toBe("light");
		expect(appearances).toEqual(["light"]);

		// User switches the OS/terminal to dark and presses Ctrl+L. The bounded
		// re-query picks up the new background and fires the appearance callback.
		terminal.refreshAppearance?.();
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(terminal.appearance).toBe("dark");
		expect(appearances).toEqual(["light", "dark"]);

		terminal.stop();
	});

	it("refreshAppearance() still probes through a Mode 2031-capable bridge (#5352)", () => {
		const { terminal, queryCount } = setupTerminal();

		// Drain startup, then have the bridge (e.g. tmux) advertise Mode 2031
		// support via DECRQM — CSI ? 2031 ; 2 $ y (reset/supported). The outer
		// terminal may still never emit an appearance notification, so an explicit
		// refresh must not be gated on advertised 2031 support.
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		for (let i = 0; i < 7; i++) process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?2031;2$y");
		const afterInitial = queryCount();

		terminal.refreshAppearance?.();
		expect(queryCount()).toBe(afterInitial + 1);

		terminal.stop();
	});

	it("does not periodically re-query OSC 11 under WSL either (#3297)", () => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		Bun.env.WSL_INTEROP = "/run/WSL/1_interop";
		const { terminal, queryCount } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		const afterInitial = queryCount();

		vi.advanceTimersByTime(10 * 60_000);

		expect(queryCount()).toBe(afterInitial);

		terminal.stop();
	});

	it("partial OSC 11 buffer does not swallow unrelated input", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// Send a partial OSC 11 start (no terminator)
		process.stdin.emit("data", "\x1b]11;rgb:ff");
		// Flush StdinBuffer timeout so the partial sequence is emitted
		vi.advanceTimersByTime(50);

		// Send an unrelated escape sequence (up arrow)
		process.stdin.emit("data", "\x1b[A");
		vi.advanceTimersByTime(50);

		// The up arrow must be forwarded to the input handler
		expect(received).toContain("\x1b[A");

		terminal.stop();
	});

	it("DA1 from old query does not cancel new queued query", () => {
		vi.useFakeTimers();
		const { terminal, queryCount, sentinelCount } = setupTerminal();
		const appearances: string[] = [];
		terminal.onAppearanceChange(a => appearances.push(a));

		// Step 1: initial query was sent on start
		expect(queryCount()).toBe(1);
		expect(sentinelCount()).toBe(1);

		// Step 2: Mode 2031 notification arrives — queues re-query since initial is pending
		process.stdin.emit("data", "\x1b[?997;1n");

		// Step 3: Complete initial OSC 11 response (light)
		process.stdin.emit("data", "\x1b]11;rgb:ffff/ffff/ffff\x07");

		// Advance past debounce timer
		vi.advanceTimersByTime(100);

		// Step 4: Complete both initial DA1 sentinels — keyboard probe first, then OSC 11.
		// The keyboard sentinel doesn't kick the queued OSC 11 query; the OSC 11 one does.
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");

		expect(queryCount()).toBe(2);
		expect(sentinelCount()).toBe(2);

		// Step 5: Complete 2nd OSC 11 response with a different color (dark)
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");

		// Step 6: Complete 2nd DA1
		process.stdin.emit("data", "\x1b[?1;2c");

		// Step 7: Verify appearance changed and callback fired
		expect(terminal.appearance).toBe("dark");
		expect(appearances).toContain("light");
		expect(appearances).toContain("dark");
		expect(appearances.length).toBe(2);

		terminal.stop();
	});

	it("reassembles a DA1 response split across stdin reads without leaking to input (#1238)", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// OSC 11 completes normally.
		process.stdin.emit("data", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07");

		// DA1 reply arrives split: the prefix appears as one event and then the StdinBuffer
		// flush timeout (50ms) elapses before the rest of the response is delivered.
		// xterm-style "VT420 with extensions" response: \x1b[?62;6;7;14;...;52c
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", ";6;7;14;21;22;23;24;28;32;42;52c");

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("reassembles a DA1 response delivered byte-by-byte", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		process.stdin.emit("data", "\x1b]11;rgb:1c1c/1c1c/1c1c\x07");
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		for (const ch of ";6;7;14;21;22;23;24;28;32;42;52c") {
			process.stdin.emit("data", ch);
		}

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");

		terminal.stop();
	});

	it("abandons private CSI reassembly when a new escape arrives mid-stream", () => {
		vi.useFakeTimers();
		const { terminal, received } = setupTerminal();

		// Start a partial DA1, then a fresh CSI (up arrow) interrupts before the terminator.
		process.stdin.emit("data", "\x1b[?62");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "\x1b[A");
		vi.advanceTimersByTime(50);

		// Up arrow must reach the input handler; probe noise must not.
		expect(received).toContain("\x1b[A");
		expect(received.some(seq => seq.includes("?62"))).toBe(false);

		terminal.stop();
	});

	it("kitty keyboard probe owns its own DA1 sentinel — does not consume OSC 11's", () => {
		const { terminal, writes, received } = setupTerminal();

		// The probe must use `\x1b[?u` (query only). Pushing `\x1b[>31u` would
		// leak a frame onto the kitty stack that shutdown's single pop cannot balance.
		expect(writes.some(w => w.includes("\x1b[>31u"))).toBe(false);
		expect(writes).toContain("\x1b[?u\x1b[c");

		// Seven DA1 sentinels are in flight at startup: keyboard probe, OSC 11, and
		// the DECRQM probes for DEC 2026, 2048, 2031, 1010, and 1011 (each rides the
		// shared FIFO). Consume them in send-order and verify none leaks to the input
		// handler.
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(received).toEqual([]);

		// An eighth stray DA1 has no owner, yet is still swallowed: `CSI ? … c` is
		// exclusively a terminal->host report, never a keystroke, so a reply that
		// lands after the sentinel FIFO drains (slow SSH/PTY links) must not leak
		// into the composer as literal text (#8542).
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(received).toEqual([]);

		terminal.stop();
	});

	it("keyboard DA1 arriving before OSC 11 reply does not falsely mark OSC 11 unsupported", () => {
		const { terminal } = setupTerminal();

		// Keyboard's DA1 arrives first (sent-order). OSC 11 must remain pending.
		process.stdin.emit("data", "\x1b[?1;2c");

		// OSC 11 reply still arrives after — its handler should still parse it
		// (osc11Pending must not have been cleared by the keyboard DA1).
		process.stdin.emit("data", "\x1b]11;rgb:0000/0000/0000\x07");
		expect(terminal.appearance).toBe("dark");

		// OSC 11's own DA1 sentinel drains the FIFO without re-entering the bug path.
		process.stdin.emit("data", "\x1b[?1;2c");

		terminal.stop();
	});

	it("uses disambiguation-only keyboard reporting on ConPTY", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		Bun.env.WSL_DISTRO_NAME = "Ubuntu";

		const { terminal, writes } = setupTerminal();
		writes.length = 0;
		process.stdin.emit("data", "\x1b[?0u");

		expect(writes).toContain("\x1b[>1u");
		expect(writes).not.toContain("\x1b[>5u");
		terminal.stop();
	});

	it("avoids alternate-key reporting on ConPTY while preserving parent event reporting", () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		Bun.env.WSL_INTEROP = "/run/WSL/1_interop";

		const { terminal, writes } = setupTerminal();
		writes.length = 0;
		process.stdin.emit("data", "\x1b[?3u");

		expect(writes).toContain("\x1b[>3u");
		expect(writes).not.toContain("\x1b[>7u");
		terminal.stop();
	});

	it("shutdown balances the single kitty push performed on detection", () => {
		const { terminal, writes } = setupTerminal();

		// Simulate kitty-capable terminal reply (level >=1).
		process.stdin.emit("data", "\x1b[?1u");

		const pushes = writes.filter(w => w === "\x1b[>5u" || w === "\x1b[>7u" || w === "\x1b[>31u").length;
		expect(pushes).toBe(1);

		terminal.stop();
		const pops = writes.filter(w => w === "\x1b[<u").length;
		expect(pops).toBe(1);
	});
});

describe("ProcessTerminal DECRQM + in-band resize (DEC 2026/2048)", () => {
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		originalCellDims = { ...getCellDimensions() };
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process, "platform", processPlatformDescriptor);
		restoreProperty(process.stdout, "columns", stdoutColumnsDescriptor);
		restoreProperty(process.stdout, "rows", stdoutRowsDescriptor);
		setCellDimensions(originalCellDims);
	});

	function setup() {
		const writes: string[] = [];
		const received: string[] = [];
		let resizeCount = 0;
		const reports: Array<{ mode: number; supported: boolean }> = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal();
		terminal.onPrivateModeReport?.((mode, supported) => reports.push({ mode, supported }));
		terminal.start(
			data => received.push(data),
			() => {
				resizeCount++;
			},
		);
		return { terminal, writes, received, reports, resizeCount: () => resizeCount };
	}

	it("queries DECRQM for DEC 2026, 2048, 2031, and xterm scroll-to-bottom modes at startup", () => {
		const { terminal, writes } = setup();
		expect(writes.some(w => w.includes("\x1b[?2026$p"))).toBe(true);
		expect(writes.some(w => w.includes("\x1b[?2048$p"))).toBe(true);
		expect(writes.some(w => w.includes("\x1b[?2031$p"))).toBe(true);
		expect(writes.some(w => w.includes("\x1b[?1010$p"))).toBe(true);
		expect(writes.some(w => w.includes("\x1b[?1011$p"))).toBe(true);
		terminal.stop();
	});

	it("reports DECRPM statuses 1, 2, and 3 as supported private modes", () => {
		const { terminal, reports } = setup();
		process.stdin.emit("data", "\x1b[?2026;1$y");
		process.stdin.emit("data", "\x1b[?2048;2$y");
		process.stdin.emit("data", "\x1b[?2031;3$y");
		expect(reports).toContainEqual({ mode: 2026, supported: true });
		expect(reports).toContainEqual({ mode: 2048, supported: true });
		expect(reports).toContainEqual({ mode: 2031, supported: true });
		terminal.stop();
	});

	it("reports DECRPM status 4 as unsupported for modes the TUI enables", () => {
		const { terminal, writes, reports } = setup();
		process.stdin.emit("data", "\x1b[?2026;4$y");
		process.stdin.emit("data", "\x1b[?2048;4$y");
		expect(reports).toContainEqual({ mode: 2026, supported: false });
		expect(reports).toContainEqual({ mode: 2048, supported: false });
		expect(writes).not.toContain("\x1b[?2048h");
		terminal.stop();
		expect(writes).not.toContain("\x1b[?2048l");
	});

	it("reports a private mode unsupported when DECRPM status is 0", () => {
		const { terminal, reports } = setup();
		process.stdin.emit("data", "\x1b[?2026;0$y");
		expect(reports).toContainEqual({ mode: 2026, supported: false });
		terminal.stop();
	});

	it("enables DEC 2048 only after DECRPM confirms support, and disables it on stop", () => {
		const { terminal, writes, reports } = setup();
		expect(writes).not.toContain("\x1b[?2048h");
		process.stdin.emit("data", "\x1b[?2048;2$y");
		expect(reports).toContainEqual({ mode: 2048, supported: true });
		expect(writes).toContain("\x1b[?2048h");
		terminal.stop();
		expect(writes).toContain("\x1b[?2048l");
	});

	it("disables xterm scroll-to-bottom modes while active and restores them on stop", () => {
		const { terminal, writes, reports } = setup();
		process.stdin.emit("data", "\x1b[?1010;1$y");
		process.stdin.emit("data", "\x1b[?1011;3$y");
		expect(reports).toContainEqual({ mode: 1010, supported: true });
		expect(reports).toContainEqual({ mode: 1011, supported: true });
		expect(writes).toContain("\x1b[?1010l");
		expect(writes).toContain("\x1b[?1011l");

		terminal.stop();

		expect(writes).toContain("\x1b[?1010h");
		expect(writes).toContain("\x1b[?1011h");
	});

	it("leaves already-reset xterm scroll-to-bottom modes unchanged", () => {
		const { terminal, writes, reports } = setup();
		process.stdin.emit("data", "\x1b[?1010;2$y");
		process.stdin.emit("data", "\x1b[?1011;4$y");
		expect(reports).toContainEqual({ mode: 1010, supported: true });
		expect(reports).toContainEqual({ mode: 1011, supported: false });
		expect(writes).not.toContain("\x1b[?1010l");
		expect(writes).not.toContain("\x1b[?1011l");

		terminal.stop();

		expect(writes).not.toContain("\x1b[?1010h");
		expect(writes).not.toContain("\x1b[?1011h");
	});

	it("does not enable DEC 2048 when reported unsupported", () => {
		const { terminal, writes, reports } = setup();
		process.stdin.emit("data", "\x1b[?2048;0$y");
		expect(reports).toContainEqual({ mode: 2048, supported: false });
		expect(writes).not.toContain("\x1b[?2048h");
		terminal.stop();
		expect(writes).not.toContain("\x1b[?2048l");
	});

	it("marks a missing DECRPM response as inconclusive when the DA1 sentinel arrives", () => {
		const { terminal, reports } = setup();
		const confirmations: boolean[] = [];
		terminal.onPrivateModeReport?.((mode, _supported, confirmed) => {
			if (mode === 2026) confirmations.push(confirmed ?? true);
		});
		// Drain keyboard + osc11 sentinels, then 2026's DA1 (no DECRPM arrived).
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		process.stdin.emit("data", "\x1b[?1;2c");
		expect(reports).toContainEqual({ mode: 2026, supported: false });
		expect(confirmations).toEqual([false]);
		terminal.stop();
	});

	it("updates geometry and cell size without resizing when an in-band report is unchanged", () => {
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const { terminal, received, resizeCount } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		process.stdin.emit("data", "\x1b[48;30;100;600;1000t");
		expect(terminal.rows).toBe(30);
		expect(terminal.columns).toBe(100);
		expect(getCellDimensions()).toEqual({ widthPx: 10, heightPx: 20 });
		expect(resizeCount()).toBe(0);
		expect(received).toEqual([]);
		terminal.stop();
	});

	it("fires resize once when an in-band report changes rows or columns", () => {
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const { terminal, received, resizeCount } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		process.stdin.emit("data", "\x1b[48;31;120;620;1200t");
		expect(terminal.rows).toBe(31);
		expect(terminal.columns).toBe(120);
		expect(getCellDimensions()).toEqual({ widthPx: 10, heightPx: 20 });
		expect(resizeCount()).toBe(1);
		expect(received).toEqual([]);
		terminal.stop();
	});

	it("applies a grow-back report whose fields carry colon subparameters (#4748)", () => {
		// iOS soft keyboard dismissed under tmux-over-SSH: the pane grows back and
		// the terminal reports the restored geometry in-band with a spec-permitted
		// `:`-subparameter appended to a field. Mode 2048 allows subparameters on
		// any field and requires clients to IGNORE them — dropping the whole
		// report instead pins `rows` at the keyboard-present height, because no
		// OS resize event accompanies the report to reconcile cached geometry.
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		const { terminal, received, resizeCount } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y"); // in-band active
		process.stdin.emit("data", "\x1b[48;20;100;400;1000t"); // keyboard appears: shrink
		expect(terminal.rows).toBe(20);
		expect(resizeCount()).toBe(1);

		process.stdin.emit("data", "\x1b[48;40;100;800;1000:0t"); // keyboard dismissed: grow back

		expect(terminal.rows).toBe(40);
		expect(terminal.columns).toBe(100);
		expect(resizeCount()).toBe(2);
		expect(received).toEqual([]);
		terminal.stop();
	});

	it("tracks OS geometry on resize when the post-resize in-band report is missed", () => {
		// Real terminals always fire SIGWINCH (process.stdout dims refresh first),
		// but the matching DEC 2048 report can be dropped or arrive malformed. The
		// getters must not stay pinned to the stale cached report, or the renderer
		// reflows at the old width and content never resizes.
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const { terminal, resizeCount } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		process.stdin.emit("data", "\x1b[48;30;100;600;1000t");
		expect(terminal.columns).toBe(100);
		expect(terminal.rows).toBe(30);

		// OS resize: stdout dims update + 'resize' fires, no new in-band report.
		Object.defineProperty(process.stdout, "columns", { value: 160, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		process.stdout.emit("resize");

		expect(resizeCount()).toBe(1);
		expect(terminal.columns).toBe(160);
		expect(terminal.rows).toBe(40);
		terminal.stop();
	});

	it("reassembles a DECRPM reply split across stdin reads", () => {
		vi.useFakeTimers();
		const { terminal, reports } = setup();
		process.stdin.emit("data", "\x1b[?2048;1");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "$y");
		expect(reports).toContainEqual({ mode: 2048, supported: true });
		terminal.stop();
	});

	it("reassembles an in-band resize report split past the flush window without leaking the tail", () => {
		// The reported bug: resizing rapidly keeps the event loop busy, so the
		// StdinBuffer flush timeout (50ms) fires after the `\x1b[48;…` prefix but
		// before the terminator. The tail then arrives as bare characters that
		// leaked into the editor as literal text (e.g. `8;125;1156;1125t`).
		vi.useFakeTimers();
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const { terminal, received, resizeCount } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y"); // in-band active

		process.stdin.emit("data", "\x1b[48;40;160");
		vi.advanceTimersByTime(50); // flush window elapses mid-report
		process.stdin.emit("data", ";800;1600t"); // tail arrives as bare chars

		expect(received).toEqual([]);
		expect(terminal.rows).toBe(40);
		expect(terminal.columns).toBe(160);
		expect(resizeCount()).toBe(1);
		terminal.stop();
	});

	it("reassembles a well-formed report split at the type field (\\x1b[4 | 8;…t)", () => {
		// Splitting right after `\x1b[4` is the exact shape from the bug report (ESC
		// `[` `4` flushed, the rest leaking). Reassembly must catch the bare `\x1b[4`
		// prefix and still apply the resize for a well-formed 5-field report.
		vi.useFakeTimers();
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const { terminal, received } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");

		process.stdin.emit("data", "\x1b[4");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "8;40;125;1156;1125t");

		expect(received).toEqual([]);
		expect(terminal.rows).toBe(40);
		expect(terminal.columns).toBe(125);
		terminal.stop();
	});

	it("reassembles a split grow-back report with colon subparameters without dropping or leaking it", () => {
		// Same grow-back report, fragmented by the StdinBuffer flush window right
		// after the subparameter colon. The partial pattern must accept `:`, or
		// the prefix is rejected as garbage, the report never applies, and the
		// `0t` tail leaks into the editor as literal keystrokes.
		vi.useFakeTimers();
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		const { terminal, received, resizeCount } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y"); // in-band active
		process.stdin.emit("data", "\x1b[48;20;100;400;1000t"); // keyboard appears: shrink
		expect(terminal.rows).toBe(20);

		process.stdin.emit("data", "\x1b[48;40;100;800;1000:");
		vi.advanceTimersByTime(50); // flush window elapses mid-report
		process.stdin.emit("data", "0t");

		expect(received).toEqual([]);
		expect(terminal.rows).toBe(40);
		expect(resizeCount()).toBe(2);
		terminal.stop();
	});

	it("forwards a split report fragment as one escape sequence instead of leaking bare characters", () => {
		// The reported symptom: a fragment like `8;125;1156;1125t` (the tail of
		// `\x1b[48;125;1156;1125t`, missing a field) appeared as literal text in the
		// editor because the tail arrived as individual printable characters. Even
		// when the reassembled sequence is not a valid resize report, it must reach
		// the input handler as ONE escape sequence — `extractPrintableText` then
		// rejects it (it contains ESC), so no characters are inserted.
		vi.useFakeTimers();
		const { terminal, received } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y"); // in-band active

		process.stdin.emit("data", "\x1b[4");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "8;125;1156;1125t");

		expect(received).toEqual(["\x1b[48;125;1156;1125t"]);
		expect(received.every(seq => extractPrintableText(seq) === undefined)).toBe(true);
		terminal.stop();
	});

	it("forwards a split kitty key colliding with the in-band prefix instead of swallowing it", () => {
		// Kitty reports the '0' key (codepoint 48) as `\x1b[48;<mods>u`. If such a
		// key is split past the flush window while in-band resize is active, the
		// reassembled sequence is not a resize report and must reach the input
		// handler — never be dropped as terminal noise.
		vi.useFakeTimers();
		const { terminal, received } = setup();
		process.stdin.emit("data", "\x1b[?2048;1$y"); // in-band active

		process.stdin.emit("data", "\x1b[48;5");
		vi.advanceTimersByTime(50);
		process.stdin.emit("data", "u");

		expect(received).toEqual(["\x1b[48;5u"]);
		terminal.stop();
	});
});

describe("OSC 66 text-sizing capability", () => {
	it("advertises text sizing only for Kitty", () => {
		// OSC 66 is a Kitty-only protocol; any other terminal must report the
		// capability as false so the renderer never emits raw escape bytes there.
		expect(getTerminalInfo("kitty").supportsTextSizing).toBe(true);
		for (const id of ["ghostty", "wezterm", "iterm2", "vscode", "alacritty", "base", "trueColor"] as const) {
			expect(getTerminalInfo(id).supportsTextSizing).toBe(false);
		}
	});
});
