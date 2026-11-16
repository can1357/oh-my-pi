import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { terminalMultiplexerEnvKeys } from "@oh-my-pi/pi-natives";
import { type FakeTtyTerminal, fakeTtyTerminal } from "./helpers/fake-tty-terminal";

const QUERY = "\x1b]7501;?\x1b\\\x1b[c";
const DA1_REPLY = "\x1b[?1;2c";
const REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error\x1b\\";
const envKeys = [...terminalMultiplexerEnvKeys(), "PI_TUI_PROGRAM_STATUS_PROBE"];

// Reply parsing, the sentinel race, and swallowing replies from stdin are the
// engine's (session and input tests); these cases pin the JS subscription
// contract across terminal restarts and the multiplexer gate.
describe("OSC 7501 program-status negotiation", () => {
	let savedEnv: Record<string, string | undefined>;
	let tty: FakeTtyTerminal | undefined;

	beforeEach(() => {
		savedEnv = {};
		for (const key of envKeys) {
			savedEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		Bun.env.PI_TUI_PROGRAM_STATUS_PROBE = "1";
	});

	afterEach(() => {
		tty?.dispose();
		tty = undefined;
		for (const key of envKeys) {
			if (savedEnv[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = savedEnv[key];
		}
	});

	function startTerminal(): FakeTtyTerminal & { results: boolean[] } {
		const started = fakeTtyTerminal();
		tty = started;
		const results: boolean[] = [];
		started.terminal.onProgramStatusSupport(supported => results.push(supported));
		started.terminal.start();
		return Object.assign(started, { results });
	}

	it("confirms a direct terminal that answers and replays the answer to late subscribers", () => {
		const { terminal, output, feed, received, results } = startTerminal();
		expect(output()).toContain(QUERY);

		feed(REPLY.slice(0, 20));
		feed(REPLY.slice(20));

		expect(results).toEqual([true]);
		const late: boolean[] = [];
		terminal.onProgramStatusSupport(supported => late.push(supported));
		expect(late).toEqual([true]);
		// The sentinels answered afterwards change nothing and reach no one.
		for (let i = 0; i < 15; i++) feed(DA1_REPLY);
		expect(results).toEqual([true]);
		expect(received).toEqual([]);
	});

	it("invalidates support on stop and reprobes the resumed terminal", () => {
		const { terminal, output, feed, results } = startTerminal();
		const late: boolean[] = [];

		feed(REPLY);
		expect(results).toEqual([true]);
		terminal.stop();
		expect(results).toEqual([true, false]);

		terminal.start();
		expect(output().split(QUERY)).toHaveLength(3);
		feed(REPLY);
		expect(results).toEqual([true, false, true]);
		const unsubscribe = terminal.onProgramStatusSupport(supported => late.push(supported));
		expect(late).toEqual([true]);
		unsubscribe();
		terminal.stop();
		expect(late).toEqual([true]);
		expect(results).toEqual([true, false, true, false]);
	});

	it("does not query behind a multiplexer that cannot route the reply", () => {
		Bun.env.TMUX = "/tmp/tmux/default,1,0";
		const { output, results } = startTerminal();
		expect(output()).toContain("\x1b[c");
		expect(output()).not.toContain("\x1b]7501;");
		expect(results).toEqual([]);
	});
});
