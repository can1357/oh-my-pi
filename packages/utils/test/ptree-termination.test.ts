import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

/**
 * Spin until the pinned root has exited, without yielding to the loop.
 *
 * Bun's reaper only runs on a loop turn, so a synchronous spin holds the
 * process in the unreaped window it needs to be observed in. Polling a pinned
 * handle rather than reopening the pid keeps the loop from allocating a pidfd
 * per iteration.
 */
function spinUntilUnreapedExit(child: ReturnType<typeof spawn>): void {
	const root = Process.fromPid(child.pid);
	if (!root) throw new Error(`Root ${child.pid} vanished before it could be pinned`);
	const deadline = Date.now() + 5_000;
	while (root.status() === ProcessStatus.Running) {
		if (Date.now() > deadline) throw new Error(`Root ${child.pid} never exited`);
	}
}

/** Poll a file the survivor wrote its own pid into, for the never-read case. */
async function readReportedPid(file: string): Promise<number> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const reported = fs.existsSync(file) ? Number.parseInt(fs.readFileSync(file, "utf8").trim() || "0", 10) : 0;
		if (reported > 0) return reported;
		if (Date.now() > deadline) throw new Error(`Descendant never reported its pid to ${file}`);
		await Bun.sleep(10);
	}
}

describe("ptree.ChildProcess.killAndWait()", () => {
	for (const readerState of ["raw", "paused", "eof", "cancel", "unread"] as const) {
		it.skipIf(process.platform === "win32")(`sweeps a dead root's group with its stdout ${readerState}`, async () => {
			// How far a stdout consumer got is not a condition anywhere in the
			// fallback: a survivor of a caller that never read — or finished
			// reading — has to be swept like any other. The root parks on a file so
			// each reader state is established while it is alive, then the exit is
			// triggered synchronously to land in the unreaped window, where a dead
			// leader's group is attributable on every platform.
			const stamp = `${process.pid}-${Date.now()}-${readerState}`;
			const goFile = path.join(os.tmpdir(), `omp-ptree-go-${stamp}`);
			const pidFile = path.join(os.tmpdir(), `omp-ptree-pid-${stamp}`);
			const report = readerState === "unread" ? `echo $! > ${pidFile}` : "echo $!";
			const filler = readerState === "paused" ? "sleep 0.05; echo filler;" : "";
			// The survivor keeps the root's stdout for the raw case, which is the one
			// whose point is a descendant still holding that pipe once the root is
			// gone. The states that need an EOF cannot afford a second writer.
			const survivorPipes = readerState === "raw" ? "2>/dev/null" : ">/dev/null 2>&1";
			// Closing both pipes while the root is still alive is what lets the stdout
			// consumer see EOF and lets the internal stderr drain run out of input, so
			// these are the states with nothing left reading rather than ones whose
			// reads merely had not finished yet.
			const close = readerState === "eof" || readerState === "unread" ? "exec 1>&- 2>&-;" : "";
			// Written last, so observing it in the drained tail is evidence that every
			// write before it — including the buffered filler — has landed and been
			// consumed, instead of waiting a fixed time and assuming so. It says
			// nothing about the drain having reached EOF, which is one read further
			// on and is not what any assertion here depends on.
			const sentinel = "stderr-drained";
			const script = `sleep 30 ${survivorPipes} & ${report}; ${filler} echo ${sentinel} >&2; ${close} while [ ! -f ${goFile} ]; do sleep 0.01; done`;
			const child = spawn(["/bin/sh", "-c", script], { detached: true });
			// Declared by inference rather than annotation: Bun's reader carries an
			// extra `readMany`, so the DOM lib type is not assignable to it.
			let reader = readerState === "unread" ? undefined : child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				if (reader) {
					const first = new TextDecoder().decode((await reader.read()).value);
					descendant = Process.fromPid(Number.parseInt(first, 10));
				} else {
					descendant = Process.fromPid(await readReportedPid(pidFile));
				}
				if (!descendant) throw new Error("Descendant exited before termination");
				if (readerState === "eof") expect((await reader?.read())?.done).toBe(true);
				if (readerState === "cancel") {
					await reader?.cancel();
					reader = undefined;
				}
				const drained = Date.now() + 5_000;
				while (!child.peekStderr().includes(sentinel)) {
					if (Date.now() > drained) throw new Error("Internal stderr drain never reported");
					await Bun.sleep(5);
				}
				expect(descendant.status()).toBe(ProcessStatus.Running);

				fs.writeFileSync(goFile, "");
				spinUntilUnreapedExit(child);
				expect(child.proc.exitCode).toBeNull();
				await child.killAndWait(undefined, -1);

				expect(descendant.status()).toBe(ProcessStatus.Exited);
				// Proves the consumer was parked over buffered output rather than
				// sitting at EOF, and that the kill did not discard it.
				if (readerState === "paused")
					expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("filler\n");
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await reader?.cancel();
				fs.rmSync(goFile, { force: true });
				fs.rmSync(pidFile, { force: true });
			}
		});
	}

	it.skipIf(process.platform === "win32")("never hides a reaped root's unswept group behind success", async () => {
		// Which arm runs depends on the kernel: with a process-group scope for
		// pidfds the retained leader reaches the group with no ownership proof at
		// all, and without one the pgid number is the only handle left and cannot
		// be attributed. The native side pins each arm on the measured scope; what
		// this covers is that neither outcome reaches the caller as a success over
		// a process that is still running.
		const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!"], { detached: true });
		const reader = child.stdout.getReader();
		let descendant: Process | null = null;
		try {
			const output = await reader.read();
			descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
			if (!descendant) throw new Error("Descendant exited before termination");
			await child.proc.exited;
			expect(Process.fromPid(child.pid)).toBeNull();
			const outcome = await child.killAndWait(undefined, -1).then(
				() => "swept",
				(error: unknown) => String(error),
			);
			if (outcome === "swept") {
				expect(descendant.status()).toBe(ProcessStatus.Exited);
			} else {
				expect(outcome).toContain("cannot be proven to still be ours");
				expect(descendant.status()).toBe(ProcessStatus.Running);
			}
		} finally {
			descendant?.killTree(9);
			await reader.cancel();
		}
	});

	it.skipIf(process.platform === "win32")("leaves buffered stdout readable after the kill", async () => {
		// The consumer is parked over unread output when the kill arrives, which
		// it has to survive: the stream belongs to the caller, not to kill().
		const child = spawn(["/bin/sh", "-c", "echo first; sleep 0.05; echo filler; exec sleep 30"], {
			detached: true,
		});
		const reader = child.stdout.getReader();
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
			await Bun.sleep(150);
			await child.killAndWait(undefined, -1);
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("filler\n");
		} finally {
			await reader.cancel();
			child.kill(undefined, -1);
		}
	});

	it.skipIf(process.platform !== "win32")("waits for a pipe-holding descendant after its root exits", async () => {
		// Windows keeps the dead root's pid reserved through the retained handle, so
		// the Toolhelp descendant walk stays identity-safe after the root exits and
		// needs no unreaped-leader window.
		const child = spawn([process.execPath, `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`], {
			detached: true,
		});
		const reader = child.stdout.getReader();
		let descendant: Process | null = null;
		try {
			const output = await reader.read();
			const pid = Number.parseInt(new TextDecoder().decode(output.value), 10);
			descendant = Process.fromPid(pid);
			if (!descendant) throw new Error("Descendant exited before termination");
			await child.proc.exited;
			expect(descendant.status()).toBe(ProcessStatus.Running);
			await child.killAndWait(undefined, -1);
			expect(descendant.status()).toBe(ProcessStatus.Exited);
		} finally {
			descendant?.killTree(9);
			child.kill(undefined, -1);
			await reader.cancel();
		}
	});

	it.skipIf(process.platform === "win32")(
		"reports synchronous group-termination errors without interrupting kill",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!"], { detached: true });
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			const killOwnGroupAndWait = Process.prototype.killOwnGroupAndWait;
			const spy = spyOn(Process.prototype, "killOwnGroupAndWait").mockImplementation(
				function (this: Process, options) {
					if (this.pid === child.pid) throw new Error("Cannot observe process group");
					return killOwnGroupAndWait.call(this, options);
				},
			);
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				await child.proc.exited;
				child.kill(undefined, -1);
				await expect(child.killAndWait(undefined, -1)).rejects.toThrow("Cannot observe process group");
			} finally {
				spy.mockRestore();
				descendant?.killTree(9);
				await child.killAndWait(undefined, -1);
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"hard-kills a descendant orphaned when the root dies to the polite signal",
		async () => {
			// The descendant reports its pid only after ignoring TERM, and SIG_IGN
			// survives the exec, so the root exits to the polite signal first and
			// reparents the survivor out of the hard wave's descendant walk.
			const child = spawn(["/bin/sh", "-c", `/bin/sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait`]);
			const root = Process.fromPid(child.pid);
			if (!root) throw new Error("Root exited before termination");
			const reader = child.stdout.getReader();
			let orphan: Process | null = null;
			try {
				const output = await reader.read();
				orphan = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!orphan) throw new Error("Descendant exited before termination");
				expect(orphan.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, 100);
				expect(root.status()).toBe(ProcessStatus.Exited);
				expect(orphan.status()).toBe(ProcessStatus.Exited);
			} finally {
				orphan?.killTree(9);
				child.kill(undefined, -1);
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"waits for subreaper descendants during immediate hard termination",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { subreaper: true });
			const root = Process.fromPid(child.pid);
			if (!root) throw new Error("Subreaper exited before termination");
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				expect(descendant.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
				expect(root.status()).toBe(ProcessStatus.Exited);
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await child.proc.exited;
				await reader.cancel();
			}
		},
	);

	for (const failure of ["timeout", "error"] as const) {
		it(`surfaces native termination ${failure} even after the root exits`, async () => {
			const child = spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
			const terminate = Process.prototype.terminate;
			const spy = spyOn(Process.prototype, "terminate").mockImplementation(async function (this: Process, options) {
				const result = await terminate.call(this, options);
				if (this.pid !== child.pid) return result;
				if (failure === "error") throw new Error("Native termination failed");
				return false;
			});
			try {
				await expect(child.killAndWait(undefined, -1)).rejects.toThrow(
					failure === "timeout" ? "Process tree termination timed out" : "Native termination failed",
				);
			} finally {
				spy.mockRestore();
				child.kill(undefined, -1);
				await child.proc.exited;
			}
		});
	}
});
