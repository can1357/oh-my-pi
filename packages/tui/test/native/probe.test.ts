import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { terminalMultiplexerEnvKeys } from "@oh-my-pi/pi-natives";
import type { TspHello } from "@oh-my-pi/pi-tui/native/encode";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { fakeTmuxCalls, withFakeTmux } from "../helpers/fake-tmux";
import { type FakeTtyTerminal, fakeTtyTerminal } from "../helpers/fake-tty-terminal";

const DA1_REPLY = "\x1b[?1;2c";
const HELLO_REPLY = '\x1b_tsp;r;{"r":"hello","v":1,"term":"tern","kinds":["col","text"],"credits":3,"future":1}\x1b\\';
const EVENT = '\x1b_tsp;e;{"ev":"ack","sf":"s:1","s":1}\x1b\\';

const originalNative = Bun.env.PI_TUI_NATIVE;
const originalTmux = Bun.env.TMUX;
const originalTmuxPane = Bun.env.TMUX_PANE;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete Bun.env[key];
	else Bun.env[key] = value;
}

/**
 * Run `body` inside tmux pane %3 whose session option `@tern-tsp` reads
 * `ternTsp`, against a fake tmux CLI; `commands()` lists the tmux invocations
 * so far as space-joined argument lists.
 */
async function inTmux(ternTsp: string, body: (commands: () => string[]) => void): Promise<void> {
	await withFakeTmux({ "show-options -qv @tern-tsp": ternTsp }, async binDir => {
		const previousPath = Bun.env.PATH;
		Bun.env.TMUX = "/tmp/tmux-501/default,1,0";
		Bun.env.TMUX_PANE = "%3";
		Bun.env.PATH = `${binDir}:${previousPath ?? ""}`;
		try {
			body(() => fakeTmuxCalls(binDir));
		} finally {
			restoreEnv("PATH", previousPath);
		}
	});
}

/**
 * Run `body` in a pane whose TSP-relevant environment is exactly `env`, with the
 * probe enabled as outside `bun test` (no `PI_TUI_NATIVE`); restores the environment.
 */
