import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	$which,
	__resetProjectDirCacheForTests,
	isPidAlive,
	procmgr,
	setProjectDir,
	setWorktreesDir,
} from "@oh-my-pi/pi-utils";
import { parseArgs } from "../../src/cli/args";
import { applyStartupCwd } from "../../src/cli/startup-cwd";
import { Settings } from "../../src/config/settings";
import {
	canAutoCreateWorktree,
	createSessionWorktree,
	decideWorktreeExit,
	inspectSessionWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	removeSessionWorktree,
	type SessionWorktreeState,
	type WorktreeExitAction,
} from "../../src/session/session-worktree";
import { formatPostCheckoutHookWarning, runPostCheckoutHook } from "../../src/utils/worktree-hook";

const clean: SessionWorktreeState = { dirty: false, moved: false, offBranch: false };

const rows: [
	name: string,
	policy: "keep" | "ask" | "remove",
	state: SessionWorktreeState,
	expected: WorktreeExitAction,
][] = [
	["keep ignores state", "keep", { dirty: true, moved: true, offBranch: true }, "keep"],
	["ask prompts even when clean", "ask", clean, "prompt"],
	["remove removes a clean worktree", "remove", clean, "remove"],
	["remove prompts when dirty", "remove", { ...clean, dirty: true }, "prompt"],
	["remove prompts when the branch moved", "remove", { ...clean, moved: true }, "prompt"],
	["remove prompts when HEAD left the branch", "remove", { ...clean, offBranch: true }, "prompt"],
];

describe("decideWorktreeExit", () => {
	it.each(rows)("%s", (_name, policy, state, action) => {
		expect(decideWorktreeExit(policy, state)).toBe(action);
	});
});

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function worktreePaths(repo: string): string[] {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => path.resolve(line.slice("worktree ".length)));
}

function branchSha(repo: string, branch: string): string | null {
	const r = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: repo,
		stdout: "pipe",
	});
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

const commitFile = async (cwd: string, name: string) => {
	await Bun.write(path.join(cwd, name), "x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-q", "-m", `add ${name}`);
};

