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
import * as daemon from "../../src/ovnfs/daemon";
import { ISOLATION_OWNER_FILE } from "../../src/task/isolation-ownership";
import * as isolationRunner from "../../src/task/isolation-runner";
import { OVNFS_CHECKOUT_FILE, ovnfsWorkspace, releaseOvnfsCheckout } from "../../src/task/ovnfs";
import { taskIsolationBaseDir } from "../../src/task/worktree";

const COMMAND = "/opt/ovnfs/ovnfs";
const STALE = "omp-authrefactor-stale1";

interface CheckoutRecord {
	command: string;
	checkout: string;
}

interface DaemonOp {
	op: string;
	checkout?: string;
	name?: string;
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
		vi.spyOn(daemon, "startDaemon").mockResolvedValue({ socket: "/tmp/ovnfs-test.sock", mount: "/mnt/ovnfs" });
		vi.spyOn(client, "callSocket").mockImplementation(
			async <T>(_socket: string, op: string, args: object): Promise<T> => {
				const record = args as { checkout?: unknown; name?: unknown };
				return handle({
					op,
					checkout: typeof record.checkout === "string" ? record.checkout : undefined,
					name: typeof record.name === "string" ? record.name : undefined,
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
});
