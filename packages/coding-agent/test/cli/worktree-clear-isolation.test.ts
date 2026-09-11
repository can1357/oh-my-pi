import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
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
	let savedExitCode: typeof process.exitCode;

	beforeEach(async () => {
		// Bun needs an explicit zero to clear an exit code set by an expected CLI failure.
		savedExitCode = process.exitCode ?? 0;
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		process.exitCode = savedExitCode;
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
		expect(await exists(recycled)).toBe(false);
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

		await clearWorktrees({ all: false, dryRun: false, json: true });

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
