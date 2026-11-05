import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { clearWorktrees, listWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import {
	ISOLATION_OWNER_FILE,
	RETAINED_BACKEND_FILE,
	writeIsolationOwner,
	writeRetainedBackend,
} from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for #6761: `omp worktree clear` (no `--all`) must delete only
 * task-isolation sandboxes whose owner process is gone. A sandbox owned by a
 * live omp process holds a running subagent's uncaptured work and must survive.
 */
describe("worktree clear task-isolation ownership", () => {
	let base: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(base, { recursive: true, force: true });
	});

	async function makeSandbox(name: string): Promise<string> {
		const dir = path.join(base, name);
		await fs.mkdir(path.join(dir, "m"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "uncaptured\n");
		return dir;
	}

	/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	it("keeps live-owned sandboxes and reclaims dead/markerless/corrupt ones", async () => {
		const live = await makeSandbox("tlive0001");
		await writeIsolationOwner(live, "live0001"); // marker names this test process

		const dead = await makeSandbox("tdead0002");
		await Bun.write(path.join(dead, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "dead0002" }));

		const orphan = await makeSandbox("tnone0003"); // no marker at all (crashed pre-marker run)

		const corrupt = await makeSandbox("tbad00004");
		await Bun.write(path.join(corrupt, ISOLATION_OWNER_FILE), "{ not json");

		// Setup race: marker written before the backend materialises `m`. The
		// dir holds only the live-owner marker and no mount yet.
		const pending = path.join(base, "tpend0005");
		await fs.mkdir(pending, { recursive: true });
		await writeIsolationOwner(pending, "pend0005");

		// Recycled pid: the crashed owner's pid was reassigned to this live test
		// process, but the recorded start-time token no longer matches.
		const recycled = await makeSandbox("trecyc06");
		await Bun.write(
			path.join(recycled, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: process.pid, id: "recyc06", startToken: "not-the-current-token" }),
		);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		const exists = async (p: string): Promise<boolean> =>
			await fs.stat(p).then(
				() => true,
				() => false,
			);
		expect(await Bun.file(path.join(live, "m", "work.txt")).exists()).toBe(true);
		expect(await exists(dead)).toBe(false);
		expect(await exists(orphan)).toBe(false);
		expect(await exists(corrupt)).toBe(false);
		expect(await exists(pending)).toBe(true);
		// Windows reports neither /proc start times nor `ps`, so pid-only liveness
		// cannot spot the recycled pid and the sandbox is conservatively kept.
		expect(await exists(recycled)).toBe(process.platform === "win32");
	});

	it("unmounts retained mounting-backend workspaces before removal", async () => {
		const retained = await makeSandbox("tret0007");
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "ret0007" }),
		);
		await writeRetainedBackend(retained, natives.IsoBackendKind.Overlayfs);
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStopSpy).toHaveBeenCalledWith(natives.IsoBackendKind.Overlayfs, path.join(retained, "m"));
		await expect(fs.stat(retained)).rejects.toThrow();
	});

	it("removes sandboxes without a retained-mount sidecar without unmounting", async () => {
		const plain = await makeSandbox("tplain08");
		await Bun.write(path.join(plain, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "plain08" }));
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStopSpy).not.toHaveBeenCalled();
		await expect(fs.stat(plain)).rejects.toThrow();
	});

	it("keeps the workspace when its retained mount cannot stop", async () => {
		const retained = await makeSandbox("tbusy0009");
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "busy0009" }),
		);
		await writeRetainedBackend(retained, natives.IsoBackendKind.Overlayfs);
		vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("umount EBUSY"));

		const { failed } = await clearWorktrees({ all: false, dryRun: false, json: true });
		expect(failed).toBe(1);

		expect(await Bun.file(path.join(retained, "m", "work.txt")).exists()).toBe(true);
	});

	it("keeps workspaces whose retained-mount metadata is unreadable", async () => {
		const retained = await makeSandbox("tbad0010");
		await Bun.write(
			path.join(retained, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: await deadPid(), id: "bad0010" }),
		);
		await Bun.write(path.join(retained, RETAINED_BACKEND_FILE), "{ not json");
		const isoStopSpy = vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		expect(isoStopSpy).not.toHaveBeenCalled();
		expect(await Bun.file(path.join(retained, "m", "work.txt")).exists()).toBe(true);
	});
});

