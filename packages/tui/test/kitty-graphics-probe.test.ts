import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { getKittyGraphics, setKittyGraphics, TERMINAL, TUI } from "@oh-my-pi/pi-tui";
import { ImageProtocol, setTerminalImageProtocol } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

// Graphics-protocol query reply captured from the spec's shape: the echoed id
// followed by `OK` for a host that implements the protocol.
const KITTY_QUERY = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";
const KITTY_OK_REPLY = "\x1b_Gi=31;OK\x1b\\";
// Realistic failure reply: a host that parses graphics but cannot load the
// inline payload (or refuses the medium) reports an error string, not `OK`.
const KITTY_ERROR_REPLY = "\x1b_Gi=31;ENOENT:no such file or directory\x1b\\";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminalInfo = TERMINAL as unknown as MutableTerminalInfo;
const originalProtocol = TERMINAL.imageProtocol;
const originalPlaceholders = getKittyGraphics().unicodePlaceholders;
const originalHerdrEnv = Bun.env.HERDR_ENV;
const originalHerdrPane = Bun.env.HERDR_PANE_ID;
const originalHerdrTab = Bun.env.HERDR_TAB_ID;
const originalHerdrWorkspace = Bun.env.HERDR_WORKSPACE_ID;
const originalTmux = Bun.env.TMUX;
const originalForcedProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalNoPlaceholders = Bun.env.PI_NO_KITTY_PLACEHOLDERS;
const originalPlaceholdersOverride = Bun.env.PI_KITTY_PLACEHOLDERS;
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

function startProbe(terminal: VirtualTerminal, insideHerdr = true): TUI {
	// Heredity safety: an inherited tmux session would wrap the query in a DCS
	// passthrough envelope, changing the bytes the write assertions expect.
	delete Bun.env.TMUX;
	if (insideHerdr) {
		Bun.env.HERDR_ENV = "1";
		Bun.env.HERDR_PANE_ID = "w1:p1";
	}
	setTerminalImageProtocol(null);
	terminalInfo.imageProtocol = null;
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	const tui = new TUI(terminal);
	tui.start();
	return tui;
}

