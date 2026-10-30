import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSessionTerminalLabel,
	buildTerminalTitleWithState,
	disposeTerminalTitleState,
	setTerminalTitle,
	initTerminalTitleState,
	popTerminalTitle,
	setSessionTerminalTitle,
	setTerminalSessionSource,
	setTerminalTitleSpinnerStyle,
	setTerminalTitleState,
	setTerminalTitleTaskNow,
} from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
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
		const frame0 = buildTerminalTitleWithState(LABEL, "working", 0, true, "linux", "braille", {});
		const frame1 = buildTerminalTitleWithState(LABEL, "working", 1, true, "linux", "braille", {});
		// The brand stays a bare `π`; only the separator between brand and label
		// carries the spinner glyph, and it advances per frame.
		expect(frame0).toBe(`${BRAND} ⠋ ${LABEL}`);
		expect(frame1).toBe(`${BRAND} ⠙ ${LABEL}`);
		expect(frame1).not.toBe(frame0);
		// The frame index is taken modulo the frame count, so it never throws or
		// produces an "undefined" separator for a large counter.
		const wrapped = buildTerminalTitleWithState(LABEL, "working", 9999, true, "linux", "braille", {});
		expect(wrapped.startsWith(`${BRAND} `)).toBe(true);
		expect(wrapped.endsWith(` ${LABEL}`)).toBe(true);
		expect(wrapped).not.toContain("undefined");
	});

	it("animates spinner frames in the separator slot while working on Windows", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "win32")).toBe(`${BRAND} ⠋ ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, "win32")).toBe(`${BRAND} ⠙ ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "working", 1, true, "win32")).toBe(`${BRAND} ⠙`);
	});

	it("keeps the state visible as a trailing separator when there is no label", () => {
		expect(buildTerminalTitleWithState(undefined, "idle", 0, true)).toBe(`${BRAND} >`);
		expect(buildTerminalTitleWithState(undefined, "attention", 0, true)).toBe(`${BRAND} !`);
		expect(buildTerminalTitleWithState(undefined, "working", 0, true, "linux", "braille", {})).toBe(`${BRAND} ⠋`);
	});

	it("renders the pre-state `π: label` layout when disabled, regardless of state", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 3, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "idle", 0, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "attention", 0, false)).toBe(`${BRAND}: ${LABEL}`);
		expect(buildTerminalTitleWithState(undefined, "idle", 0, false)).toBe(BRAND);
	});

	it("cycles the dots and line glyph sets while working", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "linux", "dots", {})).toBe(`${BRAND} ⠁ ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, "linux", "dots", {})).toBe(`${BRAND} ⠂ ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "linux", "line", {})).toBe(`${BRAND} - ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, "linux", "line", {})).toBe(`${BRAND} \\ ${LABEL}`);
	});

	it("cycles the pulse glyph set while working", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "linux", "pulse", {})).toBe(`${BRAND} ○ ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 4, true, "linux", "pulse", {})).toBe(`${BRAND} ● ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 8, true, "linux", "pulse", {})).toBe(`${BRAND} ○ ${LABEL}`);
	});

	it("cycles the selected style on Windows too", () => {
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "win32", "dots")).toBe(`${BRAND} ⠁ ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "win32", "pulse")).toBe(`${BRAND} ○ ${LABEL}`);
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "win32", "line")).toBe(`${BRAND} - ${LABEL}`);
	});

	it("keeps a static colon under WSL regardless of style", () => {
		const wslEnv = { WSL_DISTRO_NAME: "Ubuntu" };
		expect(buildTerminalTitleWithState(LABEL, "working", 0, true, "linux", "braille", wslEnv)).toBe(
			`${BRAND} : ${LABEL}`,
		);
		expect(buildTerminalTitleWithState(LABEL, "working", 1, true, "linux", "dots", wslEnv)).toBe(
			`${BRAND} : ${LABEL}`,
		);
		expect(buildTerminalTitleWithState(undefined, "working", 1, true, "linux", "line", wslEnv)).toBe(`${BRAND} :`);
	});
});

/**
 * Make `project` look like a repository root to the shared VCS API, without
 * spawning Git: lookups from the project or anything below it report that root.
 */
