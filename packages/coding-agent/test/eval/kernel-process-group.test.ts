import { describe, expect, test } from "bun:test";
import { BaseKernel, isSignalableProcessGroup, killProcessGroup } from "../../src/eval/kernel-base";

class TestKernel extends BaseKernel {
	constructor() {
		super("process-group-test", {
			languageName: "Test",
			traceIpc: false,
			exitPayload: "exit",
			interruptEscalationMs: 10,
			shutdownGraceMs: 25,
			buildPayload: code => code,
		});
	}
}

const POSIX = process.platform !== "win32";

/** Ground truth for "does a process group with this leader exist right now?" via the null signal. */
function processGroupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("isSignalableProcessGroup", () => {
	test("rejects the degenerate kill(2) group targets", () => {
		// `-0` would signal omp's own process group and `-1` would signal every
		// process the user can reach; both must never be negated into a kill.
		expect(isSignalableProcessGroup(0)).toBe(false);
		expect(isSignalableProcessGroup(1)).toBe(false);
		expect(isSignalableProcessGroup(-42)).toBe(false);
	});

	test("rejects absent or non-integer pids", () => {
		expect(isSignalableProcessGroup(undefined)).toBe(false);
		expect(isSignalableProcessGroup(Number.NaN)).toBe(false);
		expect(isSignalableProcessGroup(12.5)).toBe(false);
	});

	test("accepts a normal child pid", () => {
		expect(isSignalableProcessGroup(2)).toBe(true);
		expect(isSignalableProcessGroup(57944)).toBe(true);
	});
});

describe("killProcessGroup", () => {
	test("never signals a degenerate group even when asked to", () => {
		expect(killProcessGroup(0, "SIGKILL")).toBe(false);
		expect(killProcessGroup(1, "SIGKILL")).toBe(false);
		expect(killProcessGroup(undefined, "SIGKILL")).toBe(false);
	});

	test("reports false instead of throwing when the group is already gone", () => {
		// PID 0x7fffffff is above every platform's pid_max, so the group cannot
		// exist and kill(2) fails with ESRCH.
		expect(killProcessGroup(0x7fffffff, "SIGKILL")).toBe(false);
	});

	test.skipIf(!POSIX)("kills a live detached process group", async () => {
		const proc = Bun.spawn(["sleep", "30"], {
			detached: true,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			expect(processGroupExists(proc.pid)).toBe(true);
			expect(killProcessGroup(proc.pid, "SIGKILL")).toBe(true);
			await proc.exited;
			expect(processGroupExists(proc.pid)).toBe(false);
		} finally {
			proc.kill("SIGKILL");
		}
	});
});

describe("BaseKernel shutdown", () => {
	test.skipIf(!POSIX)("confirms a graceful zero-code exit on shutdown and repeated cleanup", async () => {
		const proc = Bun.spawn(["sh", "-c", 'read request; [ "$request" = exit ]'], {
			detached: true,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const kernel = new TestKernel();
		kernel.setProcess(proc);
		try {
			expect(await kernel.shutdown({ timeoutMs: 1_000 })).toEqual({ confirmed: true });
			expect(await proc.exited).toBe(0);
			expect(kernel.isAlive()).toBe(false);
			expect(await kernel.shutdown()).toEqual({ confirmed: true });
		} finally {
			killProcessGroup(proc.pid, "SIGKILL");
			proc.kill("SIGKILL");
			await proc.exited;
		}
	});

	test.skipIf(!POSIX).each(["graceful", "timeout"] as const)(
		"kills TERM-resistant descendants after a %s leader exit",
		async exitMode => {
			const pidFile = `/tmp/omp-kernel-process-group-${process.pid}-${Date.now()}`;
			const child = `sh -c 'trap "" TERM; echo ready > "$1"; exec sleep 30' sh '${pidFile}' &`;
			const command =
				exitMode === "graceful"
					? `${child} read request; [ "$request" = exit ]`
					: `trap 'exit 0' TERM; ${child} wait`;
			const proc = Bun.spawn(["sh", "-c", command], {
				detached: true,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				// This integration test must wait on real subprocess state; fake timers
				// cannot advance fork, signal delivery, or filesystem visibility.
				await Promise.race([
					(async () => {
						while (!(await Bun.file(pidFile).exists())) await Bun.sleep(10);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("timed out waiting for the kernel descendant");
					}),
				]);

				const kernel = new TestKernel();
				kernel.setProcess(proc);
				expect(await kernel.shutdown({ timeoutMs: 1_000 })).toEqual({ confirmed: true });
				expect(await proc.exited).toBe(0);

				await Promise.race([
					(async () => {
						while (processGroupExists(proc.pid)) await Bun.sleep(10);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("kernel process group survived shutdown");
					}),
				]);
			} finally {
				killProcessGroup(proc.pid, "SIGKILL");
				proc.kill("SIGKILL");
				await proc.exited;
				await Bun.file(pidFile).delete();
			}
		},
	);
});
