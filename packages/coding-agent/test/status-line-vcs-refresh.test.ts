/**
 * Regression: StatusLineComponent's VCS segment was blank on the first (cold)
 * paint and only appeared after an unrelated re-render (e.g. flipping a
 * statusline setting and back). The async git-status and jj-label fetches
 * filled their caches but never called #onBranchChange, so the resolved value
 * had no way to reach the screen until something else forced a repaint. Worst
 * in a jj workspace, where there is no git branch so the PR / default-branch
 * lookups (which do fire #onBranchChange) never run.
 *
 * Contract: when an async VCS fetch resolves with a value, the component
 * requests a repaint via #onBranchChange. (Post-dispose suppression of the
 * same callback is covered by status-line-dispose-async-leak.test.ts.)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
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
			getSessionName: () => "vcs-refresh test",
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

const fakeRefHead: VcsHeadState = {
	kind: "ref",
	branch: "main",
	refName: "refs/heads/main",
	commit: undefined,
};
const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	isReftable: false,
};

const gitControls = {
	defaultBranch: vi.fn(async (_signal?: AbortSignal): Promise<string | null> => null),
	head: vi.fn(async (_signal?: AbortSignal): Promise<VcsHeadState | null> => fakeRefHead),
	headSync: vi.fn((): VcsHeadState | null => fakeRefHead),
	statusSummary: vi.fn(async (_signal?: AbortSignal): Promise<GitStatus | null> => ({
		staged: 0,
		unstaged: 0,
		untracked: 0,
	})),
};

const fakeRepository = {
	defaultBranch: (signal?: AbortSignal) => gitControls.defaultBranch(signal),
	head: (signal?: AbortSignal) => gitControls.head(signal),
	headSync: () => gitControls.headSync(),
	linkedWorktree: () => null,
	statusSummary: (signal?: AbortSignal) => gitControls.statusSummary(signal),
} as unknown as VcsGitRepo;

const jjControls = {
	statusSummary: vi.fn(async (_signal?: AbortSignal): Promise<GitStatus | null> => ({
		staged: 0,
		unstaged: 0,
		untracked: 0,
	})),
	label: vi.fn(async (_signal?: AbortSignal): Promise<string | null> => null),
};

function unifiedGit(repository: VcsGitRepo, info: VcsGitRepoInfo = fakeRepoInfo): VcsRepo {
	return {
		kind: () => "git",
		asGit: () => repository,
		asJj: () => null,
		root: () => info.repoRoot,
		watchTarget: () => info.headPath,
		statusSummary: (signal?: AbortSignal) => repository.statusSummary(signal),
	} as unknown as VcsRepo;
}

const fakeVcsRepository = unifiedGit(fakeRepository);

const fakeJjRepository = {
	kind: () => "jj",
	asGit: () => null,
	asJj: () => null,
	root: () => "/fake/jj/root",
	watchTarget: () => "/fake/jj/root/.jj/repo/op_heads/heads",
	statusSummary: (signal?: AbortSignal) => jjControls.statusSummary(signal),
	label: (signal?: AbortSignal) => jjControls.label(signal),
} as unknown as VcsRepo;

beforeEach(() => {
	gitControls.defaultBranch.mockReset().mockResolvedValue(null);
	gitControls.head.mockReset().mockResolvedValue(fakeRefHead);
	gitControls.headSync.mockReset().mockReturnValue(fakeRefHead);
	gitControls.statusSummary.mockReset().mockResolvedValue({ staged: 0, unstaged: 0, untracked: 0 });
	jjControls.statusSummary.mockReset().mockResolvedValue({ staged: 0, unstaged: 0, untracked: 0 });
	jjControls.label.mockReset().mockResolvedValue(null);
	vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
	vi.spyOn(vcs, "git").mockReturnValue(fakeRepository);
	vi.spyOn(vcs, "repo").mockReturnValue(fakeVcsRepository);
});

function useReftable(info: Partial<VcsGitRepoInfo> = {}): void {
	vi.spyOn(vcs, "gitInfo").mockReturnValue({ ...fakeRepoInfo, ...info, isReftable: true });
}

function fakeRepoHandle(info: VcsGitRepoInfo, branch: string): VcsRepo {
	const repository = {
		defaultBranch: (signal?: AbortSignal) => gitControls.defaultBranch(signal),
		headSync: () => ({ ...fakeRefHead, branch, refName: `refs/heads/${branch}` }),
		linkedWorktree: () => null,
		statusSummary: (signal?: AbortSignal) => gitControls.statusSummary(signal),
	} as unknown as VcsGitRepo;
	return unifiedGit(repository, info);
}

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

describe("StatusLineComponent repaints when an async VCS fetch resolves", () => {
	it("fires #onBranchChange when git status resolves on the cold paint", async () => {
		gitControls.headSync.mockReturnValue(fakeRefHead);
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		const status = Promise.withResolvers<GitStatus | null>();
		gitControls.statusSummary.mockReturnValue(status.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the git-status fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		status.resolve({ staged: 1, unstaged: 2, untracked: 3 });
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("fires #onBranchChange when the jj label resolves on the cold paint", async () => {
		gitControls.headSync.mockReturnValue(null); // no git branch -> jj overlay
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise); // isolate the jj fire
		vi.spyOn(vcs, "repo").mockReturnValue(fakeJjRepository);
		const label = Promise.withResolvers<string | null>();
		jjControls.label.mockReturnValue(label.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the jj-label fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		label.resolve("feature-x");
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});

	it("fires #onBranchChange when jj status resolves on the cold paint", async () => {
		gitControls.headSync.mockReturnValue(null); // no git -> jj repo
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(vcs, "repo").mockReturnValue(fakeJjRepository);
		jjControls.label.mockReturnValue(Promise.withResolvers<string | null>().promise); // isolate the status fire
		const status = Promise.withResolvers<GitStatus | null>();
		jjControls.statusSummary.mockReturnValue(status.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		component.getTopBorder(80); // cold paint kicks off the jj-status fetch
		expect(onBranchChange).not.toHaveBeenCalled();

		status.resolve({ staged: 0, unstaged: 4, untracked: 1 });
		await Promise.resolve();
		await Promise.resolve();

		expect(onBranchChange).toHaveBeenCalled();
		component.dispose();
	});
});
describe("StatusLineComponent reftable branch resolve honors mid-flight invalidation", () => {
	it("discards a stale resolve invalidated mid-flight, keeps the fresh one", async () => {
		// Force the reftable async-resolve path.
		useReftable();
		// Keep the sibling async fetches quiet so only the branch resolve drives
		// #onBranchChange: git.status stays in flight forever, jj is no repo here.
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const refHead = (branchName: string): VcsHeadState => ({
			...fakeRefHead,
			branch: branchName,
			refName: `refs/heads/${branchName}`,
		});

		// Two controllable resolves: the stale one (R1) then the fresh one (R2).
		const r1 = Promise.withResolvers<VcsHeadState | null>();
		const r2 = Promise.withResolvers<VcsHeadState | null>();
		const resolveSpy = gitControls.head;
		resolveSpy.mockReturnValueOnce(r1.promise);
		resolveSpy.mockReturnValueOnce(r2.promise);

		const onBranchChange = vi.fn();
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);

		// Cold paint kicks the stale resolve (R1).
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(1);

		// A HEAD move fires the watcher: invalidateGitCaches bumps the
		// generation and releases the in-flight slot.
		component.invalidateGitCaches();

		// The repaint starts a fresh resolve (R2) for the same cwd.
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(2);

		// R1 (stale) lands first. Pre-fix it passed the in-flight-cwd guard
		// (R2 had re-set the slot), installed the stale branch, cleared the
		// marker, and caused R2 to be discarded — freezing the status line on
		// the pre-change branch.
		r1.resolve(refHead("stale-branch"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onBranchChange).not.toHaveBeenCalled();

		// R2 (fresh) lands and commits.
		r2.resolve(refHead("fresh-branch"));
		await Promise.resolve();
		await Promise.resolve();
		expect(onBranchChange).toHaveBeenCalledTimes(1);

		// The committed value is the fresh branch, served from cache with no new
		// resolve, and the stale name never reaches the rendered segment.
		expect(gitControls.head).toHaveBeenCalledTimes(2);
		const border = component.getTopBorder(80);
		expect(border.content).toContain("fresh-branch");
		expect(border.content).not.toContain("stale-branch");
		expect(gitControls.head).toHaveBeenCalledTimes(2);

		component.dispose();
	});

	it("aborts an invalidated resolve and starts only one replacement resolve", async () => {
		useReftable();
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const signals: AbortSignal[] = [];
		gitControls.head.mockImplementation(signal => {
			if (!signal) throw new Error("reftable resolve must receive an abort signal");
			signals.push(signal);
			const { promise, reject } = Promise.withResolvers<VcsHeadState | null>();
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(1);

		component.invalidateGitCaches();
		expect(signals[0]?.aborted).toBe(true);
		component.invalidateGitCaches();
		component.getTopBorder(80);
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(2);

		component.dispose();
		expect(signals[1]?.aborted).toBe(true);
		await Promise.resolve();
	});

	it("generic invalidate does not abort or restart a live reftable HEAD resolve", async () => {
		useReftable();
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(nodeFs, "watchFile").mockImplementation(() => {
			throw new Error("watch unavailable");
		});

		const signals: AbortSignal[] = [];
		const { promise, reject } = Promise.withResolvers<VcsHeadState | null>();
		gitControls.head.mockImplementation(signal => {
			if (!signal) throw new Error("reftable resolve must receive an abort signal");
			signals.push(signal);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(vi.fn());
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(1);

		// Many generic invalidations (message events, model switches, theme
		// changes, …) must not abort the live resolve or fan out replacement
		// git subprocesses — the render path self-invalidates via cwd/context
		// cache-miss checks, so a generic paint only re-renders.
		for (let i = 0; i < 10; i++) {
			component.invalidate();
		}
		component.getTopBorder(80);
		component.getTopBorder(80);

		expect(signals[0]?.aborted).toBe(false);
		expect(gitControls.head).toHaveBeenCalledTimes(1);

		// Disposal still aborts the in-flight resolve.
		component.dispose();
		expect(signals[0]?.aborted).toBe(true);
		await Promise.resolve();
	});

	it("polls a reftable branch after HEAD watcher installation fails", async () => {
		useReftable();
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(nodeFs, "watchFile").mockImplementation(() => {
			throw new Error("watch unavailable");
		});
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		gitControls.head
			.mockResolvedValueOnce({ ...fakeRefHead, branch: "before-change", refName: "refs/heads/before-change" })
			.mockResolvedValueOnce({ ...fakeRefHead, branch: "after-change", refName: "refs/heads/after-change" });

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(vi.fn());
		component.getTopBorder(80);
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("before-change");
		expect(gitControls.head).toHaveBeenCalledTimes(1);

		// No filesystem event arrives, but the next bounded poll observes the new HEAD.
		now += 5_001;
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(2);
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("after-change");
		component.dispose();
	});

	it("does not query an ancestor jj workspace while nested Git HEAD resolution is pending", async () => {
		const jjRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-jj-root-"));
		const nestedGitCwd = path.join(jjRootDir, "nested-ordinary-git");
		await fs.mkdir(nestedGitCwd);
		useReftable({
			commonDir: `${nestedGitCwd}/.git`,
			gitDir: `${nestedGitCwd}/.git`,
			gitEntryPath: `${nestedGitCwd}/.git`,
			headPath: `${nestedGitCwd}/.git/HEAD`,
			repoRoot: nestedGitCwd,
		});
		gitControls.head.mockReturnValue(Promise.withResolvers<VcsHeadState | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const jjLabel = jjControls.label.mockReturnValue(Promise.resolve("ancestor-bookmark"));
		const jjStatus = jjControls.statusSummary.mockReturnValue(
			Promise.resolve({ staged: 0, unstaged: 0, untracked: 0 }),
		);
		setProjectDir(nestedGitCwd);

		try {
			const component = new StatusLineComponent(makeSession());
			component.updateSettings(gitSegment);
			component.getTopBorder(80);
			expect(gitControls.head).toHaveBeenCalledTimes(1);
			expect(jjLabel).not.toHaveBeenCalled();
			expect(jjStatus).not.toHaveBeenCalled();
			component.dispose();
		} finally {
			setProjectDir(originalProjectDir);
			await fs.rm(jjRootDir, { recursive: true, force: true });
		}
	});

	it("does not query an ancestor jj workspace after nested Git HEAD resolution fails", async () => {
		useReftable({
			commonDir: "/nested/.git",
			gitDir: "/nested/.git",
			gitEntryPath: "/nested/.git",
			headPath: "/nested/.git/HEAD",
			repoRoot: "/nested",
		});
		gitControls.head.mockResolvedValue(null);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.getTopBorder(80);
		await Promise.resolve();
		await Promise.resolve();
		component.getTopBorder(80);

		expect(gitControls.head).toHaveBeenCalledTimes(1);
		expect(jjControls.label).not.toHaveBeenCalled();
		component.dispose();
	});
});

describe("StatusLineComponent VCS watcher and jj request lifecycle", () => {
	it("reuses one repository handle across repeated paints", () => {
		const repoSpy = vi.spyOn(vcs, "repo");
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);

		component.getTopBorder(80);
		component.getTopBorder(80);
		component.getTopBorder(80);

		expect(repoSpy).toHaveBeenCalledTimes(1);
		component.dispose();
	});

	it("discovers a repository created after setup with bounded single-flight polling", async () => {
		let now = 1_000_000;
		const repositoryCreatedAt = now + 5_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(vcs, "gitInfo").mockImplementation(() =>
			now >= repositoryCreatedAt ? { ...fakeRepoInfo, isReftable: true } : null,
		);
		vi.spyOn(vcs, "repo").mockImplementation(() => (now >= repositoryCreatedAt ? fakeVcsRepository : null));
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const head = Promise.withResolvers<VcsHeadState | null>();
		gitControls.head.mockReturnValue(head.promise);

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(vi.fn());
		component.getTopBorder(80);
		expect(gitControls.head).not.toHaveBeenCalled();

		now += 1_000;
		component.getTopBorder(80);
		expect(gitControls.head).not.toHaveBeenCalled();

		// The bounded discovery interval reaches the new repository. Repeated
		// paints while its reftable resolve is hung must reuse the one request.
		now += 4_001;
		component.getTopBorder(80);
		component.getTopBorder(80);
		expect(gitControls.head).toHaveBeenCalledTimes(1);

		head.resolve({ ...fakeRefHead, branch: "created-later", refName: "refs/heads/created-later" });
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("created-later");
		component.dispose();
	});

	it("aborts superseded jj branch and status queries without blocking their replacements", async () => {
		gitControls.headSync.mockReturnValue(null);
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		vi.spyOn(vcs, "repo").mockReturnValue(fakeJjRepository);

		const labelRequests: Array<{ signal: AbortSignal; resolve: (value: string | null) => void }> = [];
		jjControls.label.mockImplementation(signal => {
			if (!signal) {
				throw new Error("jj label requires the central bounded options");
			}
			const request = Promise.withResolvers<string | null>();
			signal.addEventListener("abort", () => request.resolve(null), { once: true });
			labelRequests.push({ signal, resolve: request.resolve });
			return request.promise;
		});
		const statusRequests: Array<{ signal: AbortSignal; resolve: (value: GitStatus | null) => void }> = [];
		jjControls.statusSummary.mockImplementation(signal => {
			if (!signal) {
				throw new Error("jj status requires the central bounded options");
			}
			const request = Promise.withResolvers<GitStatus | null>();
			signal.addEventListener("abort", () => request.resolve(null), { once: true });
			statusRequests.push({ signal, resolve: request.resolve });
			return request.promise;
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.getTopBorder(80);
		expect(labelRequests).toHaveLength(1);
		expect(statusRequests).toHaveLength(1);

		component.invalidateGitCaches();
		expect(labelRequests[0]?.signal.aborted).toBe(true);
		expect(statusRequests[0]?.signal.aborted).toBe(true);
		component.getTopBorder(80);
		expect(labelRequests).toHaveLength(2);
		expect(statusRequests).toHaveLength(2);

		labelRequests[1]?.resolve("fresh-bookmark");
		statusRequests[1]?.resolve({ staged: 0, unstaged: 1, untracked: 0 });
		await Promise.resolve();
		await Promise.resolve();
		expect(component.getTopBorder(80).content).toContain("fresh-bookmark");

		component.invalidateGitCaches();
		component.getTopBorder(80);
		expect(labelRequests).toHaveLength(3);
		expect(statusRequests).toHaveLength(3);
		component.dispose();
		expect(labelRequests[2]?.signal.aborted).toBe(true);
		expect(statusRequests[2]?.signal.aborted).toBe(true);
		await Promise.resolve();
	});
});

describe("StatusLineComponent applyCwdChange re-points watcher ownership", () => {
	let dirA: string;
	let dirB: string;
	let dirNoRepo: string;
	let repoA: VcsRepo;
	let repoB: VcsRepo;
	let repoAInfo: VcsGitRepoInfo;
	let repoBInfo: VcsGitRepoInfo;

	beforeAll(async () => {
		dirA = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-repoA-"));
		dirB = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-repoB-"));
		dirNoRepo = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-norepo-"));
		repoAInfo = {
			commonDir: path.join(dirA, ".git"),
			gitDir: path.join(dirA, ".git"),
			gitEntryPath: path.join(dirA, ".git"),
			headPath: path.join(dirA, ".git", "HEAD"),
			repoRoot: dirA,
			isReftable: false,
		};
		repoBInfo = {
			commonDir: path.join(dirB, ".git"),
			gitDir: path.join(dirB, ".git"),
			gitEntryPath: path.join(dirB, ".git"),
			headPath: path.join(dirB, ".git", "HEAD"),
			repoRoot: dirB,
			isReftable: false,
		};
		repoA = fakeRepoHandle(repoAInfo, "branch-a");
		repoB = fakeRepoHandle(repoBInfo, "branch-b");
	});

	afterAll(async () => {
		setProjectDir(originalProjectDir);
		await Promise.all([
			fs.rm(dirA, { recursive: true, force: true }),
			fs.rm(dirB, { recursive: true, force: true }),
			fs.rm(dirNoRepo, { recursive: true, force: true }),
		]);
	});

	// Test double for node:fs.StatWatcher — `vcs.watch` only calls
	// `.unref()` on it; the listener is captured from the watchFile call args.
	function fakeStatWatcher(): nodeFs.StatWatcher {
		return { unref: vi.fn() } as unknown as nodeFs.StatWatcher;
	}

	type StatsListener = (curr: nodeFs.Stats, prev: nodeFs.Stats) => void;

	function statCall(
		spy: { mock: { calls: unknown[][] } },
		index: number,
	): { target: string; listener: StatsListener } {
		const call = spy.mock.calls[index] as unknown as [string, unknown, StatsListener] | undefined;
		if (!call) throw new Error(`watchFile call ${index} not recorded`);
		return { target: call[0], listener: call[2] };
	}

	const statsOf = (n: number) => ({ mtimeMs: n, ino: n, size: n }) as nodeFs.Stats;

	it("retires the old stat-watch and re-points at the new repo on cwd change", () => {
		vi.spyOn(vcs, "repo").mockImplementation((cwd: string) => {
			if (cwd === dirA) return repoA;
			if (cwd === dirB) return repoB;
			return null;
		});
		vi.spyOn(vcs, "gitInfo").mockImplementation((cwd: string) => {
			if (cwd === dirA) return repoAInfo;
			if (cwd === dirB) return repoBInfo;
			return null;
		});
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const watchFileSpy = vi.spyOn(nodeFs, "watchFile").mockReturnValue(fakeStatWatcher());
		const unwatchFileSpy = vi.spyOn(nodeFs, "unwatchFile").mockImplementation(() => {});

		const onBranchChange = vi.fn();
		setProjectDir(dirA);
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);
		expect(component.getTopBorder(80).content).toContain("branch-a");
		expect(watchFileSpy).toHaveBeenCalledWith(repoAInfo.headPath, expect.anything(), expect.any(Function));

		// Move cwd to repo B — the SessionManager's cwd has already moved.
		setProjectDir(dirB);
		component.applyCwdChange();
		// applyCwdChange itself requests one repaint; clear it so subsequent
		// calls are attributable solely to watcher events.
		onBranchChange.mockClear();

		// Old stat-watch is retired: its exact (path, listener) pair unwatched.
		expect(unwatchFileSpy).toHaveBeenCalledWith(repoAInfo.headPath, statCall(watchFileSpy, 0).listener);
		// New stat-watch is live on repo B's HEAD.
		expect(watchFileSpy).toHaveBeenCalledWith(repoBInfo.headPath, expect.anything(), expect.any(Function));

		// Stale stat event from repo A's retired watch must not invalidate B's
		// caches or request a repaint — the ownership guard rejects it.
		statCall(watchFileSpy, 0).listener(statsOf(2), statsOf(1));
		expect(onBranchChange).not.toHaveBeenCalled();

		// Fresh stat event from repo B's watch refreshes B.
		statCall(watchFileSpy, 1).listener(statsOf(2), statsOf(1));
		expect(onBranchChange).toHaveBeenCalledTimes(1);
		expect(component.getTopBorder(80).content).toContain("branch-b");

		// No watch leak: dispose unwatches B's (path, listener) pair.
		component.dispose();
		expect(unwatchFileSpy).toHaveBeenCalledWith(repoBInfo.headPath, statCall(watchFileSpy, 1).listener);
	});

	it("falls back to bounded polling when the new cwd has no repository", () => {
		vi.spyOn(vcs, "repo").mockImplementation((cwd: string) => (cwd === dirA ? repoA : null));
		vi.spyOn(vcs, "gitInfo").mockImplementation((cwd: string) => (cwd === dirA ? repoAInfo : null));
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const watchFileSpy = vi.spyOn(nodeFs, "watchFile").mockReturnValue(fakeStatWatcher());
		const unwatchFileSpy = vi.spyOn(nodeFs, "unwatchFile").mockImplementation(() => {});

		const onBranchChange = vi.fn();
		setProjectDir(dirA);
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);
		component.watchBranch(onBranchChange);
		component.getTopBorder(80);

		// Move to a directory with no git repo — watcher unavailable fallback.
		setProjectDir(dirNoRepo);
		onBranchChange.mockClear();
		component.applyCwdChange();

		// Old stat-watch retired; no new watch created (watchFile not called again).
		expect(unwatchFileSpy).toHaveBeenCalledTimes(1);
		expect(watchFileSpy).toHaveBeenCalledTimes(1);
		// applyCwdChange still requests a repaint so the stale segment clears.
		expect(onBranchChange).toHaveBeenCalledTimes(1);

		// Rendering does not crash and the git segment is blank for no-repo.
		const border = component.getTopBorder(80);
		expect(border).toBeDefined();
		expect(border.content).not.toContain("branch-a");

		component.dispose();
	});
});

describe("StatusLineComponent git watcher survives atomic HEAD renames", () => {
	let repoDir: string;

	beforeAll(async () => {
		repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "status-line-headwatch-"));
		const gitDir = path.join(repoDir, ".git");
		await fs.mkdir(gitDir);
		await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	});

	afterAll(async () => {
		setProjectDir(originalProjectDir);
		await fs.rm(repoDir, { recursive: true, force: true });
	});

	// git rewrites HEAD via a lock file + atomic rename (HEAD.lock → HEAD), which
	// unlinks the inode. A file-bound `fs.watch` died on the stale inode after the
	// first switch (issue #8412), and Bun's inotify-backed directory watch on
	// Linux permanently stops delivering events after the first rename it observes
	// (oven-sh/bun#24875). `vcs.watch` stat-polls the HEAD path, which
	// survives the inode swap on every platform.
	it("keeps firing #onBranchChange across consecutive branch switches", async () => {
		vi.restoreAllMocks();
		gitControls.defaultBranch.mockReturnValue(Promise.withResolvers<string | null>().promise);
		gitControls.statusSummary.mockReturnValue(Promise.withResolvers<GitStatus | null>().promise);
		const watchFileSpy = vi.spyOn(nodeFs, "watchFile");

		setProjectDir(repoDir);
		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegment);

		// Await the watcher's own #onBranchChange signal rather than a wall-clock
		// delay. Only resolve once the atomically replaced HEAD is observable.
		let branchChanged = Promise.withResolvers<void>();
		let expectedBranch: string | null = null;
		component.watchBranch(() => {
			if (expectedBranch && component.getTopBorder(80).content.includes(expectedBranch)) {
				branchChanged.resolve();
			}
		});
		// Platform-independent pin: the watch must be a stat-poll of the HEAD
		// *path* (inode-independent), not an fs.watch event subscription.
		expect(watchFileSpy).toHaveBeenCalledWith(
			path.join(repoDir, ".git", "HEAD"),
			expect.objectContaining({ interval: vcs.HEAD_WATCH_INTERVAL_MS }),
			expect.any(Function),
		);
		// Prime the branch cache off the initial HEAD. The status/default mocks
		// never resolve, so this cold paint cannot fire #onBranchChange itself.
		component.getTopBorder(80);

		const switchTo = async (branchName: string) => {
			const gitDir = path.join(repoDir, ".git");
			const headLock = path.join(gitDir, "HEAD.lock");
			// Reproduce Git's relevant integration boundary directly: write the
			// lock, then atomically replace HEAD. Spawning Git adds process startup
			// but no coverage to the filesystem-watcher regression.
			await fs.writeFile(headLock, `ref: refs/heads/${branchName}\n`);
			branchChanged = Promise.withResolvers<void>();
			expectedBranch = branchName;
			const fired = branchChanged.promise;
			await fs.rename(headLock, path.join(gitDir, "HEAD"));
			await fired;
			expectedBranch = null;
		};

		await switchTo("first");
		expect(component.getTopBorder(80).content).toContain("first");

		// Regression: the second switch must still reach the display.
		await switchTo("second");
		expect(component.getTopBorder(80).content).toContain("second");

		component.dispose();
	});
});
