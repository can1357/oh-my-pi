/**
 * Regression: after `!git checkout` from a branch with a PR to one without,
 * the `pr` segment kept the previous branch's PR. The default branch and a
 * detached HEAD skip the lookup and returned the stale value forever, and a
 * fresh lookup for another branch showed the old PR until `gh` answered.
 *
 * Contract: a cached PR is only rendered for the branch it was resolved on.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { StatusLineSettings } from "@oh-my-pi/pi-tui/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const root = "/repo/pr-branch-switch";

const settings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git", "pr"],
	rightSegments: [],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

const repoInfo: VcsGitRepoInfo = {
	commonDir: `${root}/.git`,
	gitDir: `${root}/.git`,
	gitEntryPath: `${root}/.git`,
	headPath: `${root}/.git/HEAD`,
	repoRoot: root,
	isReftable: false,
};

const PR_7 = { exitCode: 0, stdout: '{"number":7,"url":"https://example.test/x/7"}', stderr: "" };
const NO_PR = { exitCode: 1, stdout: "", stderr: "no pull requests found" };

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
			getSessionName: () => "pr branch switch",
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

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** A git checkout whose HEAD the test moves, as `!git checkout` would. */
function mockCheckout(initial: VcsHeadState): { checkout(head: VcsHeadState): void } {
	let head = initial;
	const handle = {
		headSync: () => head,
		linkedWorktree: () => null,
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
		defaultBranch: async () => "main",
	} as unknown as VcsGitRepo;
	const repo = {
		kind: () => "git",
		asGit: () => handle,
		asJj: () => null,
		root: () => root,
		watchTarget: () => `${root}/.git/HEAD`,
		statusSummary: () => handle.statusSummary(),
	} as unknown as VcsRepo;
	vi.spyOn(vcs, "gitInfo").mockReturnValue(repoInfo);
	vi.spyOn(vcs, "git").mockReturnValue(handle);
	vi.spyOn(vcs, "repo").mockReturnValue(repo);
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(repo);
	vi.spyOn(vcs, "watch").mockReturnValue(() => {});
	return {
		checkout(next) {
			head = next;
		},
	};
}

function branch(name: string): VcsHeadState {
	return { kind: "ref", branch: name, refName: `refs/heads/${name}`, commit: undefined };
}

async function startOnPrBranch(initial: VcsHeadState) {
	const checkout = mockCheckout(initial);
	const run = vi.spyOn(github, "run").mockResolvedValueOnce(PR_7);
	const component = new StatusLineComponent(makeSession(), statusLineHost);
	component.updateSettings(settings);
	component.watchBranch(() => {});
	component.getTopBorder(120);
	await flush();
	expect(component.getTopBorder(120).content).toContain("#7");
	return { checkout, run, component };
}

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

describe("StatusLineComponent PR segment across branch switches", () => {
	it("drops the PR after checking out the default branch", async () => {
		const { checkout, run, component } = await startOnPrBranch(branch("feature/x"));
		try {
			checkout.checkout(branch("main"));
			component.invalidateGitCaches();
			await flush();
			const content = component.getTopBorder(120).content;
			expect(content).toContain("main");
			expect(content).not.toContain("#7");
			expect(run).toHaveBeenCalledTimes(1);
		} finally {
			component.dispose();
		}
	});

	it("drops the PR after detaching HEAD", async () => {
		const { checkout, component } = await startOnPrBranch(branch("feature/x"));
		try {
			checkout.checkout({ kind: "detached" });
			component.invalidateGitCaches();
			await flush();
			expect(component.getTopBorder(120).content).not.toContain("#7");
		} finally {
			component.dispose();
		}
	});

	it("does not show the previous branch's PR while the new branch's lookup is pending", async () => {
		const { checkout, run, component } = await startOnPrBranch(branch("feature/x"));
		try {
			const pending = Promise.withResolvers<typeof NO_PR>();
			run.mockReturnValueOnce(pending.promise);
			checkout.checkout(branch("feature/y"));
			component.invalidateGitCaches();
			expect(component.getTopBorder(120).content).not.toContain("#7");
			pending.resolve(NO_PR);
			await flush();
			const content = component.getTopBorder(120).content;
			expect(content).toContain("feature/y");
			expect(content).not.toContain("#7");
		} finally {
			component.dispose();
		}
	});

	it("keeps the PR visible while the same branch refreshes", async () => {
		const { run, component } = await startOnPrBranch(branch("feature/x"));
		try {
			const pending = Promise.withResolvers<typeof PR_7>();
			run.mockReturnValueOnce(pending.promise);
			component.invalidate();
			expect(component.getTopBorder(120).content).toContain("#7");
			pending.resolve(PR_7);
			await flush();
		} finally {
			component.dispose();
		}
	});
});
