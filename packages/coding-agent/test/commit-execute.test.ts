import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { abortOnGitFailure, CommitAbortedError, pushOrAbort } from "../src/commit/execute";

const tempDirs: string[] = [];

async function mkTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { env, stdout: "ignore", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	}
}

async function initRepoWithCommit(dir: string): Promise<void> {
	await runGit(dir, ["init", "-q", "-b", "main"]);
	await runGit(dir, ["config", "user.email", "test@example.com"]);
	await runGit(dir, ["config", "user.name", "Test"]);
	await fs.writeFile(path.join(dir, "a.txt"), "one\n");
	await runGit(dir, ["add", "."]);
	await runGit(dir, ["commit", "-q", "-m", "seed"]);
}

async function revParse(cwd: string, rev: string): Promise<string> {
	const env = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", rev], { env, stdout: "pipe", stderr: "ignore" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`git rev-parse ${rev} failed`);
	return out.trim();
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("abortOnGitFailure (issue #7834)", () => {
	it("surfaces a refusing hook's message and aborts with a sentinel instead of the raw error", async () => {
		const dir = await mkTempDir("omp-commit-hook-");
		await initRepoWithCommit(dir);
		const hook = path.join(dir, ".git", "hooks", "pre-commit");
		await fs.writeFile(hook, '#!/bin/sh\necho "policy: this change is not allowed" >&2\nexit 1\n');
		await fs.chmod(hook, 0o755);
		await fs.appendFile(path.join(dir, "a.txt"), "two\n");
		await runGit(dir, ["add", "-A"]);

		// A refused commit yields a VcsError from the native adapter;
		// this is the input both commit routes hand to abortOnGitFailure.
		let commitError: unknown;
		try {
			await vcs.requireGit(dir).commitCreate("feat: x", {});
		} catch (error) {
			commitError = error;
		}
		expect(vcs.isVcsError(commitError)).toBe(true);

		const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		expect(() =>
			abortOnGitFailure(
				"Commit 1 of 2 failed",
				commitError as vcs.VcsError,
				"0 of 2 commits created; 1 file(s) remain staged. No changes were lost.",
			),
		).toThrow(CommitAbortedError);

		const printed = stderrSpy.mock.calls.map(call => String(call[0])).join("");
		expect(printed).toContain("Commit 1 of 2 failed:");
		expect(printed).toContain("policy: this change is not allowed");
		expect(printed).toContain("0 of 2 commits created; 1 file(s) remain staged. No changes were lost.");
		// The readable message must not carry a stack trace / source dump.
		expect(printed).not.toContain("at ");
	});
});

describe("pushOrAbort (issue #7834)", () => {
	it("pushes existing commits when the working tree is clean", async () => {
		const root = await mkTempDir("omp-push-clean-");
		const bare = path.join(root, "remote.git");
		await runGit(root, ["init", "-q", "--bare", bare]);
		const work = path.join(root, "work");
		await fs.mkdir(work);
		await initRepoWithCommit(work);
		await runGit(work, ["remote", "add", "origin", bare]);
		await runGit(work, ["push", "-q", "-u", "origin", "main"]);

		// A local commit that never made it to the remote — the defect-2 scenario.
		await fs.appendFile(path.join(work, "a.txt"), "two\n");
		await runGit(work, ["add", "a.txt"]);
		await runGit(work, ["commit", "-q", "-m", "local only"]);

		const localHead = await revParse(work, "HEAD");
		expect(await revParse(bare, "main")).not.toBe(localHead);

		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await pushOrAbort(work);

		expect(await revParse(bare, "main")).toBe(localHead);
	});

	it("aborts with a sentinel when the branch has no upstream", async () => {
		const dir = await mkTempDir("omp-push-noupstream-");
		await initRepoWithCommit(dir);

		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await expect(pushOrAbort(dir)).rejects.toBeInstanceOf(CommitAbortedError);
	});
});
