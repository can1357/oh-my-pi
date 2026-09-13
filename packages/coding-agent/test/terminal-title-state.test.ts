import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
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

	beforeEach(async () => {
		originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		// Its own agent directory, so this never writes into the caller's real terminal-sessions
		// directory and two suites cannot race for one filename. Through the environment rather
		// than setAgentDir(), because that is what the resolver reads back.
		agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-state-file-test-"));
		process.env.TMUX_PANE = PANE;
		process.env.PI_CODING_AGENT_DIR = path.join(agentRoot, "agent");
		restoreEnvValue("OMP_PROFILE", undefined);
		restoreEnvValue("PI_PROFILE", undefined);
		__resetDirsFromEnvForTests();
	});

	afterEach(async () => {
		// Before anything else: a spy left installed here is inherited by whatever file runs
		// next in the same module registry, together with its call history.
		vi.restoreAllMocks();

		setAgentStateFileEnabled(false);
		await agentStateFileSettled();

		for (const key of ENV_KEYS) restoreEnvValue(key, originalEnv[key]);
		__resetDirsFromEnvForTests();

		if (agentRoot) await fs.rm(agentRoot, { recursive: true, force: true });
		agentRoot = undefined;
	});

	it("writes nothing while the setting is off", async () => {
		setAgentStateFileEnabled(false);
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(false);
	});

	it("records the state the title shows, and removes the file when switched off", async () => {
		setAgentStateFileEnabled(true);

		setTerminalTitleState("working");
		await agentStateFileSettled();
		expect((await Bun.file(stateFile()).json()).state).toBe("working");

		// The one that matters: nothing else can distinguish this from a long think.
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		const written = await Bun.file(stateFile()).json();
		expect(written.state).toBe("attention");
		expect(written.pid).toBe(process.pid);

		setAgentStateFileEnabled(false);
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(false);
	});

	it("removes the file off the event loop when the setting is switched off at runtime", async () => {
		// /settings applies this on the TUI event loop. A synchronous unlink there freezes the
		// interface while a stalled NFS home answers; only exit and teardown may block on the disk.
		//
		// A write held in flight makes the difference observable: a queued removal has to wait
		// behind it, a synchronous one would have removed the file before the call returned.
		setAgentStateFileEnabled(true);
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(true);

		const entered = Promise.withResolvers<void>();
		const held = Promise.withResolvers<number>();
		spyOn(Bun, "write").mockImplementationOnce(() => {
			entered.resolve();
			return held.promise;
		});
		setTerminalTitleState("working");
		await entered.promise;

		try {
			setAgentStateFileEnabled(false);
			expect(await Bun.file(stateFile()).exists()).toBe(true);
		} finally {
			// Released whatever the assertion did: a write left held stalls every test after this one.
			held.resolve(0);
		}
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(false);
	});

	it("registers its removal for an exit that never reaches dispose, and only for a real one", async () => {
		// SIGTERM/SIGHUP and the fatal handler run the postmortem callbacks and leave, so the
		// removal has to be one of them. It must also be exitOnly: a keep-alive pass is not this
		// agent's end, and clearing the file there would blind a reader mid-session.
		//
		// Only this registration is invoked. postmortem.cleanup() would run every callback the
		// shared test process has loaded - shell snapshots, LSP and SSH resources - and this test
		// has no business tearing those down.
		const register = spyOn(postmortem, "register");

		setAgentStateFileEnabled(true);
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(true);

		const registration = register.mock.calls.find(call => call[0] === "agent-state-file");
		expect(registration?.[2]).toEqual({ exitOnly: true });

		await registration?.[1](postmortem.Reason.SIGTERM);
		expect(await Bun.file(stateFile()).exists()).toBe(false);
	});

	it("does not publish an update that a removal overtook mid-flight", async () => {
		// The update yields at every await, and the teardown and exit removal is synchronous, so it
		// can land between the last check and the rename completing - finding nothing to delete,
		// because the file does not exist yet. The rename then publishes a state for a process that
		// is gone. (Switching the setting off queues its removal instead, so it cannot land here.)
		//
		// The stand-in mimics exactly that: the removal happens first, and the rename lands
		// anyway. A mock that let the rename fail would pass without the guard and prove nothing.
		setAgentStateFileEnabled(true);
		const rename = spyOn(fs, "rename");
		rename.mockImplementationOnce(async (from, to) => {
			const body = await Bun.file(from as string).text();
			disposeTerminalTitleState();
			await Bun.write(to as string, body);
		});

		setTerminalTitleState("attention");
		await agentStateFileSettled();

		expect(rename).toHaveBeenCalledTimes(1);
		expect(await Bun.file(stateFile()).exists()).toBe(false);
		expect(await Bun.file(`${stateFile()}.${process.pid}.tmp`).exists()).toBe(false);
	});

	it("does not leave a rolled-back state file behind when a removal lands during a Windows replacement", async () => {
		// On Windows, replacing an existing file moves it to a backup first. A teardown or exit removal
		// landing in that window deletes the pending file, the replacement fails, and the helper rolls the backup back
		// into place - restoring a state for a process that is being torn down.
		//
		// Linux never takes that path, so the stand-in drives it: the first rename fails with EPERM,
		// the removal runs just before the pending file is moved, and the real renames do the rest.
		setAgentStateFileEnabled(true);
		setTerminalTitleState("working");
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(true);

		const realRename = fs.rename;
		const rename = spyOn(fs, "rename");
		rename
			.mockImplementationOnce(async () => {
				throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			})
			.mockImplementationOnce((from, to) => realRename(from, to))
			.mockImplementationOnce(async (from, to) => {
				disposeTerminalTitleState();
				return realRename(from, to);
			});

		setTerminalTitleState("attention");
		await agentStateFileSettled();

		// Failed replace, target to backup, pending to target (gone), backup rolled back.
		expect(rename).toHaveBeenCalledTimes(4);
		expect(await Bun.file(stateFile()).exists()).toBe(false);
		const leftovers = (await fs.readdir(path.dirname(stateFile()))).filter(name =>
			name.startsWith(path.basename(stateFile())),
		);
		expect(leftovers).toEqual([]);
	});

	it("leaves no file behind when the runtime is disposed", async () => {
		setAgentStateFileEnabled(true);
		setTerminalTitleState("attention");
		await agentStateFileSettled();
		expect(await Bun.file(stateFile()).exists()).toBe(true);

		// A state file outliving its process would report "waiting on you" for ever.
		disposeTerminalTitleState();
		expect(await Bun.file(stateFile()).exists()).toBe(false);
	});
});
