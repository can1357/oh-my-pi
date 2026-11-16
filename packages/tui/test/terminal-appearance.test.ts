import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type CellDimensions, getCellDimensions, setCellDimensions } from "@oh-my-pi/pi-tui/inline-image";
import type { ProcessTerminal, TerminalAppearance, TerminalStartOptions } from "@oh-my-pi/pi-tui/terminal";
import { getTerminalBackgroundColor, setTerminalBackgroundColor } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { type FakeTty, fakeProcessTty } from "./helpers/process-tty";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { ManualScheduler } from "./native/tsp-harness";

// These suites drive the real ProcessTerminal glue and native engine on a
// fake TTY: stdin bytes are injected as reads, and the engine's output is
// captured. Probe parsing and
// negotiation themselves are covered by the engine's Rust tests; what is
// asserted here is what a consumer of the terminal observes.

withoutTerminalMultiplexer();

const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const ENV_KEYS = ["COLORFGBG", "WT_SESSION", "WSL_INTEROP", "WSL_DISTRO_NAME"] as const;

const OSC11_QUERY = "\x1b]11;?\x07";
const TMUX_OSC11_REFRESH = "\x1bPtmux;\x1b\x1b]11;?\x07\x1b\\";
const DA1_QUERY = "\x1b[c";
const DA1_REPLY = "\x1b[?1;2c";
const MODE_2031_NOTIFICATION = "\x1b[?997;1n";
const TMUX_SESSION = "/tmp/tmux-1000/default,1234,0";

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function setStdoutSize(columns: number, rows: number): void {
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
}

let tty: FakeTty;
let previousCellDimensions: CellDimensions;
const previousEnv = new Map<string, string | undefined>();
let answeredSentinels = 0;
let opened: ProcessTerminal[] = [];