function stubProjectRepo(project: string): { mockRestore(): void } {
	const roots = [project, fs.realpathSync(project)];
	return spyOn(vcs, "repo").mockImplementation((dir: string) => {
		const root = roots.find(candidate => dir === candidate || dir.startsWith(`${candidate}${path.sep}`));
		return root === undefined ? null : ({ root: () => root } as unknown as VcsRepo);
	});
}

describe("session label carries the project", () => {
	let scratchDirs: string[] = [];
	let repoStubs: Array<{ mockRestore(): void }> = [];

	afterEach(() => {
		for (const stub of repoStubs) stub.mockRestore();
		repoStubs = [];
		for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
		scratchDirs = [];
	});

	function makeProject(projectName: string): string {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tabtitle-"));
		scratchDirs.push(scratch);
		const project = path.join(scratch, projectName);
		fs.mkdirSync(project, { recursive: true });
		repoStubs.push(stubProjectRepo(project));
		return project;
	}

	function makePlainDir(dirName: string): string {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tabtitle-"));
		scratchDirs.push(scratch);
		const dir = path.join(scratch, dirName);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	it("puts the project first in the label", () => {
		const project = makeProject("demo-repo");
		expect(buildSessionTerminalLabel("Fix the build", project)).toBe("demo-repo · Fix the build");
		expect(buildTerminalTitleWithState(buildSessionTerminalLabel("Fix the build", project), "idle", 0, true)).toBe(
			`${BRAND} > demo-repo · Fix the build`,
		);
	});

	it("keeps the project inside a 25-character truncation", () => {
		const project = makeProject("demo-repo");
		const label = buildSessionTerminalLabel("Investigate the flaky upstream job", project);
		expect(label!.slice(0, 25).startsWith("demo-repo")).toBe(true);
	});

	it("keeps the task half at about forty characters", () => {
		const project = makeProject("demo-repo");
		const label = buildSessionTerminalLabel("a".repeat(60), project);
		expect(label?.startsWith("demo-repo · ")).toBe(true);
		expect(label?.endsWith("…")).toBe(true);
		expect(label!.slice("demo-repo · ".length).length).toBeLessThanOrEqual(40);
	});

	it("uses the session name alone when there is no cwd", () => {
		expect(buildSessionTerminalLabel("my-session", undefined)).toBe("my-session");
	});

	it("falls back to the directory name when there is no session name", () => {
		// The VCS lookup is stubbed to "no repository": a scratch dir under /tmp may
		// have its own `.git` uphill on some machines. The cwd stays real.
		const repoSpy = spyOn(vcs, "repo").mockReturnValue(null);
		try {
			expect(buildSessionTerminalLabel(undefined, makePlainDir("lonely-dir"))).toBe("lonely-dir");
		} finally {
			repoSpy.mockRestore();
		}
	});

	it("resolves the project from a subdirectory of the repo root", () => {
		const project = makeProject("demo-repo");
		const nested = path.join(project, "sub", "dir");
		fs.mkdirSync(nested, { recursive: true });
		expect(buildSessionTerminalLabel("Deep fix", nested)).toBe("demo-repo · Deep fix");
	});

	it("takes the project from whatever root the shared VCS API reports (Jujutsu included)", () => {
		const plain = makePlainDir("nested-cwd");
		const repoSpy = spyOn(vcs, "repo").mockReturnValue({ root: () => "/work/jj-project" } as unknown as VcsRepo);
		try {
			expect(buildSessionTerminalLabel("Deep fix", plain)).toBe("jj-project · Deep fix");
		} finally {
			repoSpy.mockRestore();
		}
	});

	it("resolves the project through a symlinked cwd", () => {
		const project = makeProject("demo-repo");
		const link = path.join(path.dirname(project), "linked-dir");
		fs.symlinkSync(project, link);
		expect(buildSessionTerminalLabel("Deep fix", link)).toBe("demo-repo · Deep fix");
	});

	it("uses the discovered project even when the cwd does not exist", () => {
		const project = makeProject("demo-repo");
		expect(buildSessionTerminalLabel("Fix", path.join(project, "never-created"))).toBe("demo-repo · Fix");
	});

	it("revalidates the project when a nearer repository appears or disappears", () => {
		const cwd = makePlainDir("new");
		let root: string | undefined = "/work/outer";
		const repoSpy = spyOn(vcs, "repo").mockImplementation(() =>
			root ? ({ root: () => root } as unknown as VcsRepo) : null,
		);
		try {
			expect(buildSessionTerminalLabel("Fix", cwd)).toBe("outer · Fix");
			root = cwd;
			expect(buildSessionTerminalLabel("Fix", cwd)).toBe("new · Fix");
			root = undefined;
			expect(buildSessionTerminalLabel("Fix", cwd)).toBe("new · Fix");
			root = "/work/restored";
			expect(buildSessionTerminalLabel("Fix", cwd)).toBe("restored · Fix");
		} finally {
			repoSpy.mockRestore();
		}
	});

	it("uses only the basename for a remote cwd, even one that exists locally", () => {
		// A collab guest echoing the host's cwd must not walk the local filesystem:
		// here the "remote" path is a real local repo, and still only its last
		// segment is used, not the repo root above it.
		const project = makeProject("demo-repo");
		const nested = path.join(project, "sub");
		fs.mkdirSync(nested);
		expect(buildSessionTerminalLabel("Fix thing", nested, undefined, true)).toBe("sub · Fix thing");
	});

	it("parses a Windows host cwd on any guest platform", () => {
		expect(buildSessionTerminalLabel("Fix thing", "C:\\work\\repo", undefined, true)).toBe("repo · Fix thing");
		expect(buildSessionTerminalLabel(undefined, "C:\\work\\repo\\", undefined, true)).toBe("repo");
		expect(buildSessionTerminalLabel("Fix thing", "/home/host/my-tool", undefined, true)).toBe("my-tool · Fix thing");
	});

	it("never truncates the project, even when the session name is exactly the project", () => {
		const longName = "a-very-long-repository-name-that-exceeds-forty-columns-by-far";
		const project = makeProject(longName);
		expect(buildSessionTerminalLabel(longName, project)).toBe(longName);
		expect(buildSessionTerminalLabel(`${longName} · ${"x".repeat(60)}`, project)).toBe(
			`${longName} · ${"x".repeat(39)}…`,
		);
	});

	it("caps a de-duplicated overlong task by display width", () => {
		const project = makeProject("demo-repo");
		const label = buildSessionTerminalLabel(`demo-repo · ${"漢".repeat(40)}`, project)!;
		expect(label.startsWith("demo-repo · ")).toBe(true);
		expect(Bun.stringWidth(label.slice("demo-repo · ".length))).toBeLessThanOrEqual(40);
	});

	it("falls back to the directory name outside a repo", () => {
		// Same stub as above: pin the true no-repo branch.
		const repoSpy = spyOn(vcs, "repo").mockReturnValue(null);
		try {
			expect(buildSessionTerminalLabel("Fix thing", makePlainDir("lonely"))).toBe("lonely · Fix thing");
		} finally {
			repoSpy.mockRestore();
		}
	});

	it("keeps the project across a rename", () => {
		const project = makeProject("demo-repo");
		expect(buildSessionTerminalLabel("Topic A", project)).toBe("demo-repo · Topic A");
		expect(buildSessionTerminalLabel("Topic B", project)).toBe("demo-repo · Topic B");
	});

	it("shows the in-progress todo row as the task half", () => {
		const project = makeProject("demo-repo");
		expect(buildSessionTerminalLabel("Topic A", project, "Collect statistics")).toBe(
			"demo-repo · Collect statistics",
		);
	});

	it("does not duplicate the project when the session name already carries it", () => {
		const project = makeProject("demo-repo");
		expect(buildSessionTerminalLabel("demo-repo · Something", project)).toBe("demo-repo · Something");
		expect(buildSessionTerminalLabel("demo-repo", project)).toBe("demo-repo");
	});
});

describe("label tracks what the session is doing now", () => {
	let scratchDirs: string[] = [];
	let writes: string[] = [];
	let repoStubs: Array<{ mockRestore(): void }> = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;

	function makeProject(projectName: string): string {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tabtitle-"));
		scratchDirs.push(scratch);
		const project = path.join(scratch, projectName);
		fs.mkdirSync(project, { recursive: true });
		repoStubs.push(stubProjectRepo(project));
		return project;
	}

	function lastTitle(): string | undefined {
		return writes
			.map(payload => /\x1b\]0;([\s\S]*?)\x07/.exec(payload)?.[1])
			.filter((t): t is string => t !== undefined)
			.at(-1);
	}

	beforeEach(() => {
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});
		initTerminalTitleState();
		setTerminalTitleSpinnerStyle("braille");
		setTerminalTitleState("idle");
	});

	afterEach(() => {
		disposeTerminalTitleState();
		stdoutSpy?.mockRestore();
		stdoutSpy = undefined;
		for (const stub of repoStubs) stub.mockRestore();
		repoStubs = [];
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
		for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
		scratchDirs = [];
	});

	it("moves the OSC title to the in-progress todo row and back", () => {
		const project = makeProject("demo-repo");
		setSessionTerminalTitle("Topic A", project);
		expect(lastTitle()).toBe(`${BRAND} > demo-repo · Topic A`);
		setTerminalTitleTaskNow("Collect statistics");
		expect(lastTitle()).toBe(`${BRAND} > demo-repo · Collect statistics`);
		setTerminalTitleTaskNow(undefined);
		expect(lastTitle()).toBe(`${BRAND} > demo-repo · Topic A`);
	});

	it("refreshes the OSC project after native repository discovery changes at the same cwd", () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tabtitle-native-"));
		scratchDirs.push(scratch);
		const outer = path.join(scratch, "outer");
		const inner = path.join(outer, "new");
		fs.mkdirSync(inner, { recursive: true });
		const initialize = (dir: string): void => {
			fs.mkdirSync(path.join(dir, ".git", "objects"), { recursive: true });
			fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
			fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
			fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
		};
		initialize(outer);
		setSessionTerminalTitle("Fix", inner);
		expect(lastTitle()).toBe(`${BRAND} > outer · Fix`);
		initialize(inner);
		setTerminalTitleTaskNow("New task");
		expect(lastTitle()).toBe(`${BRAND} > new · New task`);
		fs.rmSync(path.join(inner, ".git"), { recursive: true });
		setTerminalTitleTaskNow(undefined);
		expect(lastTitle()).toBe(`${BRAND} > outer · Fix`);
		fs.rmSync(path.join(outer, ".git"), { recursive: true });
		setSessionTerminalTitle("Plain", inner);
		expect(lastTitle()).toBe(`${BRAND} > new · Plain`);
	});

	it("composes the task half against the focused session, then returns to the main one", () => {
		const main = makeProject("main-repo");
		const worker = makeProject("worker-tree");
		setSessionTerminalTitle("Main topic", main);
		setTerminalTitleTaskNow("Worker step", { sessionName: "Worker topic", cwd: worker });
		expect(lastTitle()).toBe(`${BRAND} > worker-tree · Worker step`);
		// Clearing the focused session's task falls back to that session, not the main one.
		setTerminalTitleTaskNow(undefined, { sessionName: "Worker topic", cwd: worker });
		expect(lastTitle()).toBe(`${BRAND} > worker-tree · Worker topic`);
		setTerminalTitleTaskNow("Main step", { sessionName: "Main topic", cwd: main });
		expect(lastTitle()).toBe(`${BRAND} > main-repo · Main step`);
	});

	it("keeps startup todos pending until the terminal is claimed and the project is supplied", () => {
		const project = makeProject("startup-repo");
		setSessionTerminalTitle(undefined);
		disposeTerminalTitleState();
		writes = [];
		setTerminalTitleTaskNow("Initial title task");
		expect(lastTitle()).toBeUndefined();
		initTerminalTitleState();
		setTerminalTitleState("idle");
		expect(lastTitle()?.includes("Initial title task") ?? false).toBe(false);
		setSessionTerminalTitle("Session card", project);
		expect(lastTitle()).toBe(`${BRAND} > startup-repo · Initial title task`);
		setTerminalTitleTaskNow(undefined);
	});

	it("keeps the project in the OSC title when the session is renamed", () => {
		const project = makeProject("demo-repo");
		setSessionTerminalTitle("Topic A", project);
		setSessionTerminalTitle("Topic B", project);
		expect(lastTitle()).toBe(`${BRAND} > demo-repo · Topic B`);
	});

	it("a remote collab cwd keeps its host-side name across task updates", () => {
		setSessionTerminalTitle("Topic A", "C:\\work\\host-repo", { remoteCwd: true });
		expect(lastTitle()).toBe(`${BRAND} > host-repo · Topic A`);
		setTerminalTitleTaskNow("Do it");
		expect(lastTitle()).toBe(`${BRAND} > host-repo · Do it`);
		setTerminalTitleTaskNow(undefined);
		setSessionTerminalTitle(undefined);
	});

	it("carries the composed label into the native TSP title", () => {
		const project = makeProject("demo-repo");
		try {
			setNativeRendering(true);
			setSessionTerminalTitle("Topic A", project);
			expect(lastTitle()).toBe("demo-repo · Topic A");
		} finally {
			setNativeRendering(false);
		}
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

/** Titles observed through either sink (OSC writes plus the native title mock). */
function observedTitles(writes: string[], windowsTitleMock: WindowsConsoleTitleMock | undefined): string[] {
	const osc = writes
		.map(payload => /\x1b\]0;([\s\S]*?)\x07/.exec(payload)?.[1])
		.filter((t): t is string => t !== undefined);
	return [...osc, ...(windowsTitleMock?.titles ?? [])];
}

function resetObserved(writes: string[], windowsTitleMock: WindowsConsoleTitleMock | undefined): void {
	writes.length = 0;
	if (windowsTitleMock) windowsTitleMock.titles.length = 0;
}

describe("disposeTerminalTitleState", () => {
	let writes: string[] = [];
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let windowsTitleMock: WindowsConsoleTitleMock | undefined;
	// Under WSL the working title is a static `:` by design; hide the host's WSL markers so the spinner ticks.
	const wslEnvKeys = ["WSL_DISTRO_NAME", "WSL_INTEROP"] as const;
	let savedWslEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		vi.useFakeTimers();
		savedWslEnv = Object.fromEntries(wslEnvKeys.map(key => [key, Bun.env[key]]));
		for (const key of wslEnvKeys) delete Bun.env[key];

		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		windowsTitleMock = mockWindowsConsoleTitle();
		windowsTitleMock.succeeds = true;
		writes = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});

		// Drive the module-global to a known state from the public API so the
		// tests are order-independent: the UI owns the terminal (the previous
		// test's teardown latched it off), a fresh session base, run state idle.
		initTerminalTitleState();
		setTerminalTitleSpinnerStyle("braille");
		setSessionTerminalTitle("my-project");
		setTerminalTitleState("idle");
		resetObserved(writes, windowsTitleMock);
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
		for (const key of wslEnvKeys) {
			const value = savedWslEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	it("stops the spinner so no further OSC-title write fires on a tick after dispose", () => {
		// CONTRACT (the fix): entering `working` arms the spinner interval; once
		// `disposeTerminalTitleState()` runs, advancing the clock across many tick
		// periods must produce ZERO additional OSC-title writes. A pending tick
		// re-emitting the title after teardown is exactly the shell-tab leak.
		setTerminalTitleState("working");

		// Control: BEFORE dispose the interval is live — advancing the clock across
		// several 80ms tick periods DOES emit further OSC-title writes (proves the
		// timer was actually running, so the post-dispose silence is meaningful and
		// not a headless/TTY misconfiguration masking all writes).
		resetObserved(writes, windowsTitleMock);
		vi.advanceTimersByTime(400);
		const ticksWhileLive = observedTitles(writes, windowsTitleMock).length;
		expect(ticksWhileLive).toBeGreaterThan(0);

		// The fix under test.
		disposeTerminalTitleState();

		// After dispose: advance far past many tick periods. No tick may fire.
		resetObserved(writes, windowsTitleMock);
		vi.advanceTimersByTime(4000);
		expect(observedTitles(writes, windowsTitleMock)).toEqual([]);
	});

	it("latches: a direct setTerminalTitle after dispose cannot write the shell's tab", () => {
		// `setTerminalTitle` is EXPORTED and writes OSC/Win32 straight out, so it
		// bypasses the composed-state path entirely. A direct importer firing from
		// a delayed callback after teardown — the same window the spinner latch
		// covers — would otherwise land in the parent shell's tab, whose title
		// `popTerminalTitle()` has already restored.

		// Control: before dispose the sink really does write, so the silence below
		// is the latch and not a headless/TTY misconfiguration.
		resetObserved(writes, windowsTitleMock);
		setTerminalTitle("live write");
		expect(observedTitles(writes, windowsTitleMock).length).toBeGreaterThan(0);

		disposeTerminalTitleState();

		resetObserved(writes, windowsTitleMock);
		setTerminalTitle("after teardown");
		expect(observedTitles(writes, windowsTitleMock)).toEqual([]);

		// And the latch releases only on the explicit ownership path.
		initTerminalTitleState();
		resetObserved(writes, windowsTitleMock);
		setTerminalTitle("owned again");
		expect(observedTitles(writes, windowsTitleMock).length).toBeGreaterThan(0);
	});

	it("latches: a run-state change after dispose cannot re-arm the spinner", () => {
		// CONTRACT: dispose is teardown, not a pause. `InteractiveMode.shutdown()`
		// calls `disposeTerminalTitleState()` and `popTerminalTitle()` BEFORE
		// `this.stop()` unsubscribes the session, so in that window a live
		// `#handleAgentStart` can still call `setTerminalTitleState("working")`.
		// If dispose only stops the timer, that call re-arms it and a tick writes
		// `π ⠋ …` into the parent shell's tab — the exact leak the ordering
		// comment in `shutdown()` claims to prevent.
		disposeTerminalTitleState();

		resetObserved(writes, windowsTitleMock);
		setTerminalTitleState("working");

		// Assert on the TIMER, not only the writes: the `emitTerminalTitle` latch
		// already silences anything a re-armed interval would emit, so a write-only
		// assertion cannot tell "never re-armed" from "re-armed and ticking
		// silently forever" — the latter leaks an interval past shutdown that no
		// later dispose reaches.
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(4000);
		expect(observedTitles(writes, windowsTitleMock)).toEqual([]);
	});

	it("keeps a routine session title update from releasing the latch", () => {
		// CONTRACT (the leak): `setSessionTerminalTitle` is reached by ordinary
		// session updates — rename, cwd change, collab host frame, and an
		// extension `newSession()` resuming past its `await`. That last one can
		// land AFTER `shutdown()` disposed and `popTerminalTitle()` handed the tab
		// back, and `stop()` cannot cancel it. If a routine update released the
		// latch, this write — and a re-armed spinner behind it — would land in the
		// parent shell's tab. Only terminal ownership (`initTerminalTitleState`)
		// releases it.
		setTerminalTitleState("working");
		disposeTerminalTitleState();

		resetObserved(writes, windowsTitleMock);
		setSessionTerminalTitle("late-async-session");

		expect(observedTitles(writes, windowsTitleMock)).toEqual([]);
		// And nothing re-armed behind the silence: a live interval past shutdown
		// is a leak no later dispose reaches.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("re-emits on ownership release even when the new session's title is unchanged", () => {
		// CONTRACT: `popTerminalTitle()` hands the terminal back to the shell, so
		// after dispose the runtime does NOT know what is on screen. Deduping the
		// first post-release write against a pre-dispose `lastEmitted` would leave
		// the shell's own title in place while the runtime believes it owns the
		// tab. Same label in and out is the case that catches it.
		setSessionTerminalTitle("same-session");
		setTerminalTitleState("idle");
		disposeTerminalTitleState();

		resetObserved(writes, windowsTitleMock);
		initTerminalTitleState();
		setSessionTerminalTitle("same-session");

		expect(observedTitles(writes, windowsTitleMock).some(title => title.includes("same-session"))).toBe(true);
	});

	it("emits the selected glyph set on the next spinner tick", () => {
		setTerminalTitleSpinnerStyle("line");
		setTerminalTitleState("working");
		resetObserved(writes, windowsTitleMock);

		vi.advanceTimersByTime(400);

		const titles = observedTitles(writes, windowsTitleMock);
		expect(titles.length).toBeGreaterThan(0);
		for (const title of titles) {
			expect(title).toContain("my-project");
			expect(title).toMatch(/^π [-\\|/] my-project$/);
			expect(title).not.toContain("⠋");
		}
	});

	it("falls back to braille for an unknown style", () => {
		setTerminalTitleSpinnerStyle("line");
		setTerminalTitleSpinnerStyle("nope");
		setTerminalTitleState("working");
		resetObserved(writes, windowsTitleMock);

		vi.advanceTimersByTime(160);

		const titles = observedTitles(writes, windowsTitleMock);
		expect(titles.length).toBeGreaterThan(0);
		expect(titles.some(title => title?.includes("⠋") || title?.includes("⠙"))).toBe(true);
	});

	it("emits pulse frames on live ticks", () => {
		setTerminalTitleSpinnerStyle("pulse");
		setTerminalTitleState("working");
		resetObserved(writes, windowsTitleMock);

		vi.advanceTimersByTime(400);

		const titles = observedTitles(writes, windowsTitleMock);
		expect(titles.length).toBeGreaterThan(0);
		for (const title of titles) {
			expect(title).toContain("my-project");
			expect(title).toMatch(/^π [○◔◑◕●] my-project$/);
		}
	});

	it("releases the latch and re-arms a live spinner when the terminal is claimed again", () => {
		// CONTRACT: the latch is teardown-scoped, not permanent. Claiming the
		// terminal again owns the title, so it must resume — including a LIVE
		// spinner if the run state is still `working`. Releasing the flag alone
		// would leave a stopped timer behind a `working` state: a frozen frame.
		setTerminalTitleState("working");
		disposeTerminalTitleState();

		resetObserved(writes, windowsTitleMock);
		initTerminalTitleState();
		setSessionTerminalTitle("next-session");

		// The new session's title emitted...
		expect(observedTitles(writes, windowsTitleMock).some(title => title.includes("next-session"))).toBe(true);

		// ...and the spinner is genuinely ticking again, not frozen on one frame.
		resetObserved(writes, windowsTitleMock);
		vi.advanceTimersByTime(400);
		expect(observedTitles(writes, windowsTitleMock).length).toBeGreaterThan(0);
	});

	it("clears the title before popping the saved one on shutdown", () => {
		// CONTRACT: a terminal without a title stack ignores the pop, so the clear
		// is all that takes omp's title off the tab. A terminal with a stack must
		// see the pop last, or the clear would wipe the title it restored.
		disposeTerminalTitleState();
		popTerminalTitle();
		expect(writes).toEqual(["\x1b]0;\x07\x1b[23;2t"]);
	});

	it("restores the initial Windows console title on teardown and does not overwrite it on pop", () => {
		const originalPlatform = process.platform;
		const native = windowsTitleMock;
		if (!native) throw new Error("Windows console title mock not initialized");
		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			native.current = "original-shell-title";

			initTerminalTitleState();
			setSessionTerminalTitle("running-session");
			expect(native.titles).toContain("π > running-session");

			resetObserved(writes, native);
			// The `InteractiveMode.shutdown()` order: dispose, then pop.
			disposeTerminalTitleState();
			expect(native.titles.at(-1)).toBe("original-shell-title");

			// ConPTY applies OSC 0 as a console-title set: the clear would blank the restore.
			popTerminalTitle();
			expect(writes).toEqual([]);
			expect(native.titles.at(-1)).toBe("original-shell-title");
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});
});

