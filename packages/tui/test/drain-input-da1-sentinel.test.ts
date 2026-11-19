import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

const ITERM2_DA1_REPLY = "\x1b[?64;1;2;4;6;17;18;21;22c";
const TSP_HELLO_REPLY =
	'\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col","text"],"credits":3,"future":1}\x1b\\';

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("drainInput DA1 sentinel gating", () => {
	withoutTerminalMultiplexer();

	let terminal: ProcessTerminal | undefined;
	let previousHeadless = false;
	let previousTspProbeEnv: string | undefined;
	let writes: string[] = [];
	let spies: Array<{ mockRestore(): void }> = [];

	beforeEach(() => {
		previousTspProbeEnv = Bun.env.PI_TUI_TSP_PROBE;
	});

	function setup(env: Record<string, string> = {}): void {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		writes = [];
		spies = [
			vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
				writes.push(String(chunk));
				return true;
			}),
			vi.spyOn(process, "kill").mockImplementation(() => true),
		];
		for (const [k, v] of Object.entries(env)) {
			Bun.env[k] = v;
		}
		terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
	}

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		for (const spy of spies) spy.mockRestore();
		spies = [];
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process.stdout, "columns", stdoutColumnsDescriptor);
		restoreProperty(process.stdout, "rows", stdoutRowsDescriptor);
		setTerminalHeadless(previousHeadless);
		if (previousTspProbeEnv === undefined) delete Bun.env.PI_TUI_TSP_PROBE;
		else Bun.env.PI_TUI_TSP_PROBE = previousTspProbeEnv;
	});

	it("does not write a DA1 sentinel on non-TSP terminals even when SIXEL is supported", async () => {
		setup();
		// Answer startup capability probes with iTerm2's SIXEL-advertising DA1 report
		for (let i = 0; i < 16; i++) {
			process.stdin.emit("data", ITERM2_DA1_REPLY);
		}

		writes.length = 0;
		await terminal!.drainInput(100, 20);

		const drainedWrites = writes.join("");
		expect(drainedWrites).not.toContain("\x1b[c");
	});

	it("writes a DA1 sentinel and awaits its answer when TSP is active", async () => {
		setup({ TERM_PROGRAM: "tern", PI_TUI_TSP_PROBE: "1" });

		// Deliver TSP hello reply and answer startup DA1 sentinels
		process.stdin.emit("data", TSP_HELLO_REPLY);
		for (let i = 0; i < 16; i++) {
			process.stdin.emit("data", ITERM2_DA1_REPLY);
		}

		writes.length = 0;
		const drainPromise = terminal!.drainInput(300, 20);
		expect(writes.join("")).toContain("\x1b[c");

		// Answer the exit drain DA1 sentinel
		process.stdin.emit("data", ITERM2_DA1_REPLY);
		await drainPromise;
	});

	it("writes a DA1 sentinel when TSP probe is expected and still pending", async () => {
		setup({ TERM_PROGRAM: "tern", PI_TUI_TSP_PROBE: "1" });

		// Answer the keyboard and OSC 11 sentinels so sixelSupport is established,
		// but leave the TSP sentinel and hello pending.
		process.stdin.emit("data", ITERM2_DA1_REPLY);
		process.stdin.emit("data", ITERM2_DA1_REPLY);
		expect(terminal!.tspProbePending).toBe(true);
		expect(terminal!.tspExpected).toBe(true);

		writes.length = 0;
		const drainPromise = terminal!.drainInput(300, 20);
		expect(writes.join("")).toContain("\x1b[c");

		// Deliver DA1 reply to settle the drain
		process.stdin.emit("data", ITERM2_DA1_REPLY);
		await drainPromise;
	});
});
