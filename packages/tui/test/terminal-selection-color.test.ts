import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { getTerminalSelectionBackground, setTerminalSelectionBackground } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();

const descriptors = {
	stdinIsTty: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
	stdoutIsTty: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
	setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
};
const originalProbe = Bun.env.PI_TUI_OSC17_PROBE;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

/** Drive the real ProcessTerminal start()/probe path against a captured stdout. */
function startTerminal() {
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

let previousHeadless = false;

describe("terminal selection color probe", () => {
	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		Bun.env.PI_TUI_OSC17_PROBE = "1";
		setTerminalSelectionBackground(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		setTerminalSelectionBackground(undefined);
		if (originalProbe === undefined) delete Bun.env.PI_TUI_OSC17_PROBE;
		else Bun.env.PI_TUI_OSC17_PROBE = originalProbe;
		restoreProperty(process.stdin, "isTTY", descriptors.stdinIsTty);
		restoreProperty(process.stdout, "isTTY", descriptors.stdoutIsTty);
		restoreProperty(process.stdin, "setRawMode", descriptors.setRawMode);
	});

	it("records the terminal's 16-bit selection color reply as hex without leaking it into input", () => {
		const { terminal, writes, received } = startTerminal();
		try {
			expect(writes.some(write => write.includes("\x1b]17;?\x07\x1b[c"))).toBe(true);
			process.stdin.emit("data", "\x1b]17;rgb:3333/6666/9999\x1b\\");
			expect(getTerminalSelectionBackground()).toBe("#336699");
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("leaves the color unknown when the DA1 sentinel answers first, and still swallows a late reply", () => {
		const { terminal, received } = startTerminal();
		try {
			for (let i = 0; i < 6; i++) process.stdin.emit("data", "\x1b[?1;2c");
			expect(getTerminalSelectionBackground()).toBeUndefined();
			process.stdin.emit("data", "\x1b]17;rgb:ff/00/00\x07");
			expect(getTerminalSelectionBackground()).toBe("#ff0000");
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});
});
