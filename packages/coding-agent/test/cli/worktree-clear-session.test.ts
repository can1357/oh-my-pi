import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createSessionWorktree,
	SESSION_WORKTREE_RECORD,
	type SessionWorktree,
	writeSessionWorktreeRecord,
} from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

const exists = (p: string) =>
	fs.stat(p).then(
		() => true,
		() => false,
	);

/** `omp worktree clear` reclaims session worktrees only once their owner exited and they hold nothing to lose. */
describe("worktree clear session worktrees", () => {
	let root: string;
	let repo: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-session-")));
		repo = path.join(root, "repo");
		await fs.mkdir(repo);
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		git(repo, "init", "-q", "-b", "main");
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	/** A session worktree whose record names `pid` (undefined: this process) and the owner's `onExit`. */
	async function sessionWorktree(
		branch: string,
		pid?: number,
		onExit: "keep" | "ask" | "remove" = "remove",
	): Promise<SessionWorktree> {
		const wt = await createSessionWorktree(repo, Settings.isolated(), branch, { keepChanges: false });
		await writeSessionWorktreeRecord(wt, { onExit });
		if (pid !== undefined) {
			const file = path.join(vcs.requireGit(wt.path).info().gitDir, SESSION_WORKTREE_RECORD);
			await Bun.write(file, JSON.stringify({ ...(await Bun.file(file).json()), pid, startToken: undefined }));
		}
		return wt;
	}

	it("removes exited owners' clean worktrees and keeps dirty, live, or kept-by-policy ones", async () => {
		const clean = await sessionWorktree("wt/clean", await deadPid());
		const dirty = await sessionWorktree("wt/dirty", await deadPid());
		await Bun.write(path.join(dirty.path, "work.txt"), "uncommitted\n");
		const live = await sessionWorktree("wt/live");
		const kept = await sessionWorktree("wt/kept", await deadPid(), "keep");

		const result = await clearWorktrees({ all: false, dryRun: false, json: false });

		expect(result).toEqual({ removed: 1, failed: 0 });
		expect(await exists(clean.path)).toBe(false);
		expect(git(repo, "branch", "--list", "wt/clean")).toBe("");
		expect(await exists(dirty.path)).toBe(true);
		expect(await exists(live.path)).toBe(true);
		expect(await exists(kept.path)).toBe(true);
	});

	it.skipIf(process.platform !== "linux")(
		"keeps an exited owner's worktree while a process still works in it",
		async () => {
			const held = await sessionWorktree("wt/held", await deadPid());
			// Stands in for a shell a multiplexer restored in the worktree before the agent resumed there.
			const shell = Bun.spawn(["sleep", "30"], { cwd: held.path, stdout: "ignore", stderr: "ignore" });
			try {
				expect(await clearWorktrees({ all: false, dryRun: false, json: false })).toEqual({ removed: 0, failed: 0 });
				expect(await exists(held.path)).toBe(true);
			} finally {
				shell.kill();
				await shell.exited;
			}
			expect(await clearWorktrees({ all: false, dryRun: false, json: false })).toEqual({ removed: 1, failed: 0 });
		},
	);

	it("with --all, removes a session worktree git can no longer open", async () => {
		// Bare layout: the session worktree's git access goes through its source checkout, which is then deleted.
		const bare = path.join(root, "bare.git");
		const main = path.join(root, "main");
		git(root, "clone", "-q", "--bare", repo, bare);
		git(bare, "worktree", "add", "-q", main, "main");
		const wt = await createSessionWorktree(main, Settings.isolated(), "wt/orphan", { keepChanges: false });
		await writeSessionWorktreeRecord(wt, { onExit: "remove" });
		await fs.rm(main, { recursive: true, force: true });

		const result = await clearWorktrees({ all: true, dryRun: false, json: false });

		expect(result.failed).toBe(0);
		expect(await exists(wt.path)).toBe(false);
	});
});
