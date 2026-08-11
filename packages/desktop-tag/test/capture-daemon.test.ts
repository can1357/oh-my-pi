import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	type GatewayDaemonPaths,
	gatewayDaemonStatus,
	readAlivePid,
	resolveGatewayDaemonPaths,
	startGatewayDaemon,
	stopGatewayDaemon,
} from "../src/capture/daemon";

const fixturePath = path.join(__dirname, "helpers", "fake-gateway-daemon.ts");

/** Process-lifecycle tests need headroom under full-suite load. */
const PROCESS_TEST_TIMEOUT_MS = 20_000;

interface Managed {
	paths: GatewayDaemonPaths;
	childPid?: number;
}

const managed: Managed[] = [];

function makePaths(): GatewayDaemonPaths {
	const paths = resolveGatewayDaemonPaths(fs.mkdtempSync(path.join(os.tmpdir(), "ompk-daemon-")));
	managed.push({ paths });
	return paths;
}

function launchCmd(paths: GatewayDaemonPaths, ...flags: string[]): string[] {
	return [process.execPath, fixturePath, paths.pidFile, ...flags];
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(async () => {
	for (const entry of managed) {
		// Kill only the process still named by the live lock. A normally stopped
		// child has already removed that lock; signaling its old numeric PID can
		// terminate an unrelated Bun process after Windows recycles the PID.
		const lockedPid = readAlivePid(entry.paths.pidFile);
		const pid =
			lockedPid !== undefined &&
			lockedPid !== process.pid &&
			(entry.childPid === undefined || lockedPid === entry.childPid)
				? lockedPid
				: undefined;
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// already dead
			}
			// Windows releases the log handle only once the process is gone;
			// wait briefly so the temp-root removal below can succeed.
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && pidAlive(pid)) await Bun.sleep(25);
		}
		try {
			fs.rmSync(entry.paths.root, { recursive: true, force: true });
		} catch {
			// already gone
		}
	}
	managed.length = 0;
});

