/**
 * `commitCreate` must read the Git config that `GIT_CONFIG_GLOBAL` selects,
 * as `git commit` does: its identity and its hooks. Issue #19819.
 *
 * The ambient `~/.gitconfig` (under a scratch HOME) names identity A. The file
 * `GIT_CONFIG_GLOBAL` points at names identity B and `core.hooksPath` to a
 * `commit-msg` hook. The commit must be authored as B, and a refusing hook
 * must stop it.
 *
 * The native addon reads the process environment, which `process.env`
 * assignments in Bun do not reach, so each commit runs in a child Bun process
 * started with the environment under test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const VCS_MODULE = path.join(import.meta.dir, "..", "native", "vcs.js");
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

/** Calls the public native `git(dir).commitCreate` with no options and prints the outcome. */
const COMMIT_CHILD = `
const { git } = await import(process.argv[1]);
const repo = git(process.argv[2]);
try {
	await repo.commitCreate(process.argv[3], {});
	console.log("committed");
} catch (error) {
	console.log("refused: " + (error instanceof Error ? error.message : String(error)));
}
`;

async function runGit(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trimEnd();
}

/** A repo with one seed commit, and a scratch HOME whose `.gitconfig` is identity A. */
async function fixture(): Promise<{ root: string; scratch: string; env: Record<string, string> }> {
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-global-cfg-"));
	roots.push(scratch);
	const home = path.join(scratch, "home");
	await fs.mkdir(home);
	await Bun.write(path.join(home, ".gitconfig"), "[user]\n\tname = Ambient A\n\temail = ambient@example.test\n");
	const env = {
		...(process.env as Record<string, string>),
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
	};
	delete env.GIT_CONFIG_GLOBAL;

	const root = path.join(scratch, "repo");
	await fs.mkdir(root);
	await runGit(root, env, "init", "-q", "-b", "main");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await runGit(root, env, "add", "tracked.txt");
	await runGit(root, { ...env, GIT_AUTHOR_NAME: "Seed", GIT_AUTHOR_EMAIL: "seed@example.test", GIT_COMMITTER_NAME: "Seed", GIT_COMMITTER_EMAIL: "seed@example.test" }, "commit", "-q", "-m", "seed");
	return { root, scratch, env };
}

/** Writes the file `GIT_CONFIG_GLOBAL` names: identity B and, optionally, a hooks directory. */
async function globalConfigEnv(
	base: Record<string, string>,
	scratch: string,
	hooksPath?: string,
): Promise<Record<string, string>> {
	const file = path.join(scratch, "gitconfig-b");
	const lines = ["[user]", "\tname = Identity B", "\temail = identity-b@example.test"];
	if (hooksPath) lines.push("[core]", `\thooksPath = ${hooksPath}`);
	await Bun.write(file, `${lines.join("\n")}\n`);
	return { ...base, GIT_CONFIG_GLOBAL: file };
}

async function commitInChild(root: string, env: Record<string, string>, message: string): Promise<string> {
	const proc = Bun.spawn([process.execPath, "-e", COMMIT_CHILD, VCS_MODULE, root, message], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`commit child failed (${code}): ${stderr}`);
	return stdout.trim();
}

describe("commitCreate honors GIT_CONFIG_GLOBAL (issue #19819)", () => {
	test("a commit-msg hook from GIT_CONFIG_GLOBAL refuses the commit", async () => {
		const { root, scratch, env } = await fixture();
		const hooks = path.join(scratch, "hooks");
		await fs.mkdir(hooks);
		const hook = path.join(hooks, "commit-msg");
		await Bun.write(hook, "#!/bin/sh\necho 'policy: refused by global hook' >&2\nexit 1\n");
		await fs.chmod(hook, 0o755);
		const commitEnv = await globalConfigEnv(env, scratch, hooks);

		const before = await runGit(root, commitEnv, "rev-parse", "HEAD");
		await Bun.write(path.join(root, "tracked.txt"), "one\ntwo\n");
		await runGit(root, commitEnv, "add", "tracked.txt");

		const outcome = await commitInChild(root, commitEnv, "feat: refused");
		expect(outcome.startsWith("refused:")).toBe(true);
		expect(outcome).toContain("policy: refused by global hook");
		expect(await runGit(root, commitEnv, "rev-parse", "HEAD")).toBe(before);
	});

	test("the commit is authored with the identity GIT_CONFIG_GLOBAL names", async () => {
		const { root, scratch, env } = await fixture();
		const commitEnv = await globalConfigEnv(env, scratch);

		await Bun.write(path.join(root, "tracked.txt"), "one\ntwo\n");
		await runGit(root, commitEnv, "add", "tracked.txt");

		expect(await commitInChild(root, commitEnv, "feat: identity")).toBe("committed");
		expect(await runGit(root, commitEnv, "log", "-1", "--format=%an <%ae>")).toBe(
			"Identity B <identity-b@example.test>",
		);
	});
});
