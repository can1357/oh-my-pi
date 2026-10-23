import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { shortenPath, TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import { filterChildShellEnv, setWorktreesDir } from "@oh-my-pi/pi-utils";
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
import { runWorktreeCheckoutHook } from "../../src/utils/worktree-hook";

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
		const hook = async (script: string) => {
			const hooks = path.join(repo, ".git", "hooks");
			git(repo, "config", "core.hooksPath", hooks);
			await Bun.write(path.join(hooks, "post-checkout"), `#!/bin/sh\n${script}\n`);
			await fs.chmod(path.join(hooks, "post-checkout"), 0o755);
		};
		// Settles a deliberately stalled filesystem call even when its test times out, so nothing stays pending.
		let releaseStalled: (() => void) | undefined;
		afterEach(() => {
			releaseStalled?.();
			releaseStalled = undefined;
		});

		it("runs in the new worktree with git's new-worktree arguments", async () => {
			await hook('printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran');
			const wt = await create();
			const marker = (await Bun.file(path.join(wt.path, ".post-checkout-ran")).text()).trim().split("\n");

			expect(marker).toEqual([wt.path, "0".repeat(wt.baseCommit.length), wt.baseCommit, "1"]);
			expect(wt.hook?.error).toBeUndefined();
		});

		it("returns the branch a hook renamed the worktree to", async () => {
			await hook("git branch -m renamed-by-hook");
			const wt = await create();

			expect(wt.branch).toBe("renamed-by-hook");
			expect(git(wt.path, "branch", "--show-current")).toBe("renamed-by-hook");
		});

		it("hides the agent's own GIT_DIR from the hook", async () => {
			const wt = await create();
			await hook("git rev-parse --absolute-git-dir > .git-dir-seen");
			const helper = path.resolve(import.meta.dir, "../../src/utils/worktree-hook.ts");
			const script = `import { runWorktreeCheckoutHook } from ${JSON.stringify(helper)};
await runWorktreeCheckoutHook(${JSON.stringify(wt.path)}, ${JSON.stringify(wt.baseCommit)});`;
			// Launched with GIT_DIR, as omp is from a git hook or `git --git-dir` wrapper; spawns inherit the launch env.
			const run = Bun.spawnSync([process.execPath, "--no-install", "--eval", script], {
				env: { ...process.env, GIT_DIR: path.join(repo, ".git") },
				stderr: "pipe",
			});

			expect(run.stderr.toString()).toBe("");
			expect((await Bun.file(path.join(wt.path, ".git-dir-seen")).text()).trim()).toBe(
				git(wt.path, "rev-parse", "--absolute-git-dir"),
			);
		});

		it("keeps the worktree and reports a failing hook without terminal escapes or the home path", async () => {
			await hook(`printf '\\033[31msetup failed in %s/proj\\033[0m\\n' "${os.homedir()}" >&2; exit 17`);
			const wt = await create();

			expect(worktreePaths(repo)).toContain(wt.path);
			expect(wt.hook?.error).toBe("post-checkout hook exited with 17: setup failed in ~/proj");
		});

		// The longest line the TUI renders for it: showWarning's "Warning: " plus /wt's "Worktree created, but ".
		const rendered = (warning: string | undefined) => Bun.stringWidth(`Warning: Worktree created, but ${warning}`);

		it("keeps the whole rendered failure warning within one display line when the hook's last line is long", async () => {
			await hook(`printf '%0300d\\n' 0 >&2; exit 3`);
			const wt = await create();

			expect(wt.hook?.error).toStartWith("post-checkout hook exited with 3: 000");
			expect(rendered(wt.hook?.error)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		});

		it("cuts a long hook path, never the reason it did not run", async () => {
			const hooks = path.join(root, "h".repeat(150));
			git(repo, "config", "core.hooksPath", hooks);
			await Bun.write(path.join(hooks, "post-checkout"), "#!/bin/sh\ntouch .post-checkout-ran\n");
			await fs.chmod(path.join(hooks, "post-checkout"), 0o644);
			const wt = await create();

			expect(wt.hook?.skipped).toEndWith(" is not executable, so git skipped it");
			expect(rendered(wt.hook?.skipped)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.LINE);
		});

		it("finds a hook under a relative core.hooksPath that starts with a space", async () => {
			const wt = await create();
			git(repo, "config", "core.hooksPath", " spaced-hooks");
			const hookFile = path.join(wt.path, " spaced-hooks", "post-checkout");
			await Bun.write(hookFile, "#!/bin/sh\ntouch .post-checkout-ran\n");
			await fs.chmod(hookFile, 0o755);
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
				env: filterChildShellEnv(process.env),
			});

			expect(result.exitCode).toBe(0);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
		});

		it("reports a non-executable hook without running it", async () => {
			await hook("touch .post-checkout-ran");
			await fs.chmod(path.join(repo, ".git", "hooks", "post-checkout"), 0o644);
			const wt = await create();

			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
			expect(wt.hook?.error).toBeUndefined();
			expect(wt.hook?.skipped).toContain("is not executable");
		});

		it("reports a directory at the hook path as a failing hook, as git does, not as no hook", async () => {
			const hooks = path.join(repo, ".git", "hooks");
			git(repo, "config", "core.hooksPath", hooks);
			await fs.mkdir(path.join(hooks, "post-checkout"), { recursive: true, mode: 0o755 });
			const wt = await create();

			expect(worktreePaths(repo)).toContain(wt.path);
			expect(wt.hook?.error).toStartWith("post-checkout hook exited with ");
		});

		const gitlessRows: [name: string, hookPresent: boolean, fakeGit: string | null, reason?: "no-git" | "old-git"][] =
			[
				["needs no git binary when there is no hook", false, null, undefined],
				["reports, without failing, a hook it cannot run without git", true, null, "no-git"],
				[
					"reports, without failing, a hook a Git older than 2.36 cannot run",
					true,
					`[ "$1" = version ] && echo "git version 2.34.1" && exit 0\necho "git: '$1' is not a git command" >&2\nexit 1`,
					"old-git",
				],
				["reports, without failing, a hook when `git version` fails", true, "exit 1", "no-git"],
			];
		it.each(gitlessRows)("%s", async (_name, hookPresent, fakeGit, reason) => {
			git(repo, "config", "core.hooksPath", path.join(repo, ".git", "hooks"));
			const wt = await create();
			if (hookPresent) await hook("touch .post-checkout-ran");
			const bin = path.join(root, "bin");
			await fs.mkdir(bin, { recursive: true });
			if (fakeGit !== null) {
				await Bun.write(path.join(bin, "git"), `#!/bin/sh\n${fakeGit}\n`);
				await fs.chmod(path.join(bin, "git"), 0o755);
			}
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: { PATH: bin } });

			expect(result.exitCode).toBe(0);
			expect(result.skipped?.reason).toBe(reason);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
		});

		// Root bypasses directory permissions, so the stat would not fail.
		it.skipIf(process.getuid?.() === 0)(
			"reports, rather than silently skips, a hook that cannot be read",
			async () => {
				const wt = await create();
				await hook("touch .post-checkout-ran");
				const hooks = path.join(repo, ".git", "hooks");
				await fs.chmod(hooks, 0o000);
				try {
					const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
						env: filterChildShellEnv(process.env),
					});

					expect(result.skipped?.reason).toBe("inaccessible");
				} finally {
					await fs.chmod(hooks, 0o755);
				}
				expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
			},
		);

		it("discards the new worktree and branch when the hook runner fails, so the name can be reused", async () => {
			await hook("touch .post-checkout-ran");
			const realOpen = nodeFs.promises.open;
			// Only the runner's capture file fails, as on a full disk.
			const open = spyOn(nodeFs.promises, "open").mockImplementation(((
				file: nodeFs.PathLike,
				mode: string,
				...rest: []
			) =>
				["w", "a+"].includes(mode) && path.basename(path.dirname(String(file))).startsWith("omp-post-checkout-")
					? Promise.reject(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }))
					: realOpen(file, mode, ...rest)) as typeof realOpen);
			try {
				await expect(create()).rejects.toThrow("no space left on device");
			} finally {
				open.mockRestore();
			}

			expect(branchSha(repo, branch)).toBeNull();
			const retried = await create();
			expect(await exists(path.join(retried.path, ".post-checkout-ran"))).toBe(true);
		});

		it.each([
			["", "touch .post-checkout-ran"],
			// Its path lookup then fails too; started after the abort, that failure would go unhandled.
			[", also when the hook removed the worktree", 'rm -rf "$PWD"'],
		])(
			"an abort landing just as the hook finishes still cancels /wt and leaves nothing behind%s",
			async (_name, script) => {
				await hook(script);
				const controller = new AbortController();
				const runHook = vcs.runPostCheckoutHook;
				// The hook completes, then the user's Esc arrives before /wt hands the worktree over.
				const run = spyOn(vcs, "runPostCheckoutHook").mockImplementation(async (...args) => {
					const result = await runHook(...args);
					controller.abort();
					return result;
				});
				try {
					await expect(
						createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal }),
					).rejects.toMatchObject({ name: "AbortError" });
				} finally {
					run.mockRestore();
				}

				expect(worktreePaths(repo)).toEqual([repo]);
				expect(branchSha(repo, branch)).toBeNull();
			},
		);

		it.each([
			["chosen", "stat"],
			["resolved", "realpath"],
		] as const)(
			"an abort while the new worktree's path is still being %s cancels /wt and leaves nothing behind",
			async (_name, method) => {
				await hook("touch .post-checkout-ran");
				const worktrees = path.join(root, "wt");
				const reached = Promise.withResolvers<void>();
				const real = fs[method] as (file: nodeFs.PathLike, ...rest: unknown[]) => Promise<unknown>;
				// A lookup that never settles, as with `worktree.base` on a stalled network filesystem.
				const lookup = spyOn(fs, method).mockImplementation(((file: nodeFs.PathLike, ...rest: unknown[]) => {
					if (!String(file).startsWith(`${worktrees}${path.sep}`)) return real(file, ...rest);
					reached.resolve();
					const stalled = Promise.withResolvers<never>();
					releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
					return stalled.promise;
				}) as never);
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				try {
					await reached.promise;
				} finally {
					lookup.mockRestore();
				}
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });

				expect(worktreePaths(repo)).toEqual([repo]);
				expect(branchSha(repo, branch)).toBeNull();
			},
		);

		it("an abort while the new worktree's setup mark is being removed comes too late: /wt keeps the finished worktree", async () => {
			await hook("touch .post-checkout-ran");
			const repoProto = Object.getPrototypeOf(vcs.requireGit(repo));
			const worktreeReplaceSetupOwner = repoProto.worktreeReplaceSetupOwner;
			const controller = new AbortController();
			// Once the mark is gone another omp process may reuse the worktree, so discarding it then could delete its work.
			let calls = 0;
			const replaceSetupOwner = spyOn(repoProto, "worktreeReplaceSetupOwner").mockImplementation(function (
				this: unknown,
				...args: unknown[]
			) {
				calls++;
				controller.abort();
				return worktreeReplaceSetupOwner.apply(this, args);
			});
			const wt = await createSessionWorktree(repo, Settings.isolated(), branch, {
				signal: controller.signal,
			}).finally(() => replaceSetupOwner.mockRestore());

			expect(calls).toBe(1);

			expect(worktreePaths(repo)).toContain(wt.path);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
			expect(branchSha(repo, branch)).not.toBeNull();
		});

		it("keeps a worktree its hook moved: /wt succeeds at the new path with the setup mark gone", async () => {
			await hook(`unset GIT_DIR GIT_WORK_TREE\ngit -C "${repo}" worktree move "$PWD" "$PWD-moved"`);
			const wt = await create();

			const moved = await fs.realpath(wt.path);
			expect(moved).toEndWith("-moved");
			expect(worktreePaths(repo)).toContain(moved);
			const entry = (await vcs.requireGit(repo).worktrees()).find(e => e.branch === `refs/heads/${branch}`);
			expect(entry && (await fs.realpath(entry.path))).toBe(moved);
			expect(entry?.setupOwner).toBeUndefined();
			expect(branchSha(repo, branch)).not.toBeNull();
		});

		/** Runs `/wt` with a hook that moves its worktree, tells the test, then hangs; aborts once told and returns the rejection. */
		const abortAfterHookMoves = async () => {
			const signalPipe = path.join(root, "hook-moved");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				`unset GIT_DIR GIT_WORK_TREE\ngit -C "${repo}" worktree move "$PWD" "$PWD-moved"\necho moved > "${signalPipe}"\nsleep 600`,
			);
			const controller = new AbortController();
			const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
			// Opening the reading end waits for the hook's write, which comes after its move.
			await Bun.file(signalPipe).text();
			controller.abort();
			return pending;
		};

		it("an abort after the hook moved its worktree discards it at the new path", async () => {
			await expect(abortAfterHookMoves()).rejects.toMatchObject({ name: "AbortError" });

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("an abort after the hook renamed its branch and moved its worktree discards it at the new path", async () => {
			const signalPipe = path.join(root, "hook-renamed");
			const origin = path.join(root, "hook-origin");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				`unset GIT_DIR GIT_WORK_TREE\necho "$PWD" > "${origin}"\ngit -C "${repo}" branch -m "${branch}" "${branch}-renamed"\ngit -C "${repo}" worktree move "$PWD" "$PWD-moved"\necho moved > "${signalPipe}"\nsleep 600`,
			);
			const controller = new AbortController();
			const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
			await Bun.file(signalPipe).text();
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(await exists(`${(await Bun.file(origin).text()).trim()}-moved`)).toBe(false);
		});

		it("an abort after the hook renamed its branch leaves neither the renamed nor the original branch", async () => {
			const renamed = `${branch}-hook-renamed`;
			const signalPipe = path.join(root, "hook-rename-started");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				`unset GIT_DIR GIT_WORK_TREE\ngit -C "$PWD" branch -m "${renamed}"\necho started > "${signalPipe}"\nsleep 600`,
			);
			const controller = new AbortController();
			const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
			await Bun.file(signalPipe).text();
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });

			expect(branchSha(repo, renamed)).toBeNull();
			expect(branchSha(repo, branch)).toBeNull();
			expect(worktreePaths(repo)).toEqual([repo]);
		});

		it("an abort keeps a renamed branch another process advanced after the worktree was freed", async () => {
			const renamed = `${branch}-moved`;
			const signalPipe = path.join(root, "hook-advanced-started");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				`unset GIT_DIR GIT_WORK_TREE\ngit -C "$PWD" branch -m "${renamed}"\necho started > "${signalPipe}"\nsleep 600`,
			);
			const repoProto = Object.getPrototypeOf(vcs.requireGit(repo));
			const realRemove = repoProto.worktreeRemove;
			let advanced: string | undefined;
			const remove = spyOn(repoProto, "worktreeRemove").mockImplementation(async function (
				this: unknown,
				removePath: string,
				force?: boolean,
			) {
				const result = await realRemove.call(this, removePath, force);
				// Another process advances the renamed branch the moment the discard has freed it.
				const tip = branchSha(repo, renamed)!;
				advanced = git(
					repo,
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@t",
					"-c",
					"commit.gpgsign=false",
					"commit-tree",
					`${tip}^{tree}`,
					"-p",
					tip,
					"-m",
					"advanced",
				);
				git(repo, "update-ref", `refs/heads/${renamed}`, advanced);
				return result;
			});
			try {
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await Bun.file(signalPipe).text();
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });

				expect(advanced).toMatch(/^[0-9a-f]{40}$/);
				expect(branchSha(repo, renamed)).toBe(advanced!);
			} finally {
				remove.mockRestore();
				Bun.spawnSync(["git", "branch", "-D", renamed], { cwd: repo });
			}
		});

		it("an abort keeps a branch another process created under the name the hook renamed away", async () => {
			const renamed = `${branch}-moved`;
			const signalPipe = path.join(root, "hook-recreated-started");
			const commitFile = path.join(root, "hook-recreated-commit");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				[
					"unset GIT_DIR GIT_WORK_TREE",
					`cd "${repo}"`,
					`git branch -m "${branch}" "${renamed}"`,
					"C=$(git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit-tree 'HEAD^{tree}' -p HEAD -m other)",
					`git branch "${branch}" "$C"`,
					`echo "$C" > "${commitFile}"`,
					`echo started > "${signalPipe}"`,
					"sleep 600",
				].join("\n"),
			);
			try {
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await Bun.file(signalPipe).text();
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });

				const other = (await Bun.file(commitFile).text()).trim();
				expect(other).toMatch(/^[0-9a-f]{40}$/);
				expect(branchSha(repo, branch)).toBe(other);
			} finally {
				Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repo });
				Bun.spawnSync(["git", "branch", "-D", renamed], { cwd: repo });
			}
		});

		it("an abort keeps a branch the hook left its worktree on when its reflog shows no rename from the original", async () => {
			const other = `${branch}-other`;
			const signalPipe = path.join(root, "hook-other-started");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				`unset GIT_DIR GIT_WORK_TREE\ngit -C "$PWD" branch "${other}"\ngit -C "$PWD" -c core.hooksPath=/dev/null checkout "${other}"\ngit -C "$PWD" branch -D "${branch}"\necho started > "${signalPipe}"\nsleep 600`,
			);
			try {
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await Bun.file(signalPipe).text();
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });

				expect(branchSha(repo, other)).not.toBeNull();
				expect(worktreePaths(repo)).toEqual([repo]);
			} finally {
				Bun.spawnSync(["git", "branch", "-D", other], { cwd: repo });
			}
		});

		it("a hook that deletes the new worktree's .git fails /wt and removes the worktree", async () => {
			const origin = path.join(root, "hook-origin-nogit");
			await hook(`echo "$PWD" > "${origin}"\nrm -f .git`);
			await expect(create()).rejects.toThrow(/no longer leads to the worktree's git directory/);

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(await exists((await Bun.file(origin).text()).trim())).toBe(false);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("a hook that points the new .git at another worktree fails /wt and leaves that worktree alone", async () => {
			const victim = path.join(root, "victim-worktree");
			git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", `${branch}-victim`, victim);
			try {
				const victimGitDir = git(victim, "rev-parse", "--absolute-git-dir").trim();
				await hook(`unset GIT_DIR GIT_WORK_TREE\necho "gitdir: ${victimGitDir}" > .git`);
				await expect(create()).rejects.toThrow(/no longer leads to the worktree's git directory/);

				const listed = await Promise.all(worktreePaths(repo).map(p => fs.realpath(p)));
				expect(listed).toContain(await fs.realpath(victim));
				expect(await exists(victim)).toBe(true);
				expect(await exists(victimGitDir)).toBe(true);
				expect(branchSha(repo, branch)).toBeNull();
			} finally {
				Bun.spawnSync(["git", "worktree", "remove", "--force", victim], { cwd: repo });
				Bun.spawnSync(["git", "worktree", "prune"], { cwd: repo });
				Bun.spawnSync(["git", "branch", "-D", `${branch}-victim`], { cwd: repo });
			}
		});

		it("a hook that switches the new worktree to another existing branch fails /wt", async () => {
			const existing = `${branch}-existing`;
			git(repo, "branch", existing);
			const existingSha = branchSha(repo, existing);
			try {
				await hook(`unset GIT_DIR GIT_WORK_TREE\ngit -c core.hooksPath=/dev/null switch "${existing}"`);
				await expect(create()).rejects.toThrow(/switched the new worktree at .* from .* to /);

				expect(branchSha(repo, existing)).toBe(existingSha);
				expect(worktreePaths(repo)).toEqual([repo]);
				expect(branchSha(repo, branch)).toBeNull();
			} finally {
				Bun.spawnSync(["git", "branch", "-D", existing], { cwd: repo });
			}
		});

		it("a hook that detaches HEAD in the new worktree fails /wt", async () => {
			await hook("unset GIT_DIR GIT_WORK_TREE\ngit -c core.hooksPath=/dev/null checkout --detach");
			await expect(create()).rejects.toThrow(/detached HEAD in the new worktree/);

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("a hook that detaches HEAD and then fails keeps the worktree with its warning, as any failed hook", async () => {
			await hook("unset GIT_DIR GIT_WORK_TREE\ngit -c core.hooksPath=/dev/null checkout --detach\nexit 17");
			const wt = await create();

			expect(wt.hook?.error).toMatch(/exited with 17/);
			expect(wt.branch).toBe(branch);
			expect(worktreePaths(repo)).toContain(wt.path);
			expect(branchSha(repo, branch)).not.toBeNull();
		});

		it("a hook that deletes the branch and switches to one it created is refused, not adopted as a rename", async () => {
			const made = `${branch}-made`;
			try {
				await hook(
					`unset GIT_DIR GIT_WORK_TREE\ngit -c core.hooksPath=/dev/null switch -c "${made}" && git branch -D "${branch}"`,
				);
				await expect(create()).rejects.toThrow(/switched the new worktree/);

				expect(worktreePaths(repo)).toEqual([repo]);
			} finally {
				Bun.spawnSync(["git", "branch", "-D", made], { cwd: repo });
			}
		});

		it("keeps the setup mark on a cut-short worktree that could not be removed, so other processes refuse it", async () => {
			const repoProto = Object.getPrototypeOf(vcs.requireGit(repo));
			const remove = spyOn(repoProto, "worktreeRemove").mockRejectedValue(new Error("busy"));
			try {
				// The hook runs in the worktree at its chosen path; nothing moves it before the abort.
				const signalPipe = path.join(root, "hook-started");
				expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
				await hook(`echo started > "${signalPipe}"\nsleep 600`);
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await Bun.file(signalPipe).text();
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				remove.mockRestore();
			}

			const leftover = (await vcs.requireGit(repo).worktrees()).find(e => e.branch === `refs/heads/${branch}`);
			try {
				expect(leftover?.setupOwner).toBe(vcs.worktreeSetupOwner());
			} finally {
				if (leftover) git(repo, "worktree", "remove", "--force", leftover.path);
			}
		});

		it("a discard leaves the mark of a worktree another process added at the freed path", async () => {
			const repoProto = Object.getPrototypeOf(vcs.requireGit(repo));
			const realRemove = repoProto.worktreeRemove;
			const otherOwner = "other-live-owner";
			let replacement: string | undefined;
			const remove = spyOn(repoProto, "worktreeRemove").mockImplementation(async function (
				this: unknown,
				removePath: string,
				force?: boolean,
			) {
				const result = await realRemove.call(this, removePath, force);
				// Another process takes the path the moment it is free; without hooks, as the test's would block on its pipe.
				git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", `${branch}-other`, removePath);
				replacement = removePath;
				const entry = (await vcs.requireGit(repo).worktrees()).find(e => e.path === removePath);
				await Bun.write(path.join(entry!.gitDir, "omp-setup"), `${otherOwner}\n`);
				return result;
			});
			try {
				const signalPipe = path.join(root, "hook-started");
				expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
				await hook(`echo started > "${signalPipe}"\nsleep 600`);
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await Bun.file(signalPipe).text();
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				remove.mockRestore();
			}

			try {
				const entry = (await vcs.requireGit(repo).worktrees()).find(e => e.branch === `refs/heads/${branch}-other`);
				expect(entry?.setupOwner).toBe(otherOwner);
			} finally {
				if (replacement) git(repo, "worktree", "remove", "--force", replacement);
			}
		});

		it("a hook that removes its worktree, replaced by another process, fails /wt without clearing the replacement's mark", async () => {
			const otherOwner = "other-live-owner";
			// The hook is the "second process": it frees the path and branch, then re-adds both (hooks off, so this does not recurse) with its own mark.
			await hook(
				[
					'P="$PWD"',
					"unset GIT_DIR GIT_WORK_TREE",
					`cd "${repo}"`,
					'git worktree remove --force "$P"',
					`git -c core.hooksPath=/dev/null worktree add "$P" "${branch}"`,
					`echo "${otherOwner}" > "$(git -C "$P" rev-parse --absolute-git-dir)/omp-setup"`,
				].join("\n"),
			);

			await expect(create()).rejects.toThrow(/removed the new worktree/);

			const entry = (await vcs.requireGit(repo).worktrees()).find(e => e.branch === `refs/heads/${branch}`);
			try {
				expect(entry).toBeDefined();
				expect(entry?.setupOwner).toBe(otherOwner);
				expect(await exists(path.join(entry!.path, "tracked.txt"))).toBe(true);
				expect(branchSha(repo, branch)).not.toBeNull();
			} finally {
				if (entry) git(repo, "worktree", "remove", "--force", entry.path);
			}
		});

		it("an abort after another process replaced the removed worktree leaves the replacement and its mark alone", async () => {
			const otherOwner = "other-live-owner";
			const signalPipe = path.join(root, "hook-replaced-started");
			expect(Bun.spawnSync(["mkfifo", signalPipe]).exitCode).toBe(0);
			await hook(
				[
					'P="$PWD"',
					"unset GIT_DIR GIT_WORK_TREE",
					`cd "${repo}"`,
					'git worktree remove --force "$P"',
					`git -c core.hooksPath=/dev/null worktree add "$P" "${branch}"`,
					`echo "${otherOwner}" > "$(git -C "$P" rev-parse --absolute-git-dir)/omp-setup"`,
					`echo started > "${signalPipe}"`,
					"sleep 600",
				].join("\n"),
			);

			const findReplacement = async () =>
				(await vcs.requireGit(repo).worktrees()).find(e => e.branch === `refs/heads/${branch}`);
			try {
				const controller = new AbortController();
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await Bun.file(signalPipe).text();
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });

				const entry = await findReplacement();
				expect(entry).toBeDefined();
				expect(entry?.setupOwner).toBe(otherOwner);
				expect(await exists(path.join(entry!.path, "tracked.txt"))).toBe(true);
				expect(branchSha(repo, branch)).not.toBeNull();
			} finally {
				const entry = await findReplacement();
				if (entry) git(repo, "worktree", "remove", "--force", entry.path);
			}
		});

		it("a hook that removes its worktree, replaced by another process that committed and detached, fails /wt without deleting the branch", async () => {
			const headFile = path.join(root, "replacement-head");
			const pathFile = path.join(root, "replacement-path");
			// The "second process" re-adds the branch with hooks off, commits on it, then detaches, leaving the branch checked out nowhere.
			await hook(
				[
					'P="$PWD"',
					"unset GIT_DIR GIT_WORK_TREE",
					`cd "${repo}"`,
					'git worktree remove --force "$P"',
					`git -c core.hooksPath=/dev/null worktree add "$P" "${branch}"`,
					'git -C "$P" -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit --allow-empty -m replacement',
					`git -C "$P" rev-parse HEAD > "${headFile}"`,
					`echo "$P" > "${pathFile}"`,
					'git -C "$P" -c core.hooksPath=/dev/null checkout --detach',
				].join("\n"),
			);

			try {
				await expect(create()).rejects.toThrow(/removed the new worktree/);

				const replacementHead = (await Bun.file(headFile).text()).trim();
				expect(replacementHead).toMatch(/^[0-9a-f]{40}/);
				expect(branchSha(repo, branch)).toBe(replacementHead);
			} finally {
				const replacement = (
					await Bun.file(pathFile)
						.text()
						.catch(() => "")
				).trim();
				if (replacement) git(repo, "worktree", "remove", "--force", replacement);
			}
		});

		it("reports a hook as not run when the git on PATH cannot start", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "broken-bin");
			// Executable but not a program: spawning it fails with ENOEXEC.
			await Bun.write(path.join(bin, "git"), "not a program\n");
			await fs.chmod(path.join(bin, "git"), 0o755);
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: { PATH: bin } });

			expect(result.skipped?.reason).toBe("no-git");
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(false);
		});

		/** Start `run` while the repository's shared config is a named pipe, which stalls whatever reads it as a stalled filesystem would; abort once it is being read. */
		const abortWhileConfigStalls = async (run: (signal: AbortSignal) => Promise<unknown>) => {
			const config = path.join(repo, ".git", "config");
			await fs.rename(config, `${config}.real`);
			expect(Bun.spawnSync(["mkfifo", config]).exitCode).toBe(0);
			const controller = new AbortController();
			const pending = run(controller.signal);
			// Opening the writing end waits until the reader opened the pipe; its read then stalls.
			const writer = await fs.open(config, "w");
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				// The real config first: the abandoned reader may open it again after this read, and must not meet the pipe.
				await fs.rename(`${config}.real`, config);
				// End of file then lets that read finish.
				await writer.close();
			}
		};

		it("abort is not held up by a stalled repository when no git can locate the hook", async () => {
			const wt = await create();
			await abortWhileConfigStalls(signal =>
				vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal, env: { PATH: path.join(root, "no-git") } }),
			);
		});

		it("an abort while /wt is still finding the repository cancels it and leaves nothing behind", async () => {
			await abortWhileConfigStalls(signal => createSessionWorktree(repo, Settings.isolated(), branch, { signal }));

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("an abort while the hook's environment is still being read cancels /wt and leaves nothing behind", async () => {
			await hook("touch .post-checkout-ran");
			const reached = Promise.withResolvers<void>();
			const stalled = Promise.withResolvers<string>();
			const realReadFile = nodeFs.promises.readFile;
			// The project's dotenv files on a stalled filesystem.
			const readFile = spyOn(nodeFs.promises, "readFile").mockImplementation(((
				file: nodeFs.PathLike,
				...rest: []
			) => {
				if (!path.basename(String(file)).startsWith(".env")) return realReadFile(file, ...rest);
				reached.resolve();
				return stalled.promise;
			}) as typeof realReadFile);
			const controller = new AbortController();
			try {
				const pending = createSessionWorktree(repo, Settings.isolated(), branch, { signal: controller.signal });
				await reached.promise;
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			} finally {
				readFile.mockRestore();
				stalled.resolve("");
			}

			expect(worktreePaths(repo)).toEqual([repo]);
			expect(branchSha(repo, branch)).toBeNull();
		});

		it("leaves alone a worktree another process created at the chosen path first", async () => {
			git(repo, "config", "core.hooksPath", path.join(repo, ".git", "hooks"));
			const repoProto = Object.getPrototypeOf(vcs.requireGit(repo));
			const worktreeAdd = repoProto.worktreeAdd;
			let taken = "";
			// Another process wins the race for the same free path, so this attempt's add fails.
			const add = spyOn(repoProto, "worktreeAdd").mockImplementation(function (this: unknown, ...args: unknown[]) {
				taken = String(args[0]);
				git(repo, "worktree", "add", "-q", "--detach", taken, "HEAD");
				return worktreeAdd.apply(this, args);
			});
			try {
				await expect(create()).rejects.toThrow();
			} finally {
				add.mockRestore();
			}

			expect(await exists(path.join(taken, ".git"))).toBe(true);
			expect(worktreePaths(repo)).toContain(await fs.realpath(taken));
			expect(branchSha(repo, branch)).toBeNull();
		});

		it.each([
			["", false],
			[", also when TMPDIR can't hold its output", true],
		])("lets the git on PATH locate the hook, including config only it knows about%s", async (_name, noTmp) => {
			const wt = await create();
			const injected = path.join(root, "wrapper-hooks");
			await Bun.write(path.join(injected, "post-checkout"), "#!/bin/sh\ntouch .post-checkout-ran\n");
			await fs.chmod(path.join(injected, "post-checkout"), 0o755);
			const systemConfig = path.join(root, "wrapper-gitconfig");
			await Bun.write(systemConfig, `[core]\n\thooksPath = ${injected}\n`);
			// A wrapper bringing its own system config, as some git distributions do.
			const bin = path.join(root, "wrapper-bin");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\nexport GIT_CONFIG_SYSTEM="${systemConfig}" GIT_CONFIG_GLOBAL=/dev/null\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const {
				GIT_CONFIG_GLOBAL: _global,
				GIT_CONFIG_SYSTEM: _system,
				GIT_CONFIG_NOSYSTEM: _noSystem,
				...ambient
			} = filterChildShellEnv(process.env);
			// The supplied environment itself carries no config override.
			const env = { ...ambient, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			const tmpdir = noTmp ? spyOn(os, "tmpdir").mockReturnValue(path.join(root, "no-such-tmp")) : undefined;
			try {
				const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });
				expect(result.exitCode).toBe(0);
			} finally {
				tmpdir?.mockRestore();
			}

			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
		});

		it("falls back to the in-process lookup when the git on PATH reports no hook path", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "quiet-bin");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\n[ "$1" = rev-parse ] && exit 0\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });

			expect(result.exitCode).toBe(0);
			expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
		});

		it("keeps a running hook's output files small, returning its latest output", async () => {
			const wt = await create();
			const printed = path.join(root, "hook-printed");
			const release = path.join(root, "hook-release");
			for (const fifo of [printed, release]) expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			await hook(
				`head -c 5000000 /dev/zero | tr '\\0' x\necho LAST-LINE\necho printed > "${printed}"\ncat "${release}" > /dev/null`,
			);
			const captureFiles = async () => {
				const dirs = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith("omp-post-checkout-"));
				return dirs
					.filter(name => !before.has(name))
					.flatMap(name => ["stdout", "stderr"].map(f => path.join(os.tmpdir(), name, f)));
			};
			const before = new Set((await fs.readdir(os.tmpdir())).filter(name => name.startsWith("omp-post-checkout-")));
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: filterChildShellEnv(process.env) });
			let largest = Number.POSITIVE_INFINITY;
			try {
				await fs.readFile(printed, "utf8");
				for (let i = 0; i < 100; i++) {
					const sizes = await Promise.all(
						(await captureFiles()).map(file =>
							fs.stat(file).then(
								s => s.size,
								() => 0,
							),
						),
					);
					largest = Math.max(0, ...sizes);
					if (largest <= 1024 * 1024) break;
					// Real wait: the trim is a timer inside the run, visible only as the file's size.
					await Bun.sleep(50);
				}
			} finally {
				await fs.writeFile(release, "go");
			}
			const result = await pending;

			expect(largest).toBeLessThanOrEqual(1024 * 1024);
			// git routes a hook's stdout to its stderr; whichever stream carried it holds the tail.
			const output = result.stdout.length > result.stderr.length ? result.stdout : result.stderr;
			expect(output.length).toBeLessThanOrEqual(64 * 1024);
			expect(new TextDecoder().decode(output).trimEnd().endsWith("LAST-LINE")).toBe(true);
		});

		it.skipIf(process.platform !== "linux")(
			"keeps trimming the output files of a background process the hook left running",
			async () => {
				const wt = await create();
				const writerPid = path.join(root, "hook-writer-pid");
				const written = path.join(root, "hook-writer-done");
				// After the hook exited, the leftover writes ~5 MB to the stdout it inherited, then idles holding it.
				await hook(
					`(sleep 0.5; head -c 5000000 /dev/zero | tr '\\0' x; echo done > "${written}"; sleep 6) &\necho $! > "${writerPid}"`,
				);
				let pid = 0;
				try {
					const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
						env: filterChildShellEnv(process.env),
						detached: true,
					});
					expect(result.exitCode).toBe(0);
					pid = Number((await fs.readFile(writerPid, "utf8")).trim());
					// Real wait: the writer runs on its own schedule, visible only as its marker file.
					for (let i = 0; i < 100 && !(await exists(written)); i++) await Bun.sleep(50);
					expect(await exists(written)).toBe(true);
					// The capture file is already unlinked: its size is only visible through the writer's descriptor.
					let size = Number.POSITIVE_INFINITY;
					for (let i = 0; i < 60 && size > 1024 * 1024; i++) {
						// Real wait: the writer and the trim run on their own timers.
						await Bun.sleep(50);
						size = await fs.stat(`/proc/${pid}/fd/1`).then(
							s => s.size,
							() => Number.POSITIVE_INFINITY,
						);
					}
					expect(size).toBeLessThanOrEqual(1024 * 1024);
				} finally {
					if (pid) {
						Bun.spawnSync(["pkill", "-KILL", "-P", String(pid)]);
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// Already gone.
						}
					}
				}
			},
		);

		it.skipIf(process.platform !== "linux")(
			"keeps trimming the output files of a background process that left the hook's process group",
			async () => {
				const wt = await create();
				const writerPid = path.join(root, "hook-setsid-pid");
				const written = path.join(root, "hook-setsid-done");
				// The leftover starts its own session, so the hook's group is empty while it still holds the captures.
				await hook(
					`setsid sh -c 'echo $$ > "${writerPid}"; sleep 0.5; head -c 5000000 /dev/zero | tr "\\0" x; echo done > "${written}"; sleep 6' &`,
				);
				let pid = 0;
				try {
					const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
						env: filterChildShellEnv(process.env),
						detached: true,
					});
					expect(result.exitCode).toBe(0);
					// Real wait: the detached shell records its pid on its own schedule.
					for (let i = 0; i < 100 && !(await exists(writerPid)); i++) await Bun.sleep(50);
					pid = Number((await fs.readFile(writerPid, "utf8")).trim());
					for (let i = 0; i < 100 && !(await exists(written)); i++) await Bun.sleep(50);
					expect(await exists(written)).toBe(true);
					const sizeOf = () =>
						fs.stat(`/proc/${pid}/fd/1`).then(
							s => s.size,
							() => Number.POSITIVE_INFINITY,
						);
					let size = Number.POSITIVE_INFINITY;
					for (let i = 0; i < 60 && size > 1024 * 1024; i++) {
						// Real wait: the writer and the trim run on their own timers.
						await Bun.sleep(50);
						size = await sizeOf();
					}
					expect(size).toBeLessThanOrEqual(1024 * 1024);
				} finally {
					if (pid) {
						Bun.spawnSync(["pkill", "-KILL", "-P", String(pid)]);
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// Already gone.
						}
					}
				}
			},
		);

		it.skipIf(process.platform === "win32")(
			"stops a probe's lingering writer by closing its output instead of capturing it in a file",
			async () => {
				const wt = await create();
				await hook("touch .post-checkout-ran");
				const bin = path.join(root, "noisy-probe-bin");
				const writerPid = path.join(root, "probe-writer-pid");
				// The wrapper answers, then leaves a child that keeps writing to the stdout it inherited.
				await Bun.write(
					path.join(bin, "git"),
					`#!/bin/sh\n"${Bun.which("git")}" "$@" || exit $?\nif [ "$1" = version ]; then\n(while :; do echo noise; sleep 0.01; done) &\necho $! > "${writerPid}"\nfi\n`,
				);
				await fs.chmod(path.join(bin, "git"), 0o755);
				const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
				const alive = (pid: number) => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				};
				let pid = 0;
				try {
					const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });
					pid = Number((await fs.readFile(writerPid, "utf8")).trim());
					expect(result.exitCode).toBe(0);
					// Real wait: the writer dies on its own schedule, visible only as its pid vanishing.
					for (let i = 0; i < 60 && alive(pid); i++) await Bun.sleep(50);
					// Its next write hits the closed pipe (SIGPIPE).
					expect(alive(pid)).toBe(false);
				} finally {
					if (pid) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// Already gone.
						}
					}
				}
			},
		);

		it("runs the hook when a slow filesystem opens its capture files after the first trim poll", async () => {
			const wt = await create();
			await hook("sleep 0.6");
			const realOpen = nodeFs.promises.open;
			const open = spyOn(nodeFs.promises, "open").mockImplementation((async (
				file: nodeFs.PathLike,
				...rest: [string]
			) => {
				const target = String(file);
				if (
					["stdout", "stderr"].includes(path.basename(target)) &&
					path.basename(path.dirname(target)).startsWith("omp-post-checkout-")
				) {
					// Real wait, longer than the trim's real poll timer, which a fake clock would not reproduce.
					await Bun.sleep(400);
				}
				return realOpen(file, ...rest);
			}) as typeof realOpen);
			try {
				const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, {
					env: filterChildShellEnv(process.env),
				});
				expect(result.exitCode).toBe(0);
			} finally {
				open.mockRestore();
			}
		});

		it("runs the hook away from the terminal of the agent that started it", async () => {
			await hook("ps -o pgid= -p $$ > .post-checkout-group");
			const wt = await create();
			const hookGroup = (await Bun.file(path.join(wt.path, ".post-checkout-group")).text()).trim();
			const ownGroup = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
				.stdout.toString()
				.trim();

			// Its own session and process group (setsid), so a prompt on /dev/tty fails instead of writing into the TUI.
			expect(hookGroup).not.toBe(ownGroup);
		});

		it("keeps the git probes before the hook away from the agent's terminal too", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "probe-bin");
			const groups = path.join(root, "probe-groups");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\ncase "$1" in rev-parse|version) echo "$1 $(ps -o pgid= -p $$)" >> "${groups}";; esac\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env, detached: true });
			const ownGroup = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
				.stdout.toString()
				.trim();
			const probes = (await Bun.file(groups).text())
				.trim()
				.split("\n")
				.map(line => line.split(/\s+/));

			expect(probes.map(([probe]) => probe)).toEqual(["rev-parse", "version"]);
			for (const [, group] of probes) expect(group).not.toBe(ownGroup);
		});

		it("returns when a git wrapper's background child keeps the version output open", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "bin");
			const lingering = path.join(root, "lingering-pid");
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\nif [ "$1" = version ]; then\n  sleep 30 &\n  echo $! > "${lingering}"\nfi\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			try {
				const result = await vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env });

				expect(result.exitCode).toBe(0);
				expect(await exists(path.join(wt.path, ".post-checkout-ran"))).toBe(true);
			} finally {
				try {
					process.kill(Number((await fs.readFile(lingering, "utf8")).trim()), "SIGKILL");
				} catch {}
			}
		});

		it("abort is not held up by a stalled hook-file check", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const hookFile = path.join(repo, ".git", "hooks", "post-checkout");
			const reached = Promise.withResolvers<void>();
			const realStat = nodeFs.promises.stat;
			// A stat that never settles, as on a stalled network filesystem.
			const stat = spyOn(nodeFs.promises, "stat").mockImplementation(((file: nodeFs.PathLike, ...rest: []) => {
				if (path.resolve(String(file)) !== hookFile) return realStat(file, ...rest);
				reached.resolve();
				const stalled = Promise.withResolvers<nodeFs.Stats>();
				releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
				return stalled.promise;
			}) as typeof realStat);
			const controller = new AbortController();
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal });
			try {
				await reached.promise;
			} finally {
				// Restored before the outcome is awaited, so a regression can't leak the stalled stat into other tests.
				stat.mockRestore();
			}
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		});

		it("abort is not held up by a stalled capture directory", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const reached = Promise.withResolvers<void>();
			const realMkdtemp = nodeFs.promises.mkdtemp;
			// A temp directory that never appears, as on a stalled network-mounted TMPDIR.
			const mkdtemp = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(((prefix: string, ...rest: []) => {
				if (!prefix.includes("omp-post-checkout-")) return realMkdtemp(prefix, ...rest);
				reached.resolve();
				const stalled = Promise.withResolvers<string>();
				releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
				return stalled.promise;
			}) as typeof realMkdtemp);
			const controller = new AbortController();
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal });
			try {
				await reached.promise;
			} finally {
				mkdtemp.mockRestore();
			}
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		});

		it.each([
			["reading the hook's output", "stdout", "r"],
			["creating the hook's output file", "stdout", process.platform === "win32" ? "w" : "a+"],
		])("abort is not held up by a stalled filesystem when %s", async (_name, capture, flags) => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const reached = Promise.withResolvers<void>();
			const realOpen = nodeFs.promises.open;
			// An open that never settles, as on a stalled network-mounted TMPDIR.
			const open = spyOn(nodeFs.promises, "open").mockImplementation(((
				file: nodeFs.PathLike,
				mode: string,
				...rest: []
			) => {
				const target = String(file);
				const isCapture =
					path.basename(target) === capture &&
					path.basename(path.dirname(target)).startsWith("omp-post-checkout-");
				if (!isCapture || mode !== flags) return realOpen(file, mode, ...rest);
				reached.resolve();
				const stalled = Promise.withResolvers<nodeFs.promises.FileHandle>();
				releaseStalled = () => stalled.reject(Object.assign(new Error("released"), { code: "ENOENT" }));
				return stalled.promise;
			}) as typeof realOpen);
			const controller = new AbortController();
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal });
			try {
				await reached.promise;
			} finally {
				open.mockRestore();
			}
			controller.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		});

		it("removes this host's hook captures whose omp process is gone, never those of a live one or another host", async () => {
			const wt = await create();
			const tmp = path.join(root, "tmp");
			await fs.mkdir(tmp);
			const tmpdir = spyOn(os, "tmpdir").mockReturnValue(tmp);
			const realMkdtemp = nodeFs.promises.mkdtemp;
			let prefix = "";
			const mkdtemp = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(((given: string, ...rest: []) => {
				prefix = path.basename(given);
				return realMkdtemp(given, ...rest);
			}) as typeof realMkdtemp);
			const run = () => vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { env: filterChildShellEnv(process.env) });
			try {
				// This host's own directory name, as a run creates it: `<prefix><host tag>-<pid>-`.
				await run();
				const own = prefix.slice(0, -`${process.pid}-`.length);
				// A pid whose process has already exited, as after omp crashed before its own cleanup.
				const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
				const left = path.join(tmp, `${own}${gone}-leftover`);
				// Its omp is alive: a hook that may be running for hours.
				const running = path.join(tmp, `${own}${process.pid}-running`);
				// Another host or container sharing the TMPDIR, whose pids mean nothing here.
				const foreign = path.join(tmp, `omp-post-checkout-otherhost-${gone}-elsewhere`);
				// This machine before a reboot: its omp ended with that boot, though the pid is in use now.
				const earlierBoot = path.join(
					tmp,
					`${own.replace(/^(omp-post-checkout-[^.]+)\.[^.]+\./, "$1.0.")}${process.pid}-before-reboot`,
				);
				for (const dir of [left, running, foreign, earlierBoot])
					await Bun.write(path.join(dir, "stdout"), "output\n");
				await run();

				expect(await exists(left)).toBe(false);
				expect(await exists(path.join(running, "stdout"))).toBe(true);
				expect(await exists(path.join(foreign, "stdout"))).toBe(true);
				// Only a machine id tells this machine after a reboot from another one with the same hostname (Linux reads
				// `/etc/machine-id`; macOS and Windows always report one).
				const machineId = (
					await Bun.file("/etc/machine-id")
						.text()
						.catch(() => "")
				).trim();
				expect(await exists(path.join(earlierBoot, "stdout"))).toBe(
					process.platform === "linux" && machineId === "",
				);
			} finally {
				mkdtemp.mockRestore();
				tmpdir.mockRestore();
			}
		});

		it("returns when the hook exits even if it left a background process running", async () => {
			await hook("sleep 30 &\necho $! > .sleeper");
			const wt = await create();
			const sleeper = Number((await Bun.file(path.join(wt.path, ".sleeper")).text()).trim());
			process.kill(sleeper, "SIGKILL");

			expect(wt.hook?.error).toBeUndefined();
		});

		it("abort rejects promptly and kills what the hook spawned", async () => {
			const wt = await create();
			const ready = path.join(root, "hook-ready");
			expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
			// `wait` keeps the hook running until aborted; only a process-group kill also stops the sleep.
			await hook(`sleep 30 &\necho $! > "${ready}"\nwait`);
			const controller = new AbortController();
			const pending = runWorktreeCheckoutHook(wt.path, wt.baseCommit, controller.signal);
			const sleeper = Number((await fs.readFile(ready, "utf8")).trim());
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
				const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleeper)])
					.stdout.toString()
					.trim();
				expect(state === "" || state.startsWith("Z")).toBe(true);
			} finally {
				try {
					process.kill(sleeper, "SIGKILL");
				} catch {}
			}
		});

		it.skipIf(!Bun.which("setsid"))("abort also kills a child the hook moved into its own session", async () => {
			const wt = await create();
			const ready = path.join(root, "hook-ready");
			expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
			// `setsid` takes the sleep out of the hook's process group, so a group kill alone misses it. The pid is
			// written from inside the new session, so the abort cannot land before the child has left the group.
			await hook(`setsid sh -c 'echo $$ > "${ready}"; exec sleep 30' &\nwait`);
			const controller = new AbortController();
			const pending = runWorktreeCheckoutHook(wt.path, wt.baseCommit, controller.signal);
			const sleeper = Number((await fs.readFile(ready, "utf8")).trim());
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
				const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleeper)])
					.stdout.toString()
					.trim();
				expect(state === "" || state.startsWith("Z")).toBe(true);
			} finally {
				try {
					process.kill(sleeper, "SIGKILL");
				} catch {}
			}
		});

		it("abort also stops a hung git version check and what it spawned", async () => {
			const wt = await create();
			await hook("touch .post-checkout-ran");
			const bin = path.join(root, "bin");
			const ready = path.join(root, "probe-ready");
			expect(Bun.spawnSync(["mkfifo", ready]).exitCode).toBe(0);
			// A git wrapper that hangs on `version` with a child of its own; only a process-group kill also stops the sleep.
			await Bun.write(
				path.join(bin, "git"),
				`#!/bin/sh\nif [ "$1" = version ]; then\n  sleep 30 &\n  echo $! > "${ready}"\n  wait\nfi\nexec "${Bun.which("git")}" "$@"\n`,
			);
			await fs.chmod(path.join(bin, "git"), 0o755);
			const controller = new AbortController();
			const env = { ...filterChildShellEnv(process.env), PATH: `${bin}${path.delimiter}${process.env.PATH}` };
			const pending = vcs.runPostCheckoutHook(wt.path, wt.baseCommit, { signal: controller.signal, env });
			const sleeper = Number((await fs.readFile(ready, "utf8")).trim());
			try {
				controller.abort();
				await expect(pending).rejects.toMatchObject({ name: "AbortError" });
				const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleeper)])
					.stdout.toString()
					.trim();
				expect(state === "" || state.startsWith("Z")).toBe(true);
			} finally {
				try {
					process.kill(sleeper, "SIGKILL");
				} catch {}
			}
		});
	});
});
