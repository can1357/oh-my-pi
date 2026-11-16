import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { terminalMultiplexerEnvKeys, wrapTmuxPassthrough } from "@oh-my-pi/pi-natives";
import {
	isOsc99Supported,
	type NotifyProtocol,
	setOsc99Supported,
	TERMINAL,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { type FakeTtyTerminal, fakeTtyTerminal } from "./helpers/fake-tty-terminal";

// Formatting, suppression, multiplexer notifier routing (cmux/Herdr CLIs) and
// the D-Bus fan-out are the native profile's (pi-natives `tui::profile::notify`
// tests). These cases pin what reaches the terminal from JS: the in-band
// writes, the OSC 99 capability probe, and the active-terminal write path.

const originalOsc99Probe = Bun.env.PI_TUI_OSC99_PROBE;
const originalKittyWindow = Bun.env.KITTY_WINDOW_ID;
// Multiplexer markers plus the CMUX socket override the notifier also reads.
const MULTIPLEXER_ENV_KEYS = [...terminalMultiplexerEnvKeys(), "CMUX_SOCKET_PATH"];
const originalMultiplexerEnv = MULTIPLEXER_ENV_KEYS.map(key => [key, Bun.env[key]] as const);
const originalPiNotifications = Bun.env.PI_NOTIFICATIONS;
const originalNoDesktop = Bun.env.PI_NO_DESKTOP_NOTIFY;
const mutableTerminal = TERMINAL as unknown as { notifyProtocol: NotifyProtocol };
const originalNotifyProtocol = mutableTerminal.notifyProtocol;

function restoreEnv(key: string, original: string | undefined): void {
	if (original === undefined) {
		delete Bun.env[key];
		return;
	}
	Bun.env[key] = original;
}

let tty: FakeTtyTerminal | undefined;

/** Start a real ProcessTerminal on a faked TTY; disposed after each test. */
function setupProcessTerminal(): FakeTtyTerminal {
	tty = fakeTtyTerminal();
	tty.terminal.start();
	return tty;
}

/** Capture what reaches stdout with no terminal active. */
function captureStdout(): string[] {
	const writes: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	});
	return writes;
}

// Delivery is suppressed while the terminal is headless (the `bun test`
// default), so the whole suite opts out.
let previousHeadless = false;

