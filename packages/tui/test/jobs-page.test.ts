import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { BackgroundJobsPage } from "@oh-my-pi/pi-tui/overlays/jobs-page";
import type {
	JobsPanelDetail,
	JobsPanelJob,
	JobsPanelSnapshot,
	JobsSheetSource,
} from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { stripTerminalSequences, visibleWidth } from "@oh-my-pi/pi-tui/utils";

// The page paints box chrome through the global theme (like Agent Hub), which the
// host initializes before the first paint.
beforeAll(async () => {
	await initTheme(false);
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ESC = "\x1b";
const TAB = "\t";
const ENTER = "\r";
const SPACE = " ";
const PGUP = "\x1b[5~";
const END = "\x1b[F";

const NOW = Date.now();

function bash(
	id: string,
	status: JobsPanelJob["status"],
	label: string,
	extra: Partial<JobsPanelJob> = {},
): JobsPanelJob {
	const job: JobsPanelJob = { id, type: "bash", status, label, startTime: NOW - 4_000, ...extra };
	return job;
}

/** A non-bash job of any type; the page's bash-only default must hide these. */
function job(
	type: string,
	id: string,
	status: JobsPanelJob["status"],
	label: string,
	extra: Partial<JobsPanelJob> = {},
): JobsPanelJob {
	return { id, type, status, label, startTime: NOW - 4_000, ...extra };
}

/** `count` numbered log lines with a trailing newline, newest last. */
function log(count: number, prefix: string): string {
	const lines: string[] = [];
	for (let index = 0; index < count; index++) lines.push(`${prefix} ${String(index + 1).padStart(2, "0")}`);
	return `${lines.join("\n")}\n`;
}

const JOBS: JobsPanelSnapshot = {
	running: [bash("bash-a", "running", "alpha run"), bash("bash-b", "running", "beta run")],
	recent: [bash("bash-c", "completed", "gamma run", { endTime: NOW - 100 })],
};

const DETAILS: Record<string, JobsPanelDetail> = {
	"bash-a": { command: "alpha run", cwd: "/work", pids: [7], output: log(3, "alpha") },
	"bash-b": { command: "beta run", cwd: "/work", pids: [8], output: log(3, "beta") },
	"bash-c": { command: "gamma run", cwd: "/work", pids: [], exitCode: 0, output: log(2, "gamma") },
};

/**
 * Task + eval + bash mix. Distinct output prefixes per job so a frame can be
 * negatively asserted: a leaked non-bash row or output is always detectable.
 */
const MIXED: JobsPanelSnapshot = {
	running: [
		job("task", "task-1", "running", "explore repo"),
		bash("bash-a", "running", "alpha run"),
		job("eval", "eval-1", "running", "smoke eval"),
	],
	recent: [
		bash("bash-c", "completed", "gamma run", { endTime: NOW - 100 }),
		job("task", "task-2", "failed", "dead task", { endTime: NOW - 50 }),
	],
};

const MIXED_DETAILS: Record<string, JobsPanelDetail> = {
	"task-1": { cwd: "/work", pids: [], output: log(3, "taskout") },
	"bash-a": { command: "alpha run", cwd: "/work", pids: [7], output: log(3, "alpha") },
	"eval-1": { cwd: "/work", pids: [], output: log(3, "evalout") },
	"bash-c": { command: "gamma run", cwd: "/work", pids: [], exitCode: 0, output: log(2, "gamma") },
	"task-2": { cwd: "/work", pids: [], exitCode: 1, output: log(2, "tasktwo") },
};

/** Plain text of a rendered frame, ANSI stripped for stable assertions. */
function plain(lines: readonly string[]): string {
	const out: string[] = [];
	for (const line of lines) out.push(stripTerminalSequences(line));
	return out.join("\n");
}

/** The visible capture rows of a rendered frame (numbered rows carrying the given prefix). */
function visibleCapture(lines: readonly string[], prefix: string): string[] {
	const rows: string[] = [];
	const marker = new RegExp(`\\b${prefix} \\d`);
	for (const row of plain(lines).split("\n")) if (marker.test(row)) rows.push(row);
	return rows;
}

/** The frame's top border row, where the roster title (filter word + running count) lives. */
function titleRow(lines: readonly string[]): string {
	return plain(lines).split("\n")[0] ?? "";
}

const pages: BackgroundJobsPage[] = [];

function setup(
	jobs: JobsPanelSnapshot = JOBS,
	options: {
		details?: Record<string, JobsPanelDetail>;
		inspect?: (id: string) => JobsPanelDetail | undefined;
		rows?: number;
		requestRender?: () => void;
	} = {},
) {
	const details = options.details ?? DETAILS;
	const term = { rows: options.rows ?? 30 };
	const requestRender = options.requestRender ?? (() => {});
	const ui = { terminal: term, requestRender } as unknown as TUI;
	const source = {
		load: () => jobs,
		inspect: options.inspect ?? ((id: string) => details[id]),
		cancel: vi.fn(),
		close: vi.fn(),
	} satisfies JobsSheetSource;
	const page = new BackgroundJobsPage(ui, source);
	pages.push(page);
	return { page, source, term };
}

afterEach(() => {
	for (const page of pages.splice(0)) page.dispose();
});

describe("BackgroundJobsPage", () => {
	it("lists every job in the frame and shows only the selected job's output", () => {
		const { page } = setup();
		const first = plain(page.render(120));
		expect(first).toContain("Background jobs");
		expect(first).toContain("bash-a");
		expect(first).toContain("bash-b");
		expect(first).toContain("Output");
		expect(first).toContain("alpha 01");
		expect(first).not.toContain("beta 01");

		page.handleInput(DOWN);
		const second = plain(page.render(120));
		expect(second).toContain("beta 01");
		expect(second).not.toContain("alpha 01");
	});

	it("keeps the selected id when the job settles and moves to the recent group", () => {
		const running = bash("bash-live", "running", "settle me");
		const other = bash("bash-hold", "running", "hold me");
		const snapshot: { running: JobsPanelJob[]; recent: JobsPanelJob[] } = { running: [running, other], recent: [] };
		let detail: JobsPanelDetail = {
			command: "settle me",
			cwd: "/work",
			pids: [3],
			output: `${log(2, "live")}`,
		};
		const { page } = setup(snapshot, { inspect: () => detail });
		expect(plain(page.render(120))).toContain("live 01");

		snapshot.running = [other];
		snapshot.recent = [{ ...running, status: "completed", endTime: NOW - 10 }];
		detail = {
			command: "settle me",
			cwd: "/work",
			pids: [],
			exitCode: 0,
			output: "live 01\nlive 02\nsettled done\n",
		};
		const settled = plain(page.render(120));
		expect(settled).toContain("bash-live");
		expect(settled).toContain("settled done");
		expect(settled).toContain("Recent");
	});

	it("pauses on a manual scroll, ignores appended output, and resumes the tail on End", () => {
		let output = log(40, "step");
		const jobs: JobsPanelSnapshot = { running: [bash("bash-log", "running", "tail -f build")], recent: [] };
		const { page } = setup(jobs, {
			rows: 20,
			inspect: () => ({ command: "tail -f build", cwd: "/work", pids: [9], output }),
		});
		page.handleInput(ENTER);
		const followed = plain(page.render(120));
		expect(followed).toContain("following");
		expect(followed).toContain("step 40");
		expect(followed).not.toContain("step 01");

		page.handleInput(PGUP);
		const paused = plain(page.render(120));
		expect(paused).toContain("paused");
		expect(paused).not.toContain("step 40");

		output += "step 41\n";
		const appended = plain(page.render(120));
		expect(appended).toContain("paused");
		expect(appended).not.toContain("step 41");

		page.handleInput(END);
		const resumed = plain(page.render(120));
		expect(resumed).toContain("following");
		expect(resumed).toContain("step 41");
	});

	it("keeps the paused viewport fixed when the source rolls its capture (drops leading rows)", () => {
		let output = log(40, "step");
		const jobs: JobsPanelSnapshot = { running: [bash("bash-roll", "running", "tail -f build")], recent: [] };
		const { page } = setup(jobs, {
			rows: 20,
			inspect: () => ({ command: "tail -f build", cwd: "/work", pids: [9], output }),
		});
		page.handleInput(ENTER);
		page.render(120);
		page.handleInput(PGUP);
		const before = visibleCapture(page.render(120), "step");
		expect(before.length).toBeGreaterThan(1);
		expect(plain(page.render(120))).toContain("paused");

		// The capture rolls: the first nine lines are dropped and nine new ones
		// appended, so absolute row indices no longer name the same content.
		const rolled: string[] = [];
		for (let index = 10; index <= 49; index++) rolled.push(`step ${String(index).padStart(2, "0")}`);
		output = `${rolled.join("\n")}\n`;

		const after = visibleCapture(page.render(120), "step");
		expect(after).toEqual(before);
		expect(plain(page.render(120))).not.toContain("step 45");

		page.handleInput(END);
		expect(plain(page.render(120))).toContain("step 49");
	});

	it("freezes the capture that was on screen when following stopped, even if it rolls before the next frame", () => {
		let output = log(40, "step");
		const jobs: JobsPanelSnapshot = { running: [bash("bash-roll", "running", "tail -f build")], recent: [] };
		const { page } = setup(jobs, {
			rows: 20,
			inspect: () => ({ command: "tail -f build", cwd: "/work", pids: [9], output }),
		});
		page.handleInput(ENTER);
		expect(visibleCapture(page.render(120), "step").length).toBeGreaterThan(0);

		// The capture is replaced wholesale — distinct prefix, dropped and appended
		// rows — after the keypress but before the first paused frame: the viewport
		// must keep showing rows of the capture that was on screen at the pause.
		page.handleInput(PGUP);
		const rolled: string[] = [];
		for (let index = 1; index <= 40; index++) rolled.push(`roll ${String(index).padStart(2, "0")}`);
		output = `${rolled.join("\n")}\n`;

		const pausedLog = visibleCapture(page.render(120), "step");
		expect(pausedLog.length).toBeGreaterThan(0);
		expect(visibleCapture(page.render(120), "roll")).toHaveLength(0);

		// Resuming follows the replacement capture's newest row.
		page.handleInput(END);
		const resumed = visibleCapture(page.render(120), "roll");
		expect(resumed.length).toBeGreaterThan(0);
		expect(resumed.at(-1)).toContain("roll 40");
	});

	it("keeps the frozen rows and live status when the paused capture empties", () => {
		let detail: JobsPanelDetail = {
			command: "tail -f build",
			cwd: "/work",
			pids: [9],
			output: log(40, "step"),
		};
		const job = bash("bash-empty", "running", "tail -f build");
		const snapshot: { running: JobsPanelJob[]; recent: JobsPanelJob[] } = { running: [job], recent: [] };
		const { page } = setup(snapshot, { rows: 20, inspect: () => detail });
		page.handleInput(ENTER);
		page.render(120);
		page.handleInput(PGUP);

		// The job settles and its captured text is consumed. The paused viewport
		// keeps rows of the capture it was showing while the status line catches up
		// to the live detail.
		detail = { command: "tail -f build", cwd: "/work", pids: [], exitCode: 0, output: "" };
		snapshot.running = [];
		snapshot.recent = [{ ...job, status: "completed", endTime: NOW - 10 }];

		const pausedFrame = page.render(120);
		expect(visibleCapture(pausedFrame, "step").length).toBeGreaterThan(0);
		const paused = plain(pausedFrame);
		expect(paused).toContain("Done");
		expect(paused).not.toContain("No output");

		// Resuming follows the live (now consumed) capture instead of the frozen one.
		page.handleInput(END);
		const resumedFrame = page.render(120);
		expect(visibleCapture(resumedFrame, "step")).toHaveLength(0);
		expect(plain(resumedFrame)).toContain("No output");
	});

	it("resumes the tail on a Space follow toggle", () => {
		let output = log(40, "step");
		const jobs: JobsPanelSnapshot = { running: [bash("bash-log", "running", "tail")], recent: [] };
		const { page } = setup(jobs, {
			rows: 20,
			inspect: () => ({ command: "tail", cwd: "/work", pids: [9], output }),
		});
		page.handleInput(ENTER);
		page.render(120);
		page.handleInput(PGUP);
		expect(plain(page.render(120))).toContain("paused");
		output += "step 41\n";
		page.handleInput(SPACE);
		const resumed = plain(page.render(120));
		expect(resumed).toContain("following");
		expect(resumed).toContain("step 41");
	});

	it("clears the viewport on an empty capture so the first chunk opens at its own tail, not a foreign offset", () => {
		let betaOutput = "";
		const jobs: JobsPanelSnapshot = {
			running: [bash("bash-full", "running", "long run"), bash("bash-empty", "running", "quiet run")],
			recent: [],
		};
		const { page } = setup(jobs, {
			rows: 30,
			inspect: id =>
				id === "bash-full"
					? { command: "long run", cwd: "/work", pids: [7], output: log(60, "full") }
					: { command: "quiet run", cwd: "/work", pids: [8], output: betaOutput },
		});
		expect(visibleCapture(page.render(120), "full").at(-1)).toContain("full 60");

		// Select the empty job, pause it with PgUp, then let its first long chunk
		// land before the next frame: the paused fill must reconcile from the
		// cleared viewport, not from the previous job's scroll offset.
		page.handleInput(DOWN);
		expect(plain(page.render(120))).toContain("No output yet");
		page.handleInput(PGUP);
		betaOutput = log(200, "beta");
		const rows = visibleCapture(page.render(120), "beta");
		expect(rows.at(-1)).toContain("beta 200");
		expect(rows.some(row => /\bbeta 0(0\d|1\d|2\d|3\d)\b/.test(row))).toBe(false);
	});

	it("keeps a paused empty capture frozen and resumes its tail on End after the first chunk", () => {
		let betaOutput = "";
		const jobs: JobsPanelSnapshot = {
			running: [bash("bash-full", "running", "long run"), bash("bash-empty", "running", "quiet run")],
			recent: [],
		};
		const { page } = setup(jobs, {
			rows: 30,
			inspect: id =>
				id === "bash-full"
					? { command: "long run", cwd: "/work", pids: [7], output: log(60, "full") }
					: { command: "quiet run", cwd: "/work", pids: [8], output: betaOutput },
		});
		page.render(120);

		// Pausing an empty capture freezes that empty view: the first chunk must
		// not shift the paused viewport, and End still opens the newest tail.
		page.handleInput(DOWN);
		expect(plain(page.render(120))).toContain("No output yet");
		page.handleInput(SPACE);
		expect(plain(page.render(120))).toContain("No output yet");
		betaOutput = log(200, "beta");
		expect(plain(page.render(120))).toContain("No output yet");
		page.handleInput(END);
		expect(visibleCapture(page.render(120), "beta").at(-1)).toContain("beta 200");
	});

	it("hides the log on a narrow terminal until Tab or Enter opens the selected job", () => {
		const { page, source } = setup(undefined, { rows: 30 });
		const roster = plain(page.render(40));
		expect(roster).toContain("Background jobs");
		expect(roster).toContain("bash-a");
		expect(roster).not.toContain("Output");

		page.handleInput(TAB);
		const opened = plain(page.render(40));
		expect(opened).toContain("Output");
		expect(opened).toContain("alpha 01");

		page.handleInput(ESC);
		const back = plain(page.render(40));
		expect(back).not.toContain("Output");
		expect(source.close).not.toHaveBeenCalled();

		page.handleInput(ENTER);
		expect(plain(page.render(40))).toContain("Output");
		page.handleInput(ENTER);
		expect(plain(page.render(40))).not.toContain("Output");

		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(1);
	});

	it("expands the wide detail pane into a full-body log on Enter and returns on Esc", () => {
		const { page, source } = setup();
		const split = plain(page.render(120));
		expect(split).toContain("bash-b");
		page.handleInput(ENTER);
		const logView = plain(page.render(120));
		expect(logView).toContain("bash-a");
		expect(logView).not.toContain("bash-b");
		expect(logView).toContain("alpha 01");
		page.handleInput(ESC);
		const restored = plain(page.render(120));
		expect(restored).toContain("bash-b");
		expect(source.close).not.toHaveBeenCalled();
	});

	it("cancels only the selected running job on X, and closes on Esc", () => {
		const { page, source } = setup();
		page.handleInput("x");
		expect(source.cancel).toHaveBeenCalledWith("bash-a");
		expect(source.close).not.toHaveBeenCalled();

		page.handleInput(DOWN);
		page.handleInput(DOWN);
		page.handleInput("x");
		expect(source.cancel).toHaveBeenCalledTimes(1);

		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(1);
	});

	it("opens then closes the individual log before Esc closes the page", () => {
		const { page, source } = setup();
		page.handleInput(ENTER);
		page.handleInput(ESC);
		expect(source.close).not.toHaveBeenCalled();
		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(1);
	});

	it("never traps an empty roster in the log surface: Tab/Enter stay inert and Esc closes", () => {
		const job = bash("bash-gone", "running", "vanish run");
		const snapshot: { running: JobsPanelJob[]; recent: JobsPanelJob[] } = { running: [], recent: [] };
		const { page, source } = setup(snapshot, { rows: 20 });

		// No jobs, no selection: Tab/Enter cannot open a blank log surface.
		page.handleInput(TAB);
		page.handleInput(ENTER);
		page.render(120);

		// Esc closes the page itself, once, from the empty roster.
		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(1);

		// A job appears, its log is expanded, then it disappears: the page resolves
		// back to the empty roster instead of a blank expanded body.
		snapshot.running = [job];
		page.render(120);
		page.handleInput(ENTER);
		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(1);
		page.handleInput(ENTER);

		snapshot.running = [];
		page.render(120);

		// Esc still closes from the resolved empty roster.
		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(2);
	});

	it("bounds rows and columns, strips controls, and shortens the cwd", () => {
		const home = os.homedir();
		const cwd = path.join(home, "proj");
		const dirty = "\x1b[31mred\x1b[0m row\tcol\x07 bell\r carriage";
		const long = "x".repeat(200);
		const jobs: JobsPanelSnapshot = { running: [bash("bash-dirty", "running", "run\tcmd")], recent: [] };
		const { page, term } = setup(jobs, {
			rows: 40,
			inspect: () => ({
				command: "run\tcmd",
				cwd,
				pids: [12],
				output: `${dirty}\n${long}\nplain line\n`,
			}),
		});
		page.handleInput(TAB);
		const narrow = page.render(16);
		expect(narrow.length).toBeLessThanOrEqual(40);
		for (const line of narrow) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(16);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\r");
			expect(line).not.toContain("\x07");
		}
		const narrowText = plain(narrow);
		expect(narrowText).toContain("red row");
		expect(narrowText).toContain("plain line");

		page.handleInput(TAB);
		const wide = plain(page.render(100));
		const short = shortenPath(cwd);
		expect(wide).toContain(short);
		if (short !== cwd) expect(wide).not.toContain(cwd);

		term.rows = 3;
		const tiny = page.render(100);
		expect(tiny.length).toBeLessThanOrEqual(3);
		expect(tiny.length).toBeGreaterThanOrEqual(1);
	});

	it("resumes the newest output when the selection changes while paused", () => {
		const jobs: JobsPanelSnapshot = {
			running: [bash("bash-a", "running", "alpha run"), bash("bash-b", "running", "beta run")],
			recent: [],
		};
		const details: Record<string, JobsPanelDetail> = {
			"bash-a": { command: "alpha run", cwd: "/work", pids: [1], output: log(40, "alpha") },
			"bash-b": { command: "beta run", cwd: "/work", pids: [2], output: log(40, "beta") },
		};
		const { page } = setup(jobs, { rows: 20, details });
		page.render(120);
		page.handleInput(PGUP);
		expect(plain(page.render(120))).toContain("paused");

		page.handleInput(DOWN);
		const after = plain(page.render(120));
		expect(after).toContain("following");
		expect(after).toContain("beta 40");
		expect(after).not.toContain("alpha 40");
	});

	it.each([
		["immediate", "direct"],
		["through empty", "empty"],
	])("follows the fallback job's newest output when the paused selected job is removed (%s)", (_label, path) => {
		const a = bash("bash-a", "running", "alpha run");
		const b = bash("bash-b", "running", "beta run");
		const snapshot: { running: JobsPanelJob[]; recent: JobsPanelJob[] } = { running: [a, b], recent: [] };
		const details: Record<string, JobsPanelDetail> = {
			"bash-a": { command: "alpha run", cwd: "/work", pids: [1], output: log(40, "alpha") },
			"bash-b": { command: "beta run", cwd: "/work", pids: [2], output: log(40, "beta") },
		};
		const { page } = setup(snapshot, { rows: 20, details });
		page.render(120);
		page.handleInput(PGUP);
		expect(plain(page.render(120))).toContain("paused");

		if (path === "empty") {
			// The selection is evicted to an empty snapshot first, then a new job appears.
			snapshot.running = [];
			expect(plain(page.render(120))).toContain("No background jobs");
			snapshot.running = [b];
		} else {
			// The selection is evicted straight onto another running job.
			snapshot.running = [b];
		}

		// Either path must land on the fallback job's newest output rather than a
		// stale freeze of the removed job.
		const after = plain(page.render(120));
		expect(after).toContain("following");
		expect(after).toContain("beta 40");
		expect(after).not.toContain("alpha 40");
	});

	it("pages a single output row through the viewport, End restoring the latest", () => {
		const jobs: JobsPanelSnapshot = { running: [bash("bash-one", "running", "bun run build")], recent: [] };
		const { page } = setup(jobs, {
			rows: 6,
			inspect: () => ({ command: "bun run build", cwd: "/work", pids: [3], output: "first\nsecond\nnewest\n" }),
		});
		const text = plain(page.render(100));
		expect(text).toContain("newest");
		expect(text).not.toContain("first");
		expect(text).not.toContain("Output …");

		// The lone output row is still the viewport, so it can be paged back.
		page.handleInput(PGUP);
		const older = plain(page.render(100));
		expect(older).toContain("second");
		expect(older).not.toContain("newest");

		page.handleInput(END);
		const latest = plain(page.render(100));
		expect(latest).toContain("newest");
		expect(latest).not.toContain("second");
	});

	it("strips ANSI, controls, and tabs from untrusted job metadata", () => {
		// Fixture values carry a clear-screen CSI, a 256-color SGR, BEL, and tabs;
		// the sanitizer must drop the sequences, leaving the visible text intact.
		const job: JobsPanelJob = {
			id: "job\x1b[2J-a",
			type: "ba\tsh",
			status: "running",
			label: "run\x07ok",
			agentId: "z\x1b[38;5;123mork",
			startTime: NOW - 1_000,
		};
		const jobs: JobsPanelSnapshot = { running: [job], recent: [] };
		const { page } = setup(jobs, {
			rows: 40,
			inspect: () => ({ command: "c\x1b[2Jmd", cwd: "/w\x07ork", pids: [1], output: "out\n" }),
		});
		// `ba\tsh` is not strictly `bash`, so the bash-only default hides the row —
		// which is itself the strict-filter behavior. Toggle All explicitly so the
		// row renders and the sanitizer intent stays under test, unweakened.
		expect(plain(page.render(200))).not.toContain("job-a");
		page.handleInput("a");
		const frame = page.render(200);
		for (const line of frame) {
			expect(line).not.toContain("\x1b[2J");
			expect(line).not.toContain("\x1b[38;5;123m");
			expect(line).not.toContain("\x07");
			expect(line).not.toContain("\t");
		}
		const text = plain(frame);
		expect(text).toContain("job-a");
		expect(text).toContain("runok");
		expect(text).toContain("zork");
		expect(text).toContain("/work");
		expect(text).toContain("cmd");
	});

	it("refreshes on its own timer and stops on dispose", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const { page } = setup(undefined, { requestRender });
			vi.advanceTimersByTime(500);
			expect(requestRender).toHaveBeenCalled();
			const ticks = requestRender.mock.calls.length;
			page.dispose();
			page.dispose();
			vi.advanceTimersByTime(1_000);
			expect(requestRender.mock.calls.length).toBe(ticks);
		} finally {
			vi.useRealTimers();
		}
	});

	it("defaults to bash only on a mixed roster: non-bash rows and output stay hidden and the first bash is selected", () => {
		const { page } = setup(MIXED, { details: MIXED_DETAILS });
		const frame = plain(page.render(120));
		// The bash jobs are listed and the first filtered one is selected...
		expect(frame).toContain("bash-a");
		expect(frame).toContain("bash-c");
		expect(frame).toContain("alpha 01");
		// ...while the task/eval entries and everything they carry stay off the page.
		expect(frame).not.toContain("task-1");
		expect(frame).not.toContain("eval-1");
		expect(frame).not.toContain("task-2");
		expect(frame).not.toContain("taskout");
		expect(frame).not.toContain("evalout");
		expect(frame).not.toContain("tasktwo");
		// The title names the bash view and counts only the filtered running job.
		expect(titleRow(page.render(120))).toContain("Background jobs · bash · 1 running");
		expect(titleRow(page.render(120))).not.toContain("· all");
	});

	it("derives the title's running count from the filtered jobs, running and settled alike", () => {
		const { page } = setup(MIXED, { details: MIXED_DETAILS });
		// Bash-only: one running bash; the settled bash and the two hidden running
		// jobs must not inflate the count (settled branch stays out of `running`).
		const bashTitle = titleRow(page.render(120));
		expect(bashTitle).toContain("Background jobs · bash · 1 running");
		expect(bashTitle).not.toContain("2 running");
		expect(bashTitle).not.toContain("3 running");

		// All: every running job counts; the two settled jobs still do not.
		page.handleInput("a");
		const allTitle = titleRow(page.render(120));
		expect(allTitle).toContain("Background jobs · all · 3 running");
		expect(allTitle).not.toContain("4 running");
		expect(allTitle).not.toContain("5 running");

		// Back to bash-only: the count returns to the single filtered running job.
		page.handleInput("a");
		expect(titleRow(page.render(120))).toContain("Background jobs · bash · 1 running");
	});

	it("counts explicitly at zero when every running job is filtered out", () => {
		const snapshot: JobsPanelSnapshot = {
			running: [job("task", "task-1", "running", "explore repo")],
			recent: [bash("bash-old", "completed", "old run", { endTime: NOW - 100 })],
		};
		const { page } = setup(snapshot, {
			details: {
				"task-1": { cwd: "/work", pids: [], output: log(2, "taskout") },
				"bash-old": { command: "old run", cwd: "/work", pids: [], exitCode: 0, output: log(2, "old") },
			},
		});
		// Bash-only: the single running job is a hidden task and the visible bash
		// job is settled — the title still reports the consumer-scoped count at 0
		// rather than hiding it or borrowing the unfiltered number.
		expect(plain(page.render(120))).toContain("bash-old");
		expect(titleRow(page.render(120))).toContain("Background jobs · bash · 0 running");

		// All: the hidden running task makes the count 1.
		page.handleInput("a");
		expect(titleRow(page.render(120))).toContain("Background jobs · all · 1 running");
		page.handleInput("a");
		expect(titleRow(page.render(120))).toContain("Background jobs · bash · 0 running");
	});

	it("a toggles to every job and back: entries return, then re-hide and reseat the selection onto the bash tail", () => {
		const { page } = setup(MIXED, { details: MIXED_DETAILS });
		page.render(120);

		page.handleInput("a");
		const all = plain(page.render(120));
		expect(all).toContain("task-1");
		expect(all).toContain("eval-1");
		expect(all).toContain("task-2");
		expect(titleRow(page.render(120))).toContain("· all ·");
		// The surviving bash selection is retained, not reset to the first entry.
		expect(all).toContain("alpha 01");
		expect(all).not.toContain("taskout");

		// Move to the eval job and make sure its own output is the one shown.
		page.handleInput(DOWN);
		const evalFrame = plain(page.render(120));
		expect(evalFrame).toContain("evalout 03");
		expect(evalFrame).not.toContain("alpha 03");

		// Filtering back drops the vanished eval selection: the page lands on the
		// filtered first bash, following its own tail, with no eval leakage.
		page.handleInput("a");
		const back = plain(page.render(120));
		expect(back).not.toContain("eval-1");
		expect(back).not.toContain("evalout");
		expect(back).toContain("following");
		expect(back).toContain("alpha 03");
		expect(titleRow(page.render(120))).toContain("· bash · 1 running");
	});

	it("explains an empty bash view on a task-only session, then All restores, inspects, and one Esc closes", () => {
		const snapshot: JobsPanelSnapshot = { running: [job("task", "task-only", "running", "solo task")], recent: [] };
		const { page, source } = setup(snapshot, {
			rows: 24,
			details: { "task-only": { cwd: "/work", pids: [], output: log(3, "solo") } },
		});
		const empty = plain(page.render(120));
		expect(empty).not.toContain("task-only");
		expect(empty).not.toContain("solo");
		// Nothing filtered is running: the title still counts, at zero.
		expect(titleRow(page.render(120))).toContain("Background jobs · bash · 0 running");
		// The page explains the hidden jobs and the way out instead of claiming an
		// idle session.
		expect(empty).toContain("No bash jobs");
		expect(empty).toContain("1 hidden");
		expect(empty).toContain("a:all");

		// Without a filtered selection Tab/Enter stay inert — no blank log surface.
		page.handleInput(TAB);
		page.handleInput(ENTER);
		expect(plain(page.render(120))).not.toContain("Output");

		page.handleInput("a");
		expect(plain(page.render(120))).toContain("task-only");
		expect(titleRow(page.render(120))).toContain("Background jobs · all · 1 running");
		page.handleInput(ENTER);
		const logFrame = plain(page.render(120));
		expect(logFrame).toContain("Output");
		expect(logFrame).toContain("solo 03");

		// Back to bash-only from the expanded non-bash log. The toggle refreshes
		// the page state immediately, so the Esc a user presses right after —
		// with no render in between — closes the page itself instead of merely
		// backing out of the stale empty detail.
		page.handleInput("a");
		page.handleInput(ESC);
		expect(source.close).toHaveBeenCalledTimes(1);

		// The collapse is observable on the next frame: the empty bash roster.
		const collapsed = plain(page.render(120));
		expect(collapsed).not.toContain("Output");
		expect(collapsed).not.toContain("solo");
		expect(collapsed).toContain("No bash jobs");
	});

	it("keeps the selected bash and its paused viewport across filter toggles", () => {
		let alphaOutput = log(40, "alpha");
		const snapshot: JobsPanelSnapshot = {
			running: [job("task", "task-1", "running", "explore repo"), bash("bash-a", "running", "alpha run")],
			recent: [],
		};
		const { page } = setup(snapshot, {
			rows: 20,
			inspect: id =>
				id === "bash-a"
					? { command: "alpha run", cwd: "/work", pids: [1], output: alphaOutput }
					: { cwd: "/work", pids: [], output: log(40, "taskout") },
		});
		page.render(120);
		page.handleInput(PGUP);
		expect(plain(page.render(120))).toContain("paused");
		const before = visibleCapture(page.render(120), "alpha");

		// Output appended after the pause must not leak into either toggled frame.
		alphaOutput += "alpha 41\n";
		page.handleInput("a");
		expect(plain(page.render(120))).toContain("paused");
		expect(visibleCapture(page.render(120), "alpha")).toEqual(before);
		const all = plain(page.render(120));
		expect(all).not.toContain("alpha 41");
		// The task row is listed, but the selection (and viewport) stayed on bash-a.
		expect(all).toContain("task-1");
		expect(all).not.toContain("taskout");

		page.handleInput("a");
		expect(plain(page.render(120))).toContain("paused");
		expect(visibleCapture(page.render(120), "alpha")).toEqual(before);
		expect(plain(page.render(120))).not.toContain("alpha 41");
	});

	it("resets follow to the remaining bash's own output when the filter drops the selected task", () => {
		const snapshot: JobsPanelSnapshot = {
			running: [job("task", "task-1", "running", "explore repo"), bash("bash-a", "running", "alpha run")],
			recent: [],
		};
		const details: Record<string, JobsPanelDetail> = {
			"task-1": { cwd: "/work", pids: [], output: log(40, "taskout") },
			"bash-a": { command: "alpha run", cwd: "/work", pids: [1], output: log(40, "alpha") },
		};
		const { page } = setup(snapshot, { rows: 20, details });
		page.render(120);
		page.handleInput("a");
		// Select the task (up from the retained bash selection) and pause on its log.
		page.handleInput(UP);
		expect(plain(page.render(120))).toContain("taskout");
		page.handleInput(PGUP);
		expect(plain(page.render(120))).toContain("paused");

		page.handleInput("a");
		const after = plain(page.render(120));
		// The task vanished with its frozen viewport: the page resumes the bash's
		// newest output rather than keeping a stale freeze of the dropped job.
		expect(after).toContain("following");
		expect(after).toContain("alpha 40");
		expect(after).not.toContain("taskout");
		expect(after).not.toContain("task-1");
	});

	it("surfaces the filter hint on the roster and the expanded log, wide and 40 columns", () => {
		const { page } = setup(MIXED, { details: MIXED_DETAILS, rows: 24 });
		const wide = plain(page.render(120));
		expect(wide).toContain("a:all");
		expect(wide).not.toContain("a:bash");

		page.handleInput("a");
		const wideAll = plain(page.render(120));
		expect(wideAll).toContain("a:bash");
		expect(wideAll).not.toContain("a:all");

		// The expanded log carries the hint too, and the toggle works from there.
		page.handleInput(ENTER);
		expect(plain(page.render(120))).toContain("a:bash");
		page.handleInput("a");
		expect(plain(page.render(120))).toContain("a:all");
		page.handleInput(ESC);

		// 40 columns: the hint survives on the roster and in the expanded log
		// without corrupting the layout.
		const narrow = page.render(40);
		expect(plain(narrow)).toContain("a:all");
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		page.handleInput(TAB);
		const narrowLog = page.render(40);
		expect(plain(narrowLog)).toContain("a:all");
		for (const line of narrowLog) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("filters a derived view: the source snapshot keeps every job across toggles", () => {
		const running: JobsPanelJob[] = [
			job("task", "task-1", "running", "explore repo"),
			bash("bash-a", "running", "alpha run"),
			job("eval", "eval-1", "running", "smoke eval"),
		];
		const recent: JobsPanelJob[] = [bash("bash-c", "completed", "gamma run", { endTime: NOW - 100 })];
		const snapshot: JobsPanelSnapshot = { running, recent };
		const runningCopy = [...running];
		const recentCopy = [...recent];
		const { page } = setup(snapshot, { details: MIXED_DETAILS });

		expect(plain(page.render(120))).not.toContain("task-1");
		page.handleInput("a");
		expect(plain(page.render(120))).toContain("task-1");
		expect(plain(page.render(120))).toContain("eval-1");
		page.handleInput("a");
		expect(plain(page.render(120))).not.toContain("task-1");
		expect(plain(page.render(120))).not.toContain("eval-1");

		// Neither toggling ever touched the source: all five entries remain.
		expect(snapshot.running).toEqual(runningCopy);
		expect(snapshot.recent).toEqual(recentCopy);
		expect(snapshot.running).toHaveLength(3);
		expect(snapshot.recent).toHaveLength(1);
	});
});
