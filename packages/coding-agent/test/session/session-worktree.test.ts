import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { $which, isPidAlive, postmortem, procmgr, setWorktreesDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import {
	canAutoCreateWorktree,
	createSessionWorktree,
	decideWorktreeExit,
	finishSessionWorktree,
	inspectSessionWorktree,
	planWorktreeExit,
	removeExitWorktrees,
	removeSessionWorktree,
	type SessionWorktreeState,
	type WorktreeExitAction,
} from "../../src/session/session-worktree";
import { formatPostCheckoutHookWarning, runPostCheckoutHook } from "../../src/utils/worktree-hook";
import { restoreEnvValue } from "../helpers/settings-test-state";

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

	describe.skipIf(process.platform === "win32")("post-checkout hook", () => {
		const savedHookEnv: Record<string, string | undefined> = {};
		const envKeys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME", "XDG_CONFIG_HOME"];
		/** Pid files a test's background process writes; afterEach kills them even when the test failed or timed out. */
		const pidFilesToKill: string[] = [];
		const readPid = async (file: string) => {
			const text = await Bun.file(file)
				.text()
				.catch(() => "");
			return Number.parseInt(text, 10);
		};
		const writeScript = async (file: string, script: string) => {
			await Bun.write(file, `#!/bin/sh\n${script}\n`);
			await fs.chmod(file, 0o755);
		};
		const installHook = (script: string) => writeScript(path.join(repo, ".git", "hooks", "post-checkout"), script);
		/** `/wt`'s worktree steps: create the checkout, then finish it as a moved session. */
		const createAndFinish = async (signal?: AbortSignal) => {
			const wt = await create();
			const { warnings } = await finishSessionWorktree(wt, Settings.isolated(), {
				moved: true,
				inWorktree: true,
				withHookSignal: run => run(signal),
				rescan: async () => {},
			});
			return { ...wt, hookWarning: warnings[0] };
		};
		const headSha = () => git(repo, "rev-parse", "HEAD");
		/** The hook environment with PATH replaced, passed as `env` so the test never mutates `process.env`. */
		const envWithPath = (value: string): Record<string, string> => ({ ...procmgr.getChildShellEnv(), PATH: value });
		/** Writes an executable `git` running `script` into its own bin dir; returns the dir, a hook env whose PATH is only that dir, and HEAD. */
		const fakeGit = async (script: string) => {
			const dir = path.join(root, "fakegit");
			await writeScript(path.join(dir, "git"), script);
			return { dir, env: envWithPath(dir), head: headSha() };
		};

		beforeEach(() => {
			for (const key of envKeys) savedHookEnv[key] = process.env[key];
			// Isolate from the developer's global git config (core.hooksPath) and `~/.config/git`.
			process.env.GIT_CONFIG_GLOBAL = "/dev/null";
			process.env.GIT_CONFIG_NOSYSTEM = "1";
			process.env.HOME = root;
			delete process.env.XDG_CONFIG_HOME;
			// An earlier test file's shell-env capture would hand the hook the host's git config.
			procmgr.__resetShellConfigCacheForTests();
		});

		afterEach(async () => {
			for (const file of pidFilesToKill.splice(0)) {
				const pid = await readPid(file);
				try {
					if (pid > 0) process.kill(pid, "SIGKILL");
				} catch {}
			}
			for (const key of envKeys) restoreEnvValue(key, savedHookEnv[key]);
			procmgr.__resetShellConfigCacheForTests();
			vi.restoreAllMocks();
		});

		it("runs the hook in the new worktree with git's new-worktree arguments", async () => {
			await installHook('{ pwd -P; printf "%s\\n" "$@"; } > hook.out');
			const wt = await createAndFinish();
			expect(wt.hookWarning).toBeUndefined();
			const lines = (await Bun.file(path.join(wt.path, "hook.out")).text()).trim().split("\n");
			expect(lines).toEqual([wt.path, "0".repeat(wt.baseCommit.length), wt.baseCommit, "1"]);
		});

		it.each([
			{
				what: "the exit status and cleaned last line",
				script: `printf 'earlier\\n'; printf '\\033[31mboom\\033[0m\\tbad in %s/x\\n' '${os.homedir()}' >&2; exit 7`,
				expected: "Worktree created, but post-checkout hook exited with 7: boom   bad in ~/x",
			},
			{
				what: "the last carriage-return progress frame rather than gluing frames together",
				script: "printf 'copy 10 percent\\rcopy 55 percent\\rcopy 100 percent\\r' >&2; exit 4",
				expected: "Worktree created, but post-checkout hook exited with 4: copy 100 percent",
			},
		])("keeps the worktree and warns with $what when the hook fails", async ({ script, expected }) => {
			await installHook(script);
			const wt = await createAndFinish();
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
			await writeScript(path.join(repo, "hookbin", "git"), `exec '${$which("git")}' "$@"`);
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
			// On macOS `$which` falls back to the Command Line Tools' git, which a PATH without git does not hide.
			...(process.platform === "darwin"
				? []
				: [{ why: "missing from PATH", script: undefined, reason: "git executable not found" }]),
		])("reports nothing for /wt when git is $why", async ({ script, reason }) => {
			const env = script === undefined ? envWithPath(path.join(root, "no-git")) : (await fakeGit(script)).env;
			const result = await runPostCheckoutHook(repo, headSha(), { env });
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
			const result = await runPostCheckoutHook(path.join(root, "does-not-exist"), "a".repeat(40), {
				env: procmgr.getChildShellEnv(),
			});
			expect(result.status).toBe("error");
			expect(formatPostCheckoutHookWarning(result)).toContain("post-checkout hook could not run: ");
		});

		it("returns promptly when the hook leaves a background process holding its output", async () => {
			const bgPid = path.join(root, "hook-bg.pid");
			pidFilesToKill.push(bgPid);
			await installHook(`sleep 30 &\necho $! > '${bgPid}'`);
			const started = Date.now();
			const wt = await createAndFinish();
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(wt.hookWarning).toBeUndefined();
		});

		// Real processes: the polls wait on OS state (the hook's child starting, then dying), which fake timers cannot drive.
		it.each([
			{ trigger: "the signal aborts", onExit: false },
			// A detached hook would otherwise outlive omp.
			{ trigger: "omp exits", onExit: true },
		])("stops the hook's process tree and warns when $trigger", async ({ onExit }) => {
			const pidFile = path.join(root, "child.pid");
			const gitPidFile = path.join(root, "git.pid");
			pidFilesToKill.push(pidFile);
			await installHook(`echo $PPID > '${gitPidFile}'\nsleep 30 &\necho $! > '${pidFile}'\nwait`);
			const exitCallbacks: Array<() => unknown> = [];
			vi.spyOn(postmortem, "register").mockImplementation((id, callback) => {
				if (id === "post-checkout-hook") exitCallbacks.push(() => callback(postmortem.Reason.SIGTERM));
				return () => {};
			});
			const controller = new AbortController();
			const pending = createAndFinish(controller.signal);
			let pid = Number.NaN;
			for (let i = 0; i < 200 && !(pid > 0); i++) {
				await Bun.sleep(50);
				pid = await readPid(pidFile);
			}
			if (!(pid > 0)) throw new Error("hook never started");
			if (onExit) {
				// The exit pass awaits the callback and then exits at once: by then git must be gone.
				await Promise.all(exitCallbacks.map(exit => exit()));
				expect(isPidAlive(await readPid(gitPidFile))).toBe(false);
			} else controller.abort();
			const wt = await pending;
			expect(wt.hookWarning).toBe("Worktree created, but post-checkout hook cancelled");
			expect(worktreePaths(repo)).toContain(wt.path);
			for (let i = 0; i < 100 && isPidAlive(pid); i++) await Bun.sleep(50);
			expect(isPidAlive(pid)).toBe(false);
		});
	});
});