describe("TUI Kitty graphics capability probe", () => {
	afterEach(() => {
		vi.useRealTimers();
		setTerminalImageProtocol(originalProtocol);
		terminalInfo.imageProtocol = originalProtocol;
		setKittyGraphics({ unicodePlaceholders: originalPlaceholders });
		restoreEnv("HERDR_ENV", originalHerdrEnv);
		restoreEnv("HERDR_PANE_ID", originalHerdrPane);
		restoreEnv("HERDR_TAB_ID", originalHerdrTab);
		restoreEnv("HERDR_WORKSPACE_ID", originalHerdrWorkspace);
		restoreEnv("TMUX", originalTmux);
		restoreEnv("PI_FORCE_IMAGE_PROTOCOL", originalForcedProtocol);
		restoreEnv("PI_NO_KITTY_PLACEHOLDERS", originalNoPlaceholders);
		restoreEnv("PI_KITTY_PLACEHOLDERS", originalPlaceholdersOverride);
		restoreIsTty(process.stdin, stdinIsTtyDescriptor);
		restoreIsTty(process.stdout, stdoutIsTtyDescriptor);
	});

	it("sends the graphics query inside a Herdr pane and enables Kitty on OK", () => {
		const terminal = new VirtualTerminal(80, 24);
		const writeSpy = spyOn(terminal, "write");
		const tui = startProbe(terminal);

		expect(writeSpy.mock.calls.map(call => String(call[0]))).toContain(KITTY_QUERY);
		expect(TERMINAL.imageProtocol).toBeNull();

		terminal.sendInput(KITTY_OK_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		// The pane VTE is libghostty: placeholders are the render mode that
		// survives pane reflow and nested multiplexers.
		expect(getKittyGraphics().unicodePlaceholders).toBe(true);
		tui.stop();
	});

	it("does not probe or enable outside a Herdr pane", () => {
		// Clear every Herdr identity marker: pane id or workspace id alone keep
		// `isInsideHerdr` true even without HERDR_ENV.
		delete Bun.env.HERDR_ENV;
		delete Bun.env.HERDR_PANE_ID;
		delete Bun.env.HERDR_TAB_ID;
		delete Bun.env.HERDR_WORKSPACE_ID;
		const terminal = new VirtualTerminal(80, 24);
		const writeSpy = spyOn(terminal, "write");
		const tui = startProbe(terminal, false);

		expect(writeSpy.mock.calls.map(call => String(call[0]))).not.toContain(KITTY_QUERY);
		terminal.sendInput(KITTY_OK_REPLY);

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("respects the PI_FORCE_IMAGE_PROTOCOL kill switch inside a Herdr pane", () => {
		// `off` resolves imageProtocol to null on purpose; the probe must not
		// re-enable images behind the user's back.
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "off";
		const terminal = new VirtualTerminal(80, 24);
		const writeSpy = spyOn(terminal, "write");
		const tui = startProbe(terminal);

		expect(writeSpy.mock.calls.map(call => String(call[0]))).not.toContain(KITTY_QUERY);
		terminal.sendInput(KITTY_OK_REPLY);

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("keeps images disabled when the host replies with an error", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput(KITTY_ERROR_REPLY);

		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("re-arms the Sixel probe after a negative Kitty result", () => {
		// The startup path deferred the XTSMGRAPHICS probe while the Kitty probe
		// owned the input stream. A host that rejects the Kitty query but reports
		// Sixel geometry must still get inline images (the pre-probe behavior).
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput(KITTY_ERROR_REPLY);
		terminal.sendInput("\x1b[?2;0;1692;432S");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Sixel);
		tui.stop();
	});

	it("keeps images disabled when the host never replies", () => {
		vi.useFakeTimers();
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		// The 250 ms probe timeout resolves a silent host as unsupported: the
		// pane keeps the fallback and the probe disarms.
		vi.advanceTimersByTime(300);

		expect(TERMINAL.imageProtocol).toBeNull();
		// A reply after the timeout is inert input and must not resurrect the
		// protocol from the disarmed probe.
		terminal.sendInput(KITTY_OK_REPLY);
		expect(TERMINAL.imageProtocol).toBeNull();
		tui.stop();
	});

	it("keeps images disabled when unrelated input arrives first", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("hello");

		expect(TERMINAL.imageProtocol).toBeNull();
		// The probe stays armed: a host that replied late still resolves.
		terminal.sendInput(KITTY_OK_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		tui.stop();
	});

	it("resolves when the OK reply arrives split across chunks", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b_Gi=31;O");
		expect(TERMINAL.imageProtocol).toBeNull();
		terminal.sendInput("K\x1b\\");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		tui.stop();
	});

	it("enables Kitty but keeps placeholders off on an explicit opt-out", () => {
		Bun.env.PI_NO_KITTY_PLACEHOLDERS = "1";
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput(KITTY_OK_REPLY);

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		expect(getKittyGraphics().unicodePlaceholders).toBe(false);
		tui.stop();
	});

	it("enables Kitty when the reply header is split across chunks", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b_Gi=3");
		expect(TERMINAL.imageProtocol).toBeNull();
		terminal.sendInput("1;OK\x1b\\");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		tui.stop();
	});

	it("enables Kitty when the terminator is split after its ESC byte", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b_Gi=31;OK\x1b");
		expect(TERMINAL.imageProtocol).toBeNull();
		terminal.sendInput("\\");

		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		tui.stop();
	});

	it("does not enable SIXEL while the Kitty probe is pending", () => {
		// The sixel probe must not race the Kitty probe on the same input
		// stream: a Herdr pane answering XTSMGRAPHICS would otherwise turn on
		// Sixel while the Kitty capability question is still open.
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		terminal.sendInput("\x1b[?2;0;1692;432S");
		expect(TERMINAL.imageProtocol).toBeNull();

		terminal.sendInput(KITTY_OK_REPLY);
		expect(TERMINAL.imageProtocol).toBe(ImageProtocol.Kitty);
		tui.stop();
	});

	it("stops the probe and leaves state untouched on teardown", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = startProbe(terminal);

		tui.stop();

		expect(TERMINAL.imageProtocol).toBeNull();
		// A reply racing the teardown must not resurrect the protocol.
		terminal.sendInput(KITTY_OK_REPLY);
		expect(TERMINAL.imageProtocol).toBeNull();
	});
});
