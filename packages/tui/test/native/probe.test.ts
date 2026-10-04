import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const DA1_REPLY = "\x1b[?1;2c";
const HELLO_REPLY = '\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col","text"],"credits":3,"future":1}\x1b\\';
const EVENT = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":1}\x1b\\';

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalNative = Bun.env.PI_TUI_NATIVE;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else delete (target as Record<string, unknown>)[key];
}

function setup() {
	const writes: string[] = [];
	const received: string[] = [];
	const hellos: (TspHello | null)[] = [];
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
	terminal.onTspHello(hello => hellos.push(hello));
	terminal.start(
		data => received.push(data),
		() => {},
	);
	return { terminal, writes, received, hellos };
}

describe("TSP hello probe", () => {
	let previousHeadless = false;

	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		Bun.env.PI_TUI_NATIVE = "1";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		if (originalNative === undefined) delete Bun.env.PI_TUI_NATIVE;
		else Bun.env.PI_TUI_NATIVE = originalNative;
		restoreProperty(process.stdin, "isTTY", stdinIsTty);
		restoreProperty(process.stdout, "isTTY", stdoutIsTty);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
	});

	it("resolves with a hello reply torn across stdin reads, then hands events to input whole", () => {
		const { terminal, received, hellos } = setup();
		try {
			expect(terminal.tspProbePending).toBe(true);
			process.stdin.emit("data", HELLO_REPLY.slice(0, 30));
			process.stdin.emit("data", HELLO_REPLY.slice(30));
			expect(hellos).toHaveLength(1);
			expect(hellos[0]?.credits).toBe(3);
			expect(terminal.tspProbePending).toBe(false);
			process.stdin.emit("data", EVENT);
			expect(received).toEqual([EVENT]);
		} finally {
			terminal.stop();
		}
	});

	it("takes the hello reply and events in their OSC 877 framing through a ConPTY", () => {
		const { terminal, received, hellos } = setup();
		try {
			const oscHello = `\x1b]877;${HELLO_REPLY.slice(2)}`;
			// Every probe's DA1 sentinel right behind the reply: none may resolve it to null.
			process.stdin.emit("data", oscHello.slice(0, 40));
			process.stdin.emit("data", `${oscHello.slice(40)}${DA1_REPLY.repeat(10)}`);
			expect(hellos).toHaveLength(1);
			expect(hellos[0]?.term).toBe("tern");
			expect(terminal.tspProbePending).toBe(false);
			// C1 code points arrive as JSON escapes; a BEL may end the OSC form.
			process.stdin.emit("data", '\x1b]877;tsp;e;{"ev":"input","sf":"s:1","id":"q","value":"a\\u0085b"}\x07');
			process.stdin.emit("data", `\x1b]877;${EVENT.slice(2)}`);
			expect(received).toEqual(['\x1b_tsp;e;{"ev":"input","sf":"s:1","id":"q","value":"a\\u0085b"}\x1b\\', EVENT]);
		} finally {
			terminal.stop();
		}
	});

	it("resolves to null when the DA1 sentinel arrives first, ignoring a late reply", () => {
		const { terminal, received, hellos } = setup();
		try {
			// One sentinel per outstanding probe in the FIFO; answer until ours resolves.
			for (let i = 0; i < 10 && hellos.length === 0; i++) process.stdin.emit("data", DA1_REPLY);
			expect(hellos).toEqual([null]);
			process.stdin.emit("data", HELLO_REPLY);
			expect(hellos).toEqual([null]);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("expects TSP from TERM_PROGRAM=tern, except inside a multiplexer or with PI_TUI_NATIVE=0", () => {
		const saved = { ...Bun.env };
		try {
			// Whatever multiplexer runs the test suite must not count.
			for (const key of Object.keys(Bun.env)) {
				if (/^(TMUX|STY|ZELLIJ|HERDR_|CMUX_|WMUX)/.test(key)) delete Bun.env[key];
			}
			Bun.env.TERM = "xterm-256color";
			const terminal = new ProcessTerminal();
			Bun.env.TERM_PROGRAM = "tern";
			expect(terminal.tspExpected).toBe(true);
			Bun.env.TERM_PROGRAM = "iTerm.app";
			expect(terminal.tspExpected).toBe(false);
			Bun.env.TERM_PROGRAM = "tern";
			Bun.env.TMUX = "/tmp/tmux-501/default,1,0";
			expect(terminal.tspExpected).toBe(false);
			delete Bun.env.TMUX;
			Bun.env.PI_TUI_NATIVE = "0";
			expect(terminal.tspExpected).toBe(false);
		} finally {
			for (const key of Object.keys(Bun.env)) if (!(key in saved)) delete Bun.env[key];
			Object.assign(Bun.env, saved);
		}
	});

	it("never probes with PI_TUI_NATIVE=0", () => {
		Bun.env.PI_TUI_NATIVE = "0";
		const { terminal, writes, hellos } = setup();
		try {
			expect(writes.join("")).not.toContain("\x1b_tsp;");
			expect(hellos).toEqual([null]);
		} finally {
			terminal.stop();
		}
	});
});
