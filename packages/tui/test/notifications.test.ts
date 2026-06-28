import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@pk-nerdsaver-ai/pi-tui/terminal";
import {
	getTerminalInfo,
	isInsideTmux,
	isOsc99Supported,
	NotifyProtocol,
	setOsc99Supported,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@pk-nerdsaver-ai/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@pk-nerdsaver-ai/pi-utils";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalOsc99Probe = Bun.env.PI_TUI_OSC99_PROBE;
const originalTmux = Bun.env.TMUX;
const originalPiNotifications = Bun.env.PI_NOTIFICATIONS;
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
		restoreEnv("PI_NOTIFICATIONS", originalPiNotifications);
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

	it("under tmux, the OSC 99 capability probe is wrapped in DCS passthrough", () => {
		Bun.env.PI_TUI_OSC99_PROBE = "1";
		Bun.env.TMUX = "/tmp/tmux-1000/default,1234,0";
		mutableTerminal.notifyProtocol = NotifyProtocol.Osc99;
		const { terminal, writes } = setupProcessTerminal();
		try {
			const probe = writes.find(
				w => w.startsWith("\x1bPtmux;\x1b\x1b]99;i=omp-probe-") && w.endsWith("\x1b\x1b\\\x1b\\\x1b[c"),
			);
			expect(probe).toBeDefined();
		} finally {
			terminal.stop();
		}
	});
});
