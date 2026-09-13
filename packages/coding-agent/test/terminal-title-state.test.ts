import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	buildTerminalTitleWithState,
	disposeTerminalTitleState,
	setTerminalTitle,
	initTerminalTitleState,
	setSessionTerminalTitle,
	setTerminalTitleState,
} from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { isConPTYHosted } from "@oh-my-pi/pi-tui";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { mockWindowsConsoleTitle, type WindowsConsoleTitleMock } from "./terminal-title-test-utils";

const LABEL = "my-project";
// The brand the title runtime prefixes every composed title with. Plain π —
// window titles render in the OS UI font, so nerd-font glyphs are unusable here.
const BRAND = "π";

describe("buildTerminalTitleWithState", () => {
	it("separates brand and label with '>' when idle/done (your turn)", () => {
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, true)).toBe(`${BRAND} > ${LABEL}`);
	});

	it("separates brand and label with '!' when the agent needs attention", () => {
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, true)).toBe(`${BRAND} ! ${LABEL}`);
	});

	it("animates spinner frames in the separator slot while working outside Windows", () => {
		const frame0 = buildTerminalTitleWithState(LABEL, "working", 0, true, "linux");
		const frame1 = buildTerminalTitleWithState(LABEL, "working", 1, true, "linux");
		// The brand stays a bare `π`; only the separator between brand and label
		// carries the spinner glyph, and it advances per frame.
		expect(frame0).toBe(`${BRAND} ⠋ ${LABEL}`);
		expect(frame1).toBe(`${BRAND} ⠙ ${LABEL}`);
		expect(frame1).not.toBe(frame0);
		// The frame index is taken modulo the frame count, so it never throws or
		// produces an "undefined" separator for a large counter.
		const wrapped = buildTerminalTitleWithState(LABEL, "working", 9999, true, "linux");
		expect(wrapped.startsWith(`${BRAND} `)).toBe(true);
		expect(wrapped.endsWith(` ${LABEL}`)).toBe(true);
		expect(wrapped).not.toContain("undefined");
	});

	it("uses a static colon while working on Windows", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "win32")).toBe(`${BRAND} : ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, "win32")).toBe(`${BRAND} : ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "working", 1, true, "win32")).toBe(`${BRAND} :`);
	});

	it("keeps the state visible as a trailing separator when there is no label", () => {
		expect(buildTerminalTitleWithState(undefined, "idle", 0, true)).toBe(`${BRAND} >`);
		expect(buildTerminalTitleWithState(undefined, "attention", 0, true)).toBe(`${BRAND} !`);
		expect(buildTerminalTitleWithState(undefined, "working", 0, true, "linux")).toBe(`${BRAND} ⠋`);
	});

	it("renders the pre-state `π: label` layout when disabled, regardless of state", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 3, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "idle", 0, false)).toBe(BRAND);
	});
});

// Regression coverage for the shutdown-leak bug (PR #4451): the run-state
// `working` spinner arms a periodic `setInterval` that, on every tick, re-emits
// the terminal title as an OSC-0 write (`ESC]0;<title>BEL`). If that interval is
// not cleared on teardown, a pending tick can fire AFTER the shell title was
// restored, leaving the parent shell tab reading `π ⠋ …` post-exit.
// `disposeTerminalTitleState()` (now wired into `InteractiveMode.shutdown()`)
// must stop the timer so no further OSC-title write reaches stdout.
//
// The contract is pinned at the observable sink — `process.stdout.write` — not
// at the timer plumbing. Two seams are opened so the real write path runs under
// `bun test`, mirroring the sibling `terminal title runtime` suite:
//   - `isTerminalHeadless()` defaults to true in the test runtime and short-
//     circuits `setTerminalTitle` before any write; opt out with
//     `setTerminalHeadless(false)` and restore it.
//   - `setTerminalTitle` (and the spinner start) also no-op unless
//     `process.stdout.isTTY`; force it true and restore.
// `vi.useFakeTimers()` makes the real 80ms interval advanceable without a
// wall-clock wait, so the test is fully deterministic.

const OSC_TITLE_SEQ = "\x1b]0;";

