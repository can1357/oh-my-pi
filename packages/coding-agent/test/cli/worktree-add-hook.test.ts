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
});
