import { afterEach, describe, expect, it } from "bun:test";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

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
