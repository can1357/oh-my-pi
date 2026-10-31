import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import * as utils from "@oh-my-pi/pi-utils";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

const DA1_REPLY = "\x1b[?1;2c";
const HELLO_REPLY = '\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col","text"],"credits":3,"future":1}\x1b\\';
const EVENT = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":1}\x1b\\';

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const originalNative = Bun.env.PI_TUI_NATIVE;
const originalTmux = Bun.env.TMUX;
const originalTmuxPane = Bun.env.TMUX_PANE;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
}

/** Run inside tmux pane %3 whose session option `@tern-tsp` reads `ternTsp`; returns the tmux argvs run. */
function mockTmux(ternTsp: string): string[][] {
	Bun.env.TMUX = "/tmp/tmux-501/default,1,0";
	Bun.env.TMUX_PANE = "%3";
	const commands: string[][] = [];
	vi.spyOn(utils, "$which").mockImplementation(name => (name === "tmux" ? "/usr/bin/tmux" : null));
	vi.spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[]) => {
		const args = cmd.slice(1);
		if (cmd[0] === "/usr/bin/tmux") commands.push(args);
		const stdout = args[0] === "show-options" ? `${ternTsp}\n` : "";
		return { exitCode: 0, stdout: Buffer.from(stdout), success: true };
	}) as never);
	return commands;
}

/**
 * Run `body` in a pane whose TSP-relevant environment is exactly `env`, with the
 * probe enabled as outside `bun test` (no `PI_TUI_NATIVE`); restores the environment.
 */
function inPane(env: Record<string, string>, body: () => void): void {
	const saved = { ...Bun.env };
	try {
		for (const key of [...TERMINAL_MULTIPLEXER_ENV_KEYS, "TERM_PROGRAM", "DEVENV_RELOAD_FILE", "PI_TUI_NATIVE"]) {
			delete Bun.env[key];
		}
		Bun.env.PI_TUI_TSP_PROBE = "1";
		Object.assign(Bun.env, env);
		body();
	} finally {
		for (const key of Object.keys(Bun.env)) if (!(key in saved)) delete Bun.env[key];
		Object.assign(Bun.env, saved);
	}
}

const TSP_FALLBACK_LOG = "TSP: Tern pane keeps the classic renderer";

