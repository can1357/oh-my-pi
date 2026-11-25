/**
 * The status line's git facts come from background reads: a cold paint shows
 * nothing until the read lands, repaints reuse the facts until a run starts, a
 * turn ends or a user command finishes, and a cwd change drops the old
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

	it("re-reads working-tree counts when a run starts and when a turn ends, not on repaints", async () => {
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

		emit("turn_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("*7");

		emit("agent_start");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(3);
		expect(lineText(line)).toContain("?3");
	});

	it("re-reads git facts after a user command", async () => {
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
		line.applyCwdChange();
		expect(lineText(line)).not.toContain("branch-a");
		await flushStatus();
		expect(lineText(line)).toContain("branch-b");

		// A cwd without a repository shows no git facts.
		cwd = "/no/repo";
		line.applyCwdChange();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).not.toContain("branch-");
	});
});
