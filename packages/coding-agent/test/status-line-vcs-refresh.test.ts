/**
 * The status line's git facts come from background reads: a cold paint shows
 * nothing until the read lands, repaints reuse the facts until a run starts, a
 * turn ends or a user command finishes (reads at most one interval apart; a
 * skipped one runs once the run yields), and a cwd change drops the old
 * repository's facts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import type { VcsGitRepo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as utils from "@oh-my-pi/pi-utils";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

type GitStatus = { staged: number; unstaged: number; untracked: number };

/** The status line's least time between two git/jj reads (`VCS_READ_INTERVAL_MS`). */
const READ_INTERVAL_MS = 5_000;

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: [],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A git repository on `branch` (read at every HEAD read). */
function fakeRepo(
	root: string,
	branch: string | (() => string),
	statusSummary: () => Promise<GitStatus | null>,
): VcsRepo {
	const headSync = (): VcsHeadState => {
		const name = typeof branch === "string" ? branch : branch();
		return {
			kind: "ref",
			branch: name,
			refName: `refs/heads/${name}`,
			commit: undefined,
		};
	};
	const git = { headSync, linkedWorktree: () => null } as unknown as VcsGitRepo;
	return {
		kind: () => "git",
		asGit: () => git,
		asJj: () => null,
		root: () => root,
		statusSummary,
	} as unknown as VcsRepo;
}

function mockRepos(byCwd: Record<string, VcsRepo>): void {
	const lookup = (cwd: string) => byCwd[cwd] ?? null;
	vi.spyOn(vcs, "repo").mockImplementation(lookup);
	vi.spyOn(vcs, "repoForDisplay").mockImplementation(lookup);
}

/** A session whose events the test emits. */
function emittingSession() {
	let emit: (event: { type: string }) => void = () => {};
	const session = statusSession({
		subscribe: (listener: (event: { type: string }) => void) => {
			emit = listener;
			return () => {};
		},
	});
	return { session, emit: (type: string) => emit({ type }) };
}

describe("status line VCS refresh", () => {
	it("shows git facts once the cold paint's background read lands", async () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/cold");
		const status = Promise.withResolvers<GitStatus | null>();
		mockRepos({
			"/repo/cold": fakeRepo("/repo/cold", "cold-branch", () => status.promise),
		});
		const line = statusLine(statusSession(), gitSegment);

		expect(lineText(line)).not.toContain("cold-branch");
		status.resolve({ staged: 2, unstaged: 0, untracked: 0 });
		await flushStatus();

		const text = lineText(line);
		expect(text).toContain("cold-branch");
		expect(text).toContain("+2");
	});

	it("reads nothing while the terminal shows the checkout itself", async () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/homed");
		const statusSummary = vi
			.fn<() => Promise<GitStatus | null>>()
			.mockResolvedValue({ staged: 1, unstaged: 0, untracked: 0 });
		mockRepos({ "/repo/homed": fakeRepo("/repo/homed", "homed-branch", statusSummary) });
		const line = statusLine(statusSession(), gitSegment);

		line.setCheckoutHomed(true);
		lineText(line);
		await flushStatus();
		expect(statusSummary).not.toHaveBeenCalled();
		expect(lineText(line)).not.toContain("homed-branch");

		// Turning it off reads the checkout here again.
		line.setCheckoutHomed(false);
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(1);
		expect(lineText(line)).toContain("homed-branch");
	});

	it("re-reads working-tree counts when a run starts and when a turn ends, not on repaints", async () => {
		vi.useFakeTimers();
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/turns");
		const statusSummary = vi
			.fn<() => Promise<GitStatus | null>>()
			.mockResolvedValueOnce({ staged: 1, unstaged: 0, untracked: 0 })
			.mockResolvedValueOnce({ staged: 0, unstaged: 7, untracked: 0 })
			.mockResolvedValueOnce({ staged: 0, unstaged: 0, untracked: 3 });
		mockRepos({ "/repo/turns": fakeRepo("/repo/turns", "main", statusSummary) });
		const { session, emit } = emittingSession();
		const line = statusLine(session, gitSegment);

		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("+1");

		// Repaints and other session events reuse the facts.
		line.refresh();
		emit("message_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(READ_INTERVAL_MS);
		emit("turn_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("*7");

		vi.advanceTimersByTime(READ_INTERVAL_MS);
		emit("agent_start");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(3);
		expect(lineText(line)).toContain("?3");
	});

	it("reads at most once per interval and runs a skipped read once the run yields", async () => {
		vi.useFakeTimers();
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/busy");
		const statusSummary = vi
			.fn<() => Promise<GitStatus | null>>()
			.mockResolvedValueOnce({ staged: 1, unstaged: 0, untracked: 0 })
			.mockResolvedValueOnce({ staged: 0, unstaged: 4, untracked: 0 });
		mockRepos({ "/repo/busy": fakeRepo("/repo/busy", "main", statusSummary) });
		const { session, emit } = emittingSession();
		const line = statusLine(session, gitSegment);
		lineText(line);
		await flushStatus();

		// A turn ending right after the last read does not read again.
		emit("turn_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(1);

		// The run yields: the skipped read runs once the interval is up.
		emit("agent_end");
		vi.advanceTimersByTime(READ_INTERVAL_MS);
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("*4");
	});

	it("re-reads git facts after a user command", async () => {
		vi.useFakeTimers();
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/head");
		let branch = "before";
		const repo = fakeRepo(
			"/repo/head",
			() => branch,
			async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
		);
		mockRepos({ "/repo/head": repo });
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("before");

		branch = "after";
		line.refreshVcs();
		// Right after the last read: the command's read waits out the interval.
		vi.advanceTimersByTime(READ_INTERVAL_MS);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("after");
	});

	it("drops the old repository's facts when the cwd moves", async () => {
		let cwd = "/repo/a";
		vi.spyOn(utils, "getProjectDir").mockImplementation(() => cwd);
		const clean = async () => ({ staged: 0, unstaged: 0, untracked: 0 });
		mockRepos({
			"/repo/a": fakeRepo("/repo/a", "branch-a", clean),
			"/repo/b": fakeRepo("/repo/b", "branch-b", clean),
		});
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("branch-a");

		cwd = "/repo/b";
		line.invalidateVcs();
		expect(lineText(line)).not.toContain("branch-a");
		await flushStatus();
		expect(lineText(line)).toContain("branch-b");

		// A cwd without a repository shows no git facts.
		cwd = "/no/repo";
		line.invalidateVcs();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).not.toContain("branch-");
	});
});
