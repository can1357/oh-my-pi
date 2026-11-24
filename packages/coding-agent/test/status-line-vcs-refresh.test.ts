/**
 * The status line's git facts come from background reads: a cold paint shows
 * nothing until the read lands, working-tree counts are re-read once they are
 * older than the status TTL, one HEAD watcher serves a repository however
 * often the bar repaints, and a cwd change retires the old repository's
 * watcher and its facts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
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
	setSystemTime();
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

/** Repositories by cwd; `watch` records each watcher and whether it was retired. */
function mockRepos(byCwd: Record<string, VcsRepo>) {
	const watchers: { root: string; retired: boolean; fire(): void }[] = [];
	const lookup = (cwd: string) => byCwd[cwd] ?? null;
	vi.spyOn(vcs, "repo").mockImplementation(lookup);
	vi.spyOn(vcs, "repoForDisplay").mockImplementation(lookup);
	vi.spyOn(vcs, "watch").mockImplementation((repo, onChange) => {
		const watcher = {
			root: repo.root(),
			retired: false,
			fire: onChange as () => void,
		};
		watchers.push(watcher);
		return () => {
			watcher.retired = true;
		};
	});
	return watchers;
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

	it("re-reads working-tree counts once they are older than the status TTL, with one watcher throughout", async () => {
		const start = Date.now();
		setSystemTime(start);
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/ttl");
		const statusSummary = vi
			.fn<() => Promise<GitStatus | null>>()
			.mockResolvedValueOnce({ staged: 1, unstaged: 0, untracked: 0 })
			.mockResolvedValueOnce({ staged: 0, unstaged: 7, untracked: 0 });
		const watchers = mockRepos({
			"/repo/ttl": fakeRepo("/repo/ttl", "main", statusSummary),
		});
		const line = statusLine(statusSession(), gitSegment);

		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("+1");

		// Inside the freshness window repaints reuse the cached counts.
		setSystemTime(start + 4_000);
		line.refresh();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(1);

		// Past it, the next paint re-reads them.
		setSystemTime(start + 6_000);
		line.refresh();
		lineText(line);
		await flushStatus();
		expect(statusSummary).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("*7");
		expect(watchers).toHaveLength(1);
	});

	it("re-reads git facts at once when the HEAD watcher fires", async () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/head");
		let branch = "before";
		const repo = fakeRepo(
			"/repo/head",
			() => branch,
			async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
		);
		const watchers = mockRepos({ "/repo/head": repo });
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("before");

		branch = "after";
		watchers[0]!.fire();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("after");
	});

	it("retires the old repository's watcher and facts when the cwd moves", async () => {
		let cwd = "/repo/a";
		vi.spyOn(utils, "getProjectDir").mockImplementation(() => cwd);
		const clean = async () => ({ staged: 0, unstaged: 0, untracked: 0 });
		const watchers = mockRepos({
			"/repo/a": fakeRepo("/repo/a", "branch-a", clean),
			"/repo/b": fakeRepo("/repo/b", "branch-b", clean),
		});
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("branch-a");

		cwd = "/repo/b";
		line.applyCwdChange();
		expect(watchers[0]).toMatchObject({ root: "/repo/a", retired: true });
		expect(lineText(line)).not.toContain("branch-a");
		await flushStatus();
		expect(lineText(line)).toContain("branch-b");
		expect(watchers[1]).toMatchObject({ root: "/repo/b", retired: false });

		// A cwd without a repository shows no git facts and watches nothing.
		cwd = "/no/repo";
		line.applyCwdChange();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).not.toContain("branch-");
		expect(watchers).toHaveLength(2);
		expect(watchers[1]!.retired).toBe(true);
	});
});
