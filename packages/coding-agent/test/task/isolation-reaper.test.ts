import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as natives from "@oh-my-pi/pi-natives";
import { clearWorktrees, reapDeadIsolationSandboxes } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import {
	inspectIsolationUniqueWork,
	ISOLATION_MATERIALIZED_FILE,
	ISOLATION_OWNER_FILE,
	writeMaterializationMarker,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import {
	cleanupIsolation,
	ensureIsolation,
	removeNestedLinkedWorktrees,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { cleanup as postmortemCleanup } from "@oh-my-pi/pi-utils/postmortem";
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
		await writeMaterializationMarker(sandboxDir);
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
		const clean = await ensureIsolation(parentRepo, "tpostmortem-clean");
		const dirty = await ensureIsolation(parentRepo, "tpostmortem-dirty");
		await fs.writeFile(path.join(dirty.mergedDir, "dirty.txt"), "unique work\n");

		expect(typeof clean.cancelCleanup).toBe("function");
		expect(typeof dirty.cancelCleanup).toBe("function");

		try {
			// Simulate postmortem cleanup run (keepAlive=true so test process keeps running)
			await postmortemCleanup();

			// Clean sandbox should have been reaped
			expect(
				await fs
					.stat(clean.mergedDir)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
			// Dirty sandbox should have been preserved
			expect(
				await fs
					.stat(dirty.mergedDir)
					.then(() => true)
					.catch(() => false),
			).toBe(true);
		} finally {
			clean.cancelCleanup?.();
			dirty.cancelCleanup?.();
			await cleanupIsolation(dirty).catch(() => {});
		}
	});

	it("preserves clean sandbox on postmortem termination when the backend fails to stop", async () => {
		const handle = await ensureIsolation(parentRepo, "tpostmortem-stuck");
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("umount busy"));

		try {
			await postmortemCleanup();
			expect(isoStopSpy).toHaveBeenCalledWith(handle.backend, handle.mergedDir);
			expect(
				await fs
					.stat(handle.mergedDir)
					.then(() => true)
					.catch(() => false),
			).toBe(true);
		} finally {
			isoStopSpy.mockRestore();
			handle.cancelCleanup?.();
			await cleanupIsolation(handle).catch(() => {});
		}
	});

	it("preserves dead sandbox with unique gitignored file", async () => {
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "*.env\nbuild/\n");
		await $`git -C ${parentRepo} add .gitignore`.quiet();
		await $`git -C ${parentRepo} commit -q -m "add gitignore"`.quiet();

		const { sandboxDir, mountDir } = await createSandbox("tignored-env", false);
		// Real filesystem delay: userspace cannot set ctime; advancing ctime past the marker requires advancing the OS clock.
		await Bun.sleep(10);
		await fs.writeFile(path.join(mountDir, "secret.env"), "SECRET_TOKEN=xyz\n");

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toContain("modified after materialization");

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

	it("preserves dead sandbox with unique file in gitignored directory", async () => {
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "build/\n");
		await $`git -C ${parentRepo} add .gitignore`.quiet();
		await $`git -C ${parentRepo} commit -q -m "add gitignore"`.quiet();

		const { sandboxDir, mountDir } = await createSandbox("tignored-dir", false);
		// Real filesystem delay: userspace cannot set ctime; advancing ctime past the marker requires advancing the OS clock.
		await Bun.sleep(10);
		await fs.mkdir(path.join(mountDir, "build"), { recursive: true });
		await fs.writeFile(path.join(mountDir, "build", "app.js"), "console.log(1);\n");

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toContain("modified after materialization");

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

	it("does not treat parent-copied gitignored files as unique work when contents match", async () => {
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "node_modules/\n");
		await fs.mkdir(path.join(parentRepo, "node_modules"), { recursive: true });
		await fs.writeFile(path.join(parentRepo, "node_modules", "dep.json"), '{"name":"dep"}\n');
		await $`git -C ${parentRepo} add .gitignore`.quiet();
		await $`git -C ${parentRepo} commit -q -m "add gitignore"`.quiet();

		const { sandboxDir, mountDir } = await createSandbox("tignored-clean", false);
		await fs.mkdir(path.join(mountDir, "node_modules"), { recursive: true });
		await fs.writeFile(path.join(mountDir, "node_modules", "dep.json"), '{"name":"dep"}\n');
		await writeMaterializationMarker(sandboxDir);

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

	it("reaps clean dead sandbox whose ignored directory holds well over 2000 entries", async () => {
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "node_modules/\n");
		await $`git -C ${parentRepo} add .gitignore`.quiet();
		await $`git -C ${parentRepo} commit -q -m "add gitignore"`.quiet();

		const { sandboxDir, mountDir } = await createSandbox("tignored-2500", false);
		const nmDir = path.join(mountDir, "node_modules");
		await fs.mkdir(nmDir, { recursive: true });
		// Create 2500 files inside node_modules
		const count = 2500;
		for (let i = 0; i < count; i++) {
			await fs.writeFile(path.join(nmDir, `pkg_${i}.json`), "{}");
		}
		// Reset the materialization marker to now, simulating that node_modules was populated
		// during materialization (e.g. CoW clone)
		await writeMaterializationMarker(sandboxDir);

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

	it("preserves dead sandbox when a deep ignored file is modified after materialization", async () => {
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "node_modules/\n");
		await $`git -C ${parentRepo} add .gitignore`.quiet();
		await $`git -C ${parentRepo} commit -q -m "add gitignore"`.quiet();

		const { sandboxDir, mountDir } = await createSandbox("tignored-mod", false);
		const deepDir = path.join(mountDir, "node_modules", "pkg", "deep");
		await fs.mkdir(deepDir, { recursive: true });
		await fs.writeFile(path.join(deepDir, "index.js"), "original\n");
		await writeMaterializationMarker(sandboxDir);

		// Real filesystem delay: userspace cannot set ctime; advancing ctime past the marker requires advancing the OS clock.
		await Bun.sleep(10);
		await fs.writeFile(path.join(deepDir, "index.js"), "modified by subagent\n");

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toContain("modified after materialization");

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

	it("preserves dead sandbox when materialization marker is missing and ignored entries exist", async () => {
		await fs.writeFile(path.join(parentRepo, ".gitignore"), "*.env\n");
		await fs.writeFile(path.join(parentRepo, "test.env"), "FOO=1\n");
		await $`git -C ${parentRepo} add .gitignore`.quiet();
		await $`git -C ${parentRepo} commit -q -m "add gitignore"`.quiet();

		const { sandboxDir, mountDir } = await createSandbox("tmissing-marker", false);
		await fs.writeFile(path.join(mountDir, "test.env"), "FOO=1\n");
		// Remove marker to simulate damaged or missing materialization marker
		await fs.rm(path.join(sandboxDir, ISOLATION_MATERIALIZED_FILE), { force: true });

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toBe("missing or unreadable materialization reference marker");

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

	it("records teardown backend for ordinary sandbox and stops mount before reaping", async () => {
		const { sandboxDir, mountDir } = await createSandbox("tordinary-teardown", false);
		await Bun.write(
			path.join(sandboxDir, ISOLATION_OWNER_FILE),
			JSON.stringify({
				pid: await deadPid(),
				id: "tordinary-teardown",
				parentRepo,
				backend: natives.IsoBackendKind.Overlayfs,
			}),
		);
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		try {
			const outcome = await reapDeadIsolationSandboxes();
			expect(outcome.reaped).toBe(1);
			expect(isoStopSpy).toHaveBeenCalledWith(natives.IsoBackendKind.Overlayfs, mountDir);
			expect(
				await fs
					.stat(sandboxDir)
					.then(() => true)
					.catch(() => false),
			).toBe(false);
		} finally {
			isoStopSpy.mockRestore();
		}
	});

	it("preserves ordinary sandbox when native teardown fails during reaping", async () => {
		const { sandboxDir, mountDir } = await createSandbox("tordinary-busy", false);
		await Bun.write(
			path.join(sandboxDir, ISOLATION_OWNER_FILE),
			JSON.stringify({
				pid: await deadPid(),
				id: "tordinary-busy",
				parentRepo,
				backend: natives.IsoBackendKind.Overlayfs,
			}),
		);
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("umount busy"));

		try {
			const outcome = await reapDeadIsolationSandboxes();
			expect(outcome.reaped).toBe(0);
			expect(isoStopSpy).toHaveBeenCalledWith(natives.IsoBackendKind.Overlayfs, mountDir);
			expect(
				await fs
					.stat(sandboxDir)
					.then(() => true)
					.catch(() => false),
			).toBe(true);
		} finally {
			isoStopSpy.mockRestore();
		}
	});

	it("preserves dead sandbox when sandbox git metadata (.git) is missing or unreadable", async () => {
		const { sandboxDir, mountDir } = await createSandbox("tcorrupt-git", false);
		await fs.rm(path.join(mountDir, ".git"), { recursive: true, force: true });

		const check = await inspectIsolationUniqueWork(sandboxDir);
		expect(check.hasUniqueWork).toBe(true);
		expect(check.reason).toBe("sandbox git repository missing or unreadable");

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

	it("filesDiffer accurately compares files exceeding chunk size without full file reads", async () => {
		const { sandboxDir, mountDir } = await createSandbox("tlarge-chunks", false);
		// 130KB file (exceeds 64KB COMPARISON_CHUNK_SIZE)
		const chunkSize = 64 * 1024;
		const largeBufA = Buffer.alloc(chunkSize * 2 + 1024, 0x61); // all 'a'
		const largeBufB = Buffer.from(largeBufA);
		// Mutate a byte in the second chunk (offset 70,000)
		largeBufB[chunkSize + 5000] = 0x62; // 'b'

		await fs.writeFile(path.join(parentRepo, "large.bin"), largeBufA);
		await fs.writeFile(path.join(mountDir, "large.bin"), largeBufB);

		const checkDiffer = await inspectIsolationUniqueWork(sandboxDir);
		expect(checkDiffer.hasUniqueWork).toBe(true);
		expect(checkDiffer.reason).toContain("file large.bin differs from parent checkout");

		// When files match completely across chunks
		await fs.writeFile(path.join(mountDir, "large.bin"), largeBufA);
		const checkMatch = await inspectIsolationUniqueWork(sandboxDir);
		expect(checkMatch.hasUniqueWork).toBe(false);
	});
});
