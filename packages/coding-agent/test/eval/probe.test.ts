// Integration test: runBoundedProbe spawns and kills a real subprocess, so the
// timeout/abort teardown is inherently wall-clock bound. Fake timers cannot
// advance a child process's execution or resolve its `exited` promise, so the
// real-timer exception in ts-no-test-timers applies here.
import { describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { probeCandidates, runBoundedProbe } from "../../src/eval/probe";

// A cross-platform "hangs forever" command: re-invoke the running Bun to sleep.
const bun = process.execPath;
const HANG = [bun, "-e", "await Bun.sleep(60_000)"];
const IGNORE_TERM = [bun, "-e", 'process.on("SIGTERM", () => {}); await Bun.sleep(60_000)'];
const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

async function expectExited(child: Process | null): Promise<void> {
	if (child) expect(await child.waitForExit({ timeoutMs: 2_000 })).toBe(true);
}

describe("runBoundedProbe", () => {
	test("a hung probe is bounded by its timeout instead of hanging (regression: #9466)", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, { cwd: process.cwd(), env: baseEnv(), timeoutMs: 300 });
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("force-kills a probe that ignores SIGTERM when its timeout expires", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(IGNORE_TERM, {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 300,
		});
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("kills descendants spawned by an interpreter shim", async () => {
		const pidFile = join(tmpdir(), `omp-probe-grandchild-${process.pid}-${Date.now()}.pid`);
		let grandchild: Process | null = null;
		const wrapper = [
			bun,
			"-e",
			`const child=Bun.spawn([process.execPath,"-e","await Bun.sleep(60_000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});await Bun.write(${JSON.stringify(pidFile)},String(child.pid));await child.exited`,
		];
		try {
			const result = await runBoundedProbe(wrapper, {
				cwd: process.cwd(),
				env: baseEnv(),
				timeoutMs: 1_000,
			});
			expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
			const grandchildPid = Number(await Bun.file(pidFile).text());
			expect(grandchildPid).toBeGreaterThan(0);
			grandchild = Process.fromPid(grandchildPid);
			await expectExited(grandchild);
		} finally {
			if (grandchild?.status() === ProcessStatus.Running) grandchild.killTree();
			await rm(pidFile, { force: true });
		}
	});

	test.skipIf(process.platform === "win32")("kills a probe group after its leader exits", async () => {
		const leader = Bun.spawn(
			[
				bun,
				"-e",
				`const child = Bun.spawn(${JSON.stringify(HANG)}, { stdio: ["ignore", "ignore", "ignore"] });
				child.unref();
				console.log(child.pid);`,
			],
			{ detached: true, stdout: "pipe" },
		);
		try {
			const pid = Number((await new Response(leader.stdout).text()).trim());
			expect(await leader.exited).toBe(0);
			const orphan = Process.fromPid(pid);
			expect(orphan?.status()).toBe(ProcessStatus.Running);
			expect(Process.killGroup(leader.pid)).toBe(true);
			await expectExited(orphan);
		} finally {
			Process.killGroup(leader.pid);
		}
	});

	test("an already-aborted signal short-circuits without spawning", async () => {
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
	});

	test("an in-flight probe is killed when its signal aborts", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.timeout(100),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	// Failure mode: the abort comes while the probe's launcher starts (Linux), and the probe is then spawned in the
	// launcher's place with the aborted signal, which `Bun.spawn` refuses with an `AbortError`: the probe rejects
	// instead of reporting the abort. The launcher's spawn is where the abort lands here.
	test.skipIf(process.platform !== "linux")(
		"an abort while the probe's launcher starts is reported, and nothing is spawned in its place",
		async () => {
			const launcher = `/proc/${process.pid}/exe`;
			const caller = new AbortController();
			const spawned: string[] = [];
			const spawn = Bun.spawn.bind(Bun);
			const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: object) => {
				spawned.push(cmd[0]);
				if (cmd[0] === launcher) caller.abort();
				return spawn(cmd, options as never);
			}) as unknown as typeof Bun.spawn);
			let outcome: unknown;
			try {
				outcome = await runBoundedProbe(HANG, {
					cwd: process.cwd(),
					env: baseEnv(),
					signal: caller.signal,
				}).catch((error: unknown) => error);
			} finally {
				spy.mockRestore();
			}
			expect(outcome).toEqual({ exitCode: null, timedOut: false, aborted: true });
			expect(spawned).toEqual([launcher]);
		},
	);

	test("a fast probe reports its real exit code", async () => {
		const ok = await runBoundedProbe([bun, "-e", "process.exit(0)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(ok).toEqual({ exitCode: 0, timedOut: false, aborted: false });

		const failing = await runBoundedProbe([bun, "-e", "process.exit(3)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(failing).toEqual({ exitCode: 3, timedOut: false, aborted: false });
	});
});

describe("probeCandidates", () => {
	test("shares one discovery deadline across hung candidates instead of paying it per candidate", async () => {
		const start = Date.now();
		const result = await probeCandidates(
			[
				{ command: HANG, env: baseEnv(), label: "cand-a" },
				{ command: HANG, env: baseEnv(), label: "cand-b" },
				{ command: HANG, env: baseEnv(), label: "cand-c" },
			],
			{ cwd: process.cwd(), timeoutMs: 300 },
		);
		const elapsed = Date.now() - start;
		expect(result).toEqual({ ok: false, aborted: false, timedOut: true, failures: expect.any(Array) });
		// One 300ms budget total, not 3×: the whole discovery stays well under the
		// combined per-candidate cost it would incur without a shared deadline.
		expect(elapsed).toBeLessThan(900);
	});

	test("returns the first candidate that exits 0 and skips the rest", async () => {
		const result = await probeCandidates(
			[
				{ command: [bun, "-e", "process.exit(1)"], env: baseEnv(), label: "bad" },
				{ command: [bun, "-e", "process.exit(0)"], env: baseEnv(), label: "good" },
				{ command: HANG, env: baseEnv(), label: "would-hang" },
			],
			{ cwd: process.cwd(), timeoutMs: 5_000 },
		);
		expect(result).toEqual({ ok: true, index: 1 });
	});
});
