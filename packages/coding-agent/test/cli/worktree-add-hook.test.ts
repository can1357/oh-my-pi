import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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

	it("preserves a refusing hook's failure status and stderr", async () => {
		await hook("echo checkout-refused >&2; exit 17");
		const { result } = await add("refused");

		expect(result.exitCode).toBe(17);
		expect(result.stderr.toString()).toContain("checkout-refused");
	});

	async function legacyShim(): Promise<{ shimDir: string }> {
		// Git 2.34-style shim on PATH: reports 2.34.1 and rejects the `hook`
		// subcommand the way real Git < 2.36 does, forwarding everything else.
		const realGit = Bun.which("git");
		if (!realGit) throw new Error("git is required for this test");
		const shimDir = path.join(root, "shim");
		await fs.mkdir(shimDir, { recursive: true });
		const shim = path.join(shimDir, "git");
		await Bun.write(
			shim,
			[
				"#!/bin/sh",
				'if [ "$1" = "hook" ]; then echo "git: hook is not a git command" >&2; exit 1; fi',
				'if [ "$1" = "--version" ]; then echo "git version 2.34.1"; exit 0; fi',
				`exec "${realGit}" "$@"`,
				"",
			].join("\n"),
		);
		await fs.chmod(shim, 0o755);
		return { shimDir };
	}

	it("runs the post-checkout hook when git predates `git hook run` (git < 2.36)", async () => {
		const { shimDir } = await legacyShim();

		await hook('printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran; echo hook-output');
		const worktree = path.join(root, "legacy");
		const result = await $`bun ${cli} worktree add --detach ${worktree} HEAD`
			.cwd(repo)
			.env({ ...process.env, PATH: `${shimDir}:${process.env.PATH}` })
			.quiet()
			.nothrow();
		const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
		const marker = (await Bun.file(path.join(worktree, ".post-checkout-ran")).text()).trim().split("\n");

		expect(result.exitCode).toBe(0);
		expect(marker).toEqual([worktree, "0".repeat(head.length), head, "1"]);
		expect(result.stderr.toString()).toContain("hook-output");
	});

	it("expands a ~-relative core.hooksPath when git predates `git hook run`", async () => {
		const { shimDir } = await legacyShim();
		// `git config core.hooksPath` returns the raw token; git reads the key
		// via git_config_pathname, expanding `~` against HOME.
		const home = path.join(root, "home");
		const homeHooks = path.join(home, ".githooks");
		await fs.mkdir(homeHooks, { recursive: true });
		const file = path.join(homeHooks, "post-checkout");
		await Bun.write(file, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran\n');
		await fs.chmod(file, 0o755);
		await $`git -C ${repo} config core.hooksPath ${"~/.githooks"}`.quiet();

		const worktree = path.join(root, "legacy-tilde");
		const result = await $`bun ${cli} worktree add --detach ${worktree} HEAD`
			.cwd(repo)
			.env({ ...process.env, PATH: `${shimDir}:${process.env.PATH}`, HOME: home })
			.quiet()
			.nothrow();
		const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
		const marker = (await Bun.file(path.join(worktree, ".post-checkout-ran")).text()).trim().split("\n");

		expect(result.exitCode).toBe(0);
		expect(marker).toEqual([worktree, "0".repeat(head.length), head, "1"]);
	});

	it("falls back to the common dir hooks/ with git's hook environment when git predates `git hook run`", async () => {
		const { shimDir } = await legacyShim();
		await $`git -C ${repo} config --unset core.hooksPath`.quiet();
		// The hook records its environment the way `git hook run` provides it:
		// GIT_EXEC_PATH set, GIT_PREFIX empty, and the exec path on PATH.
		await hook(
			'printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran; ' +
				'printf "%s\\n" "${GIT_EXEC_PATH:-unset}" "${GIT_PREFIX-UNSET}" > .post-checkout-env; ' +
				'if [ -n "$GIT_EXEC_PATH" ]; then case ":$PATH:" in *":$GIT_EXEC_PATH:"*) echo prefixed >> .post-checkout-env;; esac; fi',
		);
		const worktree = path.join(root, "legacy-common");
		const result = await $`bun ${cli} worktree add --detach ${worktree} HEAD`
			.cwd(repo)
			.env({ ...process.env, PATH: `${shimDir}:${process.env.PATH}` })
			.quiet()
			.nothrow();
		const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
		const marker = (await Bun.file(path.join(worktree, ".post-checkout-ran")).text()).trim().split("\n");
		const hookEnv = (await Bun.file(path.join(worktree, ".post-checkout-env")).text()).trim().split("\n");
		const execPath = (await $`git --exec-path`.text()).trim();

		expect(result.exitCode).toBe(0);
		expect(marker).toEqual([worktree, "0".repeat(head.length), head, "1"]);
		expect(hookEnv[0]).toBe(execPath);
		expect(hookEnv[1]).toBe("");
		expect(hookEnv[2]).toBe("prefixed");
	});
});
