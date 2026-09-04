import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as desktopNotify from "@oh-my-pi/pi-tui/desktop-notify";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import {
	getTerminalInfo,
	isInsideTmux,
	isInsideZellij,
	isOsc99Supported,
	NotifyProtocol,
	setOsc99Supported,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalOsc99Probe = Bun.env.PI_TUI_OSC99_PROBE;
const originalTmux = Bun.env.TMUX;
const originalZellij = Bun.env.ZELLIJ;
const originalHerdrEnv = Bun.env.HERDR_ENV;
const originalHerdrPaneId = Bun.env.HERDR_PANE_ID;
const originalHerdrTabId = Bun.env.HERDR_TAB_ID;
const originalHerdrWorkspaceId = Bun.env.HERDR_WORKSPACE_ID;
const originalPiNotifications = Bun.env.PI_NOTIFICATIONS;
const originalCmuxSurfaceId = Bun.env.CMUX_SURFACE_ID;
const originalCmuxWorkspaceId = Bun.env.CMUX_WORKSPACE_ID;
const originalCmuxSocketPath = Bun.env.CMUX_SOCKET_PATH;
const mutableTerminal = TERMINAL as unknown as { notifyProtocol: NotifyProtocol };
const originalNotifyProtocol = mutableTerminal.notifyProtocol;

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

function setupProcessTerminal() {
	const writes: string[] = [];
	const received: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
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
	return { terminal, writes, received };
}

// setupProcessTerminal() drives the real ProcessTerminal start()/probe path, so
// these cases opt out of the test-default headless suppression.
let previousHeadless = false;

describe("terminal notifications", () => {
	beforeEach(() => {
		setOsc99Supported(false);
		previousHeadless = setTerminalHeadless(false);
		// Default the suite to the "outside tmux" baseline so probe/format
		// assertions never see a stray inherited TMUX leaking the DCS wrap in.
		delete Bun.env.TMUX;
		delete Bun.env.ZELLIJ;
		delete Bun.env.HERDR_ENV;
		delete Bun.env.HERDR_PANE_ID;
		delete Bun.env.HERDR_TAB_ID;
		delete Bun.env.HERDR_WORKSPACE_ID;
		delete Bun.env.CMUX_SURFACE_ID;
		delete Bun.env.CMUX_WORKSPACE_ID;
		delete Bun.env.CMUX_SOCKET_PATH;
		// `PI_NOTIFICATIONS=off` is set in this workspace's CI env, which would
		// short-circuit `sendNotification` before it writes anything. Clear it
		// so the delivery-path assertions actually observe stdout writes.
		delete Bun.env.PI_NOTIFICATIONS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setOsc99Supported(false);
		mutableTerminal.notifyProtocol = originalNotifyProtocol;
		restoreEnv("PI_TUI_OSC99_PROBE", originalOsc99Probe);
		restoreEnv("TMUX", originalTmux);
		restoreEnv("ZELLIJ", originalZellij);
		restoreEnv("HERDR_ENV", originalHerdrEnv);
		restoreEnv("HERDR_PANE_ID", originalHerdrPaneId);
		restoreEnv("HERDR_TAB_ID", originalHerdrTabId);
		restoreEnv("HERDR_WORKSPACE_ID", originalHerdrWorkspaceId);
		restoreEnv("PI_NOTIFICATIONS", originalPiNotifications);
		restoreEnv("CMUX_SURFACE_ID", originalCmuxSurfaceId);
		restoreEnv("CMUX_WORKSPACE_ID", originalCmuxWorkspaceId);
		restoreEnv("CMUX_SOCKET_PATH", originalCmuxSocketPath);
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("keeps string notification formatting backward-compatible", () => {
		const terminal = getTerminalInfo("kitty");
		expect(terminal.formatNotification("hello")).toBe("\x1b]99;;hello\x1b\\");
	});

	it("falls back to a single OSC 99 line until rich support is confirmed", () => {
		const terminal = getTerminalInfo("kitty");
		expect(terminal.formatNotification({ title: "Session", body: "Complete" })).toBe(
			"\x1b]99;;Session: Complete\x1b\\",
		);
	});

	it("formats structured Kitty OSC 99 title and body chunks", () => {
		setOsc99Supported(true);
		const terminal = getTerminalInfo("kitty");
		const out = terminal.formatNotification({
			title: "Session",
			body: "Complete",
			id: "complete-1",
			type: "completion",
			urgency: "normal",
			iconName: "info",
			sound: "info",
			actions: "focus",
			expiresMs: 5000,
		});

		expect(out).toBe(
			"\x1b]99;i=complete-1:f=T2ggTXkgUGk=:a=focus:u=1:t=Y29tcGxldGlvbg==:n=aW5mbw==:s=aW5mbw==:w=5000:d=0;Session\x1b\\" +
				"\x1b]99;i=complete-1:p=body;Complete\x1b\\",
		);
	});

	it("base64-encodes unsafe OSC 99 payload controls", () => {
		setOsc99Supported(true);
		const terminal = getTerminalInfo("kitty");
		const out = terminal.formatNotification({ title: "Line 1\nLine 2", id: "unsafe" });
		expect(out).toBe("\x1b]99;i=unsafe:f=T2ggTXkgUGk=:e=1;TGluZSAxCkxpbmUgMg==\x1b\\");
	});

	it("queries and confirms OSC 99 support before rich notifications", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { terminal, writes, received } = setupProcessTerminal();
		try {
			const query = writes.find(w => w.startsWith("\x1b]99;i=omp-probe-") && w.endsWith("\x1b\\\x1b[c"));
			expect(query).toBeDefined();
			const id = query!.match(/i=([^:;]+):p=\?/u)?.[1];
			expect(id).toBeDefined();

			process.stdin.emit("data", `\x1b]99;i=${id}:p=?;p=title,body:a=focus,report:s=system,silent:w=1\x1b\\`);

			expect(isOsc99Supported()).toBe(true);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("marks OSC 99 unsupported when the DA1 sentinel wins", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { terminal, received } = setupProcessTerminal();
		try {
			process.stdin.emit("data", "\x1b[?1;2c");
			process.stdin.emit("data", "\x1b[?1;2c");
			process.stdin.emit("data", "\x1b[?1;2c");

			expect(isOsc99Supported()).toBe(false);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("isInsideTmux reads the TMUX env fresh on each call", () => {
		expect(isInsideTmux()).toBe(false);
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		expect(isInsideTmux()).toBe(true);
		delete Bun.env.TMUX;
		expect(isInsideTmux()).toBe(false);
	});

	it("wraps an OSC payload in tmux's DCS passthrough envelope with doubled ESCs", () => {
		const payload = "\x1b]99;;Hello\x1b\\";
		expect(wrapTmuxPassthrough(payload)).toBe("\x1bPtmux;\x1b\x1b]99;;Hello\x1b\x1b\\\x1b\\");
	});

	it("routes a real cmux surface notification exactly once with explicit argv fields", () => {
		Bun.env.CMUX_SURFACE_ID = "123e4567-e89b-12d3-a456-426614174000";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const unref = vi.fn();
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref }) as never);

		TERMINAL.sendNotification({ title: "--title=spoof", body: "--surface other" });

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith({
			cmd: [
				"cmux",
				"notify",
				"--surface",
				"123e4567-e89b-12d3-a456-426614174000",
				"--title",
				"--title=spoof",
				"--body",
				"--surface other",
			],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(unref).toHaveBeenCalledTimes(1);
		expect(stdout).not.toHaveBeenCalled();
	});

	it("keeps the existing OSC fallback for cmux workspace or socket state without a surface", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		Bun.env.CMUX_WORKSPACE_ID = "workspace:1";
		TERMINAL.sendNotification("workspace");
		delete Bun.env.CMUX_WORKSPACE_ID;
		Bun.env.CMUX_SOCKET_PATH = "/tmp/cmux.sock";
		TERMINAL.sendNotification("socket");

		expect(spawn).not.toHaveBeenCalled();
		expect(writes).toEqual(["\x1b]99;;workspace\x1b\\", "\x1b]99;;socket\x1b\\"]);
	});

	it("rejects option-like cmux surface values and retains the existing fallback", () => {
		Bun.env.CMUX_SURFACE_ID = "--help";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		TERMINAL.sendNotification("ping");

		expect(spawn).not.toHaveBeenCalled();
		expect(writes).toEqual(["\x1b]99;;ping\x1b\\"]);
	});

	it("falls back to the terminal protocol when cmux cannot be spawned", () => {
		Bun.env.CMUX_SURFACE_ID = "123e4567-e89b-12d3-a456-426614174000";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(() => TERMINAL.sendNotification("ping")).not.toThrow();
		expect(writes).toEqual(["\x1b]99;;ping\x1b\\"]);
	});

	it("unrefs a lingering cmux child so notification delivery cannot pin process exit", () => {
		Bun.env.CMUX_SURFACE_ID = "123e4567-e89b-12d3-a456-426614174000";
		const unref = vi.fn();
		vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref }) as never);

		TERMINAL.sendNotification("ping");

		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("under tmux, OSC-protocol sendNotification wraps for passthrough and appends BEL", () => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		TERMINAL.sendNotification("ping");

		// Single write — both pieces must reach tmux as one contiguous chunk so a
		// concurrent renderer cannot interleave between the OSC and the BEL.
		expect(writes).toEqual(["\x1bPtmux;\x1b\x1b]99;;ping\x1b\x1b\\\x1b\\\x07"]);
	});

	it("under tmux, Bell-protocol sendNotification stays a plain BEL (no DCS wrap)", () => {
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Bell;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		TERMINAL.sendNotification("ping");

		expect(writes).toEqual(["\x07"]);
	});

	it("Bell-protocol sendNotification also fans out to D-Bus when the gate is open", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Bell;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
		vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(true);
		const dbus = vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(() => {});

		TERMINAL.sendNotification({ title: "Session", body: "Complete" });

		// BEL still hits stdout for tmux monitor-bell / X11 urgency / audible bell.
		expect(writes).toEqual(["\x07"]);
		// And the desktop toast is dispatched with the same structured payload.
		expect(dbus).toHaveBeenCalledTimes(1);
		expect(dbus).toHaveBeenCalledWith({ title: "Session", body: "Complete" });
	});

	it("skips the D-Bus dispatch when the gate forbids it (kept side-effect free)", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Bell;
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(false);
		const dbus = vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(() => {});

		TERMINAL.sendNotification("ping");

		expect(dbus).not.toHaveBeenCalled();
	});

	it("never reaches D-Bus when the terminal already speaks an in-band notify protocol", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// Even if the gate would say yes, the BEL branch is skipped so dispatch never fires.
		vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(true);
		const dbus = vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(() => {});

		TERMINAL.sendNotification("ping");

		expect(dbus).not.toHaveBeenCalled();
	});

	it("outside tmux, OSC-protocol sendNotification writes the raw OSC unchanged", () => {
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		TERMINAL.sendNotification("ping");

		expect(writes).toEqual(["\x1b]99;;ping\x1b\\"]);
	});

	it("isInsideZellij reads the ZELLIJ env fresh on each call", () => {
		expect(isInsideZellij()).toBe(false);
		Bun.env.ZELLIJ = "0";
		expect(isInsideZellij()).toBe(true);
		delete Bun.env.ZELLIJ;
		expect(isInsideZellij()).toBe(false);
	});

	it("under Zellij, OSC-protocol sendNotification appends a plain BEL (no DCS wrap)", () => {
		Bun.env.ZELLIJ = "0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		TERMINAL.sendNotification("ping");

		// Zellij raises its [!] bell flag on a bare BEL; it has no DCS passthrough,
		// so the OSC (which Zellij drops) is followed by a plain BEL — no wrap.
		expect(writes).toEqual(["\x1b]99;;ping\x1b\\\x07"]);
	});

	it("under tmux, the OSC 99 capability probe is suppressed (reply cannot route back to the pane)", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { terminal, writes } = setupProcessTerminal();
		try {
			// tmux forwards the passthrough probe to the outer terminal but cannot
			// route the `p=?` reply back to the sending pane, so the reply would
			// leak into the pane as text (#5582). The probe must not fire at all.
			const probe = writes.find(w => w.includes("]99;i=omp-probe-") && w.includes(":p=?"));
			expect(probe).toBeUndefined();
			expect(isOsc99Supported()).toBe(false);
		} finally {
			terminal.stop();
		}
	});
});
