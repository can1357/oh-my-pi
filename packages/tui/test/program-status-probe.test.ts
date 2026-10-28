import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

const QUERY = "\x1b]7501;?\x1b\\\x1b[c";
const DA1_REPLY = "\x1b[?1;2c";
const REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error\x1b\\";
const envKeys = [...TERMINAL_MULTIPLEXER_ENV_KEYS, "PI_TUI_PROGRAM_STATUS_PROBE"];

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else Reflect.deleteProperty(target, key);
}

describe("OSC 7501 program-status negotiation", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedStdinTty: PropertyDescriptor | undefined;
	let savedStdoutTty: PropertyDescriptor | undefined;
	let savedRawMode: PropertyDescriptor | undefined;
	let previousHeadless: boolean;

	beforeEach(() => {
		savedEnv = {};
		for (const key of envKeys) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		Bun.env.PI_TUI_PROGRAM_STATUS_PROBE = "1";
		savedStdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		savedStdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		savedRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", savedStdinTty);
		restoreProperty(process.stdout, "isTTY", savedStdoutTty);
		restoreProperty(process.stdin, "setRawMode", savedRawMode);
		for (const key of envKeys) {
			if (savedEnv[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = savedEnv[key];
		}
	});

	function startTerminal() {
		const writes: string[] = [];
		const received: string[] = [];
		const results: boolean[] = [];
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
		const terminal = new ProcessTerminal();
		terminal.onProgramStatusSupport(supported => results.push(supported));
		terminal.start(
			data => received.push(data),
			() => {},
		);
		return { terminal, writes, received, results };
	}

	it("confirms any direct terminal that answers, even without Rex identity", () => {
		const { terminal, writes, received, results } = startTerminal();
		try {
			expect(writes).toContain(QUERY);
			process.stdin.emit("data", REPLY.slice(0, 20));
			process.stdin.emit("data", REPLY.slice(20));
			expect(results).toEqual([true]);
			const late: boolean[] = [];
			terminal.onProgramStatusSupport(supported => late.push(supported));
			expect(late).toEqual([true]);
			for (let i = 0; i < 15; i++) process.stdin.emit("data", DA1_REPLY);
			expect(results).toEqual([true]);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("invalidates support on stop and reprobes the resumed terminal", () => {
		const { terminal, writes, results } = startTerminal();
		const late: boolean[] = [];
		try {
			process.stdin.emit("data", REPLY);
			expect(results).toEqual([true]);
			terminal.stop();
			expect(results).toEqual([true, false]);

			terminal.start(
				() => {},
				() => {},
			);
			expect(writes.filter(write => write === QUERY)).toHaveLength(2);
			process.stdin.emit("data", REPLY);
			expect(results).toEqual([true, false, true]);
			const unsubscribe = terminal.onProgramStatusSupport(supported => late.push(supported));
			expect(late).toEqual([true]);
			unsubscribe();
		} finally {
			terminal.stop();
		}
		expect(late).toEqual([true]);
	});

	it("accepts the protocol's implicit state set when the reply omits states", () => {
		const { terminal, results } = startTerminal();
		try {
			process.stdin.emit("data", "\x1b]7501;?\x1b\\");
			expect(results).toEqual([true]);
		} finally {
			terminal.stop();
		}
	});

	it("leaves an unsupported terminal unconfirmed and swallows its late reply", () => {
		const { terminal, results, received } = startTerminal();
		try {
			for (let i = 0; i < 15 && results.length === 0; i++) process.stdin.emit("data", DA1_REPLY);
			expect(results).toEqual([false]);
			process.stdin.emit("data", REPLY);
			expect(results).toEqual([false]);
			expect(received).toEqual([]);
		} finally {
			terminal.stop();
		}
	});

	it("rejects a receiver without both working and blocked states", () => {
		const { terminal, results } = startTerminal();
		try {
			process.stdin.emit("data", "\x1b]7501;?:states=idle,working,done\x07");
			expect(results).toEqual([false]);
		} finally {
			terminal.stop();
		}
	});

	it("does not query behind a multiplexer that cannot route the reply", () => {
		Bun.env.TMUX = "/tmp/tmux/default,1,0";
		const { terminal, writes, results } = startTerminal();
		try {
			expect(writes).not.toContain(QUERY);
			expect(results).toEqual([]);
		} finally {
			terminal.stop();
		}
	});
});
