/**
 * A failed ovnfs checkout removal must not erase the record `omp worktree clear`
 * needs. Reusing the slot moves that record aside; a lost creation reply keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import * as client from "../../src/ovnfs/client";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import * as daemon from "../../src/ovnfs/daemon";
import { ISOLATION_OWNER_FILE } from "../../src/task/isolation-ownership";
import * as isolationRunner from "../../src/task/isolation-runner";
import { OVNFS_CHECKOUT_FILE, ovnfsWorkspace, releaseOvnfsCheckout } from "../../src/task/ovnfs";
import * as executorModule from "../../src/task/executor";
import * as worktreeModule from "../../src/task/worktree";
import { taskIsolationBaseDir } from "../../src/task/worktree";

const COMMAND = "/opt/ovnfs/ovnfs";
const STALE = "omp-authrefactor-stale1";

interface CheckoutRecord {
	command: string;
	checkout: string;
	start?: string;
}

interface DaemonOp {
	op: string;
	checkout?: string;
	name?: string;
	base?: string;
}

describe("ovnfs checkout recovery", () => {
	let root: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ovnfs-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(path.join(root, "wt"));
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	function mockDaemon(handle: (op: DaemonOp) => unknown): void {
		vi.spyOn(daemon, "startDaemon").mockResolvedValue({ socket: "/tmp/ovnfs-test.sock" });
		vi.spyOn(client, "callSocket").mockImplementation(
			async <T>(_socket: string, op: string, args: object): Promise<T> => {
				const record = args as { checkout?: unknown; name?: unknown; base?: unknown };
				return handle({
					op,
					checkout: typeof record.checkout === "string" ? record.checkout : undefined,
					name: typeof record.name === "string" ? record.name : undefined,
					base: typeof record.base === "string" ? record.base : undefined,
				}) as T;
			},
		);
	}

	async function plant(repo: string, agentId: string, checkout: string, pid: number): Promise<string> {
		const baseDir = taskIsolationBaseDir(repo, agentId);
		await fs.mkdir(baseDir, { recursive: true });
		await Bun.write(path.join(baseDir, OVNFS_CHECKOUT_FILE), JSON.stringify({ command: COMMAND, checkout }));
		await Bun.write(path.join(baseDir, ISOLATION_OWNER_FILE), JSON.stringify({ pid, id: agentId }));
		return baseDir;
	}

	async function retainedDirs(baseDir: string): Promise<string[]> {
		const prefix = `${path.basename(baseDir)}.retained-`;
		const names = await fs.readdir(path.dirname(baseDir));
		return names.filter(name => name.startsWith(prefix)).map(name => path.join(path.dirname(baseDir), name));
	}

	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	async function readRecord(dir: string): Promise<CheckoutRecord> {
		return (await Bun.file(path.join(dir, OVNFS_CHECKOUT_FILE)).json()) as CheckoutRecord;
	}

	it("reuses a slot after checkout removal fails without dropping the old record", async () => {
		const removed: string[] = [];
		let failRemoval = true;
		mockDaemon(op => {
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				if (failRemoval) throw new client.OvnfsError("busy", "checkout is busy");
				return {};
			}
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/ovnfs/${op.name}` } };
			throw new Error(op.op);
		});
		const repo = path.join(root, "reuse");
		await fs.mkdir(repo);
		const agentId = "AuthRefactor";
		const baseDir = await plant(repo, agentId, STALE, await deadPid());
		const owner = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).text();

		const workspace = await ovnfsWorkspace(COMMAND)(repo, agentId);

		const current = await readRecord(baseDir);
		expect(current).toEqual({ command: COMMAND, checkout: expect.stringMatching(/^omp-authrefactor-[0-9a-f]{6}$/) });
		expect(workspace.dir).toBe(`/mnt/ovnfs/${current.checkout}`);
		const [sibling] = await retainedDirs(baseDir);
		expect(sibling).toBeString();
		expect(await readRecord(sibling)).toEqual({ command: COMMAND, checkout: STALE });
		expect(await Bun.file(path.join(sibling, ISOLATION_OWNER_FILE)).text()).toBe(owner);

		failRemoval = false;
		const beforeClear = removed.length;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const cleared = await clearWorktrees({ all: false, dryRun: false, json: true });
		expect(cleared).toEqual({ removed: 1, failed: 0 });
		expect(removed.slice(beforeClear)).toEqual([STALE]);
		await expect(fs.stat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readRecord(baseDir)).toEqual(current);
	});

	it("replaces a slot once its previous checkout is removed", async () => {
		const removed: string[] = [];
		mockDaemon(op => {
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				return {};
			}
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/ovnfs/${op.name}` } };
			throw new Error(op.op);
		});
		const repo = path.join(root, "removed");
		await fs.mkdir(repo);
		const baseDir = await plant(repo, "Removed", STALE, await deadPid());

		const workspace = await ovnfsWorkspace(COMMAND)(repo, "Removed");

		expect(removed).toEqual([STALE]);
		expect(await retainedDirs(baseDir)).toEqual([]);
		const record = await readRecord(baseDir);
		expect(record.command).toBe(COMMAND);
		expect(record.checkout).not.toBe(STALE);
		expect(workspace.dir).toBe(`/mnt/ovnfs/${record.checkout}`);
	});

	it("keeps the checkout record when it cannot be moved out of the slot", async () => {
		const ops: string[] = [];
		mockDaemon(op => {
			ops.push(op.op);
			if (op.op === "rm") throw new client.OvnfsError("busy", "checkout is busy");
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/ovnfs/${op.name}` } };
			throw new Error(op.op);
		});
		vi.spyOn(isolationRunner, "vacateIsolationSlot").mockResolvedValue(undefined);
		const repo = path.join(root, "stuck");
		await fs.mkdir(repo);
		const baseDir = await plant(repo, "Stuck", STALE, await deadPid());
		const owner = await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).text();

		await expect(ovnfsWorkspace(COMMAND)(repo, "Stuck")).rejects.toThrow(/previous checkout/);

		expect(await readRecord(baseDir)).toEqual({ command: COMMAND, checkout: STALE });
		expect(await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).text()).toBe(owner);
		expect(ops).not.toContain("new");
		expect(await retainedDirs(baseDir)).toEqual([]);
	});

	it("keeps the checkout record when creation fails after the request may have reached the daemon", async () => {
		const removed: string[] = [];
		let requested = "";
		mockDaemon(op => {
			if (op.op === "new") {
				requested = op.name ?? "";
				throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "lost");
		await fs.mkdir(repo);
		const agentId = "LostReply";

		await expect(ovnfsWorkspace(COMMAND)(repo, agentId)).rejects.toThrow(/socket hang up/);

		const baseDir = taskIsolationBaseDir(repo, agentId);
		const record = await readRecord(baseDir);
		expect(requested).toMatch(/^omp-lostreply-[0-9a-f]{6}$/);
		expect(record).toEqual({ command: COMMAND, checkout: requested });
		expect(await Bun.file(path.join(baseDir, ISOLATION_OWNER_FILE)).exists()).toBe(true);
		expect(removed).toContain(requested);
		await expect(releaseOvnfsCheckout(baseDir)).rejects.toThrow(/connection refused/);
		expect(await readRecord(baseDir)).toEqual(record);
	});

	it("deletes the checkout record when creation fails and removal is confirmed", async () => {
		const removed: string[] = [];
		let requested = "";
		mockDaemon(op => {
			if (op.op === "new") {
				requested = op.name ?? "";
				throw new client.OvnfsError("invalid", "rejected");
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				throw new client.OvnfsError("not_found", "missing");
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "confirmed");
		await fs.mkdir(repo);
		const baseDir = taskIsolationBaseDir(repo, "Confirmed");

		await expect(ovnfsWorkspace(COMMAND)(repo, "Confirmed")).rejects.toThrow(/ovnfs: invalid: rejected/);

		expect(requested).toMatch(/^omp-confirmed-[0-9a-f]{6}$/);
		expect(removed).toEqual([requested]);
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the older checkout when creation is refused because its name already exists", async () => {
		const removed: string[] = [];
		let requested = "";
		mockDaemon(op => {
			if (op.op === "new") {
				requested = op.name ?? "";
				throw new client.OvnfsError("exists", "already exists");
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				return {};
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "collision");
		await fs.mkdir(repo);
		const baseDir = taskIsolationBaseDir(repo, "Collision");

		await expect(ovnfsWorkspace(COMMAND)(repo, "Collision")).rejects.toThrow(/ovnfs: exists: already exists/);

		expect(requested).toMatch(/^omp-collision-[0-9a-f]{6}$/);
		expect(removed).toEqual([]);
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes a new slot when the daemon cannot start", async () => {
		vi.spyOn(daemon, "startDaemon").mockRejectedValue(new Error("cannot run /opt/ovnfs/ovnfs"));
		const repo = path.join(root, "no-daemon");
		await fs.mkdir(repo);
		const baseDir = taskIsolationBaseDir(repo, "NoDaemon");

		await expect(ovnfsWorkspace(COMMAND)(repo, "NoDaemon")).rejects.toThrow(/cannot run \/opt\/ovnfs\/ovnfs/);

		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps the checkout record when closing a workspace cannot remove its checkout", async () => {
		let failRemoval = false;
		const removed: string[] = [];
		mockDaemon(op => {
			if (op.op === "new" && op.name) return { checkout: { name: op.name, path: `/mnt/ovnfs/${op.name}` } };
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				if (failRemoval) throw new client.OvnfsError("busy", "checkout is busy");
				return {};
			}
			throw new Error(op.op);
		});
		const repo = path.join(root, "cleanup");
		await fs.mkdir(repo);
		const agentId = "Cleanup";
		const workspace = await ovnfsWorkspace(COMMAND)(repo, agentId);
		const baseDir = taskIsolationBaseDir(repo, agentId);
		const record = await readRecord(baseDir);

		failRemoval = true;
		await workspace.cleanup();

		expect(removed).toContain(record.checkout);
		expect(await readRecord(baseDir)).toEqual(record);
		expect(workspace.dir).toBe(`/mnt/ovnfs/${record.checkout}`);

		failRemoval = false;
		await workspace.cleanup();
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	/** A daemon that captured `repo` as one repository on capture `b_1`, serving `features`. */
	function captureDaemon(repo: string, features: string[], handle: (op: DaemonOp) => unknown): void {
		vi.spyOn(client, "socketFeatures").mockResolvedValue(new Set(features));
		mockDaemon(op => {
			if (op.op === "new" && op.name && !op.base) {
				return {
					checkout: { name: op.name, path: `/mnt/ovnfs/${op.name}`, base: "b_1" },
					capture: { root: repo, repos: [""] },
				};
			}
			return handle(op);
		});
	}

	it("starts from the checkout's capture only when the daemon can diff and reopen it", async () => {
		const repo = path.join(root, "features");
		await fs.mkdir(repo);
		captureDaemon(repo, ["diff.binary"], () => ({}));
		expect((await ovnfsWorkspace(COMMAND)(repo, "Old")).start).toBeUndefined();

		vi.restoreAllMocks();
		captureDaemon(repo, ["new.base", "diff.binary"], op => {
			if (op.op === "diff") throw new client.OvnfsError("unsupported", "a.big goes through a filter");
			return {};
		});
		const workspace = await ovnfsWorkspace(COMMAND)(repo, "New");
		expect(workspace.start).toBeDefined();
		// ovnfs leaves a filtered path to git: the runner then diffs against the baseline.
		expect(await workspace.start?.rootPatch()).toBeUndefined();
	});

	it("records the start checkout a branch baseline opens until it is removed", async () => {
		const repo = path.join(root, "start");
		await fs.mkdir(repo);
		const removed: string[] = [];
		const opened: DaemonOp[] = [];
		let failRemoval = false;
		captureDaemon(repo, ["new.base", "diff.binary"], op => {
			if (op.op === "new") {
				opened.push(op);
				return { checkout: { name: op.name, path: path.join(root, "missing", op.name ?? ""), base: op.base } };
			}
			if (op.op === "rm") {
				removed.push(op.checkout ?? "");
				// Only the removal after the baseline read fails; clearing a leftover first succeeds.
				if (failRemoval && opened.length > 0) throw new client.OvnfsError("busy", "checkout is busy");
				return {};
			}
			throw new Error(op.op);
		});
		const agentId = "Branch";
		const workspace = await ovnfsWorkspace(COMMAND)(repo, agentId);
		const baseDir = taskIsolationBaseDir(repo, agentId);
		const { checkout } = await readRecord(baseDir);
		const start = `${checkout}-start`;

		failRemoval = true;
		// The start checkout's path is no repository, so the baseline read fails.
		await expect(workspace.start?.baseline()).rejects.toThrow();
		expect(opened).toEqual([{ op: "new", base: "b_1", name: start, checkout: undefined }]);
		expect(await readRecord(baseDir)).toEqual({ command: COMMAND, checkout, start });

		// Closing the workspace removes the start checkout too, and keeps the record while it cannot.
		removed.length = 0;
		await workspace.cleanup();
		expect(removed).toEqual([start]);
		expect(await readRecord(baseDir)).toEqual({ command: COMMAND, checkout, start });

		failRemoval = false;
		removed.length = 0;
		await workspace.cleanup();
		expect(removed).toEqual([start, checkout]);
		await expect(fs.stat(baseDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	/**
	 * Runs agent `agentId` to success on a checkout of `repo` whose daemon diffs
	 * it as `patch`, with the branch commit stubbed to report `patch`.
	 */
	async function runOnCheckout(repo: string, agentId: string, mergeMode: "patch" | "branch", patch: string) {
		const artifactsDir = path.join(root, "artifacts", agentId);
		await fs.mkdir(artifactsDir, { recursive: true });
		const opened: DaemonOp[] = [];
		captureDaemon(repo, ["new.base", "diff.binary"], op => {
			if (op.op === "diff") return { patch, binary: true };
			if (op.op === "new") {
				opened.push(op);
				return { checkout: { name: op.name, path: `/mnt/ovnfs/${op.name}`, base: op.base } };
			}
			return {};
		});
		const baseline = {
			root: { repoRoot: repo, headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
			nested: [],
		};
		const captured = vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline);
		const committed = vi.spyOn(worktreeModule, "commitToBranch").mockResolvedValue({
			branchName: `omp/task/${agentId}`,
			baseSha: "base",
			rootPatch: patch,
			nestedPatches: [],
		});
		const succeeded: SingleResult = {
			index: 0,
			id: agentId,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Do work",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		};
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(succeeded);
		const result = await isolationRunner.runIsolatedSubprocess({
			baseOptions: {
				cwd: repo,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: agentId,
				keepAlive: false,
			},
			context: { repoRoot: repo },
			openWorkspace: ovnfsWorkspace(COMMAND),
			agentId,
			mergeMode,
			artifactsDir,
			buildFailureResult: error => ({ ...succeeded, exitCode: 1, error: String(error) }),
		});
		return { result, opened, captured, committed, baseline };
	}

	const binaryPatch =
		"diff --git a/logo.bin b/logo.bin\nnew file mode 100644\nindex 0000000..1b2c3d4\nGIT binary patch\nliteral 3\nKcmZQzWMT#Y01f~L\n\nliteral 0\nHcmV?d00001\n\n";

	it("hands the daemon's binary patch to a patch-mode run without taking a baseline", async () => {
		const repo = path.join(root, "patch-run");
		await fs.mkdir(repo);
		const { result, captured, committed } = await runOnCheckout(repo, "PatchRun", "patch", binaryPatch);
		expect(result.error).toBeUndefined();
		expect(await Bun.file(result.patchPath ?? "").text()).toBe(binaryPatch);
		expect(captured).not.toHaveBeenCalled();
		expect(committed).not.toHaveBeenCalled();
	});

	it("commits the daemon's patch on the baseline of a checkout reopened on the same capture", async () => {
		const repo = path.join(root, "branch-run");
		await fs.mkdir(repo);
		const { result, opened, captured, committed, baseline } = await runOnCheckout(
			repo,
			"BranchRun",
			"branch",
			binaryPatch,
		);
		expect(result.branchName).toBe("omp/task/BranchRun");
		const start = opened.find(op => op.base);
		expect(start?.base).toBe("b_1");
		expect(captured.mock.calls).toEqual([[`/mnt/ovnfs/${start?.name}`, repo]]);
		expect(committed).toHaveBeenCalledTimes(1);
		expect(committed.mock.calls[0]?.[1]).toBe(baseline);
		expect(committed.mock.calls[0]?.[5]).toEqual({ rootPatch: binaryPatch, nestedPatches: [] });
	});
});
