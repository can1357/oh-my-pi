/**
 * #11071: a colocated jj-git checkout resolved to Git in `detect()`, so the
 * status line showed the git HEAD ("detached" in practice) instead of the
 * active jj bookmark/change id.
 *
 * Presentation now follows a second detector, `vcs.repoForDisplay()`, whose
 * only policy difference is preferring jj on equal-root ties; automation
 * keeps `vcs.repo()`. The component (and footer) split accordingly:
 * branch label and the head watcher come from the display
 * repository (status counts stay on the operational repository), while PR
 * lookup keeps resolving the operational git branch — a jj bookmark/change
 * id must never become a GitHub head.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

type GitStatus = { staged: number; unstaged: number; untracked: number };

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "display-detector test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function headFor(branch: string): VcsHeadState {
	return { kind: "ref", branch, refName: `refs/heads/${branch}`, commit: undefined };
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
		statusSummary: async (): Promise<GitStatus | null> => ({ staged: 0, unstaged: 0, untracked: 0 }),
	} as unknown as VcsGitRepo;
}

function gitWithDefaultBranch(branch: string): VcsGitRepo {
	return { defaultBranch: async () => branch, linkedWorktree: () => null } as unknown as VcsGitRepo;
}

function operationalGit(root: string, head: VcsHeadState | null): VcsRepo {
	const handle = gitHandle(head);
	return {
		kind: () => "git",
		asGit: () => handle,
		asJj: () => null,
		root: () => root,
		watchTarget: () => `${root}/.git/HEAD`,
		statusSummary: (signal?: AbortSignal) => handle.statusSummary(signal),
	} as unknown as VcsRepo;
}

function displayJj(root: string, label: () => Promise<string | null>, status: GitStatus): VcsRepo {
	return {
		kind: () => "jj",
		asGit: () => null,
		asJj: () => ({}) as never,
		root: () => root,
		watchTarget: () => `${root}/.jj/repo/op_heads/heads`,
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

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function mockRepos(operational: VcsRepo, display: VcsRepo, root: string): void {
	vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfoFor(root));
	vi.spyOn(vcs, "git").mockReturnValue(null);
	vi.spyOn(vcs, "repo").mockReturnValue(operational);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(display);
}

describe("StatusLineComponent display detector", () => {
	it("shows the jj bookmark with the jj watch target when colocated", async () => {
		const root = "/repo/colocated";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => "my-bookmark", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);
		let watched: VcsRepo | null = null;
		vi.spyOn(vcs, "watch").mockImplementation(((repo: VcsRepo) => {
			watched = repo;
			return () => {};
		}) as unknown as typeof vcs.watch);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80);
		await flush();

		expect(vcs.repoForDisplay).toHaveBeenCalled();
		expect(onBranchChange).toHaveBeenCalled();
		const content = component.getTopBorder(80).content;
		expect(content).toContain("my-bookmark");
		expect((watched as VcsRepo | null)?.watchTarget()).toBe(`${root}/.jj/repo/op_heads/heads`);
		component.dispose();
	});

	it("keeps the git branch for a nested git checkout under an outer jj workspace", async () => {
		const root = "/repo/nested";
		const operational = operationalGit(root, headFor("git-branch-name"));
		mockRepos(operational, operationalGit(root, headFor("git-branch-name")), root);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("git-branch-name");
		component.dispose();
	});

	it("keeps detached for ordinary git with no jj workspace", async () => {
		const root = "/repo/plain";
		const operational = operationalGit(root, detachedHead);
		mockRepos(operational, operationalGit(root, detachedHead), root);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		expect(component.getTopBorder(80).content).toContain("detached");
		component.dispose();
	});

	it("does not send the jj bookmark to PR lookup when the git branch is default", async () => {
		const root = "/repo/colocated-pr";
		const operational = operationalGit(root, headFor("main"));
		const display = displayJj(root, async () => "feature-x", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const run = vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: "{}", stderr: "" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();

		expect(component.getTopBorder(80).content).toContain("feature-x");
		expect(run).not.toHaveBeenCalled();
		component.dispose();
	});

	it("still looks up PRs by the operational git branch when it is not default", async () => {
		const root = "/repo/colocated-pr-live";
		const operational = operationalGit(root, headFor("git-branch-name"));
		const display = displayJj(root, async () => "feature-x", { staged: 0, unstaged: 0, untracked: 0 });
		mockRepos(operational, display, root);
		vi.spyOn(vcs, "git").mockReturnValue(gitWithDefaultBranch("main"));
		const run = vi
			.spyOn(github, "run")
			.mockResolvedValue({ exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitPrSegments);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[1]).toEqual(["pr", "view", "--json", "number,url"]);
		expect(component.getTopBorder(80).content).toContain("feature-x");
		expect(component.getTopBorder(80).content).toContain("#7");
		component.dispose();
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

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(() => {});

		component.getTopBorder(80);
		await flush();
		const content = component.getTopBorder(80).content;
		expect(content).toContain("evil-");
		expect(content).toContain("bookmark");
		// The raw erase-display payload is gone (theme ANSI aside, which is
		// emitted by the renderer itself, not the label).
		expect(content).not.toContain("[2J");
		component.dispose();
	});
});
