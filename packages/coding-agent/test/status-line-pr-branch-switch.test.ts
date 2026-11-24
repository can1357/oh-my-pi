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
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

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

const PR_7 = {
	exitCode: 0,
	stdout: '{"number":7,"url":"https://example.test/x/7"}',
	stderr: "",
};
const NO_PR = { exitCode: 1, stdout: "", stderr: "no pull requests found" };

/** A git checkout whose HEAD the test moves, as `!git checkout` would (the HEAD watcher then fires). */
function mockCheckout(initial: VcsHeadState): {
	checkout(head: VcsHeadState): void;
} {
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
	let headMoved = (): void => {};
	vi.spyOn(vcs, "watch").mockImplementation((_repo, onChange) => {
		headMoved = onChange as () => void;
		return () => {};
	});
	return {
		checkout(next) {
			head = next;
			headMoved();
		},
	};
}

/** Paint once (a stale snapshot starts its refresh on read), then let the refresh land. */
async function repaint(component: ReturnType<typeof statusLine>): Promise<string> {
	lineText(component);
	await flushStatus();
	return lineText(component);
}

function branch(name: string): VcsHeadState {
	return {
		kind: "ref",
		branch: name,
		refName: `refs/heads/${name}`,
		commit: undefined,
	};
}

async function startOnPrBranch(initial: VcsHeadState) {
	const checkout = mockCheckout(initial);
	const run = vi.spyOn(github, "run").mockResolvedValue(NO_PR).mockResolvedValueOnce(PR_7);
	const component = statusLine(
		statusSession({
			sessionManager: { getSessionName: () => "pr branch switch" },
		}),
		settings,
	);
	lineText(component);
	await flushStatus();
	expect(lineText(component)).toContain("#7");
	return { checkout, run, component };
}

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

describe("status line PR segment across branch switches", () => {
	it("drops the PR after checking out the default branch", async () => {
		const { checkout, component } = await startOnPrBranch(branch("feature/x"));
		try {
			checkout.checkout(branch("main"));
			const content = await repaint(component);
			expect(content).toContain("main");
			expect(content).not.toContain("#7");
		} finally {
			component.dispose();
		}
	});

	it("drops the PR after detaching HEAD", async () => {
		const { checkout, component } = await startOnPrBranch(branch("feature/x"));
		try {
			checkout.checkout({ kind: "detached" });
			expect(await repaint(component)).not.toContain("#7");
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
			// Branch and PR come from one snapshot: never the new branch beside the old PR.
			const during = lineText(component);
			expect(during.includes("feature/y") && during.includes("#7")).toBe(false);
			pending.resolve(NO_PR);
			const content = await repaint(component);
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
			component.refresh();
			expect(lineText(component)).toContain("#7");
			pending.resolve(PR_7);
			await flushStatus();
		} finally {
			component.dispose();
		}
	});
});