describe("disposeTerminalTitleState", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;

	beforeEach(() => {
		vi.useFakeTimers();

		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		windowsTitleMock = mockWindowsConsoleTitle();
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		// Drive the module-global to a known state from the public API so the
		// tests are order-independent: the UI owns the terminal (the previous
		// test's teardown latched it off), a fresh session base, run state idle.
		initTerminalTitleState();
		setSessionTerminalTitle("my-project");
		setTerminalTitleState("idle");
		writes.length = 0;
	});

	afterEach(() => {
		// A started interval must never leak between tests.
		disposeTerminalTitleState();
		stdoutSpy?.mockRestore();
		windowsTitleMock?.restore();
		windowsTitleMock = undefined;
		stdoutSpy = undefined;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
		vi.useRealTimers();
	});

	it.skipIf(isConPTYHosted())("stops the spinner so no further OSC-title write fires on a tick after dispose", () => {
		// CONTRACT (the fix): entering `working` arms the spinner interval; once
		// `disposeTerminalTitleState()` runs, advancing the clock across many tick
		// periods must produce ZERO additional OSC-title writes. A pending tick
		// re-emitting the title after teardown is exactly the shell-tab leak.
		setTerminalTitleState("working");

		// Control: BEFORE dispose the interval is live — advancing the clock across
		// several 80ms tick periods DOES emit further OSC-title writes (proves the
		// timer was actually running, so the post-dispose silence is meaningful and
		// not a headless/TTY misconfiguration masking all writes).
		writes.length = 0;
		vi.advanceTimersByTime(400);
		const ticksWhileLive = writes.filter(payload => payload.includes(OSC_TITLE_SEQ)).length;
		expect(ticksWhileLive).toBeGreaterThan(0);

		// The fix under test.
		disposeTerminalTitleState();

		// After dispose: advance far past many tick periods. No tick may fire.
		writes.length = 0;
		vi.advanceTimersByTime(4000);
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ))).toEqual([]);
	});

	it("latches: a direct setTerminalTitle after dispose cannot write the shell's tab", () => {
		// `setTerminalTitle` is EXPORTED and writes OSC/Win32 straight out, so it
		// bypasses the composed-state path entirely. A direct importer firing from
		// a delayed callback after teardown — the same window the spinner latch
		// covers — would otherwise land in the parent shell's tab, whose title
		// `popTerminalTitle()` has already restored.

		// Control: before dispose the sink really does write, so the silence below
		// is the latch and not a headless/TTY misconfiguration.
		writes.length = 0;
		setTerminalTitle("live write");
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ)).length).toBeGreaterThan(0);

		disposeTerminalTitleState();

		writes.length = 0;
		setTerminalTitle("after teardown");
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ))).toEqual([]);

		// And the latch releases only on the explicit ownership path.
		initTerminalTitleState();
		writes.length = 0;
		setTerminalTitle("owned again");
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ)).length).toBeGreaterThan(0);
	});

	it("latches: a run-state change after dispose cannot re-arm the spinner", () => {
		// CONTRACT: dispose is teardown, not a pause. `InteractiveMode.shutdown()`
		// calls `disposeTerminalTitleState()` and `popTerminalTitle()` BEFORE
		// `this.stop()` unsubscribes the session, so in that window a live
		// `#handleAgentStart` can still call `setTerminalTitleState("working")`.
		// If dispose only stops the timer, that call re-arms it and a tick writes
		// `π ⠋ …` into the parent shell's tab — the exact leak the ordering
		// comment in `shutdown()` claims to prevent.
		disposeTerminalTitleState();

		writes.length = 0;
		setTerminalTitleState("working");

		// Assert on the TIMER, not only the writes: the `emitTerminalTitle` latch
		// already silences anything a re-armed interval would emit, so a write-only
		// assertion cannot tell "never re-armed" from "re-armed and ticking
		// silently forever" — the latter leaks an interval past shutdown that no
		// later dispose reaches.
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(4000);
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ))).toEqual([]);
	});

	it("keeps a routine session title update from releasing the latch", () => {
		// CONTRACT (the leak): `setSessionTerminalTitle` is reached by ordinary
		// session updates — rename, cwd change, collab host frame, and an
		// extension `newSession()` resuming past its `await`. That last one can
		// land AFTER `shutdown()` disposed and `popTerminalTitle()` handed the tab
		// back, and `stop()` cannot cancel it. If a routine update released the
		// latch, this write — and a re-armed spinner behind it — would land in the
		// parent shell's tab. Only terminal ownership (`initTerminalTitleState`)
		// releases it.
		setTerminalTitleState("working");
		disposeTerminalTitleState();

		writes.length = 0;
		setSessionTerminalTitle("late-async-session");

		expect(writes).toEqual([]);
		// And nothing re-armed behind the silence: a live interval past shutdown
		// is a leak no later dispose reaches.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("re-emits on ownership release even when the new session's title is unchanged", () => {
		// CONTRACT: `popTerminalTitle()` hands the terminal back to the shell, so
		// after dispose the runtime does NOT know what is on screen. Deduping the
		// first post-release write against a pre-dispose `lastEmitted` would leave
		// the shell's own title in place while the runtime believes it owns the
		// tab. Same label in and out is the case that catches it.
		setSessionTerminalTitle("same-session");
		setTerminalTitleState("idle");
		disposeTerminalTitleState();

		writes.length = 0;
		initTerminalTitleState();
		setSessionTerminalTitle("same-session");

		expect(writes.some(payload => payload.includes("same-session"))).toBe(true);
	});

	it.skipIf(isConPTYHosted())(
		"releases the latch and re-arms a live spinner when the terminal is claimed again",
		() => {
			// CONTRACT: the latch is teardown-scoped, not permanent. Claiming the
			// terminal again owns the title, so it must resume — including a LIVE
			// spinner if the run state is still `working`. Releasing the flag alone
			// would leave a stopped timer behind a `working` state: a frozen frame.
			setTerminalTitleState("working");
			disposeTerminalTitleState();

			writes.length = 0;
			initTerminalTitleState();
			setSessionTerminalTitle("next-session");

			// The new session's title emitted...
			expect(writes.some(payload => payload.includes("next-session"))).toBe(true);

			// ...and the spinner is genuinely ticking again, not frozen on one frame.
			writes.length = 0;
			vi.advanceTimersByTime(400);
			expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ)).length).toBeGreaterThan(0);
		},
	);
});