const GATE_OFF = ["set-option", "-p", "-t", "%3", "allow-set-title", "off"];
const GATE_RESTORE = ["set-option", "-pu", "-t", "%3", "allow-set-title"];

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
		// Whatever tmux runs the test suite must not count.
		delete Bun.env.TMUX;
		delete Bun.env.TMUX_PANE;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreEnv("TMUX", originalTmux);
		restoreEnv("TMUX_PANE", originalTmuxPane);
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

	it.each([
		// A dev shell or rc file rewrote TERM; Tern's identity survives and no session marker exists.
		["a Tern pane with a rewritten screen TERM", { TERM_PROGRAM: "tern", TERM: "screen-256color" }, true, true],
		[
			"a Tern pane inside screen",
			{ TERM_PROGRAM: "tern", TERM: "screen-256color", STY: "4242.pts-0.host" },
			false,
			false,
		],
		["a Tern pane inside zellij", { TERM_PROGRAM: "tern", TERM: "xterm-kitty", ZELLIJ: "0" }, false, false],
		// devenv 2.x redraws its shell from its own emulator: DA1 passes, APC does not.
		[
			"a Tern pane inside devenv's reloading shell",
			{ TERM_PROGRAM: "tern", TERM: "xterm-kitty", DEVENV_RELOAD_FILE: "/p/.devenv/reload-env.sh" },
			false,
			false,
		],
		// Without Tern's identity, a screen TERM still stands for a session whose markers were stripped.
		["a screen TERM without Tern's identity", { TERM: "screen-256color" }, false, false],
		// PI_TUI_NATIVE=1 still forces the probe past a multiplexer, never the optimistic surface.
		["a forced probe inside zellij", { TERM_PROGRAM: "tern", ZELLIJ: "0", PI_TUI_NATIVE: "1" }, true, false],
	])("decides the probe for %s", (_name, env, probes, expected) => {
		inPane(env, () => {
			const { terminal, writes, hellos } = setup();
			try {
				expect(writes.join("").includes("\x1b_tsp;")).toBe(probes);
				expect(terminal.tspExpected).toBe(expected);
				if (!probes) expect(hellos).toEqual([null]);
			} finally {
				terminal.stop();
			}
		});
	});

	it("never probes in a Tern pane inside tmux without @tern-tsp, and logs why", () => {
		const debug = vi.spyOn(logger, "debug");
		inPane({ TERM_PROGRAM: "tern", TERM: "tmux-256color" }, () => {
			mockTmux("");
			const { terminal, writes, hellos } = setup();
			try {
				expect(writes.join("")).not.toContain("tsp;");
				expect(hellos).toEqual([null]);
				expect(debug.mock.calls.filter(call => call[0] === TSP_FALLBACK_LOG)).toEqual([
					[TSP_FALLBACK_LOG, { reason: expect.stringContaining("@tern-tsp") }],
				]);
			} finally {
				terminal.stop();
			}
		});
	});

	it("logs once why a Tern pane whose probe lost to DA1 keeps the classic renderer", () => {
		const debug = vi.spyOn(logger, "debug");
		inPane({ TERM_PROGRAM: "tern", TERM: "xterm-kitty" }, () => {
			const { terminal, hellos } = setup();
			try {
				for (let i = 0; i < 10 && hellos.length === 0; i++) process.stdin.emit("data", DA1_REPLY);
				expect(hellos).toEqual([null]);
				// A restart (external editor) probes again and loses again: the log already says why.
				terminal.stop();
				terminal.start(
					() => {},
					() => {},
				);
				for (let i = 0; i < 10 && terminal.tspProbePending; i++) process.stdin.emit("data", DA1_REPLY);
				expect(terminal.tspProbePending).toBe(false);
				expect(debug.mock.calls.filter(call => call[0] === TSP_FALLBACK_LOG)).toEqual([
					[TSP_FALLBACK_LOG, { reason: expect.stringContaining("DA1") }],
				]);
			} finally {
				terminal.stop();
			}
		});
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

	it("never probes inside tmux without @tern-tsp, even with PI_TUI_NATIVE=1", () => {
		const commands = mockTmux("");
		const { terminal, writes, hellos } = setup();
		try {
			expect(writes.join("")).not.toContain("tsp;");
			expect(hellos).toEqual([null]);
			expect(terminal.tspExpected).toBe(false);
			terminal.stop();
			expect(commands).not.toContainEqual(GATE_OFF);
			expect(commands).not.toContainEqual(GATE_RESTORE);
		} finally {
			terminal.stop();
		}
	});

	it("probes inside tmux with @tern-tsp: gates APC titles, sends hello without DA1, resolves on the reply", () => {
		delete Bun.env.PI_TUI_NATIVE;
		const commands = mockTmux("1");
		const { terminal, writes, hellos } = setup();
		try {
			expect(commands).toContainEqual(["show-options", "-qv", "@tern-tsp"]);
			expect(commands).toContainEqual(GATE_OFF);
			const out = writes.join("");
			const hello = out.indexOf("\x1b_tsp;");
			expect(hello).toBeGreaterThanOrEqual(0);
			expect(out.slice(hello)).not.toMatch(/^\x1b_tsp;[^\x1b]*\x1b\\\x1b\[c/);
			expect(terminal.tspExpected).toBe(false);
			// tmux answers DA1 itself: a DA1 reply must not end the probe.
			process.stdin.emit("data", DA1_REPLY);
			expect(terminal.tspProbePending).toBe(true);
			process.stdin.emit("data", HELLO_REPLY);
			expect(hellos).toHaveLength(1);
			expect(hellos[0]?.term).toBe("tern");
			expect(commands).not.toContainEqual(GATE_RESTORE);
			terminal.stop();
			expect(commands.filter(c => c[1] === "-pu")).toEqual([GATE_RESTORE]);
		} finally {
			terminal.stop();
		}
	});

	it("resolves the tmux probe to null after 1 s without a reply and restores APC titles", () => {
		vi.useFakeTimers();
		const commands = mockTmux("1");
		const { terminal, hellos } = setup();
		try {
			vi.advanceTimersByTime(999);
			expect(hellos).toEqual([]);
			expect(terminal.tspProbePending).toBe(true);
			vi.advanceTimersByTime(1);
			expect(hellos).toEqual([null]);
			expect(commands).toContainEqual(GATE_RESTORE);
			process.stdin.emit("data", HELLO_REPLY);
			expect(hellos).toEqual([null]);
			terminal.stop();
			expect(commands.filter(c => c[1] === "-pu")).toHaveLength(1);
		} finally {
			terminal.stop();
		}
	});
});
