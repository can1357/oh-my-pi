import { beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as path from "node:path";
import type { VcsGitRepo, VcsGitRepoInfo, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

function fakeSession(): AgentSession {
	const model = { id: "test-model", contextWindow: 200_000 };
	const messages = [{ role: "user", content: "hi" }];
	const session = {
		messages,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		settings: undefined,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "repro",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => ({ tokens: 6000, contextWindow: 200_000, percent: 3 }),
		contextUsageRevision: 0,
	};
	return session as unknown as AgentSession;
}

function fakeRepo(): VcsRepo {
	const git = {
		headSync: () => ({ kind: "ref", branch: "main" }),
		head: async () => ({ kind: "ref", branch: "main" }),
		linkedWorktree: () => null,
		defaultBranch: async () => "main",
	};
	const repo = {
		kind: () => "git",
		asJj: () => null,
		asGit: () => git as unknown as VcsGitRepo,
		label: async () => "main",
		statusSummary: async () => ({ staged: 0, unstaged: 0, untracked: 0 }),
	};
	return repo as unknown as VcsRepo;
}

function fakeGitInfo(): VcsGitRepoInfo {
	const info = { isReftable: false, headPath: "/repo/.git/HEAD" };
	return info as unknown as VcsGitRepoInfo;
}

interface Harness {
	component: StatusLineComponent;
	repoSpy: Mock<typeof vcs.repo>;
	dispose: () => void;
}

function mountStatusLine(repoFactory: () => VcsRepo | null = fakeRepo): Harness {
	const repoSpy: Mock<typeof vcs.repo> = spyOn(vcs, "repo").mockImplementation(repoFactory);
	const gitSpy = spyOn(vcs, "git").mockImplementation(() => fakeRepo().asGit());
	const infoSpy = spyOn(vcs, "gitInfo").mockImplementation(() => fakeGitInfo());

	const component = new StatusLineComponent(fakeSession());
	component.updateSettings({
		preset: "custom",
		leftSegments: ["path", "git"],
		rightSegments: ["pr"],
		separator: "powerline-thin",
		sessionAccent: false,
	});
	return {
		component,
		repoSpy,
		dispose: () => {
			component.dispose();
			repoSpy.mockRestore();
			gitSpy.mockRestore();
			infoSpy.mockRestore();
		},
	};
}

describe("status line VCS discovery", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("discovers the repository once, not on every rendered frame", () => {
		const { component, repoSpy, dispose } = mountStatusLine();
		try {
			// Warm the projectDir / active-repo caches, then simulate the
			// working-spinner repaint loop: the status line is rebuilt on every
			// painted frame while nothing about the repository changed.
			component.getTopBorder(120);
			const perFrame = () => {
				repoSpy.mockClear();
				component.getTopBorder(120);
				return repoSpy.mock.calls.length;
			};
			// Repository discovery is a native filesystem walk (costly on WSL). Once
			// the handle is memoized it must not re-walk on steady-state frames, and
			// the count must never scale with the frame rate.
			expect(perFrame()).toBe(0);
			expect(perFrame()).toBe(0);
		} finally {
			dispose();
		}
	});

	it("bounds negative discovery and retries after the fallback polling interval", () => {
		let now = 1_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		const { component, repoSpy, dispose } = mountStatusLine(() => null);
		try {
			// Warm the unrelated active-repository resolution, then isolate the
			// status line's repo memo.
			component.getTopBorder(120);
			component.invalidateGitCaches();
			repoSpy.mockClear();

			component.getTopBorder(120);
			expect(repoSpy).toHaveBeenCalledTimes(1);
			component.getTopBorder(120);
			now += 4_999;
			component.getTopBorder(120);
			expect(repoSpy).toHaveBeenCalledTimes(1);

			// A bounded miss must expire so `git init` becomes visible without a
			// cwd or HEAD watcher event.
			now += 1;
			component.getTopBorder(120);
			expect(repoSpy).toHaveBeenCalledTimes(2);
		} finally {
			nowSpy.mockRestore();
			dispose();
		}
	});

	it("clears the staged indicator after a same-branch commit", async () => {
		using tempDir = TempDir.createSync("@omp-status-line-vcs-discovery-");
		const cwd = tempDir.path();
		await $`git init --initial-branch=main`.cwd(cwd).quiet();
		await $`git config user.name "Test User"`.cwd(cwd).quiet();
		await $`git config user.email "test@example.com"`.cwd(cwd).quiet();
		await Bun.write(path.join(cwd, "tracked.txt"), "base\n");
		await $`git add tracked.txt && git commit -m base`.cwd(cwd).quiet();
		await Bun.write(path.join(cwd, "tracked.txt"), "staged\n");
		await $`git add tracked.txt`.cwd(cwd).quiet();

		const originalProjectDir = getProjectDir();
		const discoverRepo = vcs.repo;
		let statusReadDone: (() => void) | undefined;
		const repoSpy = spyOn(vcs, "repo").mockImplementation(repoCwd => {
			const repository = discoverRepo(repoCwd);
			if (!repository) return null;
			const statusSummary = repository.statusSummary.bind(repository);
			repository.statusSummary = async signal => {
				try {
					return await statusSummary(signal);
				} finally {
					statusReadDone?.();
					statusReadDone = undefined;
				}
			};
			return repository;
		});
		const awaitStatusRead = async (component: StatusLineComponent): Promise<string> => {
			const settled = Promise.withResolvers<void>();
			statusReadDone = settled.resolve;
			component.getTopBorder(120);
			await settled.promise;
			await Promise.resolve();
			return Bun.stripANSI(component.getTopBorder(120).content);
		};

		const headPath = path.join(cwd, ".git", "HEAD");
		const headBeforeCommit = await Bun.file(headPath).text();
		let now = 1_000_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		setProjectDir(cwd);
		const component = new StatusLineComponent(fakeSession());
		component.updateSettings({
			preset: "custom",
			leftSegments: ["git"],
			rightSegments: [],
			separator: "powerline-thin",
			sessionAccent: false,
		});
		try {
			expect(await awaitStatusRead(component)).toContain("+1");

			await $`git commit -m staged`.cwd(cwd).quiet();
			expect(await Bun.file(headPath).text()).toBe(headBeforeCommit);
			now += 1_000;

			expect(await awaitStatusRead(component)).not.toContain("+1");
		} finally {
			component.dispose();
			setProjectDir(originalProjectDir);
			nowSpy.mockRestore();
			repoSpy.mockRestore();
		}
	});
});
