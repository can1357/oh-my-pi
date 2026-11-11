import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isPidAlive } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

describe.skipIf(process.platform === "win32")("worktree add checkout hooks", () => {
	let root: string;
	let repo: string;
	let hooks: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-hook-"));
		repo = path.join(root, "repo");
		await $`git init -q ${repo}`.quiet();
		await $`git -C ${repo} -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit --allow-empty -qm probe`.quiet();
		hooks = path.join(repo, ".git", "hooks");
		await $`git -C ${repo} config core.hooksPath ${hooks}`.quiet();
		await Bun.write(path.join(repo, "local-probe.txt"), "untracked file to exercise clone fallback\n");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function hook(script: string): Promise<void> {
		const file = path.join(hooks, "post-checkout");
		await Bun.write(file, `#!/bin/sh\n${script}\n`);
		await fs.chmod(file, 0o755);
	}

	async function add(name: string) {
		const worktree = path.join(root, name);
		const result = await $`bun ${cli} worktree add --detach ${worktree} HEAD`.cwd(repo).quiet().nothrow();
		return { worktree, result };
	}

	it("runs post-checkout in the new worktree after clone or plain-checkout fallback", async () => {
		await hook('printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran; echo hook-output');
		const { worktree, result } = await add("linked");
		const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
		const marker = (await Bun.file(path.join(worktree, ".post-checkout-ran")).text()).trim().split("\n");

		expect(result.exitCode).toBe(0);
		expect(marker).toEqual([worktree, "0".repeat(head.length), head, "1"]);
		expect(result.stderr.toString()).toContain("hook-output");
	});

	// On macOS `$which` falls back to the Command Line Tools' git, which an empty PATH does not hide.
	it.skipIf(process.platform === "darwin")(
		"exits 1 with a warning and keeps the worktree when no git can run the hook",
		async () => {
			const worktree = path.join(root, "nogit");
			const bunDir = path.join(root, "bin");
			await fs.mkdir(bunDir);
			await fs.symlink(process.execPath, path.join(bunDir, "bun"));
			const result = await $`${process.execPath} ${cli} worktree add --detach ${worktree} HEAD`
				.cwd(repo)
				.env({ ...process.env, PATH: bunDir })
				.quiet()
				.nothrow();

			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain("warning: post-checkout hook not run");
			expect((await fs.stat(worktree)).isDirectory()).toBe(true);
		},
	);

	it("preserves a refusing hook's failure status and stderr", async () => {
		await hook("echo checkout-refused >&2; exit 17");
		const { result } = await add("refused");

		expect(result.exitCode).toBe(17);
		expect(result.stderr.toString()).toContain("checkout-refused");
	});

	it("preserves the status when git hook run itself dies of a signal", async () => {
		await hook("kill -TERM $PPID");
		const { worktree, result } = await add("signalled");

		expect(result.exitCode).toBe(143);
		expect((await fs.stat(worktree)).isDirectory()).toBe(true);
	});

	it("the hook gets omp's own env, ~/.env values included, when launched from $HOME", async () => {
		const home = path.join(root, "home");
		await Bun.write(path.join(home, ".env"), "OMP_WT_ADD_DOTENV_ONLY=from-home-dotenv\n");
		await hook('printf "%s" "$OMP_WT_ADD_DOTENV_ONLY" > .dotenv-seen');
		const worktree = path.join(root, "dotenv");
		const result = await $`bun ${cli} worktree add -C ${repo} --detach ${worktree} HEAD`
			.cwd(home)
			.env({ ...process.env, HOME: home })
			.quiet()
			.nothrow();

		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(await Bun.file(path.join(worktree, ".dotenv-seen")).text()).toBe("from-home-dotenv");
	});

	// A real background job that writes after the command returned: the poll waits on OS state, which fake timers cannot drive.
	it("returns with the hook's status and leaves its background job writing to omp's stderr, as git does", async () => {
		const marker = path.join(root, "bg.done");
		const stderrFile = path.join(root, "stderr.txt");
		await hook(`( sleep 0.5; echo late >&2; echo after > "${marker}" ) &\nexit 3`);
		// stderr goes to a file, as it would to a terminal, so no pipe keeps this test waiting on the job.
		const script = '"$0" "$1" worktree add --detach "$2" HEAD 2>"$3"';
		const result = await $`sh -c ${script} ${process.execPath} ${cli} ${path.join(root, "background")} ${stderrFile}`
			.cwd(repo)
			.quiet()
			.nothrow();

		expect(result.exitCode).toBe(3);
		for (let i = 0; i < 100 && !(await Bun.file(marker).exists()); i++) await Bun.sleep(50);
		expect(await Bun.file(marker).text()).toBe("after\n");
		expect(await Bun.file(stderrFile).text()).toContain("late");
	}, 15_000);

	// Real child processes and signals: the polls below wait on OS state, which fake timers cannot drive.
	it("stops the hook when the terminal's process group receives Ctrl-C", async () => {
		const pidFile = path.join(root, "hook.pid");
		await hook(`echo $$ > "${pidFile}"\nsleep 30`);
		const child = Bun.spawn(["bun", cli, "worktree", "add", "--detach", path.join(root, "interrupted"), "HEAD"], {
			cwd: repo,
			detached: true,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		let pid = Number.NaN;
		try {
			const pollDeadline = Date.now() + 10_000;
			while (Date.now() < pollDeadline && !Number.isInteger(pid)) {
				const text = await Bun.file(pidFile)
					.text()
					.catch(() => "");
				const parsed = Number.parseInt(text, 10);
				if (Number.isInteger(parsed)) pid = parsed;
				else await Bun.sleep(50);
			}
			expect(Number.isInteger(pid)).toBe(true);

			process.kill(-child.pid, "SIGINT");

			const goneDeadline = Date.now() + 5_000;
			while (Date.now() < goneDeadline && isPidAlive(pid)) await Bun.sleep(50);
			expect(isPidAlive(pid)).toBe(false);
		} finally {
			if (Number.isInteger(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// Group already gone.
			}
		}
	}, 20_000);
});