describe("terminal notifications", () => {
	beforeEach(() => {
		setOsc99Supported(false);
		previousHeadless = setTerminalHeadless(false);
		// Default the suite to a direct-terminal baseline so probe/format
		// assertions never see inherited multiplexer markers.
		for (const key of MULTIPLEXER_ENV_KEYS) delete Bun.env[key];
		// `PI_NOTIFICATIONS=off` is set in this workspace's CI env, which would
		// short-circuit `sendNotification` before it writes anything. Clear it
		// so the delivery-path assertions actually observe stdout writes.
		delete Bun.env.PI_NOTIFICATIONS;
		// Keep a Linux runner's BEL cases from spawning a real D-Bus toast.
		Bun.env.PI_NO_DESKTOP_NOTIFY = "1";
	});

	afterEach(() => {
		tty?.dispose();
		tty = undefined;
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setOsc99Supported(false);
		mutableTerminal.notifyProtocol = originalNotifyProtocol;
		restoreEnv("PI_TUI_OSC99_PROBE", originalOsc99Probe);
		restoreEnv("KITTY_WINDOW_ID", originalKittyWindow);
		for (const [key, value] of originalMultiplexerEnv) restoreEnv(key, value);
		restoreEnv("PI_NOTIFICATIONS", originalPiNotifications);
		restoreEnv("PI_NO_DESKTOP_NOTIFY", originalNoDesktop);
	});

	it("queries OSC 99 support, adopts rich notifications on the reply, and releases them on stop", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		// The engine resolves kitty (OSC 99) from the environment.
		Bun.env.KITTY_WINDOW_ID = "1";
		mutableTerminal.notifyProtocol = "osc99";
		const { terminal, output, received, feed } = setupProcessTerminal();
		const id = output().match(/\x1b\]99;i=([^:;]+):p=\?;\x1b\\\x1b\[c/u)?.[1];
		expect(id).toBeDefined();
		let mark = output().length;
		TERMINAL.sendNotification({ title: "Session", body: "Complete" });
		expect(output().slice(mark)).toContain("\x1b]99;;Session: Complete\x1b\\");

		feed(`\x1b]99;i=${id}:p=?;p=title,body:a=focus,report:s=system,silent:w=1\x1b\\`);

		expect(isOsc99Supported()).toBe(true);
		expect(received).toEqual([]);
		// Confirmed support switches notifications to structured title/body chunks.
		mark = output().length;
		TERMINAL.sendNotification({ title: "Session", body: "Complete" });
		expect(output().slice(mark)).toContain(":p=body;Complete\x1b\\");

		// A resumed TUI may own a different terminal: support waits for the next probe.
		terminal.stop();
		expect(isOsc99Supported()).toBe(false);
	});

	it("wraps an OSC payload in tmux's DCS passthrough envelope with doubled ESCs", () => {
		const payload = "\x1b]99;;Hello\x1b\\";
		expect(wrapTmuxPassthrough(payload)).toBe("\x1bPtmux;\x1b\x1b]99;;Hello\x1b\x1b\\\x1b\\");
	});

	it("writes nothing while notifications are suppressed or the terminal is headless", () => {
		mutableTerminal.notifyProtocol = "osc99";
		const writes = captureStdout();
		Bun.env.PI_NOTIFICATIONS = "off";
		TERMINAL.sendNotification("ping");
		delete Bun.env.PI_NOTIFICATIONS;
		setTerminalHeadless(true);
		TERMINAL.sendNotification("ping");
		expect(writes).toEqual([]);
	});

	it.each([
		["outside tmux, an OSC notification is written unchanged", {}, "osc99", ["\x1b]99;;ping\x1b\\"]],
		// One write: both pieces reach tmux as one contiguous chunk so a concurrent
		// renderer cannot interleave between the OSC and the BEL.
		[
			"under tmux, an OSC notification is wrapped for passthrough and followed by a BEL",
			{ TMUX: "/tmp/tmux-1000/default,1234,0" },
			"osc99",
			["\x1bPtmux;\x1b\x1b]99;;ping\x1b\x1b\\\x1b\\\x07"],
		],
		["under tmux, a BEL notification stays a plain BEL", { TMUX: "/tmp/tmux-1000/default,1234,0" }, "bell", ["\x07"]],
		// Zellij raises its [!] bell flag on a bare BEL; it has no DCS passthrough,
		// so the OSC (which Zellij drops) is followed by a plain BEL.
		[
			"under Zellij, an OSC notification is followed by a plain BEL",
			{ ZELLIJ: "0" },
			"osc99",
			["\x1b]99;;ping\x1b\\\x07"],
		],
		["under Zellij, a BEL notification stays a single plain BEL", { ZELLIJ: "0" }, "bell", ["\x07"]],
		// A Herdr session without a pane id, or a cmux surface id that is not a
		// UUID, leaves the terminal fallback in place.
		["an incomplete Herdr session keeps the OSC fallback", { HERDR_ENV: "1" }, "osc99", ["\x1b]99;;ping\x1b\\"]],
		[
			"an option-like cmux surface keeps the OSC fallback",
			{ CMUX_SURFACE_ID: "--help" },
			"osc99",
			["\x1b]99;;ping\x1b\\"],
		],
	] as const)("%s", (_label, env, protocol, expected) => {
		Object.assign(Bun.env, env);
		mutableTerminal.notifyProtocol = protocol;
		const writes = captureStdout();

		TERMINAL.sendNotification("ping");

		expect(writes).toEqual([...expected]);
	});

	it("under tmux, the OSC 99 capability probe is suppressed (reply cannot route back to the pane)", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		Bun.env.KITTY_WINDOW_ID = "1";
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		const { output } = setupProcessTerminal();
		// tmux forwards the passthrough probe to the outer terminal but cannot
		// route the `p=?` reply back to the sending pane, so the reply would
		// leak into the pane as text (#5582). The probe must not fire at all,
		// while the other capability probes still go out.
		expect(output()).toContain("\x1b[c");
		expect(output()).not.toContain("]99;i=");
		expect(isOsc99Supported()).toBe(false);
	});

	// While a TUI owns stdout, its frames go through an off-thread pump; a
	// notification written straight to stdout could split a frame's escape
	// sequence. Each of the three write sites must take the terminal's path —
	// out through the engine's output, never as a direct stdout string; each
	// row's bytes prove which site it reached.
	it.each([
		["direct", undefined, "\x1b]9;ping\x1b\\"],
		["tmux", "TMUX", "\x1bPtmux;\x1b\x1b]9;ping\x1b\x1b\\\x1b\\\x07"],
		["Zellij", "ZELLIJ", "\x1b]9;ping\x1b\\\x07"],
	] as const)(
		"routes a %s notification through the active terminal, never straight to stdout",
		(_host, envKey, sequence) => {
			if (envKey === "TMUX") Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
			if (envKey === "ZELLIJ") Bun.env.ZELLIJ = "0";
			mutableTerminal.notifyProtocol = "osc9";
			const { output, directWrites } = setupProcessTerminal();
			const before = output().length;

			TERMINAL.sendNotification("ping");

			expect(output().slice(before).split(sequence)).toHaveLength(2);
			expect(directWrites).toEqual([]);
		},
	);
});
