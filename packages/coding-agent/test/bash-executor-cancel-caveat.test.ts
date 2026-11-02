// A cancelled bash run must not report a clean stop it cannot confirm. These
// drive real process trees: a detached `setsid` daemon that omp cannot see, and
// a tracked child that it can. Fake timers cannot advance fork, signal delivery,
// or /proc, so both run against live subprocesses.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";

const LINUX = process.platform === "linux";
const HAS_SETSID = LINUX && Bun.spawnSync(["sh", "-c", "command -v setsid"]).exitCode === 0;

/** A zombie is dead but unreaped; treat it as not alive. Linux only. */
function isAlive(pid: number): boolean {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat.slice(stat.lastIndexOf(")") + 2).trimStart()[0];
		return state !== "Z" && state !== "X";
	} catch {
		return false;
	}
}

async function pollUntil(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (!predicate()) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(20);
	}
	return true;
}

function readPid(file: string): number | undefined {
	try {
		const value = Number(fs.readFileSync(file, "utf8").trim());
		return Number.isInteger(value) && value > 1 ? value : undefined;
	} catch {
		return undefined;
	}
}

describe("executeBash cancellation reporting", () => {
	it.skipIf(!HAS_SETSID)(
		"warns that a process detached into its own session may still be running",
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cancel-daemon-"));
			const pidFile = path.join(dir, "daemon.pid");
			// A double fork + setsid detaches the daemon into a new session, so the
			// run's spawn registry and process group never see it. `exec sleep 60`
			// keeps the leader (which omp does track) alive so the run is cancellable.
			const command = `setsid --fork sh -c 'echo $$ > ${pidFile}; exec sleep 30'; exec sleep 60`;
			const ctrl = new AbortController();
			let daemonPid: number | undefined;
			try {
				const runP = executeBash(command, { cwd: dir, timeout: 0, signal: ctrl.signal });
				await pollUntil(() => (daemonPid = readPid(pidFile)) !== undefined, 5_000);
				expect(daemonPid).toBeDefined();
				ctrl.abort();
				const result = await runP;

				expect(result.cancelled).toBe(true);
				// The scenario is real: the detached daemon outlived the cancel.
				expect(isAlive(daemonPid as number)).toBe(true);
				// The result says so instead of a bare "[Command cancelled]".
				expect(result.output).toContain("detached into its own session");
				expect(result.output).toContain("pgrep");
			} finally {
				if (daemonPid !== undefined && isAlive(daemonPid)) {
					try {
						process.kill(daemonPid, "SIGKILL");
					} catch {}
				}
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(!LINUX)(
		"still cleanly cancels a tracked child, which it does stop",
		async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-cancel-child-"));
			const pidFile = path.join(dir, "child.pid");
			// A plain background child stays in the run's tree; the native cancellation
			// owns it and kills it, so this cancel is clean (no surviving tracked pid).
			const command = `/bin/sleep 30 & echo $! > ${pidFile}; wait`;
			const ctrl = new AbortController();
			let childPid: number | undefined;
			try {
				const runP = executeBash(command, { cwd: dir, timeout: 0, signal: ctrl.signal });
				await pollUntil(() => (childPid = readPid(pidFile)) !== undefined, 5_000);
				expect(childPid).toBeDefined();
				ctrl.abort();
				const result = await runP;

				expect(result.cancelled).toBe(true);
				// Cancellation is still reported, and the tracked child is actually gone.
				expect(result.output).toContain("[Command cancelled]");
				expect(await pollUntil(() => !isAlive(childPid as number), 5_000)).toBe(true);
			} finally {
				if (childPid !== undefined && isAlive(childPid)) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {}
				}
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
