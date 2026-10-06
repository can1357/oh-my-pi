import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { clearWorktrees, reapDeadIsolationSandboxes } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { inspectIsolationUniqueWork, ISOLATION_OWNER_FILE } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { removeNestedLinkedWorktrees } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

describe("task-isolation sandbox reaper and protection", () => {
	let wtBase: string;
	let parentRepo: string;
	let tempDirs: string[] = [];

	beforeEach(async () => {
		wtBase = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-reap-"));
		parentRepo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parent-"));
		tempDirs.push(wtBase, parentRepo);
		setWorktreesDir(wtBase);

		// Init parent git repo with an initial commit
		await $`git -C ${parentRepo} init -q`.quiet();
		await $`git -C ${parentRepo} config user.email test@example.com`.quiet();
		await $`git -C ${parentRepo} config user.name "Test User"`.quiet();
		await $`git -C ${parentRepo} config commit.gpgsign false`.quiet();
		await fs.writeFile(path.join(parentRepo, "root.txt"), "root content\n");
		await $`git -C ${parentRepo} add root.txt`.quiet();
		await $`git -C ${parentRepo} commit -q -m "initial commit"`.quiet();
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		for (const dir of tempDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
		tempDirs = [];
	});

	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	async function createSandbox(name: string, isLive: boolean): Promise<{ sandboxDir: string; mountDir: string }> {
		const sandboxDir = path.join(wtBase, name);
		const mountDir = path.join(sandboxDir, "m");
		await fs.mkdir(sandboxDir, { recursive: true });
		await $`git clone -q ${parentRepo} ${mountDir}`.quiet();
		await $`git -C ${mountDir} config user.email test@example.com`.quiet();
		await $`git -C ${mountDir} config user.name "Test User"`.quiet();
		await $`git -C ${mountDir} config commit.gpgsign false`.quiet();

		const pid = isLive ? process.pid : await deadPid();
		const owner = {
			pid,
			id: name,
			parentRepo,
		};
		await fs.writeFile(path.join(sandboxDir, ISOLATION_OWNER_FILE), JSON.stringify(owner));
		return { sandboxDir, mountDir };
	}

	it("reaps clean dead sandbox automatically", async () => {
		const { sandboxDir } = await createSandbox("tclean01", false);
		expect(
			await fs
				.stat(sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(false);

		const outcome = await reapDeadIsolationSandboxes();
		expect(outcome.reaped).toBe(1);
		expect(
			await fs
				.stat(sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	it("preserves dead sandbox with modified file differing from parent checkout", async () => {
		const { sandboxDir, mountDir } = await createSandbox("tdirty02", false);
		await fs.writeFile(path.join(mountDir, "dirty.txt"), "subagent unique work\n");

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toContain("differs from parent checkout");

		const outcome = await reapDeadIsolationSandboxes();
		expect(outcome.kept).toBe(1);
		expect(outcome.reaped).toBe(0);
		expect(
			await fs
				.stat(sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);
	});

	it("preserves dead sandbox with unique commit not in parent repo", async () => {
		const { sandboxDir, mountDir } = await createSandbox("tcommit03", false);
		await fs.writeFile(path.join(mountDir, "feature.txt"), "feature code\n");
		await $`git -C ${mountDir} add feature.txt`.quiet();
		await $`git -C ${mountDir} commit -q -m "agent commit"`.quiet();

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toContain("unique commit");

		const outcome = await reapDeadIsolationSandboxes();
		expect(outcome.kept).toBe(1);
		expect(outcome.reaped).toBe(0);
		expect(
			await fs
				.stat(sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);
	});

	it("does not treat pre-existing parent dirty files as unique work when contents match", async () => {
		// Make parent dirty before sandbox creation
		await fs.writeFile(path.join(parentRepo, "parent-dirty.txt"), "pre-existing WIP\n");
		const { sandboxDir, mountDir } = await createSandbox("tcleanwip04", false);
		// Sandbox was cloned from parent with same file
		await fs.writeFile(path.join(mountDir, "parent-dirty.txt"), "pre-existing WIP\n");

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(false);

		const outcome = await reapDeadIsolationSandboxes();
		expect(outcome.reaped).toBe(1);
		expect(
			await fs
				.stat(sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	it("keeps live-owned sandbox intact", async () => {
		const { sandboxDir } = await createSandbox("tlive05", true);

		const outcome = await reapDeadIsolationSandboxes();
		expect(outcome.reaped).toBe(0);
		expect(outcome.kept).toBe(0);
		expect(
			await fs
				.stat(sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);
	});

	it("clearWorktrees honours protection by default and deletes with force", async () => {
		const clean = await createSandbox("tclean06", false);
		const dirty = await createSandbox("tdirty07", false);
		await fs.writeFile(path.join(dirty.mountDir, "unique.txt"), "do not delete me\n");

		// Clear without force
		const res1 = await clearWorktrees({ all: false, dryRun: false, json: true, force: false });
		expect(res1.removed).toBe(1); // clean removed
		expect(res1.failed).toBe(0);

		expect(
			await fs
				.stat(clean.sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(false);
		expect(
			await fs
				.stat(dirty.sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);

		// Clear with force
		const res2 = await clearWorktrees({ all: false, dryRun: false, json: true, force: true });
		expect(res2.removed).toBe(1); // dirty removed
		expect(res2.failed).toBe(0);
		expect(
			await fs
				.stat(dirty.sandboxDir)
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	it("removes nested linked worktrees from cloned mount without touching parent", async () => {
		// Create nested linked worktree inside parent repo
		const nestedParentDir = path.join(parentRepo, ".worktrees", "nested-wt");
		await $`git -C ${parentRepo} worktree add -q ${nestedParentDir} -b nested-branch HEAD`.quiet();
		expect(
			await fs
				.stat(nestedParentDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);
		await fs.writeFile(path.join(nestedParentDir, "nested-file.txt"), "nested content\n");

		// Simulate clone into sandbox mountDir
		const sandboxDir = path.join(wtBase, "tnested08");
		const mountDir = path.join(sandboxDir, "m");
		await fs.mkdir(sandboxDir, { recursive: true });
		await $`git clone -q ${parentRepo} ${mountDir}`.quiet();

		// Nested directory exists in clone
		const clonedNestedDir = path.join(mountDir, ".worktrees", "nested-wt");
		await fs.mkdir(clonedNestedDir, { recursive: true });
		await fs.writeFile(path.join(clonedNestedDir, "nested-file.txt"), "nested content\n");

		// Call removeNestedLinkedWorktrees
		const removed = await removeNestedLinkedWorktrees(parentRepo, mountDir);
		expect(removed).toContain(path.normalize(".worktrees/nested-wt"));

		// Verify cloned nested directory is absent from mountDir
		expect(
			await fs
				.stat(clonedNestedDir)
				.then(() => true)
				.catch(() => false),
		).toBe(false);

		// Verify parent repository nested worktree is untouched
		expect(
			await fs
				.stat(nestedParentDir)
				.then(() => true)
				.catch(() => false),
		).toBe(true);
		expect(await Bun.file(path.join(nestedParentDir, "nested-file.txt")).text()).toBe("nested content\n");
	});

	it("cleans up clean sandbox on postmortem termination and preserves unique work", async () => {
		const { register, cleanup } = await import("@oh-my-pi/pi-utils/postmortem");
		const clean = await createSandbox("tpostmortem-clean", true);
		const dirty = await createSandbox("tpostmortem-dirty", true);
		await fs.writeFile(path.join(dirty.mountDir, "dirty.txt"), "unique work\n");

		// Register both sandboxes as ensureIsolation does
		const cancelClean = register(`task-isolation:${clean.sandboxDir}`, async () => {
			const stat = await fs.stat(clean.sandboxDir).catch(() => null);
			if (!stat?.isDirectory()) return;
			const check = await inspectIsolationUniqueWork(clean.sandboxDir);
			if (!check.hasUniqueWork) {
				await fs.rm(clean.sandboxDir, { recursive: true, force: true });
			}
		});

		const cancelDirty = register(`task-isolation:${dirty.sandboxDir}`, async () => {
			const stat = await fs.stat(dirty.sandboxDir).catch(() => null);
			if (!stat?.isDirectory()) return;
			const check = await inspectIsolationUniqueWork(dirty.sandboxDir);
			if (!check.hasUniqueWork) {
				await fs.rm(dirty.sandboxDir, { recursive: true, force: true });
			}
		});

		try {
			// Simulate postmortem cleanup run (keepAlive=true so test process keeps running)
			await cleanup();

			// Clean sandbox should have been reaped
			expect(
				await fs
					.stat(clean.sandboxDir)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
			// Dirty sandbox should have been preserved
			expect(
				await fs
					.stat(dirty.sandboxDir)
					.then(() => true)
					.catch(() => false),
			).toBe(true);
		} finally {
			cancelClean();
			cancelDirty();
		}
	});
});
