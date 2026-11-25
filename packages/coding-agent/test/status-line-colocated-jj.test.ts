/**
 * #11071: a colocated jj-git checkout resolved to Git in `detect()`, so the
 * status line showed the git HEAD ("detached" in practice) instead of the
 * active jj bookmark/change id.
 *
 * Presentation now follows a second detector, `vcs.repoForDisplay()`, whose
 * only policy difference is preferring jj on equal-root ties; automation
 * keeps `vcs.repo()`. The branch label comes from the display repository,
 * while PR lookup keeps resolving the operational git
 * branch — a jj bookmark/change id must never become a GitHub head.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

type GitStatus = { staged: number; unstaged: number; untracked: number };

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	disposeStatusLines();
	vi.restoreAllMocks();
});

function makeLine(settings: StatusLineSettings) {
	return statusLine(
		statusSession({
			sessionManager: { getSessionName: () => "display-detector test" },
		}),
		settings,
	);
}

function headFor(branch: string): VcsHeadState {
	return {
		kind: "ref",
		branch,
		refName: `refs/heads/${branch}`,
		commit: undefined,
	};
}
const detachedHead: VcsHeadState = { kind: "detached" };

function repoInfoFor(root: string): VcsGitRepoInfo {
	return {
		commonDir: `${root}/.git`,
		gitDir: `${root}/.git`,
		gitEntryPath: `${root}/.git`,
		headPath: `${root}/.git/HEAD`,
		repoRoot: root,
		isReftable: false,
	};
}

function gitHandle(head: VcsHeadState | null): VcsGitRepo {
	return {
		headSync: () => head,
		linkedWorktree: () => null,
		statusSummary: async (): Promise<GitStatus | null> => ({
			staged: 0,
			unstaged: 0,
			untracked: 0,
		}),
	} as unknown as VcsGitRepo;
}

function gitWithDefaultBranch(branch: string): VcsGitRepo {
	return {
		defaultBranch: async () => branch,
		linkedWorktree: () => null,
	} as unknown as VcsGitRepo;
}

function operationalGit(root: string, head: VcsHeadState | null): VcsRepo {
	const handle = gitHandle(head);
	return {
		kind: () => "git",
		asGit: () => handle,
		asJj: () => null,
		root: () => root,
		statusSummary: (signal?: AbortSignal) => handle.statusSummary(signal),
	} as unknown as VcsRepo;
}

function displayJj(root: string, label: () => Promise<string | null>, status: GitStatus): VcsRepo {
	return {
		kind: () => "jj",
		asGit: () => null,
		asJj: () => ({}) as never,
		root: () => root,
		label,
		statusSummary: async () => status,
	} as unknown as VcsRepo;
}

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};
const gitPrSegments: StatusLineSettings = {
	...gitSegment,
	leftSegments: ["git", "pr"],
};

/** Paint once (the first paint starts the VCS read), then let it land. */
async function paint(line: ReturnType<typeof makeLine>): Promise<string> {
	lineText(line, 80);
	await flushStatus();
	return lineText(line, 80);
}

function mockRepos(operational: VcsRepo, display: VcsRepo, root: string): void {
	vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
	vi.spyOn(vcs, "git").mockReturnValue(null);
	vi.spyOn(vcs, "repo").mockReturnValue(operational);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(display);
}

describe("status line display detector", () => {
	it("shows the jj bookmark when colocated", async () => {
		const root = "/repo/colocated";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => "my-bookmark", {
			staged: 0,
			unstaged: 0,
			untracked: 0,
		});
		mockRepos(operational, display, root);

		const component = makeLine(gitSegment);
		const painted = await paint(component);

		expect(vcs.repoForDisplay).toHaveBeenCalled();
		const content = painted;
		expect(content).toContain("my-bookmark");
	});

	it("keeps the git branch for a nested git checkout under an outer jj workspace", async () => {
		const root = "/repo/nested";
		const operational = operationalGit(root, headFor("git-branch-name"));
		mockRepos(operational, operationalGit(root, headFor("git-branch-name")), root);

		const component = makeLine(gitSegment);
		const painted = await paint(component);
		expect(painted).toContain("git-branch-name");
	});

	it("keeps detached for ordinary git with no jj workspace", async () => {
		const root = "/repo/plain";
		const operational = operationalGit(root, detachedHead);
		mockRepos(operational, operationalGit(root, detachedHead), root);

		const component = makeLine(gitSegment);
		const painted = await paint(component);
		expect(painted).toContain("detached");
	});

	it("does not send the jj bookmark to PR lookup when the git branch is default", async () => {
		const root = "/repo/colocated-pr";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => "feature-x", {
			staged: 0,
			unstaged: 0,
			untracked: 0,
		});
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const run = vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "{}", stderr: "" });

		const component = makeLine(gitPrSegments);
		const painted = await paint(component);

		expect(painted).toContain("feature-x");
		expect(run).not.toHaveBeenCalled();
	});

	it("still looks up PRs by the operational git branch when it is not default", async () => {
		const root = "/repo/colocated-pr-live";
		const operational = operationalGit(root, headFor("git-branch-name"));
		const display = displayJj(root, async () => "feature-x", {
			staged: 0,
			unstaged: 0,
			untracked: 0,
		});
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const run = vi.spyOn(github, "run").mockResolvedValue({
			exitCode: 0,
			stdout: '{"number":7,"url":"https://example.test/x/7"}',
			stderr: "",
		});

		const component = makeLine(gitPrSegments);
		const painted = await paint(component);

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[1]).toEqual(["pr", "view", "--json", "number,url"]);
		expect(painted).toContain("feature-x");
		expect(painted).toContain("#7");
	});
	it("sanitizes control characters from the jj label", async () => {
		const root = "/repo/sanitize";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => `evil-${String.fromCharCode(27)}[2J-bookmark`, {
			staged: 0,
			unstaged: 0,
			untracked: 0,
		});
		mockRepos(operational, display, root);

		const component = makeLine(gitSegment);
		const painted = await paint(component);
		const content = painted;
		expect(content).toContain("evil-");
		expect(content).toContain("bookmark");
		// The raw erase-display payload is gone (theme ANSI aside, which is
		// emitted by the renderer itself, not the label).
		expect(content).not.toContain("[2J");
	});
});
