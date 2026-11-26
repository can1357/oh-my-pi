/**
 * Concurrent `commitCreate` calls must not share `.git/COMMIT_EDITMSG`.
 *
 * The `commit-msg` hook runs after the message is written and before it is
 * read back. Replacing `COMMIT_EDITMSG` in that window is another call's
 * write. Each call has to commit its own subject and body, including the
 * hook's edit of the file it was given, and remove that file on every exit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-msg-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	// A global `core.hooksPath` would hide the fixture hook from gix.
	await git(root, "config", "core.hooksPath", ".git/hooks");
	await git(root, "config", "commit.gpgsign", "false");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

async function installHook(root: string, script: string, name = "commit-msg"): Promise<void> {
	const hooks = path.join(root, ".git", "hooks");
	await fs.mkdir(hooks, { recursive: true });
	const hook = path.join(hooks, name);
	await Bun.write(hook, script);
	await fs.chmod(hook, 0o755);
}

async function readLines(filePath: string): Promise<string[]> {
	try {
		return (await Bun.file(filePath).text()).split("\n").filter(line => line.length > 0);
	} catch {
		return [];
	}
}

// Bounded by a clock deadline, not a loop count, so a slow runner has the
// full budget to reach the expected count.
async function waitForLineCount(filePath: string, count: number, budgetMs: number): Promise<string[]> {
	const deadline = Date.now() + budgetMs;
	let lines = await readLines(filePath);
	while (lines.length < count && Date.now() < deadline) {
		await Bun.sleep(25);
		lines = await readLines(filePath);
	}
	return lines;
}

function within<T>(promise: Promise<T>, budgetMs: number, label: string): Promise<T> {
	const { promise: timedOut, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${budgetMs} ms`)), budgetMs);
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

describe("commitCreate message isolation", () => {
	test("keeps its subject and body when another call replaces COMMIT_EDITMSG", async () => {
		const root = await repository();
		await installHook(
			root,
			[
				"#!/bin/sh",
				'printf \'%s\' "$1" > "$GIT_DIR/seen-msg-path"',
				"printf '\\nHook-Trailer: kept\\n' >> \"$1\"",
				"printf '%s\\n\\n%s\\n' 'stolen subject' 'stolen body' > \"$GIT_DIR/COMMIT_EDITMSG\"",
				"",
			].join("\n"),
		);
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await Bun.write(shared, "preexisting\n");
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("mine subject\n\nmine body\n", { allowEmpty: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		const committed = await git(root, "log", "-1", "--format=%B");
		expect(committed).toContain("mine subject");
		expect(committed).toContain("mine body");
		expect(committed).toContain("Hook-Trailer: kept");
		expect(committed).not.toContain("stolen subject");
		const seen = (await Bun.file(path.join(root, ".git", "seen-msg-path")).text()).trim();
		expect(path.basename(seen)).not.toBe("COMMIT_EDITMSG");
		expect(await Bun.file(seen).exists()).toBe(false);
		expect(await Bun.file(shared).text()).toBe("stolen subject\n\nstolen body\n");
	});

	test("serializes the shared COMMIT_EDITMSG through the commit-msg hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		// Mark pre-commit entry so the test proves the second call has entered
		// commit_with_index before checking that it stays blocked before commit-msg.
		await installHook(root, ["#!/bin/bash", 'echo pre >> "$GIT_DIR/pre-commit-ran"', ""].join("\n"), "pre-commit");
		// Legacy hooks ignore $1 and read the documented COMMIT_EDITMSG path. The
		// hook parks after recording which call it is (its private file's name);
		// only once released does it record the shared file it actually saw.
		await installHook(
			root,
			[
				"#!/bin/bash",
				'name=$(basename "$1")',
				'echo "$name" >> "$GIT_DIR/hook-ran"',
				"end=$((SECONDS + 60))",
				// Sleep so a parked hook does not spin a core while the test waits.
				'while [ ! -f "$GIT_DIR/release-all" ] && [ $SECONDS -lt $end ]; do sleep 0.1; done',
				'cat "$GIT_DIR/COMMIT_EDITMSG" > "$GIT_DIR/seen-$name"',
				"",
			].join("\n"),
		);
		const repo = vcsGitDiscover(root)!;
		const preRan = path.join(gitDir, "pre-commit-ran");
		const ran = path.join(gitDir, "hook-ran");

		const first = repo.commitCreate("first subject\n\nfirst body\n", { allowEmpty: true });
		// Keep unhandled rejections from leaking if an assertion fails early.
		first.catch(() => {});
		let second: Promise<string> | undefined;
		let results: PromiseSettledResult<string>[] | undefined;
		let runs1: string[];
		try {
			runs1 = await waitForLineCount(ran, 1, 10_000);
			expect(runs1).toHaveLength(1);
			// While the first hook is parked, a second call must not reach its own
			// hook. Without serialization it does, and the first hook then reads the
			// second call's message.
			second = repo.commitCreate("second subject\n\nsecond body\n", { allowEmpty: true });
			second.catch(() => {});
			expect(await waitForLineCount(preRan, 2, 10_000)).toHaveLength(2);
			const runsWhileParked = await waitForLineCount(ran, 2, 2_000);
			expect(runsWhileParked).toHaveLength(1);
		} finally {
			await Bun.write(path.join(gitDir, "release-all"), "");
			results = await Promise.allSettled([first, ...(second ? [second] : [])]);
		}
		// A CAS loser never lands, so both hook views are read from the hook log
		// after both calls settle, not from a success branch.
		const runs = await waitForLineCount(ran, 2, 10_000);
		expect(runs).toHaveLength(2);
		expect(runs[0]).toBe(runs1[0]);
		const seen = async (name: string): Promise<string> =>
			(await Bun.file(path.join(gitDir, `seen-${name}`)).text()).trim();
		expect(await seen(runs[0])).toBe("first subject\n\nfirst body");
		expect(await seen(runs[1])).toBe("second subject\n\nsecond body");
		const fulfilled = results.filter(result => result.status === "fulfilled");
		const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(fulfilled.length).toBeGreaterThanOrEqual(1);
		for (const failure of rejected) {
			expect(failure.reason).toMatchObject({ name: "VcsError", code: "HeadMoved" });
		}
	}, 30_000);

	test("does not let a concurrent noVerify commit overwrite COMMIT_EDITMSG during a verified hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		await installHook(
			root,
			[
				"#!/bin/bash",
				'echo entered >> "$GIT_DIR/hook-ran"',
				"end=$((SECONDS + 60))",
				'while [ ! -f "$GIT_DIR/release-all" ] && [ $SECONDS -lt $end ]; do sleep 0.1; done',
				'cat "$GIT_DIR/COMMIT_EDITMSG" > "$GIT_DIR/seen-verified"',
				"",
			].join("\n"),
		);
		const repo = vcsGitDiscover(root)!;
		const ran = path.join(gitDir, "hook-ran");

		const verified = repo.commitCreate("verified subject\n\nverified body\n", { allowEmpty: true });
		verified.catch(() => {});
		try {
			expect(await waitForLineCount(ran, 1, 10_000)).toHaveLength(1);
			const unverifiedSha = await within(
				repo.commitCreate("unverified subject\n\nunverified body\n", { allowEmpty: true, noVerify: true }),
				10_000,
				"noVerify commit",
			);
			expect(unverifiedSha).toBe(await git(root, "rev-parse", "HEAD"));
		} finally {
			await Bun.write(path.join(gitDir, "release-all"), "");
			await Promise.allSettled([verified]);
		}
		const seen = (await Bun.file(path.join(gitDir, "seen-verified")).text()).trim();
		expect(seen).toBe("verified subject\n\nverified body");
	}, 30_000);

	test("keeps unrelated native calls responsive and cancels aborted waiters under lock contention", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		await installHook(
			root,
			[
				"#!/bin/bash",
				'cat "$GIT_DIR/COMMIT_EDITMSG" >> "$GIT_DIR/all-seen"',
				'echo entered >> "$GIT_DIR/hook-ran"',
				"end=$((SECONDS + 60))",
				'while [ ! -f "$GIT_DIR/release-all" ] && [ $SECONDS -lt $end ]; do sleep 0.1; done',
				"",
			].join("\n"),
		);
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;
		const ran = path.join(gitDir, "hook-ran");

		const first = repo.commitCreate("holder subject\n", { allowEmpty: true });
		first.catch(() => {});
		const waiters: Promise<string>[] = [];
		try {
			expect(await waitForLineCount(ran, 1, 10_000)).toHaveLength(1);
			// Queue more waiters than libuv's default 4-thread pool so a pool-bound
			// lock wait would stall unrelated native calls.
			const controller = new AbortController();
			const canceled = repo.commitCreate("aborted waiter\n", { allowEmpty: true }, controller.signal);
			canceled.catch(() => {});
			waiters.push(canceled);
			for (let i = 0; i < 5; i++) {
				const pending = repo.commitCreate(`waiter ${i}\n`, { allowEmpty: true });
				pending.catch(() => {});
				waiters.push(pending);
			}
			// Let waiters reach the lock before probing responsiveness and abort.
			await Bun.sleep(100);
			expect(await within(repo.headSha(), 5_000, "unrelated libuv call")).toBe(head);
			controller.abort();
			await expect(within(canceled, 5_000, "aborted waiter")).rejects.toMatchObject({
				name: "VcsError",
				code: "Canceled",
			});
		} finally {
			await Bun.write(path.join(gitDir, "release-all"), "");
			await Promise.allSettled([first, ...waiters]);
		}
		const seen = await Bun.file(path.join(gitDir, "all-seen")).text();
		expect(seen).not.toContain("aborted waiter");
	}, 30_000);

	test("releases the shared-message lock before the post-commit hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		await installHook(root, ["#!/bin/bash", 'echo commit-msg >> "$GIT_DIR/hook-ran"', "exit 0", ""].join("\n"));
		const postCommit = path.join(gitDir, "hooks", "post-commit");
		await Bun.write(
			postCommit,
			[
				"#!/bin/bash",
				'echo post-commit >> "$GIT_DIR/hook-ran"',
				"end=$((SECONDS + 60))",
				'while [ ! -f "$GIT_DIR/release-all" ] && [ $SECONDS -lt $end ]; do sleep 0.1; done',
				"",
			].join("\n"),
		);
		await fs.chmod(postCommit, 0o755);
		const repo = vcsGitDiscover(root)!;
		const ran = path.join(gitDir, "hook-ran");
		const hookRuns = async (): Promise<string[]> => {
			try {
				return (await Bun.file(ran).text()).split("\n").filter(line => line.length > 0);
			} catch {
				return [];
			}
		};

		const first = repo.commitCreate("first subject\n", { allowEmpty: true });
		first.catch(() => {});
		let second: Promise<string> | undefined;
		try {
			const deadline = Date.now() + 10_000;
			let runs = await hookRuns();
			while (!runs.includes("post-commit") && Date.now() < deadline) {
				await Bun.sleep(25);
				runs = await hookRuns();
			}
			expect(runs).toContain("post-commit");
			// commit-msg has returned, so the next commit must be able to run its
			// own commit-msg hook while this post-commit hook is still parked.
			second = repo.commitCreate("second subject\n", { allowEmpty: true });
			second.catch(() => {});
			const secondDeadline = Date.now() + 10_000;
			while (runs.filter(line => line === "commit-msg").length < 2 && Date.now() < secondDeadline) {
				await Bun.sleep(25);
				runs = await hookRuns();
			}
			expect(runs.filter(line => line === "commit-msg")).toHaveLength(2);
		} finally {
			await Bun.write(path.join(gitDir, "release-all"), "");
			await Promise.allSettled([first, ...(second ? [second] : [])]);
		}
	}, 30_000);

	test("rejects a hooked commit when COMMIT_EDITMSG cannot be written", async () => {
		const root = await repository();
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await fs.rm(shared, { force: true });
		await fs.mkdir(shared);
		await installHook(root, "#!/bin/sh\nexit 0\n");
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("must not land\n", { allowEmpty: true })).rejects.toThrow(/COMMIT_EDITMSG/);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);

		const skipped = await repo.commitCreate("skipped the hook\n", { allowEmpty: true, noVerify: true });
		expect(skipped).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("skipped the hook");

		await fs.rm(path.join(root, ".git", "hooks", "commit-msg"));
		const unhooked = await repo.commitCreate("no hook reads it\n", { allowEmpty: true });
		expect(unhooked).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("no hook reads it");

		// A disabled config hook (`hook.<id>.enabled=false`) does not run and
		// must not fail when COMMIT_EDITMSG cannot be written.
		await git(root, "config", "hook.disabled.event", "commit-msg");
		await git(root, "config", "hook.disabled.enabled", "false");
		const repoWithDisabled = vcsGitDiscover(root)!;
		const disabled = await repoWithDisabled.commitCreate("disabled hook does not read it\n", { allowEmpty: true });
		expect(disabled).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("disabled hook does not read it");

		await git(root, "config", "hook.active.event", "commit-msg");
		await git(root, "config", "hook.active.command", "true");
		const repoWithActive = vcsGitDiscover(root)!;
		await expect(repoWithActive.commitCreate("enabled hook reads it\n", { allowEmpty: true })).rejects.toThrow(
			/COMMIT_EDITMSG/,
		);
		expect(await git(root, "rev-parse", "HEAD")).toBe(disabled);
	});

	test("rejects a hooked commit when the lock file cannot be locked instead of writing unlocked", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		const shared = path.join(gitDir, "COMMIT_EDITMSG");
		const lockPath = path.join(gitDir, ".omp-commit-editmsg.lock");
		await Bun.write(shared, "untouched\n");
		await fs.mkdir(lockPath);
		await installHook(root, "#!/bin/sh\nexit 0\n");
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("must not bypass lock\n", { allowEmpty: true })).rejects.toThrow(
			/lock COMMIT_EDITMSG/,
		);
		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		expect(await Bun.file(shared).text()).toBe("untouched\n");

		// A pre-existing read-only lock file (e.g. owned by another user on a
		// local filesystem) still serializes via read-only fallback.
		await fs.rmdir(lockPath);
		await Bun.write(lockPath, "");
		await fs.chmod(lockPath, 0o444);
		try {
			const sha = await repo.commitCreate("readonly lock still works\n", { allowEmpty: true });
			expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
			expect(await git(root, "log", "-1", "--format=%B")).toBe("readonly lock still works");
		} finally {
			await fs.chmod(lockPath, 0o644);
		}
	});

	test("leaves no message file behind when noVerify skips the hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		const before = new Set(await fs.readdir(gitDir));
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("private message\n", { allowEmpty: true, noVerify: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("private message");
		const added = (await fs.readdir(gitDir)).filter(name => !before.has(name));
		expect(added).toEqual([]);
	});

	test("removes the message file when commit-msg rejects the commit", async () => {
		const root = await repository();
		await installHook(root, ["#!/bin/sh", 'printf \'%s\' "$1" > "$GIT_DIR/seen-msg-path"', "exit 1", ""].join("\n"));
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await Bun.write(shared, "preexisting\n");
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("will not land\n", { allowEmpty: true })).rejects.toThrow();

		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		const seen = (await Bun.file(path.join(root, ".git", "seen-msg-path")).text()).trim();
		expect(path.basename(seen)).not.toBe("COMMIT_EDITMSG");
		expect(await Bun.file(seen).exists()).toBe(false);
		// Hooks that ignore `$1` and read COMMIT_EDITMSG see this call's message.
		expect(await Bun.file(shared).text()).toBe("will not land\n");
	});
});