describe("worktree clear linked checkout metadata", () => {
	let root: string;
	let base: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-linked-")));
		base = path.join(root, "managed");
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function makeRelativeCheckout(repo: string, checkout: string): Promise<string> {
		await fs.mkdir(checkout, { recursive: true });
		const gitdir = path.join(repo, ".git", "worktrees", path.basename(checkout));
		const pointer = path.relative(checkout, gitdir).split(path.sep).join("/");
		await Bun.write(path.join(gitdir, "HEAD"), "ref: refs/heads/topic\n");
		await Bun.write(path.join(gitdir, "commondir"), "../..\n");
		await Bun.write(path.join(gitdir, "gitdir"), `${path.relative(gitdir, path.join(checkout, ".git"))}\n`);
		await Bun.write(path.join(checkout, ".git"), `gitdir: ${pointer}\n`);
		await Bun.write(path.join(checkout, "work.txt"), "uncommitted work\n");
		return gitdir;
	}

	it.each(["absolute", "relative"] as const)(
		"lists %s gitdir checkouts as live and keeps their contents during clear",
		async pointerKind => {
			const repo = path.join(root, "repo");
			const checkout = path.join(base, "linked");
			const gitEntry = path.join(checkout, ".git");
			const gitdir = path.join(repo, ".git", "worktrees", "linked");
			const pointer = pointerKind === "relative" ? path.relative(checkout, gitdir) : gitdir;
			await Bun.write(gitEntry, `gitdir: ${pointer}\n`);
			await Bun.write(path.join(gitdir, "HEAD"), "ref: refs/heads/topic\n");
			await Bun.write(path.join(gitdir, "commondir"), "../..\n");
			await Bun.write(path.join(gitdir, "gitdir"), `${path.relative(gitdir, gitEntry)}\n`);
			await Bun.write(path.join(checkout, "work.txt"), "uncommitted work\n");
			const log = vi.spyOn(console, "log").mockImplementation(() => {});

			await listWorktrees({ json: true });

			expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual([
				{ path: checkout, kind: "pr-checkout", parentRepo: repo, branch: "topic" },
			]);

			await clearWorktrees({ all: false, dryRun: true, json: true });

			expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual({ removed: 0, kept: 1 });

			expect(await clearWorktrees({ all: false, dryRun: false, json: true })).toEqual({ removed: 0, failed: 0 });
			expect(await Bun.file(path.join(checkout, "work.txt")).text()).toBe("uncommitted work\n");
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps a relative linked checkout under a symlinked worktree base",
		async () => {
			const realBase = path.join(root, "real", "managed");
			const checkout = path.join(realBase, "linked");
			const repo = path.join(root, "real", "repo");
			await makeRelativeCheckout(repo, checkout);
			const alias = path.join(root, "alias");
			await fs.symlink(realBase, alias, "dir");
			setWorktreesDir(alias);
			const log = vi.spyOn(console, "log").mockImplementation(() => {});

			await listWorktrees({ json: true });

			expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual([
				{
					path: path.join(alias, "linked"),
					kind: "pr-checkout",
					parentRepo: await fs.realpath(repo),
					branch: "topic",
				},
			]);

			expect(await clearWorktrees({ all: false, dryRun: false, json: true })).toEqual({ removed: 0, failed: 0 });
			expect(await Bun.file(path.join(checkout, "work.txt")).text()).toBe("uncommitted work\n");
		},
	);

	// Windows reports ENOENT, not ENOTDIR, for traversal through a regular file.
	it.skipIf(process.platform === "win32")(
		"preserves an ENOTDIR checkout while listing a valid sibling and clearing an orphan",
		async () => {
			const invalid = path.join(base, "invalid");
			const blocker = path.join(root, "not-a-directory");
			await Bun.write(blocker, "unrelated source data\n");
			await Bun.write(path.join(invalid, ".git"), `gitdir: ${path.relative(invalid, blocker)}/worktrees/broken\n`);
			await Bun.write(path.join(invalid, "work.txt"), "inaccessible work\n");
			const repo = path.join(root, "repo");
			const checkout = path.join(base, "valid");
			await makeRelativeCheckout(repo, checkout);
			const orphan = path.join(base, "orphan");
			await fs.mkdir(orphan);
			const log = vi.spyOn(console, "log").mockImplementation(() => {});

			await listWorktrees({ json: true });

			expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual(
				expect.arrayContaining([
					{ path: invalid, kind: "pr-checkout", scanError: expect.stringContaining("ENOTDIR") },
					{ path: checkout, kind: "pr-checkout", parentRepo: repo, branch: "topic" },
				]),
			);
			await listWorktrees({ json: false });
			expect(log.mock.calls.map(call => String(call[0])).join("\n")).toContain("1 unknown");

			await clearWorktrees({ all: false, dryRun: true, json: true });

			expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual({
				wouldRemove: [orphan],
				skipped: [{ path: invalid, error: expect.stringContaining("ENOTDIR") }],
				failed: 1,
			});
			expect(await clearWorktrees({ all: false, dryRun: false, json: true })).toEqual({ removed: 1, failed: 1 });
			expect(await Bun.file(path.join(invalid, "work.txt")).text()).toBe("inaccessible work\n");
			expect(await Bun.file(path.join(checkout, "work.txt")).text()).toBe("uncommitted work\n");
			expect(await Bun.file(blocker).text()).toBe("unrelated source data\n");
			await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it.skipIf(process.platform === "win32")("preserves cyclic gitdir targets even during clear --all", async () => {
		const checkout = path.join(base, "cyclic");
		const target = path.join(root, "cycle");
		await fs.symlink(target, target, "dir");
		await Bun.write(path.join(checkout, ".git"), `gitdir: ${path.relative(checkout, target)}\n`);
		await Bun.write(path.join(checkout, "work.txt"), "inaccessible work\n");
		const orphan = path.join(base, "orphan");
		await fs.mkdir(orphan);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listWorktrees({ json: true });

		expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual(
			expect.arrayContaining([{ path: checkout, kind: "pr-checkout", scanError: expect.stringContaining("ELOOP") }]),
		);
		expect(await clearWorktrees({ all: true, dryRun: false, json: true })).toEqual({ removed: 1, failed: 1 });
		expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
			skipped: [{ path: checkout, error: expect.stringContaining("ELOOP") }],
		});
		expect(await Bun.file(path.join(checkout, "work.txt")).text()).toBe("inaccessible work\n");
		expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
		await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.skipIf(process.platform === "win32")("keeps legacy containers with unreadable checkout metadata", async () => {
		const checkout = path.join(base, "project", "linked");
		const gitEntry = path.join(checkout, ".git");
		await Bun.write(path.join(checkout, "work.txt"), "inaccessible work\n");
		await fs.symlink(gitEntry, gitEntry, "file");
		const orphan = path.join(base, "orphan");
		await fs.mkdir(orphan);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listWorktrees({ json: true });

		expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual(
			expect.arrayContaining([{ path: checkout, kind: "unknown", scanError: expect.stringContaining("ELOOP") }]),
		);
		expect(await clearWorktrees({ all: false, dryRun: false, json: true })).toEqual({ removed: 1, failed: 1 });
		expect(await Bun.file(path.join(checkout, "work.txt")).text()).toBe("inaccessible work\n");
		await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["gitfile", "target", "registration"] as const)(
		"keeps a checkout with inaccessible %s metadata and continues clearing other entries",
		async inaccessible => {
			const repo = path.join(root, "repo");
			const checkout = path.join(base, "linked");
			const gitdir = await makeRelativeCheckout(repo, checkout);
			const orphan = path.join(base, "orphan");
			await fs.mkdir(orphan);
			const denied = Object.assign(new Error("EACCES: permission denied reading worktree metadata"), {
				code: "EACCES",
			});
			// Inject permission errors so the contract is exercised even as root or
			// on Windows, where chmod cannot reliably make these paths inaccessible.
			if (inaccessible === "gitfile") {
				const readFile = fs.readFile;
				vi.spyOn(fs, "readFile").mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
					if (String(args[0]) === path.join(checkout, ".git")) throw denied;
					return readFile(...args);
				}) as typeof fs.readFile);
			} else if (inaccessible === "target") {
				const realpath = fs.realpath;
				vi.spyOn(fs, "realpath").mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
					if (path.resolve(String(args[0])) === gitdir) throw denied;
					return realpath(...args);
				}) as typeof fs.realpath);
			} else {
				const stat = fs.stat;
				vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
					if (String(args[0]) === gitdir) throw denied;
					return stat(...args);
				}) as typeof fs.stat);
			}
			const log = vi.spyOn(console, "log").mockImplementation(() => {});

			await listWorktrees({ json: true });

			expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual(
				expect.arrayContaining([
					{ path: checkout, kind: "pr-checkout", scanError: expect.stringContaining("EACCES") },
				]),
			);
			expect(await clearWorktrees({ all: false, dryRun: false, json: false })).toEqual({ removed: 1, failed: 1 });
			expect(log.mock.calls.map(call => String(call[0])).join("\n")).toContain("cannot inspect worktree");
			expect(await Bun.file(path.join(checkout, "work.txt")).text()).toBe("uncommitted work\n");
			await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("still selects malformed and missing relative gitdir links as orphaned", async () => {
		const malformed = path.join(base, "malformed");
		await Bun.write(path.join(malformed, ".git"), "not a gitdir pointer\n");
		const missing = path.join(base, "missing");
		const repo = path.join(root, "repo");
		const gitdir = path.join(repo, ".git", "worktrees", "missing");
		await fs.mkdir(repo);
		await Bun.write(path.join(missing, ".git"), `gitdir: ${path.relative(missing, gitdir)}\n`);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await listWorktrees({ json: true });

		expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual(
			expect.arrayContaining([
				{ path: malformed, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" },
				{
					path: missing,
					kind: "pr-checkout",
					parentRepo: repo,
					orphanReason: "parent repo no longer tracks this worktree",
				},
			]),
		);

		await clearWorktrees({ all: false, dryRun: true, json: true });

		expect(JSON.parse(String(log.mock.lastCall?.[0]))).toEqual({
			wouldRemove: expect.arrayContaining([malformed, missing]),
		});
	});
});
