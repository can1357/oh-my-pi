import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");
// Herdr desktop's terminal id plus every multiplexer marker, TERM included: the
// suite may itself run inside Herdr or tmux, which must not switch paths on or off.
const SESSION_ENV_KEYS = ["HC_TERMINAL_ID", ...TERMINAL_MULTIPLEXER_ENV_KEYS];
const SESSION_ENV = Object.fromEntries(SESSION_ENV_KEYS.map(key => [key, Bun.env[key]]));

// Geometry-reflow contract for the *real* terminal driven through the *real*
// renderer. These exercise the seam VirtualTerminal cannot model: the OS channel
// (SIGWINCH) and the DEC 2048 in-band channel disagreeing. The observable
// contract is `probe.last` — the width the transcript actually reflowed to.
describe("ProcessTerminal geometry reflow through the renderer", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		for (const key of SESSION_ENV_KEYS) delete Bun.env[key];
	});

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
		for (const [key, value] of Object.entries(SESSION_ENV)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		vi.restoreAllMocks();
	});

	it("reflows to the OS width on resize when in-band resize is inactive", async () => {
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		expect(harness.probe.last).toBe(100);

		await harness.osResize(160, 40);

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("reflows to the OS width when the post-resize in-band report is missed", async () => {
		// The regression: SIGWINCH fires and process.stdout dims update, but the
		// matching DEC 2048 report is dropped/malformed. Before the fix the getter
		// stayed pinned to the cached report and the transcript reflowed at the old
		// width — content never resized.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y"); // DECRPM: 2048 supported -> in-band active
		await harness.inBand(30, 100, 600, 1000); // seed cached geometry at 100 cols
		expect(harness.probe.last).toBe(100);

		await harness.osResize(160, 40); // no follow-up in-band report

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("reflows to in-band geometry that disagrees with the OS (in-band stays authoritative)", async () => {
		// No OS resize: process.stdout stays at 100, but an in-band report claims
		// 140. The getter must keep preferring in-band (it can be more accurate than
		// ioctl under some multiplexers), so the reconcile fix must not make the OS
		// channel unconditionally win.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);

		await harness.inBand(30, 140, 700, 1400);
		await harness.elapse(600);

		expect(harness.terminal.columns).toBe(140);
		expect(harness.probe.last).toBe(140);
	});

	it("returns to the pty size in Herdr after a peek report read late", async () => {
		// Herdr reports the smaller size of a peek but sends no report when the
		// terminal returns to its pane. With the peek's SIGWINCH coalesced away
		// while the event loop was busy, stdout never shows the peek size, and
		// the late report pinned the viewport to the peek until the next resize.
		Bun.env.HC_TERMINAL_ID = "t7";
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100);

		await harness.inBand(20, 80);
		expect([harness.terminal.rows, harness.probe.last]).toEqual([20, 80]);
		await harness.elapse(600);

		expect([harness.terminal.rows, harness.terminal.columns]).toEqual([30, 100]);
		expect(harness.probe.last).toBe(100);
	});

	it("repaints at the pty height in Herdr after a height-only peek report read late", async () => {
		Bun.env.HC_TERMINAL_ID = "t7";
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100);

		await harness.inBand(15, 100);
		expect(harness.terminal.rows).toBe(15);
		// Let the shrink's own resize transaction finish: it paints once more when
		// its anchor probe times out (about 300 ms), before the 500 ms fallback.
		await harness.elapse(350);
		const writesBefore = harness.writes.length;
		await harness.elapse(250);

		expect(harness.terminal.rows).toBe(30);
		expect(harness.writes.length).toBeGreaterThan(writesBefore);
	});

	it("keeps a Herdr report whose SIGWINCH follows it", async () => {
		Bun.env.HC_TERMINAL_ID = "t7";
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100);

		await harness.inBand(30, 140);
		await harness.osResize(140, 30);
		await harness.elapse(600);

		expect(harness.terminal.columns).toBe(140);
		expect(harness.probe.last).toBe(140);
	});

	it.each([
		["a tmux session", { TMUX: "/tmp/tmux-501/default,1,0" }],
		["tmux known only by TERM", { TERM: "tmux-256color" }],
	])("keeps in-band precedence for %s inside a Herdr terminal", async (_name, env) => {
		// A grid-owning multiplexer in a Herdr pane owns its own pty; its reports stay authoritative.
		Bun.env.HC_TERMINAL_ID = "t7";
		Object.assign(Bun.env, env);
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100);

		await harness.inBand(30, 140);
		await harness.elapse(600);

		expect(harness.terminal.columns).toBe(140);
		expect(harness.probe.last).toBe(140);
	});

	it("returns to the pty size in Herdr inside Orca, which does not own the grid", async () => {
		Bun.env.HC_TERMINAL_ID = "t7";
		Bun.env.ORCA_PANE_KEY = "pane";
		Bun.env.ORCA_WORKTREE_ID = "wt";
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100);

		await harness.inBand(20, 80);
		await harness.elapse(600);

		expect([harness.terminal.rows, harness.terminal.columns]).toEqual([30, 100]);
	});

	it("reflows when an in-band report is split across stdin reads", async () => {
		// A report fragmented mid-sequence must be reassembled by StdinBuffer within
		// the flush window and still drive a reflow — exercises the parser through
		// the full ProcessTerminal -> TUI stack.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(30, 100, 600, 1000);

		await harness.feed("\x1b[48;40;160", ";800;1600t");

		expect(harness.terminal.columns).toBe(160);
		expect(harness.probe.last).toBe(160);
	});

	it("recovers the full height when the grow-back report carries colon subparameters (#4748)", async () => {
		// iOS soft keyboard under tmux-over-SSH: an in-band shrink lands (keyboard
		// up), then the keyboard is dismissed and the grow-back report arrives with
		// a spec-permitted `:`-subparameter and no accompanying OS resize. The
		// parser must ignore the subparameter — dropping the report leaves the
		// viewport pinned at the keyboard-present height.
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.feed("\x1b[?2048;1$y");
		await harness.inBand(15, 100, 300, 1000); // keyboard appears: 30 -> 15 rows
		expect(harness.terminal.rows).toBe(15);

		await harness.feed("\x1b[48;30;100;600;1000:0t"); // keyboard dismissed: grow back

		expect(harness.terminal.rows).toBe(30);
		expect(harness.terminal.columns).toBe(100);
	});

	it("stops rendering and raises SIGHUP when terminal input ends", async () => {
		// SIGHUP is the POSIX exit path; Windows quits directly (covered below).
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		const rendersBeforeDisconnect = harness.probe.widths.length;
		const signalsBeforeDisconnect = harness.signals.length;

		await harness.endInput();
		harness.tui.requestRender(true);
		await harness.settle();

		expect(harness.probe.widths).toHaveLength(rendersBeforeDisconnect);
		expect(harness.signals.slice(signalsBeforeDisconnect)).toContainEqual({ pid: process.pid, signal: "SIGHUP" });
	});

	it("does not wait for terminal output to drain after input ends on Windows", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		harness = createProcessTerminalRenderHarness(100, 30);

		await harness.endInput();

		expect(quit).toHaveBeenCalledWith(129, { drainStdout: false });
		expect(harness.signals).toHaveLength(0);
	});

	it("stops rendering and raises SIGHUP when terminal output fails", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		const rendersBeforeDisconnect = harness.probe.widths.length;
		const signalsBeforeDisconnect = harness.signals.length;

		await harness.failOutput();
		harness.tui.requestRender(true);
		await harness.settle();

		expect(harness.probe.widths).toHaveLength(rendersBeforeDisconnect);
		expect(harness.signals.slice(signalsBeforeDisconnect)).toContainEqual({ pid: process.pid, signal: "SIGHUP" });
	});
});
