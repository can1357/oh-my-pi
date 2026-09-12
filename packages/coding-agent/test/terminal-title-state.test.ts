import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildTerminalTitleWithState,
	disposeTerminalTitleState,
	agentStateFileSettled,
	setAgentStateFileEnabled,
	setSessionTerminalTitle,
	setTerminalTitleState,
} from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { getTerminalId, isConPTYHosted } from "@oh-my-pi/pi-tui";
import {
	__resetDirsFromEnvForTests,
	getTerminalSessionsDir,
	postmortem,
	setTerminalHeadless,
} from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";
import { mockWindowsConsoleTitle, type WindowsConsoleTitleMock } from "./terminal-title-test-utils";

const LABEL = "my-project";
// The brand the title runtime prefixes every composed title with. Plain π —
// window titles render in the OS UI font, so nerd-font glyphs are unusable here.
const BRAND = "π";

describe("buildTerminalTitleWithState", () => {
	it("separates brand and label with '>' when idle/done (your turn)", () => {
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, true)).toBe(`${BRAND} > ${LABEL}`);
	});

	it("separates brand and label with '!' when the agent needs attention", () => {
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, true)).toBe(`${BRAND} ! ${LABEL}`);
	});

	it("animates spinner frames in the separator slot while working outside Windows", () => {
		const frame0 = buildTerminalTitleWithState(LABEL, "working", 0, true, "linux");
		const frame1 = buildTerminalTitleWithState(LABEL, "working", 1, true, "linux");
		// The brand stays a bare `π`; only the separator between brand and label
		// carries the spinner glyph, and it advances per frame.
		expect(frame0).toBe(`${BRAND} ⠋ ${LABEL}`);
		expect(frame1).toBe(`${BRAND} ⠙ ${LABEL}`);
		expect(frame1).not.toBe(frame0);
		// The frame index is taken modulo the frame count, so it never throws or
		// produces an "undefined" separator for a large counter.
		const wrapped = buildTerminalTitleWithState(LABEL, "working", 9999, true, "linux");
		expect(wrapped.startsWith(`${BRAND} `)).toBe(true);
		expect(wrapped.endsWith(` ${LABEL}`)).toBe(true);
		expect(wrapped).not.toContain("undefined");
	});

	it("uses a static colon while working on Windows", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "win32")).toBe(`${BRAND} : ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, "win32")).toBe(`${BRAND} : ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "working", 1, true, "win32")).toBe(`${BRAND} :`);
	});

	it("keeps the state visible as a trailing separator when there is no label", () => {
		expect(buildTerminalTitleWithState(undefined, "idle", 0, true)).toBe(`${BRAND} >`);
		expect(buildTerminalTitleWithState(undefined, "attention", 0, true)).toBe(`${BRAND} !`);
		expect(buildTerminalTitleWithState(undefined, "working", 0, true, "linux")).toBe(`${BRAND} ⠋`);
	});

	it("renders the pre-state `π: label` layout when disabled, regardless of state", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 3, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "idle", 0, false)).toBe(BRAND);
	});
});

// Regression coverage for the shutdown-leak bug (PR #4451): the run-state
// `working` spinner arms a periodic `setInterval` that, on every tick, re-emits
// the terminal title as an OSC-0 write (`ESC]0;<title>BEL`). If that interval is
// not cleared on teardown, a pending tick can fire AFTER the shell title was
// restored, leaving the parent shell tab reading `π ⠋ …` post-exit.
// `disposeTerminalTitleState()` (now wired into `InteractiveMode.shutdown()`)
// must stop the timer so no further OSC-title write reaches stdout.
//
// The contract is pinned at the observable sink — `process.stdout.write` — not
// at the timer plumbing. Two seams are opened so the real write path runs under
// `bun test`, mirroring the sibling `terminal title runtime` suite:
//   - `isTerminalHeadless()` defaults to true in the test runtime and short-
//     circuits `setTerminalTitle` before any write; opt out with
//     `setTerminalHeadless(false)` and restore it.
//   - `setTerminalTitle` (and the spinner start) also no-op unless
//     `process.stdout.isTTY`; force it true and restore.
// `vi.useFakeTimers()` makes the real 80ms interval advanceable without a
// wall-clock wait, so the test is fully deterministic.

const OSC_TITLE_SEQ = "\x1b]0;";

describe("disposeTerminalTitleState", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;

	beforeEach(() => {
		vi.useFakeTimers();

		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		windowsTitleMock = mockWindowsConsoleTitle();
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		// Drive the module-global to a known state from the public API so the
		// tests are order-independent: a fresh session base, run state idle.
		setSessionTerminalTitle("my-project");
		setTerminalTitleState("idle");
		writes.length = 0;
	});

	afterEach(() => {
		// A started interval must never leak between tests.
		disposeTerminalTitleState();
		stdoutSpy?.mockRestore();
		windowsTitleMock?.restore();
		windowsTitleMock = undefined;
		stdoutSpy = undefined;
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
		vi.useRealTimers();
	});

	it.skipIf(isConPTYHosted())("stops the spinner so no further OSC-title write fires on a tick after dispose", () => {
		// CONTRACT (the fix): entering `working` arms the spinner interval; once
		// `disposeTerminalTitleState()` runs, advancing the clock across many tick
		// periods must produce ZERO additional OSC-title writes. A pending tick
		// re-emitting the title after teardown is exactly the shell-tab leak.
		setTerminalTitleState("working");

		// Control: BEFORE dispose the interval is live — advancing the clock across
		// several 80ms tick periods DOES emit further OSC-title writes (proves the
		// timer was actually running, so the post-dispose silence is meaningful and
		// not a headless/TTY misconfiguration masking all writes).
		writes.length = 0;
		vi.advanceTimersByTime(400);
		const ticksWhileLive = writes.filter(payload => payload.includes(OSC_TITLE_SEQ)).length;
		expect(ticksWhileLive).toBeGreaterThan(0);

		// The fix under test.
		disposeTerminalTitleState();

		// After dispose: advance far past many tick periods. No tick may fire.
		writes.length = 0;
		vi.advanceTimersByTime(4000);
		expect(writes.filter(payload => payload.includes(OSC_TITLE_SEQ))).toEqual([]);
	});
});

