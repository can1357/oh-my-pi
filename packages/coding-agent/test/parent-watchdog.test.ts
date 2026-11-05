import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";

const FIXTURE = path.join(import.meta.dir, "fixtures", "parent-watchdog-orphan.ts");

describe("startParentWatchdog", () => {
	// Issue #14340: an IPC worker whose main thread was pinned inside a
	// synchronous native call (onnxruntime inference) outlived its dead parent
	// as a multi-GiB PPID-1 orphan, because the parent-liveness watchdog ran on
	// that same starved event loop.
	it("kills an orphaned process whose main thread is blocked", async () => {
		const middle = Bun.spawn([process.execPath, FIXTURE], { stdout: "pipe", stderr: "inherit" });
		const childPid = Number.parseInt((await new Response(middle.stdout).text()).trim(), 10);
		await middle.exited;
		// The middle hard-killed itself after the child armed: a signal on POSIX,
		// TerminateProcess exit code 1 on Windows (the never-armed path exits 2).
		if (process.platform === "win32") expect(middle.exitCode).toBe(1);
		else expect(middle.signalCode).toBe("SIGKILL");

		const child = Process.fromPid(childPid);
		if (!child) return; // Already gone: the watchdog won the race.
		const exited = await child.waitForExit({ timeoutMs: 5_000 });
		if (!exited) child.killTree();
		expect(exited).toBe(true);
	}, 15_000);
});
