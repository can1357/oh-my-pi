/**
 * Worker-thread body of `startParentWatchdog` (`./parent-watchdog`): receives
 * the parent pid, polls its liveness, and SIGKILLs the whole process the moment
 * it is gone. Runs on its own event loop so a worker whose main thread is
 * pinned inside a synchronous native call (onnxruntime `session.run`) still
 * dies with its parent instead of lingering as a PPID-1 orphan (issue #14340).
 */
import { parentPort } from "node:worker_threads";
import type * as Natives from "@oh-my-pi/pi-natives";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";

const POLL_INTERVAL_MS = 250;

if (!parentPort) throw new Error("parent-watchdog-worker: missing parentPort");

function die(): never {
	// SIGKILL mirrors the parent's hard-kill: skip every JS/native finalizer
	// (onnxruntime's crashes Bun on Windows, issue #1606).
	process.kill(process.pid, "SIGKILL");
	throw new Error("parent-watchdog-worker: SIGKILL did not terminate the process");
}

async function watch(parentPid: number): Promise<void> {
	// Reparent baseline. omp often runs as PID 1 in containers, so a ppid of 1
	// alone is not an orphan signal; only a change is. A parent that died before
	// this snapshot is still caught by the exit probes on `parentPid` below.
	const initialPpid = process.ppid;
	let natives: typeof Natives | null = null;
	let parent: Natives.Process | null = null;
	try {
		if (!process.env.PI_TEST_NO_NATIVES) {
			// Dynamic: PI_TEST_NO_NATIVES hosts must never load the addon.
			natives = await import("@oh-my-pi/pi-natives");
			// Null when pidfd_open is blocked (pre-5.3 kernels, restrictive
			// seccomp) even for a live parent; the probes below cover that.
			parent = natives.Process.fromPid(parentPid);
		}
	} catch {}

	const isParentAlive = (): boolean => {
		if (process.ppid !== initialPpid) return false;
		if (parent && natives) {
			try {
				return parent.status() === natives.ProcessStatus.Running;
			} catch {}
		}
		try {
			process.kill(parentPid, 0);
			return true;
		} catch (err: unknown) {
			return err instanceof Error && "code" in err && err.code === "EPERM";
		}
	};
	if (!isParentAlive()) die();
	if (parent) void parent.waitForExit().then(die, die);
	setInterval(() => {
		if (!isParentAlive()) die();
	}, POLL_INTERVAL_MS);
}

const handle = (message: unknown): void => {
	if (typeof message === "number") void watch(message);
};

const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else parentPort.on("message", handle);