describe("agent state file", () => {
	// The title already carries the state, but only a terminal emulator can read a title. This is
	// the same state, offered where any program can poll it.
	const stateFile = (): string => {
		const terminalId = getTerminalId();
		if (!terminalId) throw new Error("no terminal id in this test environment");
		return path.join(getTerminalSessionsDir(), `${terminalId}.state.json`);
	};

	// A test runner has no controlling terminal, so `getTerminalId()` would find nothing and the
	// feature would correctly write nothing. Standing in as a multiplexer pane gives the same
	// stable identity a real session has - but the runner may itself be inside tmux, so the
	// caller's value is put back afterwards rather than deleted.
	const PANE = "%omp-state-file-test";
	// Everything setAgentDir would touch, captured by name: it rewrites the directory resolver
	// and clears the profile variables process-wide, so putting one value back is not enough.
	const ENV_KEYS = ["TMUX_PANE", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
	let originalEnv: Record<string, string | undefined> = {};
	let agentRoot: string | undefined;

	beforeEach(() => {
		originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		// Its own agent directory, so this never writes into the caller's real terminal-sessions
		// directory and two suites cannot race for one filename. Through the environment rather
		// than setAgentDir(), because that is what the resolver reads back.
		agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-state-file-test-"));
		process.env.TMUX_PANE = PANE;
		process.env.PI_CODING_AGENT_DIR = path.join(agentRoot, "agent");
		restoreEnvValue("OMP_PROFILE", undefined);
		restoreEnvValue("PI_PROFILE", undefined);
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		setAgentStateFileEnabled(false);
		await agentStateFileSettled();

		for (const key of ENV_KEYS) restoreEnvValue(key, originalEnv[key]);
		__resetDirsFromEnvForTests();

		if (agentRoot) fs.rmSync(agentRoot, { recursive: true, force: true });
		agentRoot = undefined;
	});

	it("writes nothing while the setting is off", async () => {
		setAgentStateFileEnabled(false);
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("records the state the title shows, and removes the file when switched off", async () => {
		setAgentStateFileEnabled(true);

		setTerminalTitleState("working");
		await agentStateFileSettled();
		expect(JSON.parse(fs.readFileSync(stateFile(), "utf8")).state).toBe("working");

		// The one that matters: nothing else can distinguish this from a long think.
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		const written = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
		expect(written.state).toBe("attention");
		expect(written.pid).toBe(process.pid);

		setAgentStateFileEnabled(false);
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("survives a keep-alive cleanup pass, because the agent is still running", async () => {
		// The removal is registered with postmortem so a signal exit - which never reaches
		// disposeTerminalTitleState - cannot leave the file behind. It is registered exitOnly:
		// a manual keep-alive pass is not this agent's end, and deleting the file there would
		// blind a reader in the middle of a session.
		setAgentStateFileEnabled(true);
		setTerminalTitleState("attention");
		await agentStateFileSettled();

		await postmortem.cleanup();

		expect(fs.existsSync(stateFile())).toBe(true);
		expect(JSON.parse(fs.readFileSync(stateFile(), "utf8")).state).toBe("attention");
	});

	it("does not publish an update that a removal overtook mid-flight", async () => {
		// The update yields at every await, and a removal is synchronous, so it can land between
		// the last check and the rename completing - finding nothing to delete, because the file
		// does not exist yet. The rename then publishes a state for a process that is gone.
		//
		// The stand-in mimics exactly that: the removal happens first, and the rename lands
		// anyway. A mock that let the rename fail would pass without the guard and prove nothing.
		setAgentStateFileEnabled(true);
		const rename = spyOn(fsPromises, "rename");
		rename.mockImplementationOnce(async (from, to) => {
			const body = fs.readFileSync(from as string, "utf8");
			setAgentStateFileEnabled(false);
			fs.writeFileSync(to as string, body);
		});

		setTerminalTitleState("attention");
		await agentStateFileSettled();

		expect(rename).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(stateFile())).toBe(false);
		expect(fs.existsSync(`${stateFile()}.${process.pid}.tmp`)).toBe(false);
	});

	it("leaves no file behind when the runtime is disposed", async () => {
		setAgentStateFileEnabled(true);
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		expect(fs.existsSync(stateFile())).toBe(true);

		// A state file outliving its process would report "waiting on you" for ever.
		disposeTerminalTitleState();
		expect(fs.existsSync(stateFile())).toBe(false);
	});
});