// Tern names omp's directory in its composer bar from the OSC 7 omp writes, as
// it does for a shell's prompt; other terminals must not hear it.
describe("reporting the session to Tern", () => {
	const OSC7 = /\x1b\]7;([^\x07]*)\x07/g;
	let writes = "";
	let stdoutSpy: { mockRestore(): void } | undefined;
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;
	let prevTermProgram: string | undefined;

	beforeEach(() => {
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		prevTermProgram = Bun.env.TERM_PROGRAM;
		Bun.env.TERM_PROGRAM = "tern";
		writes = "";
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
			return true;
		});
		initTerminalTitleState();
	});

	afterEach(() => {
		disposeTerminalTitleState();
		stdoutSpy?.mockRestore();
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		if (prevTermProgram === undefined) delete Bun.env.TERM_PROGRAM;
		else Bun.env.TERM_PROGRAM = prevTermProgram;
		setTerminalHeadless(prevHeadless);
	});

	it.skipIf(process.platform === "win32")("reports the directory with OSC 7 when it changes", () => {
		let cwd = "/work/my project";
		setTerminalSessionSource({ file: () => undefined, cwd: () => cwd });
		// Retitling in the same directory says nothing new.
		setSessionTerminalTitle("my-project");
		cwd = "/work/other";
		setSessionTerminalTitle("my-project");
		expect([...writes.matchAll(OSC7)].map(match => match[1])).toEqual([
			`file://${os.hostname()}/work/my%20project`,
			`file://${os.hostname()}/work/other`,
		]);
	});

	it("reports nothing to other terminals", () => {
		Bun.env.TERM_PROGRAM = "ghostty";
		setTerminalSessionSource({ file: () => undefined, cwd: () => "/work/other" });
		setSessionTerminalTitle("my-project");
		expect(writes).not.toContain("\x1b]7;");
	});
});
