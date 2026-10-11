import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";
import {
	createProcessTerminalRenderHarness,
	type ProcessTerminalRenderHarness,
} from "./process-terminal-render-harness";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

// XTSMGRAPHICS item 2 reply captured from foot 1.27: status 0 (success) plus the
// terminal's maximum SIXEL geometry in pixels.
const SIXEL_SUPPORTED_REPLY = "\x1b[?2;0;1692;432S";

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalWtSession = Bun.env.WT_SESSION;
const originalWslDistro = Bun.env.WSL_DISTRO_NAME;
const originalWslInterop = Bun.env.WSL_INTEROP;
const originalForcedProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function restoreIsTty(
	stream: NodeJS.ReadStream | NodeJS.WriteStream,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(stream, "isTTY", descriptor);
		return;
	}
	delete (stream as unknown as { isTTY?: boolean }).isTTY;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[name];
	else Bun.env[name] = value;
}

function startProbe(terminal: VirtualTerminal): TUI {
	setTerminalImageProtocol(null);
	terminalInfo.imageProtocol = null;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	const tui = new TUI(terminal);
	tui.start();
	return tui;
}

describe("TUI SIXEL capability probe", () => {
	afterEach(() => {
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
		restoreEnv("WT_SESSION", originalWtSession);
		restoreEnv("WSL_DISTRO_NAME", originalWslDistro);
		restoreEnv("WSL_INTEROP", originalWslInterop);
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForcedProtocol);
		restoreIsTty(process.stdin, stdinIsTtyDescriptor);
		restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
	});

	it("enables SIXEL only after a positive capability reply", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);
		expect(TERMINAL.imageProtocol).toBeNull();

		terminal.sendInput(SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL on a terminal identified only by COLORTERM (foot)", () => {
		// Regression: the probe used to require isConPTYHosted() && WT_SESSION, so a
		// SIXEL-capable terminal that exports no identifying variable (foot sets
		// TERM=foot and COLORTERM=truecolor only) resolved the `trueColor`
		// capability row, kept imageProtocol null, and rendered every image as the
		// `[Image: …]` text card.
		delete Bun.env.WT_SESSION;
		delete Bun.env.WSL_DISTRO_NAME;
		delete Bun.env.WSL_INTEROP;
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput(SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("enables SIXEL when the reply arrives split across chunks", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b[?2;0;1692");
		expect(TERMINAL.imageProtocol).toBeNull();
		terminal.sendInput(";432S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps SIXEL disabled when the terminal reports a zero geometry", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b[?2;0;0S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("keeps SIXEL disabled when the terminal reports a failure status", () => {
		// `CSI ? 2 ; Ps ; Pv S` carries the status in Ps: 0 is success and 1..3 are
		// error/failure per xterm ctlseqs, so only Ps = 0 may enable SIXEL.
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b[?2;3;1692;432S");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("keeps SIXEL disabled when the terminal never answers", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("hello");

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("enables SIXEL under WSL + Windows Terminal (process.platform is linux)", () => {
		// Regression for #6009: inside WSL, process.platform reports "linux" even
		// though the host is Windows Terminal, so a probe gated on
		// process.platform === "win32" never negotiated SIXEL there. The probe no
		// longer gates on the host at all; WSL is one covered environment of many.
		if (process.platform !== "linux") return;
		Bun.env.WT_SESSION = "test-wt-session";
		Bun.env.WSL_DISTRO_NAME = "Ubuntu";
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput(SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("respects the PI_FORCE_IMAGE_PROTOCOL kill switch", () => {
		// `off` resolves imageProtocol to null on purpose; the probe must not
		// re-enable images behind the user's back.
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput(SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});
});

describe("ProcessTerminal DA1 SIXEL detection", () => {
	withoutTerminalMultiplexer();
	const envKeys = ["PI_FORCE_IMAGE_PROTOCOL", "PI_TUI_NATIVE", "PI_NO_GLYPH_PROTOCOL", "TERM_PROGRAM"] as const;
	const previousEnv = new Map<string, string | undefined>();
	let harness: ProcessTerminalRenderHarness | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		for (const key of envKeys) previousEnv.set(key, Bun.env[key]);
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.TERM_PROGRAM;
		Bun.env.PI_TUI_NATIVE = "0";
		Bun.env.PI_NO_GLYPH_PROTOCOL = "1";
		setTerminalImageProtocol(null);
	});

	afterEach(() => {
		harness?.dispose();
		vi.useRealTimers();
		harness = undefined;
		setTerminalImageProtocol(originalProtocol);
		for (const [key, value] of previousEnv) restoreEnv(key, value);
		previousEnv.clear();
	});

	it("enables SIXEL from native Windows Terminal DA1 without a graphics reply", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		process.stdin.emit("data", "\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52cx");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		expect(received).toEqual(["x"]);
		vi.advanceTimersByTime(251);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("consumes the graphics reply after DA1 has already enabled SIXEL", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		process.stdin.emit("data", "\x1b[?62;4;22;28c");
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		process.stdin.emit("data", `${SIXEL_SUPPORTED_REPLY}x`);

		expect(received).toEqual(["x"]);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("consumes a graphics reply split across the stdin flush deadline after DA1", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		process.stdin.emit("data", "\x1b[?62;4;22;28c");
		process.stdin.emit("data", "\x1b[?2;0;1692");
		vi.advanceTimersByTime(51);
		expect(received).toEqual([]);
		process.stdin.emit("data", ";432Sx");

		expect(received).toEqual(["x"]);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("consumes a negative graphics reply without revoking DA1-advertised support", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		process.stdin.emit("data", "\x1b[?62;4;22;28c\x1b[?2;3;0Sx");

		expect(received).toEqual(["x"]);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("reassembles a DA1 advertisement split beyond the stdin flush deadline", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		const received: string[] = [];
		harness.tui.addInputListener(data => {
			received.push(data);
		});

		process.stdin.emit("data", "\x1b[?61;4;6;7;14");
		vi.advanceTimersByTime(51);
		expect(TERMINAL.imageProtocol).toBeNull();
		process.stdin.emit("data", ";21;22;23;24;28;32;42;52cx");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		expect(received).toEqual(["x"]);
	});

	it("accepts a late unowned DA1 advertisement after the graphics timeout", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		const sentinelCount = harness.writes.reduce((count, write) => count + (write.match(/\x1b\[c/g)?.length ?? 0), 0);
		process.stdin.emit("data", "\x1b[?61;6;22c".repeat(sentinelCount));
		vi.advanceTimersByTime(251);
		expect(TERMINAL.imageProtocol).toBeNull();

		process.stdin.emit("data", "\x1b[?61;4;6;22c");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	it("does not mistake the conformance level or other attributes for SIXEL", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });

		process.stdin.emit("data", "\x1b[?4;14;24;42c");
		expect(TERMINAL.imageProtocol).toBeNull();
		process.stdin.emit("data", SIXEL_SUPPORTED_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
	});

	for (const override of ["off", "none"]) {
		it(`keeps graphics disabled by an explicit ${override} override`, () => {
			Bun.env.PI_FORCE_IMAGE_PROTOCOL = override;
			harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });

			process.stdin.emit("data", "\x1b[?61;4;6;22c");

			expect(TERMINAL.imageProtocol).toBeNull();
		});
	}

	for (const protocol of [ImageProtocol.Kitty, ImageProtocol.Iterm2]) {
		it(`does not replace the already selected ${protocol} graphics protocol`, () => {
			setTerminalImageProtocol(protocol);
			harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });

			process.stdin.emit("data", "\x1b[?61;4;6;22c");

			expect(TERMINAL.imageProtocol).toBe(protocol);
		});
	}

	it("replays a DA1 advertisement to a subscriber attached after detection", () => {
		harness = createProcessTerminalRenderHarness(80, 24, { conpty: true, nativeWindowsConsole: false });
		process.stdin.emit("data", "\x1b[?61;4;6;22c");
		const reports: boolean[] = [];

		harness.terminal.onSixelSupport(supported => reports.push(supported));

		expect(reports).toEqual([true]);
	});
});