describe("session worktree helpers (real git)", () => {
	let root: string;
	let repo: string;
	let savedEnv: string | undefined;
	let savedCwd: string;
	const branch = "wt/test-session";

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-wt-")));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		savedEnv = process.env.OMP_WORKTREE_DIR;
		savedCwd = process.cwd();
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "core.autocrlf", "false");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterEach(async () => {
		process.chdir(savedCwd);
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		await fs.rm(root, { recursive: true, force: true });
	});

	const create = (keepChanges = true, name = branch) =>
		createSessionWorktree(repo, Settings.isolated(), name, { keepChanges });

	it("offers a worktree only in a primary checkout with commits", async () => {
		const plain = path.join(root, "plain");
		const unborn = path.join(root, "unborn");
		await fs.mkdir(plain);
		await fs.mkdir(unborn);
		git(unborn, "init", "-q");
		await expect(createSessionWorktree(unborn, Settings.isolated(), branch)).rejects.toThrow("has no commits");
		expect(await exists(path.join(root, "wt"))).toBe(false);
		const wt = await create();
		expect(await canAutoCreateWorktree(repo)).toBe(true);
		expect(await canAutoCreateWorktree(plain)).toBe(false);
		expect(await canAutoCreateWorktree(unborn)).toBe(false);
		expect(await canAutoCreateWorktree(wt.path)).toBe(false);
	});

	it("removes a clean worktree and deletes its branch", async () => {
		const wt = await create();
		expect(worktreePaths(repo)).toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await removeSessionWorktree(wt, false);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBeNull();
	});

	it("keeps the branch at the new commit when the worktree moved", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
		await removeSessionWorktree(wt, true);
		expect(await exists(wt.path)).toBe(false);
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("prompts instead of removing when commits exist only on a detached HEAD", async () => {
		const wt = await create();
		git(wt.path, "switch", "-q", "--detach");
		await commitFile(wt.path, "detached.txt");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, offBranch: true });
		const prompts: string[] = [];
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async (_title, message) => {
				prompts.push(message);
				return false;
			},
			() => {},
		);
		expect(plan).toEqual([]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(`HEAD is not on ${branch}`);
		expect(await exists(wt.path)).toBe(true);
	});

	it("reports moved from the source repo when the worktree dir was deleted externally", async () => {
		const wt = await create();
		await commitFile(wt.path, "new.txt");
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		expect(worktreePaths(repo)).not.toContain(wt.path);
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, moved: true });
	});

	it("rejects and keeps the branch when git cannot remove the worktree", async () => {
		const wt = await create();
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		await expect(removeSessionWorktree(wt, false)).rejects.toThrow(`branch '${branch}' kept`);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});

	it("starts from clean HEAD with keepChanges:false and reports worktree edits as dirty", async () => {
		await Bun.write(path.join(repo, "tracked.txt"), "edited\n");
		await Bun.write(path.join(repo, "untracked.txt"), "u\n");
		const wt = await create(false);
		expect(wt.keptChanges).toBe(false);
		expect(wt.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
		expect(await Bun.file(path.join(wt.path, "tracked.txt")).text()).toBe("base\n");
		expect(await exists(path.join(wt.path, "untracked.txt"))).toBe(false);
		expect(git(wt.path, "status", "--porcelain")).toBe("");
		expect(git(repo, "diff", "--name-only")).toBe("tracked.txt");
		expect(git(repo, "ls-files", "--others", "--exclude-standard")).toBe("untracked.txt");
		expect(await inspectSessionWorktree(wt)).toEqual(clean);
		await Bun.write(path.join(wt.path, "tracked.txt"), "wt edit\n");
		expect(await inspectSessionWorktree(wt)).toEqual({ ...clean, dirty: true });
	});

	it("plans newest first and removes from inside the newest worktree", async () => {
		const older = await create(true, "wt/older");
		const newer = await create(true, "wt/newer");
		const plan = await planWorktreeExit(
			[older, newer],
			"remove",
			async () => {
				throw new Error("clean worktrees must not prompt");
			},
			() => {},
		);
		expect(plan.map(p => p.worktree.branch)).toEqual(["wt/newer", "wt/older"]);
		process.chdir(newer.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(newer.path)}. Resuming opens in the directory you launch omp from.`,
		]);
		expect(await fs.realpath(process.cwd())).toBe(repo);
		expect(worktreePaths(repo)).toEqual([repo]);
		expect(branchSha(repo, "wt/newer")).toBeNull();
		expect(branchSha(repo, "wt/older")).toBeNull();
	});

	it("keeps a worktree removed without a prompt that changed after planning", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "late.txt"), "written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await Bun.file(path.join(wt.path, "late.txt")).text()).toBe("written during teardown\n");
	});

	it("keeps a confirmed dirty worktree that got more uncommitted edits after the prompt", async () => {
		const wt = await create();
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		await Bun.write(path.join(wt.path, "dirty.txt"), "more work written during teardown\n");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("changed while the session was closing");
		expect(await exists(wt.path)).toBe(true);
	});

	it("removes a confirmed dirty worktree, keeps a moved branch, and names it in the resume note", async () => {
		const wt = await create();
		await commitFile(wt.path, "work.txt");
		const tip = git(wt.path, "rev-parse", "HEAD");
		await Bun.write(path.join(wt.path, "dirty.txt"), "d\n");
		const plan = await planWorktreeExit(
			[wt],
			"ask",
			async () => true,
			() => {},
		);
		expect(plan.map(p => p.worktree)).toEqual([wt]);
		process.chdir(wt.path);
		expect(await removeExitWorktrees(plan)).toEqual([
			`Removed worktree ${shortenPath(wt.path)}. Resuming opens in the directory you launch omp from; its commits are on branch ${branch}.`,
		]);
		expect(await exists(wt.path)).toBe(false);
		expect(branchSha(repo, branch)).toBe(tip);
	});

	it("returns a message instead of throwing when removal fails", async () => {
		const wt = await create();
		const plan = await planWorktreeExit(
			[wt],
			"remove",
			async () => true,
			() => {},
		);
		await fs.rm(wt.path, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		const messages = await removeExitWorktrees(plan);
		expect(messages).toEqual([`Failed to remove worktree ${wt.path}; branch '${branch}' kept.`]);
		expect(branchSha(repo, branch)).toBe(wt.baseCommit);
	});
});

describe.skipIf(process.platform === "win32")("session worktree post-checkout hook (real git)", () => {
	let root: string;
	let repo: string;
	let savedCwd: string;
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"OMP_WORKTREE_DIR",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"GIT_CONFIG_NOSYSTEM",
		"GIT_DIR",
		"HOME",
		"XDG_CONFIG_HOME",
	];
	const pidsToKill: number[] = [];
	/** Pid files a test's background process writes; afterEach kills them even when the test failed or timed out. */
	const pidFilesToKill: string[] = [];

	const installHook = async (script: string) => {
		const hookPath = path.join(repo, ".git", "hooks", "post-checkout");
		await Bun.write(hookPath, `#!/bin/sh\n${script}\n`);
		await fs.chmod(hookPath, 0o755);
	};
	/** `/wt`'s worktree steps: create the checkout, then run its hook. */
	const create = async (signal?: AbortSignal) => {
		const wt = await createSessionWorktree(repo, Settings.isolated(), "wt/hook", { keepChanges: true });
		const hookWarning = formatPostCheckoutHookWarning(await runPostCheckoutHook(wt.path, wt.baseCommit, { signal }));
		return { ...wt, hookWarning };
	};
	const headSha = () => git(repo, "rev-parse", "HEAD").trim();
	/** The hook environment with PATH replaced, passed as `env` so the test never mutates `process.env`. */
	const envWithPath = (value: string): Record<string, string> => ({ ...procmgr.getChildShellEnv(), PATH: value });
	/** Writes an executable `git` running `script` into its own bin dir; returns the dir, a hook env whose PATH is only that dir, and HEAD. */
	const fakeGit = async (script: string) => {
		const dir = path.join(root, "fakegit");
		const file = path.join(dir, "git");
		await Bun.write(file, `#!/bin/sh\n${script}\n`);
		await fs.chmod(file, 0o755);
		return { dir, env: envWithPath(dir), head: headSha() };
	};

	beforeEach(async () => {
		for (const key of envKeys) savedEnv[key] = process.env[key];
		savedCwd = process.cwd();
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-wt-hook-")));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		// Isolate from the developer's global git config (core.hooksPath, templates).
		await Bun.write(path.join(root, "gitconfig"), "");
		process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
		process.env.GIT_CONFIG_SYSTEM = path.join(root, "gitconfig");
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		process.env.HOME = root;
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.GIT_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
		git(repo, "init", "-q", "-b", "main");
		await Bun.write(path.join(repo, "tracked.txt"), "base\n");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "init");
	});

	afterEach(async () => {
		for (const file of pidFilesToKill.splice(0)) {
			const pid = Number.parseInt(
				await Bun.file(file)
					.text()
					.catch(() => ""),
				10,
			);
			if (pid > 0) pidsToKill.push(pid);
		}
		for (const pid of pidsToKill.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		process.chdir(savedCwd);
		setWorktreesDir(undefined);
		for (const key of envKeys) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		procmgr.__resetShellConfigCacheForTests();
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("runs the hook in the new worktree with git's new-worktree arguments", async () => {
		await installHook('{ pwd -P; printf "%s\\n" "$@"; } > hook.out');
		const wt = await create();
		expect(wt.hookWarning).toBeUndefined();
		const lines = (await Bun.file(path.join(wt.path, "hook.out")).text()).trim().split("\n");
		expect(lines).toEqual([wt.path, "0".repeat(wt.baseCommit.length), wt.baseCommit, "1"]);
	});

	it.each([
		{
			what: "the exit status and cleaned last line",
			script: "printf 'earlier\\n'; printf '\\033[31mboom\\033[0m\\tbad\\n' >&2; exit 7",
			expected: "Worktree created, but post-checkout hook exited with 7: boom   bad",
		},
		{
			what: "the last carriage-return progress frame rather than gluing frames together",
			script: "printf 'copy 10 percent\\rcopy 55 percent\\rcopy 100 percent\\r' >&2; exit 4",
			expected: "Worktree created, but post-checkout hook exited with 4: copy 100 percent",
		},
	])("keeps the worktree and warns with $what when the hook fails", async ({ script, expected }) => {
		await installHook(script);
		const wt = await create();
		expect(worktreePaths(repo)).toContain(wt.path);
		expect(wt.hookWarning).toBe(expected);
	});

	it("runs the hook with the git the lookup resolves when that git is not on the hook's PATH", async () => {
		// Models $which's macOS fallback to Xcode/CLT git, which a bare `git` spawn on this PATH cannot find.
		// $which calls Bun.which on every lookup, so spying on Bun.which is its test seam.
		const realGit = $which("git");
		const realWhich = Bun.which;
		const bunDir = path.join(root, "bin");
		await fs.mkdir(bunDir);
		await fs.symlink(process.execPath, path.join(bunDir, "bun"));
		await installHook("pwd -P > hook.out");
		vi.spyOn(Bun, "which").mockImplementation((command, options) =>
			command === "git" ? realGit : realWhich(command, options),
		);
		expect(await runPostCheckoutHook(repo, headSha(), { env: envWithPath(bunDir) })).toEqual({ status: "ok" });
		expect((await Bun.file(path.join(repo, "hook.out")).text()).trim()).toBe(repo);
	});

	it("resolves a relative PATH entry against the worktree, as a bare git spawn there would", async () => {
		const realGit = $which("git");
		const wrapper = path.join(repo, "hookbin", "git");
		await Bun.write(wrapper, `#!/bin/sh\nexec '${realGit}' "$@"\n`);
		await fs.chmod(wrapper, 0o755);
		await installHook("pwd -P > hook.out");
		expect(await runPostCheckoutHook(repo, headSha(), { env: envWithPath("hookbin") })).toEqual({ status: "ok" });
		expect((await Bun.file(path.join(repo, "hook.out")).text()).trim()).toBe(repo);
	});

	it("does not take a lowercase `path` for PATH, since POSIX env names are case-sensitive", async () => {
		const ran = path.join(root, "fake-git-ran");
		const { dir, head } = await fakeGit(`: > '${ran}'\necho "git version 2.99.0"`);
		const env: Record<string, string> = { ...procmgr.getChildShellEnv(), path: dir };
		delete env.PATH;
		await runPostCheckoutHook(repo, head, { env });
		expect(await Bun.file(ran).exists()).toBe(false);
	});

	it.each([
		{
			why: "older than 2.36 (no `git hook run`)",
			script: `[ "$1" = version ] && { echo "git version 2.34.1"; exit 0; }\necho "git: 'hook' is not a git command." >&2\nexit 1`,
			reason: "git 2.34",
		},
		{
			why: "a stub that runs nothing (macOS without the Command Line Tools)",
			script: `echo "xcrun: error: invalid active developer path" >&2\nexit 1`,
			reason: "`git version` failed",
		},
		{
			why: "missing from PATH",
			script: undefined,
			reason: "git executable not found",
		},
	])("reports nothing for /wt when git is $why", async ({ script, reason }) => {
		let env: Record<string, string>;
		let head: string;
		if (script === undefined) {
			const emptyDir = path.join(root, "empty-bin");
			await fs.mkdir(emptyDir);
			env = envWithPath(emptyDir);
			head = headSha();
		} else ({ env, head } = await fakeGit(script));
		const result = await runPostCheckoutHook(repo, head, { env });
		expect(result).toEqual({ status: "unavailable", reason: expect.stringContaining(reason) });
		expect(formatPostCheckoutHookWarning(result)).toBeUndefined();
	});

	// A real stuck git process: the poll waits on OS state, which fake timers cannot drive.
	it("cancels while `git version` is stuck, without running the hook", async () => {
		const started = path.join(root, "version-started");
		const { env, head } = await fakeGit(`[ "$1" = version ] && { : > '${started}'; exec /bin/sleep 30; }\nexit 1`);
		const controller = new AbortController();
		const pending = runPostCheckoutHook(repo, head, { env, signal: controller.signal });
		for (let i = 0; i < 200 && !(await Bun.file(started).exists()); i++) await Bun.sleep(25);
		controller.abort();
		expect(await pending).toEqual({ status: "cancelled" });
	});

	it("returns promptly when `git version` leaves a background process holding its output", async () => {
		const bgPid = path.join(root, "version-bg.pid");
		pidFilesToKill.push(bgPid);
		const { env, head } = await fakeGit(
			`if [ "$1" = version ]; then echo "git version 2.99.0"; /bin/sleep 30 & echo $! > '${bgPid}'; fi\nexit 0`,
		);
		const started = Date.now();
		expect(await runPostCheckoutHook(repo, head, { env })).toEqual({ status: "ok" });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("reports an error, not a missing git, when the hook's cwd is missing but git is on PATH", async () => {
		const result = await runPostCheckoutHook(path.join(root, "does-not-exist"), "a".repeat(40));
		expect(result.status).toBe("error");
		expect(formatPostCheckoutHookWarning(result)).toBeDefined();
	});

	it("does not pass omp's GIT_DIR to the hook", async () => {
		await installHook('printf "%s" "${GIT_DIR-unset}" > hook.out');
		const ompGitDir = path.join(root, "omp-start-repo", ".git");
		process.env.GIT_DIR = ompGitDir;
		const wt = await create();
		const seen = await Bun.file(path.join(wt.path, "hook.out")).text();
		// Git itself points GIT_DIR at the new worktree's gitdir; it must not be omp's.
		expect(seen).toContain(path.join(repo, ".git", "worktrees"));
	});

	it.each([
		{
			what: "moved to another project before any shell use",
			fromHome: false,
			args: (_dest: string): string[] => [],
			moveAfterStart: true,
			result: "keeps the launch directory's dotenv-only value from the hook",
			seen: "unset",
		},
		{
			what: "started with --cwd somewhere else",
			fromHome: false,
			args: (dest: string) => ["--cwd", dest],
			moveAfterStart: false,
			result: "keeps the launch directory's dotenv-only value from the hook",
			seen: "unset",
		},
		{
			what: "started from $HOME with --cwd",
			fromHome: true,
			args: (dest: string) => ["--cwd", dest],
			moveAfterStart: false,
			result: "passes ~/.env values, user config, to the hook",
			seen: "from-launch-dotenv",
		},
	])("$result when omp was $what", async ({ fromHome, args, moveAfterStart, seen }) => {
		// Bun reads HOME once at startup, so the suite's HOME=root needs the lookup faked too.
		if (fromHome) vi.spyOn(os, "homedir").mockReturnValue(root);
		const launch = fromHome ? root : path.join(root, "launch");
		const elsewhere = path.join(root, "elsewhere");
		await fs.mkdir(launch, { recursive: true });
		await fs.mkdir(elsewhere);
		await Bun.write(path.join(launch, ".env"), "OMP_HOOK_DOTENV_ONLY=from-launch-dotenv\n");
		await installHook('printf "%s" "${OMP_HOOK_DOTENV_ONLY-unset}" > hook.out');
		procmgr.__resetShellConfigCacheForTests();
		__resetProjectDirCacheForTests();
		// The directory omp was launched in, whose dotenv Bun loaded into the environment.
		setProjectDir(launch);
		process.env.OMP_HOOK_DOTENV_ONLY = "from-launch-dotenv";
		try {
			await applyStartupCwd(parseArgs(args(elsewhere)));
			// `/move` (or a resume into another project) before anything built a shell environment.
			if (moveAfterStart) setProjectDir(elsewhere);
			const wt = await create();
			expect(await Bun.file(path.join(wt.path, "hook.out")).text()).toBe(seen);
		} finally {
			delete process.env.OMP_HOOK_DOTENV_ONLY;
			procmgr.__resetShellConfigCacheForTests();
			__resetProjectDirCacheForTests();
		}
	});

	it("returns promptly when the hook leaves a background process holding its output", async () => {
		await installHook("sleep 30 &\necho $! > bg.pid");
		const started = Date.now();
		const wt = await create();
		const pid = Number((await Bun.file(path.join(wt.path, "bg.pid")).text()).trim());
		pidsToKill.push(pid);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(wt.hookWarning).toBeUndefined();
	});

	it("stops the hook's process tree and warns when the signal aborts", async () => {
		await installHook("sleep 30 &\necho $! > child.pid\nwait");
		const controller = new AbortController();
		const pending = create(controller.signal);
		const worktreeRoot = path.join(root, "wt");
		let childPidFile: string | undefined;
		for (let i = 0; i < 200 && !childPidFile; i++) {
			const entries = await fs.readdir(worktreeRoot, { recursive: true }).catch(() => []);
			const found = entries.find(f => f.endsWith("child.pid"));
			if (found) childPidFile = path.join(worktreeRoot, found);
			else await Bun.sleep(50);
		}
		if (!childPidFile) throw new Error("hook never started");
		await Bun.sleep(50);
		const pid = Number((await Bun.file(childPidFile).text()).trim());
		pidsToKill.push(pid);
		controller.abort();
		const wt = await pending;
		expect(wt.hookWarning).toBe("Worktree created, but post-checkout hook cancelled");
		expect(worktreePaths(repo)).toContain(wt.path);
		for (let i = 0; i < 100 && isPidAlive(pid); i++) await Bun.sleep(50);
		expect(isPidAlive(pid)).toBe(false);
	});
});