function inPane(env: Record<string, string>, body: () => void): void {
	const saved = { ...Bun.env };
	try {
		for (const key of [...terminalMultiplexerEnvKeys(), "TERM_PROGRAM", "DEVENV_RELOAD_FILE", "PI_TUI_NATIVE"]) {
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

const GATE_OFF = "set-option -p -t %3 allow-set-title off";
const GATE_RESTORE = "set-option -pu -t %3 allow-set-title";

let tty: FakeTtyTerminal | undefined;

/** A surface transition the engine's handshake reported to the host. */
interface SurfaceTransition {
	live: boolean;
	hello: TspHello | undefined;
}

/** A started ProcessTerminal on a faked TTY whose surface transitions are recorded; disposed after each test. */
function setup(): FakeTtyTerminal & { surfaces: SurfaceTransition[] } {
	const started = fakeTtyTerminal();
	tty = started;
	const surfaces: SurfaceTransition[] = [];
	started.terminal.bind(
		{
			input: data => {
				started.received.push(data);
			},
			paste: () => {},
			render: () => {},
			resize: () => {},
			nativeSurface: (live, hello) => {
				surfaces.push({ live, hello });
			},
		},
		started.clock,
	);
	started.terminal.start();
	return Object.assign(started, { surfaces });
}

// The probe's sequencing (DA1 FIFO, OSC 877 framing, the tmux reply window) and
// the surface handshake are the engine's (session and surface tests). These
// cases pin the JS side: the environment decisions, the decoded `hello`
// reaching the host with the surface, TSP events reaching the host, tmux
// APC-title gating, and the fallback log.
describe("TSP hello probe", () => {
	beforeEach(() => {
		Bun.env.PI_TUI_NATIVE = "1";
		// Whatever tmux runs the test suite must not count.
		delete Bun.env.TMUX;
		delete Bun.env.TMUX_PANE;
	});

	afterEach(() => {
		tty?.dispose();
		tty = undefined;
		vi.restoreAllMocks();
		restoreEnv("TMUX", originalTmux);
		restoreEnv("TMUX_PANE", originalTmuxPane);
		restoreEnv("PI_TUI_NATIVE", originalNative);
	});

	it("opens the surface with a hello reply torn across stdin reads, then hands events to the host whole", () => {
		// Outside a Tern pane: no optimistic surface ahead of the reply.
		inPane({}, () => {
			const { terminal, feed, received, surfaces } = setup();
			expect(terminal.tspProbePending).toBe(true);
			expect(surfaces).toEqual([]);

			feed(HELLO_REPLY.slice(0, 30));
			feed(HELLO_REPLY.slice(30));

			expect(surfaces).toHaveLength(1);
			expect(surfaces[0]?.live).toBe(true);
			expect(surfaces[0]?.hello?.credits).toBe(3);
			expect(terminal.tspProbePending).toBe(false);

			feed(EVENT);
			expect(received).toEqual([EVENT]);
		});
	});

	it("confirms the surface a Tern pane opened ahead of the reply", () => {
		inPane({ TERM_PROGRAM: "tern", TERM: "xterm-kitty" }, () => {
			const { feed, surfaces } = setup();
			expect(surfaces).toEqual([{ live: true, hello: undefined }]);
			feed(HELLO_REPLY);
			expect(surfaces).toHaveLength(2);
			expect(surfaces[1]?.live).toBe(true);
			expect(surfaces[1]?.hello?.credits).toBe(3);
		});
	});

	it("expects TSP from TERM_PROGRAM=tern, except inside a multiplexer or with PI_TUI_NATIVE=0", () => {
		const saved = { ...Bun.env };
		// A headless terminal (the `bun test` default) never expects TSP.
		const previousHeadless = setTerminalHeadless(false);
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
			setTerminalHeadless(previousHeadless);
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
			const { terminal, output, surfaces } = setup();
			expect(output().includes("\x1b_tsp;")).toBe(probes);
			expect(terminal.tspExpected).toBe(expected);
			// An expected surface opens on assumed capabilities ahead of the reply.
			expect(surfaces).toEqual(expected ? [{ live: true, hello: undefined }] : []);
		});
	});

	it.skipIf(process.platform === "win32")(
		"never probes in a Tern pane inside tmux without @tern-tsp, and logs why",
		async () => {
			const debug = vi.spyOn(logger, "debug");
			await inTmux("", () =>
				inPane({ TERM_PROGRAM: "tern", TERM: "tmux-256color", TMUX: Bun.env.TMUX ?? "" }, () => {
					const { output, surfaces } = setup();
					expect(output()).not.toContain("tsp;");
					expect(surfaces).toEqual([]);
					expect(debug.mock.calls.filter(call => call[0] === TSP_FALLBACK_LOG)).toEqual([
						[TSP_FALLBACK_LOG, { reason: expect.stringContaining("@tern-tsp") }],
					]);
				}),
			);
		},
	);

	it("logs once why a Tern pane whose probe lost to DA1 keeps the classic renderer", () => {
		const debug = vi.spyOn(logger, "debug");
		inPane({ TERM_PROGRAM: "tern", TERM: "xterm-kitty" }, () => {
			const { terminal, feed, surfaces } = setup();
			// One sentinel per outstanding probe in the FIFO; answer until ours resolves.
			for (let i = 0; i < 10 && terminal.tspProbePending; i++) feed(DA1_REPLY);
			// The surface the environment promised opened optimistically and was revoked.
			expect(surfaces).toEqual([
				{ live: true, hello: undefined },
				{ live: false, hello: undefined },
			]);
			// A restart (external editor) probes again and loses again: the log already says why.
			terminal.stop();
			terminal.start();
			expect(terminal.tspProbePending).toBe(true);
			for (let i = 0; i < 10 && terminal.tspProbePending; i++) feed(DA1_REPLY);
			expect(terminal.tspProbePending).toBe(false);
			expect(debug.mock.calls.filter(call => call[0] === TSP_FALLBACK_LOG)).toEqual([
				[TSP_FALLBACK_LOG, { reason: expect.stringContaining("DA1") }],
			]);
		});
	});

	it("never probes with PI_TUI_NATIVE=0", () => {
		Bun.env.PI_TUI_NATIVE = "0";
		const { output, surfaces } = setup();
		expect(output()).not.toContain("\x1b_tsp;");
		expect(surfaces).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"never probes inside tmux without @tern-tsp, even with PI_TUI_NATIVE=1",
		async () => {
			await inTmux("", commands => {
				const { terminal, output, surfaces } = setup();
				expect(output()).not.toContain("tsp;");
				expect(surfaces).toEqual([]);
				expect(terminal.tspExpected).toBe(false);
				terminal.stop();
				expect(commands()).not.toContain(GATE_OFF);
				expect(commands()).not.toContain(GATE_RESTORE);
			});
		},
	);

	it.skipIf(process.platform === "win32")(
		"probes inside tmux with @tern-tsp: gates APC titles, sends hello without DA1, resolves on the reply",
		async () => {
			delete Bun.env.PI_TUI_NATIVE;
			await inTmux("1", commands => {
				const { terminal, output, feed, surfaces } = setup();
				expect(commands()).toContain("show-options -qv @tern-tsp");
				expect(commands()).toContain(GATE_OFF);
				const out = output();
				const hello = out.indexOf("\x1b_tsp;");
				expect(hello).toBeGreaterThanOrEqual(0);
				expect(out.slice(hello)).not.toMatch(/^\x1b_tsp;[^\x1b]*\x1b\\\x1b\[c/);
				expect(terminal.tspExpected).toBe(false);
				// tmux answers DA1 itself: a DA1 reply must not end the probe.
				feed(DA1_REPLY);
				expect(terminal.tspProbePending).toBe(true);
				feed(HELLO_REPLY);
				expect(surfaces).toHaveLength(1);
				expect(surfaces[0]?.live).toBe(true);
				expect(surfaces[0]?.hello?.term).toBe("tern");
				expect(commands()).not.toContain(GATE_RESTORE);
				terminal.stop();
				expect(commands().filter(c => c.startsWith("set-option -pu"))).toEqual([GATE_RESTORE]);
			});
		},
	);

	it.skipIf(process.platform === "win32")(
		"gives up on the tmux probe after 1 s without a reply and restores APC titles",
		async () => {
			await inTmux("1", commands => {
				const { terminal, clock, feed, surfaces } = setup();
				clock.advance(999);
				expect(terminal.tspProbePending).toBe(true);
				clock.advance(1);
				expect(terminal.tspProbePending).toBe(false);
				expect(commands()).toContain(GATE_RESTORE);
				// A reply after the deadline opens nothing.
				feed(HELLO_REPLY);
				expect(surfaces).toEqual([]);
				terminal.stop();
				expect(commands().filter(c => c.startsWith("set-option -pu"))).toHaveLength(1);
			});
		},
	);
});