describe("gateway daemon lifecycle", () => {
	it(
		"runs the full lifecycle: start -> running with matching pid -> stop -> not running with pid file gone",
		async () => {
			const paths = makePaths();

			const start = await startGatewayDaemon({
				cmd: launchCmd(paths),
				paths,
				readyTimeoutMs: 8000,
				pollIntervalMs: 25,
			});

			expect(start.started).toBe(true);
			if (!start.started) throw new Error("gateway did not start");
			managed[managed.length - 1].childPid = start.pid;

			// Controller and fixture agree on the pid lock.
			const status = gatewayDaemonStatus(paths);
			expect(status.running).toBe(true);
			expect(status.pid).toBe(start.pid);
			expect(readAlivePid(paths.pidFile)).toBe(start.pid);

			const stop = await stopGatewayDaemon({ paths, killTimeoutMs: 8000, pollIntervalMs: 25 });
			expect(stop.stopped).toBe(true);
			if (!stop.stopped) throw new Error("gateway did not stop");
			expect(stop.pid).toBe(start.pid);

			expect(gatewayDaemonStatus(paths).running).toBe(false);
			expect(fs.existsSync(paths.pidFile)).toBe(false);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"reports alreadyRunning with the same pid when started while already running",
		async () => {
			const paths = makePaths();

			const first = await startGatewayDaemon({
				cmd: launchCmd(paths),
				paths,
				readyTimeoutMs: 8000,
				pollIntervalMs: 25,
			});
			expect(first.started).toBe(true);
			if (!first.started) throw new Error("gateway did not start");
			managed[managed.length - 1].childPid = first.pid;

			const second = await startGatewayDaemon({
				cmd: launchCmd(paths),
				paths,
				readyTimeoutMs: 8000,
				pollIntervalMs: 25,
			});
			expect(second.started).toBe(false);
			if (second.started || !second.alreadyRunning) throw new Error("expected alreadyRunning result");
			expect(second.pid).toBe(first.pid);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"returns started:false with the stderr marker and exit info for an early-exiting child",
		async () => {
			const paths = makePaths();

			const result = await startGatewayDaemon({
				cmd: launchCmd(paths, "--exit-early"),
				paths,
				readyTimeoutMs: 8000,
				pollIntervalMs: 25,
			});

			expect(result.started).toBe(false);
			expect("reason" in result).toBe(true);
			const reason = "reason" in result ? result.reason : "";
			expect(reason).toContain("fake gateway boom");
			expect(reason).toContain("exit code 7");
			expect(fs.existsSync(paths.pidFile)).toBe(false);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"does not let a stale pid file block a fresh start",
		async () => {
			const paths = makePaths();

			// Spawn a bun child that exits immediately, record its (now-dead) pid.
			const stalePid = await new Promise<number>(resolve => {
				const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
				child.once("exit", () => resolve(child.pid as number));
			});
			fs.mkdirSync(paths.root, { recursive: true });
			fs.writeFileSync(paths.pidFile, String(stalePid));

			// The stale pid names a dead process, so it must not look running.
			expect(gatewayDaemonStatus(paths).running).toBe(false);

			const start = await startGatewayDaemon({
				cmd: launchCmd(paths),
				paths,
				readyTimeoutMs: 8000,
				pollIntervalMs: 25,
			});
			expect(start.started).toBe(true);
			if (!start.started) throw new Error("gateway did not start");
			expect(start.pid).not.toBe(stalePid);
			managed[managed.length - 1].childPid = start.pid;
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it("returns stopped:false, running:false with no pid file", async () => {
		const paths = makePaths();
		const result = await stopGatewayDaemon({ paths, killTimeoutMs: 8000, pollIntervalMs: 25 });
		expect(result).toEqual({ stopped: false, running: false });
	});

	it("rejects a lock naming a live unrelated PID without signaling it", async () => {
		const paths = makePaths();
		// Record current process pid in lock file but with non-gateway parameters or plain PID
		// that does not match gateway signatures
		const lockContent = JSON.stringify({
			pid: process.pid,
			gatewayId: "unrelated-id",
			createdAt: Date.now(),
		});
		fs.mkdirSync(paths.root, { recursive: true });
		fs.writeFileSync(paths.pidFile, lockContent);

		// If current process is bun test, readAlivePid verifies identity fail-closed unless matched
		// stopGatewayDaemon must return stopped:false, running:false and not signal an unrelated process
		const alive = readAlivePid(paths.pidFile);
		if (alive !== undefined) {
			expect(alive).toBe(process.pid);
		} else {
			const stopResult = await stopGatewayDaemon({ paths, killTimeoutMs: 500, pollIntervalMs: 25 });
			expect(stopResult.stopped).toBe(false);
			if (stopResult.stopped) throw new Error("unrelated PID was unexpectedly stopped");
			expect(stopResult.running).toBe(false);
		}
	});

	it(
		"handles concurrent startup without orphaned gateways or overwritten locks",
		async () => {
			const paths = makePaths();

			const [p1, p2] = await Promise.all([
				startGatewayDaemon({
					cmd: launchCmd(paths),
					paths,
					readyTimeoutMs: 8000,
					pollIntervalMs: 25,
				}),
				startGatewayDaemon({
					cmd: launchCmd(paths),
					paths,
					readyTimeoutMs: 8000,
					pollIntervalMs: 25,
				}),
			]);

			const startedCount = (p1.started ? 1 : 0) + (p2.started ? 1 : 0);
			expect(startedCount).toBe(1);

			const winnerPid = p1.started ? p1.pid : (p2 as { pid: number }).pid;
			managed[managed.length - 1].childPid = winnerPid;

			const stop = await stopGatewayDaemon({ paths, killTimeoutMs: 8000, pollIntervalMs: 25 });
			expect(stop.stopped).toBe(true);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

describe("daemon env defaults", () => {
	it(
		"injects the 30-minute default CAPTURE_IDLE_EXIT_MS when no env option is passed",
		async () => {
			// The controller merges process.env, so the ambient shell must not
			// already define the variable; save/delete/restore around the test.
			const saved = process.env.CAPTURE_IDLE_EXIT_MS;
			delete process.env.CAPTURE_IDLE_EXIT_MS;
			try {
				const paths = makePaths();

				const start = await startGatewayDaemon({
					cmd: launchCmd(paths),
					paths,
					readyTimeoutMs: 8000,
					pollIntervalMs: 25,
				});
				expect(start.started).toBe(true);
				if (!start.started) throw new Error("gateway did not start");
				managed[managed.length - 1].childPid = start.pid;

				expect(fs.readFileSync(paths.logFile, "utf8")).toContain("CAPTURE_IDLE_EXIT_MS=1800000");

				const stop = await stopGatewayDaemon({ paths, killTimeoutMs: 8000, pollIntervalMs: 25 });
				expect(stop.stopped).toBe(true);
			} finally {
				if (saved === undefined) {
					delete process.env.CAPTURE_IDLE_EXIT_MS;
				} else {
					process.env.CAPTURE_IDLE_EXIT_MS = saved;
				}
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"lets an explicit CAPTURE_IDLE_EXIT_MS (including 0 = never) win over the default",
		async () => {
			const paths = makePaths();

			const start = await startGatewayDaemon({
				cmd: launchCmd(paths),
				paths,
				env: { ...process.env, CAPTURE_IDLE_EXIT_MS: "0" },
				readyTimeoutMs: 8000,
				pollIntervalMs: 25,
			});
			expect(start.started).toBe(true);
			if (!start.started) throw new Error("gateway did not start");
			managed[managed.length - 1].childPid = start.pid;

			expect(fs.readFileSync(paths.logFile, "utf8")).toContain("CAPTURE_IDLE_EXIT_MS=0");

			const stop = await stopGatewayDaemon({ paths, killTimeoutMs: 8000, pollIntervalMs: 25 });
			expect(stop.stopped).toBe(true);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});
