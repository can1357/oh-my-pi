import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { isPidRunning } from "@oh-my-pi/pi-utils/procmgr";
import { runCli } from "../src/cli";
import * as computerWorkerEntry from "../src/tools/computer/worker-entry";

// The worker-host re-entry seam dispatches any `__omp_worker_*` selector to
// `runWorkerEntrypoint`. An unrecognized selector must fail loudly rather than
// exit 0 with empty output, so a stale/mistyped selector cannot look healthy to
// a parent process or install smoke path (issue #5712).
describe("worker selector dispatch", () => {
	beforeEach(() => {
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = 0;
	});

	it("fails with a nonzero exit and stderr error on an unknown selector", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["__omp_worker_does_not_exist"]);

		expect(process.exitCode).toBe(1);
		expect(stderr).toHaveBeenCalledWith("Error: unknown worker selector: __omp_worker_does_not_exist\n");
	});
	it("declares workerHostEntry in process entry before dispatching worker selector", async () => {
		const repoRoot = path.resolve(__dirname, "../../..");
		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				"-e",
				`
				import { workerHostEntry } from "./packages/utils/src/worker-host.ts";
				await import("./packages/coding-agent/src/cli.ts");
				process.stdout.write("ENTRY=" + (workerHostEntry() ?? "null"));
				process.exit(0);
				`,
				"__omp_worker_does_not_exist",
			],
			cwd: repoRoot,
			env: { ...process.env, PI_COMPILED: "true" },
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = await new Response(proc.stdout).text();
		expect(stdout).toContain("ENTRY=");
		expect(stdout).not.toBe("ENTRY=null");
	});

	it("leaves normal root flags untouched", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		await runCli(["--version"]);

		expect(process.exitCode).toBe(0);
		expect(stdout).toHaveBeenCalled();
		expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("unknown worker selector"));
	});

	it("exits promptly when an IPC worker selector is launched without an IPC channel", async () => {
		const proc = Bun.spawn({
			cmd: [process.execPath, "packages/coding-agent/src/cli.ts", "__omp_worker_js_eval_process"],
			cwd: path.resolve(__dirname, "../../.."),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
		if (!exited) {
			proc.kill("SIGKILL");
		}
		expect(exited).toBe(true);
	});

	it("reaps orphaned IPC worker when parent process terminates", async () => {
		const repoRoot = path.resolve(__dirname, "../../..");
		const parent = Bun.spawn({
			cmd: [
				process.execPath,
				"-e",
				`
				const child = Bun.spawn({
					cmd: [process.execPath, "packages/coding-agent/src/cli.ts", "__omp_worker_js_eval_process"],
					cwd: ${JSON.stringify(repoRoot)},
					ipc(msg) {},
					serialization: "advanced",
					windowsHide: true,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				console.log("CHILD_PID:" + child.pid);
				setTimeout(() => process.exit(0), 500);
				`,
			],
			cwd: repoRoot,
			stdout: "pipe",
		});

		const text = await new Response(parent.stdout).text();
		const match = text.match(/CHILD_PID:(\d+)/);
		expect(match).not.toBeNull();
		const childPid = Number(match?.[1]);
		expect(childPid).toBeGreaterThan(0);

		await parent.exited;

		let running = isPidRunning(childPid);
		try {
			for (let i = 0; i < 30 && running; i++) {
				await Bun.sleep(100);
				running = isPidRunning(childPid);
			}
		} finally {
			if (running) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {}
			}
		}
		expect(running).toBe(false);
	});

	it("reaps orphaned IPC worker using fallback watchdog when native process handles are unavailable", async () => {
		const repoRoot = path.resolve(__dirname, "../../..");
		const parent = Bun.spawn({
			cmd: [
				process.execPath,
				"-e",
				`
				const child = Bun.spawn({
					cmd: [process.execPath, "packages/coding-agent/src/cli.ts", "__omp_worker_js_eval_process"],
					cwd: ${JSON.stringify(repoRoot)},
					env: { ...process.env, PI_TEST_NO_NATIVES: "1" },
					ipc() {},
					serialization: "advanced",
					windowsHide: true,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				console.log("CHILD_PID:" + child.pid);
				setTimeout(() => process.exit(0), 500);
				`,
			],
			cwd: repoRoot,
			stdout: "pipe",
		});

		const text = await new Response(parent.stdout).text();
		const match = text.match(/CHILD_PID:(\d+)/);
		expect(match).not.toBeNull();
		const childPid = Number(match?.[1]);
		expect(childPid).toBeGreaterThan(0);

		await parent.exited;

		let running = isPidRunning(childPid);
		try {
			for (let i = 0; i < 30 && running; i++) {
				await Bun.sleep(100);
				running = isPidRunning(childPid);
			}
		} finally {
			if (running) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch {}
			}
		}
		expect(running).toBe(false);
	});

	it("does not treat PID 1 as an immediate orphan at boot in container environments", async () => {
		const repoRoot = path.resolve(__dirname, "../../..");
		const childScript = `
			Object.defineProperty(process, "ppid", { value: 1, configurable: true });
			process.env.PI_TEST_NO_NATIVES = "1";
			const originalKill = process.kill;
			process.kill = (pid, sig) => {
				if (pid === 1 && sig === 0) return true;
				return originalKill.call(process, pid, sig);
			};
			const { runCli } = await import("./packages/coding-agent/src/cli.ts");
			await runCli(["__omp_worker_js_eval_process"]);
		`;

		const child = Bun.spawn({
			cmd: [process.execPath, "-e", childScript],
			cwd: repoRoot,
			ipc() {},
			serialization: "advanced",
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});

		await Bun.sleep(400);
		const alive = !child.killed && child.exitCode === null;
		child.kill("SIGKILL");
		expect(alive).toBe(true);
	});
});

describe("computer worker entry", () => {
	it("is side-effect-free to import outside a worker and exposes a named start function", () => {
		// Importing on the main thread (no parentPort) must not start the worker
		// core; the CLI host and bundled hosts call the exported hook explicitly.
		expect(computerWorkerEntry.startComputerWorker).toBeFunction();
	});
});
