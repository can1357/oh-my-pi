import { afterEach, describe, expect, it, vi } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, "platform");

// Geometry-reflow contract for the *real* terminal driven through the *real*
// renderer. These exercise the seam VirtualTerminal cannot model: the OS channel
// (SIGWINCH) and the DEC 2048 in-band channel disagreeing. The observable
// contract is `probe.last` — the width the transcript actually reflowed to.
describe("ProcessTerminal geometry reflow through the renderer", () => {
	let harness: ProcessTerminalRenderHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		if (PLATFORM_DESCRIPTOR) Object.defineProperty(process, "platform", PLATFORM_DESCRIPTOR);
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

		expect(harness.terminal.columns).toBe(140);
		expect(harness.probe.last).toBe(140);
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
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		const rendersBeforeDisconnect = harness.probe.widths.length;

		await harness.endInput();
		harness.tui.requestRender(true);
		await harness.settle();

		expect(harness.probe.widths).toHaveLength(rendersBeforeDisconnect);
		expect(harness.signals.at(-1)).toEqual({ pid: process.pid, signal: "SIGHUP" });
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
		harness = createProcessTerminalRenderHarness(100, 30);
		await harness.settle();
		const rendersBeforeDisconnect = harness.probe.widths.length;

		await harness.failOutput();
		harness.tui.requestRender(true);
		await harness.settle();

		expect(harness.probe.widths).toHaveLength(rendersBeforeDisconnect);
		expect(harness.signals.at(-1)).toEqual({ pid: process.pid, signal: "SIGHUP" });
	});
});