beforeEach(() => {
	for (const key of ENV_KEYS) {
		previousEnv.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	previousCellDimensions = { ...getCellDimensions() };
	tty = fakeProcessTty();
	setTerminalBackgroundColor(undefined);
	answeredSentinels = 0;
});

afterEach(() => {
	// Stop before restoring the fakes so no terminal stays registered, even when
	// an expectation failed mid-test.
	for (const terminal of opened) terminal.stop();
	opened = [];
	tty.dispose();
	vi.restoreAllMocks();
	setTerminalBackgroundColor(undefined);
	setCellDimensions(previousCellDimensions);
	restoreProperty(process, "platform", processPlatformDescriptor);
	restoreProperty(process.stdout, "columns", stdoutColumnsDescriptor);
	restoreProperty(process.stdout, "rows", stdoutRowsDescriptor);
	for (const [key, value] of previousEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	previousEnv.clear();
});

/** Everything written to the terminal so far, or since `mark` (a `tty.writes.length`). */
function output(mark = 0): string {
	return tty.writes.slice(mark).join("");
}

/** Direct OSC 11 queries written so far (tmux passthrough refreshes excluded). */
function directQueries(): number {
	const written = output();
	return count(written, OSC11_QUERY) - count(written, TMUX_OSC11_REFRESH);
}

function send(data: string): void {
	tty.type(data);
}

/** Answer every DA1 probe sentinel written and not yet answered, in send order. */
function answerSentinels(): void {
	const outstanding = count(output(), DA1_QUERY) - answeredSentinels;
	answeredSentinels += outstanding;
	for (let i = 0; i < outstanding; i++) send(DA1_REPLY);
}

// conpty defaults false so keyboard-flag assertions stay hermetic under WSL,
// where ConPTY detection would otherwise read the live WSL_* env.
function open({ conpty = false, start }: { conpty?: boolean; start?: TerminalStartOptions } = {}) {
	const scheduler = new ManualScheduler();
	const received: string[] = [];
	const pastes: string[] = [];
	let resizes = 0;
	const terminal = tty.terminal({ conpty });
	opened.push(terminal);
	terminal.bind(
		{
			input: data => received.push(data),
			paste: text => pastes.push(text),
			render: () => {},
			resize: () => {
				resizes++;
			},
		},
		scheduler,
	);
	terminal.start(start);
	return {
		terminal,
		received,
		pastes,
		resizes: () => resizes,
		/** Let `ms` pass, then run every engine timer that came due. */
		elapse(ms: number): void {
			scheduler.advance(ms);
			scheduler.flush();
		},
	};
}

describe("ProcessTerminal appearance detection", () => {
	it("keeps startup probe replies out of input and publishes the detected appearance", () => {
		const { terminal, received } = open();
		const changes: TerminalAppearance[] = [];
		terminal.onAppearanceChange(appearance => changes.push(appearance));

		expect(directQueries()).toBe(1);
		expect(count(output(), DA1_QUERY)).toBeGreaterThanOrEqual(2);
		send("\x1b]11;rgb:ffff/ffff/ffff\x07");
		answerSentinels();

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("light");
		expect(changes).toEqual(["light"]);
		expect(getTerminalBackgroundColor()).toBe(0xffffff);
	});

	it("keeps the startup query pending when the keyboard probe's DA1 sentinel arrives first", () => {
		const { terminal, received } = open();

		// The keyboard probe's sentinel was sent first; the OSC 11 reply still
		// belongs to a pending query.
		send(DA1_REPLY);
		answeredSentinels++;
		send("\x1b]11;rgb:0000/0000/0000\x07");
		answerSentinels();

		expect(terminal.appearance).toBe("dark");
		expect(received).toEqual([]);
	});

	it("replays an already detected appearance to late subscribers", () => {
		const { terminal } = open();
		send("\x1b]11;rgb:ffff/ffff/ffff\x07");
		answerSentinels();

		const appearances: TerminalAppearance[] = [];
		terminal.onAppearanceChange(appearance => appearances.push(appearance));

		expect(appearances).toEqual(["light"]);
	});

	it("reports every OSC 11 response with its RGB while change callbacks stay deduplicated", () => {
		const { terminal, received, elapse } = open();
		const reports: Array<{ reported: TerminalAppearance; current: TerminalAppearance | undefined; rgb: number }> = [];
		const changes: TerminalAppearance[] = [];
		let selfUnsubscribeCalls = 0;
		const unsubscribeSelf = terminal.onAppearanceReport(() => {
			selfUnsubscribeCalls++;
			unsubscribeSelf();
		});
		terminal.onAppearanceReport(() => {
			throw new Error("report callback failure");
		});
		const unsubscribeCollector = terminal.onAppearanceReport(appearance => {
			// The RGB is published before report callbacks run.
			reports.push({ reported: appearance, current: terminal.appearance, rgb: getTerminalBackgroundColor() });
		});
		terminal.onAppearanceChange(appearance => changes.push(appearance));

		send("\x1b]11;rgb:1010/2020/3030\x07");
		answerSentinels();
		// Mode 2031 notifications drive the automatic re-queries.
		for (const reply of ["\x1b]11;rgb:2020/3030/4040\x07", "\x1b]11;rgb:ffff/ffff/ffff\x07"]) {
			send(MODE_2031_NOTIFICATION);
			elapse(100);
			send(reply);
			answerSentinels();
		}
		unsubscribeCollector();
		unsubscribeCollector();
		send(MODE_2031_NOTIFICATION);
		elapse(100);
		send("\x1b]11;rgb:0000/0000/0000\x07");

		expect(directQueries()).toBe(4);
		expect(reports).toEqual([
			{ reported: "dark", current: "dark", rgb: 0x102030 },
			{ reported: "dark", current: "dark", rgb: 0x203040 },
			{ reported: "light", current: "light", rgb: 0xffffff },
		]);
		expect(selfUnsubscribeCalls).toBe(1);
		expect(changes).toEqual(["dark", "light", "dark"]);
		expect(received).toEqual([]);
	});

	it("carries an explicit refresh token to report and change callbacks", () => {
		const { terminal, received } = open();
		const events: Array<{ kind: "report" | "change"; appearance: TerminalAppearance; token: number | undefined }> =
			[];
		terminal.onAppearanceReport((appearance, token) => events.push({ kind: "report", appearance, token }));
		terminal.onAppearanceChange((appearance, token) => events.push({ kind: "change", appearance, token }));

		send("\x1b]11;rgb:0000/0000/0000\x07");
		// The startup query's sentinel is still outstanding: the refresh is
		// accepted with its token but queued until that cycle drains.
		expect(terminal.refreshAppearance(42)).toBe(42);
		expect(directQueries()).toBe(1);
		answerSentinels();
		expect(directQueries()).toBe(2);
		send("\x1b]11;rgb:ffff/ffff/ffff\x07");

		expect(events).toEqual([
			{ kind: "report", appearance: "dark", token: undefined },
			{ kind: "change", appearance: "dark", token: undefined },
			{ kind: "report", appearance: "light", token: 42 },
			{ kind: "change", appearance: "light", token: 42 },
		]);
		expect(received).toEqual([]);
	});

	it("re-queries once per explicit refresh, even behind a Mode 2031-capable bridge, and applies the reply (#5352)", () => {
		const { terminal, received } = open();
		const changes: TerminalAppearance[] = [];
		terminal.onAppearanceChange(appearance => changes.push(appearance));

		// The bridge (e.g. tmux) advertises Mode 2031, yet the outer terminal may
		// never notify: an explicit refresh must still probe.
		send("\x1b]11;rgb:ffff/ffff/ffff\x07");
		send("\x1b[?2031;2$y");
		answerSentinels();

		// The user switched the terminal to dark and pressed Ctrl+L.
		expect(terminal.refreshAppearance()).toBeNumber();
		expect(directQueries()).toBe(2);
		send("\x1b]11;rgb:0000/0000/0000\x07");
		answerSentinels();

		expect(received).toEqual([]);
		expect(terminal.appearance).toBe("dark");
		expect(changes).toEqual(["light", "dark"]);

		terminal.refreshAppearance();
		expect(directQueries()).toBe(3);
	});

	it("refuses an appearance refresh while input is deferred and after stop", () => {
		const { terminal } = open({ start: { deferInput: true } });
		expect(terminal.refreshAppearance(1)).toBeUndefined();
		expect(directQueries()).toBe(0);

		terminal.enableInput();
		expect(directQueries()).toBe(1);
		send("\x1b]11;rgb:ffff/ffff/ffff\x07");
		answerSentinels();

		terminal.stop();
		const mark = tty.writes.length;
		expect(terminal.refreshAppearance(2)).toBeUndefined();
		expect(output(mark)).toBe("");
	});

	it("drops the previous session's RGB on stop and restart without an OSC 11 response", () => {
		Bun.env.COLORFGBG = "15;0";
		const { terminal, elapse } = open();
		send("\x1b]11;rgb:1111/2222/3333\x07");
		answerSentinels();
		expect(getTerminalBackgroundColor()).toBe(0x112233);

		terminal.stop();
		expect(getTerminalBackgroundColor()).toBe(0x000000);
		terminal.start();
		// The DA1 sentinel completes the unanswered query: consumers must use
		// the environment fallback, not the previous session's OSC 11 RGB.
		answerSentinels();
		expect(getTerminalBackgroundColor()).toBe(0x000000);
		expect(terminal.appearance).toBeUndefined();

		send(MODE_2031_NOTIFICATION);
		elapse(100);
		send("\x1b]11;rgb:4444/5555/6666\x07");
		expect(getTerminalBackgroundColor()).toBe(0x445566);
	});

	it("resets stale RGB before a deferred-input prepaint and accepts the fresh reply", () => {
		Bun.env.COLORFGBG = "15;0";
		setTerminalBackgroundColor(0x112233);
		const { terminal } = open({ start: { deferInput: true } });
		expect(directQueries()).toBe(0);
		expect(getTerminalBackgroundColor()).toBe(0x000000);
		terminal.write("first paint");
		expect(output()).toContain("first paint");
		expect(getTerminalBackgroundColor()).toBe(0x000000);

		terminal.enableInput();
		expect(directQueries()).toBe(1);
		send("\x1b]11;rgb:4444/5555/6666\x07");
		expect(getTerminalBackgroundColor()).toBe(0x445566);

		terminal.stop();
		expect(getTerminalBackgroundColor()).toBe(0x000000);
	});

	it("does not let an old terminal's stop erase the current owner's RGB", () => {
		Bun.env.COLORFGBG = "15;0";
		const { terminal: oldTerminal } = open();
		send("\x1b]11;rgb:1111/2222/3333\x07");
		expect(getTerminalBackgroundColor()).toBe(0x112233);

		const { terminal } = open({ start: { deferInput: true } });
		expect(getTerminalBackgroundColor()).toBe(0x000000);
		terminal.enableInput();
		send("\x1b]11;rgb:4444/5555/6666\x07");
		expect(getTerminalBackgroundColor()).toBe(0x445566);

		oldTerminal.stop();
		expect(getTerminalBackgroundColor()).toBe(0x445566);
		terminal.stop();
		expect(getTerminalBackgroundColor()).toBe(0x000000);
	});

	it("leaves the real owner's RGB and the terminal untouched when a headless terminal starts and stops", () => {
		open();
		send("\x1b]11;rgb:1111/2222/3333\x07");
		const mark = tty.writes.length;

		setTerminalHeadless(true);
		const headlessTerminal = tty.terminal({ conpty: false });
		headlessTerminal.start();
		expect(getTerminalBackgroundColor()).toBe(0x112233);
		headlessTerminal.stop();
		setTerminalHeadless(false);

		expect(getTerminalBackgroundColor()).toBe(0x112233);
		expect(output(mark)).toBe("");
	});

	// Only native Windows Terminal is polled (#5091): the engine decides that
	// from the host platform (pi-natives `tui::profile` tests), and the polling
	// itself is covered by its session tests.
	it.each([
		["a POSIX terminal (#3297)", {}],
		["WSL (#3297)", { WSL_INTEROP: "/run/WSL/1_interop" }],
	] as const)("does not re-query OSC 11 without Mode 2031 under %s", (_label, env) => {
		Object.assign(Bun.env, env);
		const { elapse } = open();

		send("\x1b]11;rgb:0000/0000/0000\x07");
		send("\x1b[?2031;0$y");
		answerSentinels();
		const afterStartup = directQueries();

		// A periodic probe wipes the user's text selection on several terminals
		// (#3297); only a host that never notifies through Mode 2031 is polled.
		elapse(30_000);

		expect(directQueries()).toBe(afterStartup);
	});

	it("refreshes tmux's background cache through passthrough, then reads it directly", () => {
		Bun.env.TMUX = TMUX_SESSION;
		const { terminal, received, elapse } = open();
		// The startup probe stays direct.
		expect(directQueries()).toBe(1);
		expect(output()).not.toContain(TMUX_OSC11_REFRESH);

		send("\x1b]11;rgb:0000/0000/0000\x07");
		answerSentinels();
		const reports: Array<{ appearance: TerminalAppearance; token: number | undefined }> = [];
		terminal.onAppearanceReport((appearance, token) => reports.push({ appearance, token }));

		const mark = tty.writes.length;
		expect(terminal.refreshAppearance(42)).toBe(42);
		// No DA1 sentinel rides through tmux: a fragmented outer DA1 reply could
		// be decoded by tmux as Alt+[ followed by printable bytes.
		expect(output(mark)).toBe(TMUX_OSC11_REFRESH);

		// Once the reply reached tmux's cache, the cache is read directly.
		elapse(99);
		expect(directQueries()).toBe(1);
		elapse(1);
		expect(directQueries()).toBe(2);

		send("\x1b]11;rgb:ffff/ffff/ffff\x07");
		answerSentinels();

		expect(terminal.appearance).toBe("light");
		expect(reports).toEqual([{ appearance: "light", token: 42 }]);
		expect(received).toEqual([]);
	});

	it("cancels a pending tmux cache read on stop", () => {
		Bun.env.TMUX = TMUX_SESSION;
		const { terminal, elapse } = open();
		send("\x1b]11;rgb:0000/0000/0000\x07");
		answerSentinels();

		terminal.refreshAppearance();
		terminal.stop();
		const mark = tty.writes.length;
		elapse(100);

		expect(output(mark)).toBe("");
	});

	// Herdr classifies before tmux, but the refresh follows whichever session
	// caches OSC 11; a multiplexer without a cache keeps the refresh direct.
	it.each([
		["tmux nested inside a Herdr pane", TMUX_SESSION, true],
		["a Herdr pane without tmux", undefined, false],
	] as const)("routes an explicit refresh inside %s by the caching session", (_label, tmux, passthrough) => {
		Bun.env.HERDR_PANE_ID = "w1:p1";
		if (tmux !== undefined) Bun.env.TMUX = tmux;
		const { terminal } = open();
		send("\x1b]11;rgb:ffff/ffff/ffff\x07");
		answerSentinels();
		const before = directQueries();

		terminal.refreshAppearance();

		expect(output().includes(TMUX_OSC11_REFRESH)).toBe(passthrough);
		// A cache refresh defers its direct read; a direct refresh queries now.
		expect(directQueries()).toBe(passthrough ? before : before + 1);
	});

	it.each([
		[false, "win32", "\x1b[>5u"],
		[true, "linux", "\x1b[>1u"],
	] as const)(
		"picks keyboard flags by the conpty option (%p), not the ambient platform (%s)",
		(conpty, platform, push) => {
			Object.defineProperty(process, "platform", { value: platform, configurable: true });
			open({ conpty });
			const mark = tty.writes.length;

			send("\x1b[?0u");

			expect(output(mark)).toBe(push);
		},
	);
});

describe("ProcessTerminal private modes and in-band resize", () => {
	it("decides each unbracketed multiline burst by the stall probe once DECRQM confirms 2004 (#13344, #12540)", () => {
		let stalled = false;
		const { received, pastes } = open({ start: { isLoopStalled: () => stalled } });
		send("\x1b[?2004;1$y");
		received.length = 0;

		// IME/dictation commits are typed input, never bracketed: on a responsive
		// loop the block lands as one paste instead of one submit per line.
		send("1. do xxx\r2. do yyy\r3. do zzz");
		expect(pastes).toEqual(["1. do xxx\r2. do yyy\r3. do zzz"]);
		expect(received).toEqual([]);

		// The same shape drained after an event-loop stall is batched typing:
		// every Enter must still submit.
		stalled = true;
		received.length = 0;
		send("aaa\rbbb\rccc");
		expect(received).toEqual(["a", "a", "a", "\r", "b", "b", "b", "\r", "c", "c", "c"]);
		expect(pastes).toHaveLength(1);
	});

	it("emits no output while idle after confirming bracketed paste, nor after stop", () => {
		const { terminal, elapse } = open();
		send("\x1b[?2004;1$y");
		// Let the one-shot keyboard fallback finish before measuring idle output.
		elapse(1000);
		const idle = tty.writes.length;
		elapse(15_000);
		expect(output(idle)).toBe("");

		terminal.stop();
		const stopped = tty.writes.length;
		elapse(1000);
		expect(output(stopped)).toBe("");
	});

	it.each([
		["TMUX session", "TMUX", TMUX_SESSION],
		["TERM fallback", "TERM", "tmux-256color"],
	] as const)("rearms bracketed paste inside tmux via %s without DECRQM 2004 (#15596)", (_label, key, value) => {
		// tmux <= 3.5a answers the DA1 sentinel but not `CSI ? 2004 $ p`, and it
		// drops paste markers whenever the pane's own 2004 flag was cleared.
		Bun.env[key] = value;
		const { terminal, received } = open();
		const reports: Array<{ mode: number; supported: boolean }> = [];
		terminal.onPrivateModeReport((mode, supported) => reports.push({ mode, supported }));
		answerSentinels();
		expect(reports).toContainEqual({ mode: 2004, supported: false });

		const mark = tty.writes.length;
		terminal.write("frame");
		send("x");

		expect(output(mark)).toBe("\x1b[?2004hframe\x1b[?2004h");
		expect(received).toEqual(["x"]);
	});

	it("forwards each private mode resolution with its DECRPM status to subscribers", () => {
		const { terminal } = open();
		const reports: Array<{ mode: number; supported: boolean; confirmed?: boolean; status?: number }> = [];
		terminal.onPrivateModeReport((mode, supported, confirmed, status) =>
			reports.push({ mode, supported, confirmed, status }),
		);

		for (const reply of ["2026;1", "2048;4", "2031;3", "2004;0", "1010;2"]) send(`\x1b[?${reply}$y`);
		// DEC 1011 is left unanswered: its DA1 sentinel proves only that DECRQM
		// went unanswered, not that the mode is unsupported.
		answerSentinels();

		expect(reports).toEqual([
			{ mode: 2026, supported: true, confirmed: true, status: 1 },
			{ mode: 2048, supported: false, confirmed: true, status: 4 },
			{ mode: 2031, supported: true, confirmed: true, status: 3 },
			{ mode: 2004, supported: false, confirmed: true, status: 0 },
			{ mode: 1010, supported: true, confirmed: true, status: 2 },
			{ mode: 1011, supported: false, confirmed: false, status: undefined },
		]);
		// A permanently reset in-band resize mode is neither enabled nor restored.
		terminal.stop();
		expect(output()).not.toContain("\x1b[?2048h");
		expect(output()).not.toContain("\x1b[?2048l");
		// A stopped terminal retires its output until the next start().
		const stopped = tty.writes.length;
		terminal.write("after stop");
		expect(output(stopped)).toBe("");
	});

	it("applies in-band geometry and cell size, resizing only when rows or columns change", () => {
		setStdoutSize(100, 30);
		const { terminal, received, resizes } = open();
		send("\x1b[?2048;1$y");

		send("\x1b[48;30;100;600;1000t");
		expect(terminal.columns).toBe(100);
		expect(terminal.rows).toBe(30);
		expect(getCellDimensions()).toEqual({ widthPx: 10, heightPx: 20 });
		expect(resizes()).toBe(0);

		send("\x1b[48;31;120;620;1200t");
		expect(terminal.columns).toBe(120);
		expect(terminal.rows).toBe(31);
		expect(resizes()).toBe(1);
		expect(received).toEqual([]);
	});

	it("tracks OS geometry on resize when the post-resize in-band report is missed", () => {
		// The OS refreshes process.stdout dimensions before firing `resize`, but
		// the matching DEC 2048 report can be dropped. The getters must not stay
		// pinned to the stale in-band report, or the renderer reflows at the old
		// width.
		setStdoutSize(100, 30);
		const { terminal, resizes } = open();
		send("\x1b[?2048;1$y");
		send("\x1b[48;30;100;600;1000t");

		setStdoutSize(160, 40);
		process.stdout.emit("resize");

		expect(resizes()).toBe(1);
		expect(terminal.columns).toBe(160);
		expect(terminal.rows).toBe(40);
	});
});
